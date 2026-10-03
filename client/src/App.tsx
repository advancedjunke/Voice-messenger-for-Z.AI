import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { User, ChatMessage, MessageType, KnownUser, ConnectionState, AiSettings, AiTranslationState, GroupInfo } from './types.js';
import { useWebRTC } from './hooks/useWebRTC.js';
import { audioTone } from './utils/audioTone.js';
import { isNewerVersion } from './utils/format.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { AuthScreen } from './components/AuthScreen.js';
import { CallModal } from './components/CallModal.js';
import { UserProfileModal } from './components/UserProfileModal.js';
import { ForwardModal } from './components/ForwardModal.js';
// NEW (v1.0.29) GC: модалки создания/управления группой (рендерит App)
import { GroupCreateModal } from './components/GroupCreateModal.js';
import { GroupManageModal } from './components/GroupManageModal.js';
// FIX (v1.0.21): иконки для тостов (замена блокирующих alert())
import { Info, AlertCircle, CheckCircle2 } from 'lucide-react';

const CLOUD_SERVER_URL = 'https://f2f9c29f9c574a2c-217-199-233-97.serveousercontent.com';

// ─── NEW (v1.0.28) AI: настройки AI-функций (persist: vm_ai_settings) ───
// Белый список целевых языков перевода (синхронизирован с AI_TRANSLATE_LANGS
// на сервере и AI_LANG_NAMES в ChatArea).
const AI_LANGS: readonly string[] = ['ru', 'en', 'de', 'es', 'fr', 'it', 'pt', 'zh', 'ja', 'ko', 'tr', 'uk'];

// Дефолт настроек (всё включено, 3 подсказки, русский) + нормализация:
// обрезка мусора из localStorage и из колбэка модалки (clamp count 1..3,
// язык — только из белого списка).
const AI_SETTINGS_DEFAULT: AiSettings = {
  suggestions: true,
  summary: true,
  translation: true,
  suggestionCount: 3,
  translateTarget: 'ru',
};

function normalizeAiSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const count = Math.min(3, Math.max(1, Math.round(Number(raw?.suggestionCount) || 3)));
  const lang = AI_LANGS.includes(raw?.translateTarget as string)
    ? ((raw as AiSettings).translateTarget)
    : 'ru';
  return {
    suggestions: raw?.suggestions !== false,
    summary: raw?.summary !== false,
    translation: raw?.translation !== false,
    suggestionCount: count,
    translateTarget: lang,
  };
}

// FIX (v1.0.21): нормализация ключей собеседников. Сервер ключует переписки
// в нижнем регистре (getConversationKey), а клиент хранил conversations/unreadCounts
// по имени в исходном регистре — один и тот же человек с разным написанием ника
// расщеплял историю на две беседы. Все Map-ключи по имени — только через keyOf.
const keyOf = (name: string) => name.trim().toLowerCase();

// ─── NEW (v1.0.29) GC: ключи групповых бесед ───
// Группы ключуются по id (имя меняется при переименовании, id — никогда).
// Формат совпадает с серверным: messageHistory/БД хранят 'group::<id>'.
const GROUP_KEY_PREFIX = 'group::';
const groupKeyOf = (groupId: string) => GROUP_KEY_PREFIX + groupId;
// Ключ открытого чата: группа — по id, личный чат — по нижнему регистру имени.
const targetKeyOf = (u: User | null | undefined) =>
  u ? (u.isGroup && u.groupId ? groupKeyOf(u.groupId) : keyOf(u.username)) : '';

// NEW (v1.0.29) GC: слияние истории с локальными сообщениями (выделено из
// chat:history_loaded — теперь общий код и для групповых бесед). Ключ — id;
// свои копии не теряют read/deleted (см. FIX v1.0.21 F11).
function mergeHistory(
  prev: Record<string, ChatMessage[]>,
  partnerKey: string,
  messages: unknown
): Record<string, ChatMessage[]> {
  const merged = new Map<string, ChatMessage>();
  for (const m of Array.isArray(messages) ? (messages as ChatMessage[]) : []) {
    if (m && m.id) merged.set(m.id, m);
  }
  const local = prev[partnerKey] || [];
  for (const m of local) {
    const fromHistory = merged.get(m.id);
    if (!fromHistory) {
      merged.set(m.id, m);
    } else if (m.timestamp > fromHistory.timestamp) {
      merged.set(m.id, { ...m, read: m.read || fromHistory.read, deleted: m.deleted || fromHistory.deleted });
    } else {
      merged.set(m.id, { ...fromHistory, read: fromHistory.read || m.read, deleted: fromHistory.deleted || m.deleted });
    }
  }
  const list = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
  return { ...prev, [partnerKey]: list };
}

// NEW (v1.0.29) GC: чистая функция обновления списка печатающих в группе
// (дедуп имён по нижнему регистру; пустой список — ключ удаляется)
function applyGroupTyping(
  prev: Record<string, string[]>,
  groupKey: string,
  name: string,
  isTyping: boolean
): Record<string, string[]> {
  const list = prev[groupKey] || [];
  const nextList = isTyping
    ? list.some(n => n.toLowerCase() === name.toLowerCase())
      ? list
      : [...list, name]
    : list.filter(n => n.toLowerCase() !== name.toLowerCase());
  const next = { ...prev };
  if (nextList.length > 0) next[groupKey] = nextList;
  else delete next[groupKey];
  return next;
}

// FIX (v1.0.21): минимальная система тостов вместо блокирующих alert()
type Toast = { id: number; text: string; kind: 'info' | 'error' | 'success' };
const TOAST_MAX = 4;

function getEffectiveServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('server');

  // v1.0.14: в настольном приложении (Electron, file://) адрес приходит от
  // умной цепочки запуска (localhost → UDP-поиск → встроенный хост). Он ВСЕГДА
  // актуальнее сохранённого в localStorage — иначе после смены хоста приложение
  // навсегда цеплялось бы за старый мёртвый IP.
  if (fromQuery && window.location.protocol === 'file:') return fromQuery;

  const saved = localStorage.getItem('vm_server_url');
  if (saved) return saved;

  if (fromQuery) return fromQuery;

  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;

  // In regular browser running through web server (e.g. cloudflare or local preview)
  if (window.location.protocol.startsWith('http') && window.location.port !== '5173') {
    return window.location.origin;
  }

  // If in local dev
  if (window.location.port === '5173') {
    return 'http://localhost:3001';
  }

  // Fallback for desktop app if query not present
  return CLOUD_SERVER_URL;
}

// v1.0.12: системные desktop-уведомления о новых сообщениях (когда вкладка не в фокусе)
function showDesktopNotification(senderName: string, message: ChatMessage) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;

    const body = message.deleted
      ? 'Сообщение удалено'
      : message.mediaType === 'voice'
      ? '🎤 Голосовое сообщение'
      : message.mediaType === 'image'
      ? message.text || '📷 Фото'
      : (message.text || '').slice(0, 120);

    const n = new Notification(`${senderName} · Voice Messenger`, {
      body: body || 'Новое сообщение',
      icon: '/icon.png',
      tag: `vm_${senderName}`, // не плодим кучу уведомлений от одного человека
      silent: true, // звук уже играет audioTone
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch { /* уведомления не критичны */ }
}

export function App() {
  // NEW (v1.0.24): версия клиента синхронизирована с package.json (1.0.24)
  const APP_VERSION = '1.0.30'; // FIX (v1.0.21): синхронизировано с package.json и Sidebar

  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('vm_username');
    const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
    return saved ? { id: '', socketId: '', username: saved, avatar: savedAvatar, online: false } : null;
  });

  const [serverUrl, setServerUrl] = useState<string>(getEffectiveServerUrl);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  // FIX: беседы ключуются по СТАБИЛЬНОМУ имени пользователя (не socket.id),
  // чтобы история не терялась при переподключении
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // NEW (v1.0.24) S1: скелетоны при загрузке истории — включаем при запросе
  // chat:history, выключаем в chat:history_loaded (+ страховочный таймаут 12с,
  // если сервер не ответил — не «зависшие» скелетоны, а пустое состояние)
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyTimeoutRef = useRef<number | null>(null);

  // FIX (v1.0.21): стек тостов — неблокирующая замена window.alert()
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  /** Показать тост; авто-скрытие через durationMs (5с по умолчанию, 8с — уведомление об обновлении) */
  const pushToast = useCallback(
    (text: string, kind: Toast['kind'] = 'info', durationMs = 5000) => {
      const id = ++toastIdRef.current;
      setToasts(prev => {
        const next = [...prev, { id, text, kind }];
        // не более TOAST_MAX видимых — вытесняем самые старые
        return next.length > TOAST_MAX ? next.slice(next.length - TOAST_MAX) : next;
      });
      window.setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, durationMs);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // v1.0.10: индикаторы «печатает…» (username → таймстамп последнего события)
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const typingTimeoutsRef = useRef<Record<string, number>>({});
  // FIX (v1.0.21): таймер авто-гашения собственного «печатает…» (2.5с тишины)
  const selfTypingIdleRef = useRef<number | null>(null);
  // v1.0.11: известные пользователи (в т.ч. офлайн) — для сайдбара
  const [knownUsers, setKnownUsers] = useState<KnownUser[]>([]);
  // v1.0.10: звук уведомлений (сохраняется в localStorage)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => localStorage.getItem('vm_sound') !== '0');
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);

  // ─── NEW (v1.0.25) F2: «без звука» для отдельных чатов (персист vm_muted) ───
  // Глобальный vm_sound продолжает работать как «мастер-выключатель»; mute
  // чата подавляет И тон, И системное уведомление — но счётчик непрочитанных
  // в сайдбаре всё равно растёт (тихо, не незаметно).
  const [mutedChats, setMutedChats] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('vm_muted') || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch {
      return new Set<string>(); // приватный режим / битый JSON — просто без мьютов
    }
  });
  const mutedChatsRef = useRef(mutedChats);
  useEffect(() => { mutedChatsRef.current = mutedChats; }, [mutedChats]);
  useEffect(() => {
    try { localStorage.setItem('vm_muted', JSON.stringify(Array.from(mutedChats))); } catch { /* ignore */ }
  }, [mutedChats]);
  const handleToggleMute = useCallback(() => {
    const partner = selectedUserRef.current;
    if (!partner) return;
    // NEW (v1.0.29) GC: группы — ключ group::id (мьют групповых чатов работает)
    const key = targetKeyOf(partner);
    setMutedChats(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ─── NEW (v1.0.27) MS: реф текущего пользователя ───
  // В multi-session эхо МОИХ сообщений приходит в другие мои окна с senderId
  // ОТПРАВИВШЕГО сокета (не этого окна) — «своё/чужое» решаем по ИМЕНИ.
  const currentUserRef = useRef<User | null>(currentUser);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  // ─── NEW (v1.0.27) AI: подсказки ответов и сводка переписки (LLM на сервере) ───
  // Состояние общее для всех бесед, но при смене собеседника сбрасывается
  // (эффект ниже) — устаревшие результаты игнорируются ещё и по partnerUsername.
  const [aiReplies, setAiReplies] = useState<string[]>([]);
  const [aiRepliesLoading, setAiRepliesLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<{ text: string; messageCount: number } | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  // NEW (v1.0.28) AI: настройки AI-функций (persist в localStorage vm_ai_settings;
  // приватный режим/битый JSON → дефолты). Управляют видимостью AI-кнопок в ChatArea.
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => {
    try {
      const raw = localStorage.getItem('vm_ai_settings');
      if (raw) return normalizeAiSettings(JSON.parse(raw) as Partial<AiSettings>);
    } catch { /* ignore */ }
    return AI_SETTINGS_DEFAULT;
  });
  // NEW (v1.0.28) AI: переводы сообщений (id → состояние). Кэш глобальный на
  // сессию: id сообщений уникальны, перевод переживает переключение собеседника.
  // Правка сообщения после перевода оставляет старый перевод (id не меняется) —
  // задокументированное упрощение.
  // NEW (v1.0.29) AI: готовые переводы переживают и ПЕРЕЗАГРУЗКУ (vm_ai_translations,
  // последние 50 записей; повреждённый JSON → пустой кэш).
  const [aiTranslations, setAiTranslations] = useState<Record<string, AiTranslationState>>(() => {
    try {
      const raw = localStorage.getItem('vm_ai_translations');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, AiTranslationState>;
        if (parsed && typeof parsed === 'object') {
          const clean: Record<string, AiTranslationState> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (k && v && v.status === 'done' && typeof v.translated === 'string') {
              clean[k] = {
                status: 'done',
                translated: v.translated,
                sourceLang: typeof v.sourceLang === 'string' && v.sourceLang ? v.sourceLang : undefined,
              };
            }
          }
          return clean;
        }
      }
    } catch { /* ignore */ }
    return {};
  });
  // NEW (v1.0.29) AI: персист кэша переводов (только готовые, максимум 50)
  useEffect(() => {
    try {
      const done = Object.entries(aiTranslations).filter(([, v]) => v.status === 'done');
      const capped = Object.fromEntries(done.slice(-50));
      localStorage.setItem('vm_ai_translations', JSON.stringify(capped));
    } catch { /* ignore */ }
  }, [aiTranslations]);

  // ─── NEW (v1.0.29) GC: групповые чаты ───
  // Список моих групп (актуализируется: groups:list_result при входе +
  // group:updated / group:deleted на изменения).
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [isGroupCreateOpen, setIsGroupCreateOpen] = useState(false);
  const [isGroupManageOpen, setIsGroupManageOpen] = useState(false);
  // кто печатает в группах: ключ группы → список имён (индикатор в ChatArea)
  const [groupTyping, setGroupTyping] = useState<Record<string, string[]>>({});
  const groupTypingTimersRef = useRef<Record<string, number>>({});
  // реф выбора группы — колбэки сокета (group:create_result) используют свежую версию
  const handleSelectGroupRef = useRef<(g: GroupInfo) => void>(() => {});
  // Сброс AI-состояния при смене собеседника (покрывает все пути выбора чата).
  // Переводы (aiTranslations) НЕ сбрасываем — они привязаны к id сообщения, а не к чату.
  useEffect(() => {
    setAiReplies([]);
    setAiRepliesLoading(false);
    setAiSummary(null);
    setAiSummaryLoading(false);
  }, [selectedUser?.username]);
  const handleRequestAiReplies = useCallback(() => {
    const sel = selectedUserRef.current;
    // NEW (v1.0.28) AI: подсказки отключены в настройках — кнопку не должно быть
    // видно, но и запрос не уходит (страховка от горячих клавиш/гонок)
    if (!sel || !socketRef.current || !aiSettings.suggestions) return;
    setAiRepliesLoading(true);
    setAiReplies([]);
    // NEW (v1.0.29) GC: в группе — подсказки по groupId
    if (sel.isGroup && sel.groupId) {
      socketRef.current.emit('ai:suggest_replies', { groupId: sel.groupId, count: aiSettings.suggestionCount });
    } else {
      // NEW (v1.0.28) AI: число подсказок из настроек (1..3; сервер клампит сам)
      socketRef.current.emit('ai:suggest_replies', { partnerUsername: sel.username, count: aiSettings.suggestionCount });
    }
  }, [aiSettings.suggestions, aiSettings.suggestionCount]);
  const handleRequestAiSummary = useCallback(() => {
    const sel = selectedUserRef.current;
    if (!sel || !socketRef.current || !aiSettings.summary) return;
    setAiSummaryLoading(true);
    // Непустой «пустой» объект открывает модалку со скелетонами до результата
    setAiSummary({ text: '', messageCount: 0 });
    // NEW (v1.0.29) GC: в группе — сводка по groupId
    if (sel.isGroup && sel.groupId) {
      socketRef.current.emit('ai:summarize', { groupId: sel.groupId });
    } else {
      socketRef.current.emit('ai:summarize', { partnerUsername: sel.username });
    }
  }, [aiSettings.summary]);
  const handleDismissAiSummary = useCallback(() => setAiSummary(null), []);
  // NEW (v1.0.28) AI: запрос перевода сообщения (кнопка Languages на пузыре).
  // Повторный клик в статусе loading — no-op: серверный in-flight guard игнорирует
  // дубли, локально не перезаписываем 'loading' запись.
  const handleRequestAiTranslation = useCallback((messageId: string, text: string) => {
    if (!socketRef.current || !aiSettings.translation) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    setAiTranslations(prev =>
      prev[messageId]?.status === 'loading' ? prev : { ...prev, [messageId]: { status: 'loading' } }
    );
    socketRef.current.emit('ai:translate_message', {
      messageId,
      text: clean,
      targetLang: aiSettings.translateTarget,
    });
  }, [aiSettings.translation, aiSettings.translateTarget]);
  // NEW (v1.0.28) AI: скрыть перевод (крестик на плашке / повторный клик по кнопке)
  const handleDismissAiTranslation = useCallback((messageId: string) => {
    setAiTranslations(prev => {
      if (!prev[messageId]) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
  }, []);
  // NEW (v1.0.28) AI: сохранение настроек из модалки (кнопка «Готово» в ChatArea).
  // Отключённые функции сразу прячут свой UI (чипы подсказок/панель сводки).
  const handleUpdateAiSettings = useCallback((next: AiSettings) => {
    const merged = normalizeAiSettings(next);
    setAiSettings(merged);
    try { localStorage.setItem('vm_ai_settings', JSON.stringify(merged)); } catch { /* ignore */ }
    if (!merged.suggestions) {
      setAiReplies([]);
      setAiRepliesLoading(false);
    }
    if (!merged.summary) {
      setAiSummary(null);
      setAiSummaryLoading(false);
    }
  }, []);

  // ─── NEW (v1.0.23) TH1: тема оформления (тёмная по умолчанию — идентичность приложения) ───
  // Класс на <html> уже выставлен FOUC-скриптом в index.html; здесь состояние
  // синхронизируется с localStorage, применяется при переключении и сохраняется.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('vm_theme') === 'light' ? 'light' : 'dark'
  );

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
    localStorage.setItem('vm_theme', theme);
    // цвет хрома браузера (мобильные) подстраивается под тему
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f0518' : '#f3f4f6');
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // NEW (v1.0.26) F1: синк темы/звука/мьютов между вкладками. storage-событие
  // приходит ТОЛЬКО в другие вкладки (зацикливания нет). Дублирует изменения,
  // сделанные в параллельно открытой вкладке — состояние одной личности
  // (vm_theme/vm_sound/vm_muted) едино во всех окнах приложения.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'vm_theme') {
        const next = e.newValue === 'light' ? 'light' : 'dark';
        setTheme(prev => (prev === next ? prev : next));
      } else if (e.key === 'vm_sound') {
        const next = e.newValue !== '0';
        setSoundEnabled(prev => (prev === next ? prev : next));
      } else if (e.key === 'vm_muted') {
        try {
          const raw = JSON.parse(e.newValue || '[]');
          const next = new Set(Array.isArray(raw) ? raw.map(String) : []);
          // обновляем только при фактическом расхождении — иначе лишний рендер
          setMutedChats(prev => {
            const same = prev.size === next.size && Array.from(next).every(v => prev.has(v));
            return same ? prev : next;
          });
        } catch { /* битый JSON — игнорируем */ }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // ref текущего выбранного пользователя (для read-квитанций и звуков)
  const selectedUserRef = useRef<User | null>(null);
  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);
  // v1.0.12: кэш последних визитов (чтобы при уходе собеседника в офлайн
  // шапка чата показывала время, а не «давно» — онлайн-список lastSeen не содержит)
  const lastSeenCacheRef = useRef<Record<string, number>>({});

  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  // NEW (v1.0.22) N6: детальное состояние соединения (индикатор в сайдбаре):
  // connecting → online → reconnecting/offline. socketConnected (для AuthScreen
  // и модалки настроек) остаётся простой производной от него.
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean;
    latestVersion?: string;
    releaseNotes?: string;
  } | null>(null);

  // Auto-detect host mode if running locally in Electron desktop app
  useEffect(() => {
    if (window.location.protocol === 'file:' && !localStorage.getItem('vm_server_url')) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 400);
      fetch('http://localhost:3001/health', { signal: ctrl.signal })
        .then(res => {
          clearTimeout(timer);
          if (res.ok) {
            console.log('✅ Host machine detected: switching to local server http://localhost:3001');
            setServerUrl('http://localhost:3001');
          }
        })
        .catch(() => {});
    }
  }, []);

  // Check for updates on mount (v1.0.11: бейдж только если версия ДЕЙСТВИТЕЛЬНО новее)
  useEffect(() => {
    fetch(`${serverUrl}/api/updates/check`)
      .then(res => res.json())
      .then(data => {
        if (data && data.available && data.latestVersion && isNewerVersion(data.latestVersion, APP_VERSION)) {
          setUpdateInfo(data);
        }
      })
      .catch(() => {});
  }, [serverUrl]);

  // Setup Socket.io connection
  useEffect(() => {
    // NEW (v1.0.22) N6: новый сокет (первое подключение/смена сервера) — «подключаемся»
    setConnectionState('connecting');
    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server with ID:', socket.id);
      setSocketConnected(true);
      // NEW (v1.0.22) N6: соединение установлено
      setConnectionState('online');

      // v1.0.17: вход в аккаунт — имя + токен сессии (REST-авторизация).
      // Если аккаунта/токена нет — просто открывается экран входа.
      const savedName = localStorage.getItem('vm_username');
      const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
      const savedToken = localStorage.getItem('vm_token') || undefined;
      if (savedName) {
        socket.emit('user:register', { username: savedName, avatar: savedAvatar, token: savedToken });
      }
    });

    socket.on('disconnect', (reason: string) => {
      console.log('Disconnected from server:', reason);
      setSocketConnected(false);
      // NEW (v1.0.22) N6: ручной дисконнект (выход/замена сессии) — «нет связи»;
      // транспортные сбои (ping timeout / transport close / error) — «переподключение…»,
      // т.к. socket.io продолжает авто-реконнект
      setConnectionState(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });

    // NEW (v1.0.22) N6: попытка соединения не удалась (сервер недоступен) —
    // авто-реконнект активен, показываем «переподключение…»
    socket.on('connect_error', () => {
      setConnectionState(prev => (prev === 'online' ? prev : 'reconnecting'));
    });

    socket.on('user:registered', ({ user, allUsers }: { user: User; allUsers: User[] }) => {
      setCurrentUser(user);
      setLoginError(null);
      if (user.avatar) {
        localStorage.setItem('vm_avatar', user.avatar);
      }
      setUsers(allUsers);
      // v1.0.11: запрашиваем известных (в т.ч. офлайн) пользователей
      socket.emit('users:known');
      // NEW (v1.0.29) GC: запрашиваем свои группы (сервер шлёт их и сам после
      // user:registered — дублируем для надёжности при реконнектах)
      socket.emit('groups:list');
      // v1.0.12: спрашиваем разрешение на системные уведомления (после первого входа)
      try {
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      } catch { /* не критично */ }
    });

    // Регистрация/вход не прошли (имя занято, неверный пароль, токен истёк)
    socket.on('user:register_failed', ({ message }: { message: string; needPassword?: boolean }) => {
      setLoginError(message || 'Не удалось войти');
    });

    // Этот ник открыли с другого устройства — разлогиниваем текущую сессию
    socket.on('user:replaced', ({ message }: { message?: string }) => {
      // FIX (v1.0.21): тост вместо блокирующего alert()
      pushToast(message || 'Этот ник открыт в другом окне.', 'error');
      localStorage.removeItem('vm_username');
      setCurrentUser(null);
      setSelectedUser(null);
      // v1.0.11: сервер принудительно закрыл сокет — пересоздаём соединение,
      // чтобы следующий вход в сеть гарантированно дошёл до сервера
      // (найдено при QA: после replace старый сокет «зависал» и emit терялся)
      socket.disconnect();
      socket.connect();
    });

    socket.on('user:updated', (updatedUser: User) => {
      if (updatedUser) {
        setCurrentUser(updatedUser);
        if (updatedUser.avatar) {
          localStorage.setItem('vm_avatar', updatedUser.avatar);
        }
      }
    });

    socket.on('users:update', (allUsers: User[]) => {
      setUsers(allUsers);
      // v1.0.12 FIX: сверяем ВЫБРАННОГО собеседника по СТАБИЛЬНОМУ имени, а не socket.id.
      // Раньше офлайн-контакт не «оживал» в шапке открытого чата, когда входил в сеть
      // (новый объект пользователя имеет новый socket.id, а офлайн-User имеет id='') —
      // статус обновлялся только после перевыбора чата.
      setSelectedUser(prev => {
        if (!prev) return null;
        // NEW (v1.0.29) GC: синтетический пользователь группы не синхронизируется
        // с присутствием (иначе одноимённый онлайн-юзер «подменял» открытую группу)
        if (prev.isGroup) return prev;
        const fresh = allUsers.find(
          u => u.username.toLowerCase() === prev.username.toLowerCase()
        );
        if (fresh) return { ...fresh };
        // v1.0.12: собеседник исчез из списка онлайн → помечаем офлайн
        // (иначе шапка чата зависала в «В сети», пока не перевыберешь чат)
        if (prev.online) {
          const cached = lastSeenCacheRef.current[prev.username.toLowerCase()];
          return { ...prev, online: false, inCallWith: null, lastSeen: cached ?? prev.lastSeen };
        }
        return prev;
      });
    });

    socket.on('chat:receive', (message: ChatMessage) => {
      // FIX: определяем собеседника по имени (стабильно), а не по socket.id.
      // Для своих (эхо) сообщений сервер присылает recipientName.
      // NEW (v1.0.27) MS: «своё» теперь по ИМЕНИ отправителя — эхо из другого
      // моего окна приходит с senderId чужого сокета (multi-session), а не socket.id.
      const isMine = keyOf(message.senderName) === keyOf(currentUserRef.current?.username || '');
      // NEW (v1.0.29) GC: групповое сообщение — ключ по id группы (имя группы
      // меняется при переименовании, id — никогда)
      const isGroupMsg = Boolean(message.groupId);
      const partnerKey = isGroupMsg
        ? groupKeyOf(String(message.groupId))
        : keyOf(isMine ? (message.recipientName || '') : message.senderName);
      if (!partnerKey || partnerKey === GROUP_KEY_PREFIX) return;

      setConversations(prev => ({
        ...prev,
        [partnerKey]: [...(prev[partnerKey] || []), message],
      }));

      // v1.0.10: счётчик непрочитанных, звук и read-квитанции
      if (!isMine) {
        // FIX (v1.0.21): сравниваем открытый чат по нормализованному ключу —
        // регистр ника больше не ломает авто-прочтение.
        // NEW (v1.0.29) GC: targetKeyOf покрывает и группы (group::id)
        const openKey = targetKeyOf(selectedUserRef.current);
        if (openKey && openKey === partnerKey && document.hasFocus()) {
          // чат открыт и вкладка в фокусе — сразу подтверждаем прочтение
          if (isGroupMsg) {
            socketRef.current?.emit('chat:read', { groupId: message.groupId });
          } else {
            socketRef.current?.emit('chat:read', { partnerUsername: message.senderName });
          }
        } else {
          setUnreadCounts(prevCounts => ({
            ...prevCounts,
            [partnerKey]: (prevCounts[partnerKey] || 0) + 1,
          }));
          // NEW (v1.0.25) F2: чат заглушён — ни тона, ни системного уведомления
          // (счётчик непрочитанных выше всё равно инкрементируется)
          if (mutedChatsRef.current.has(partnerKey)) return;
          if (soundEnabledRef.current) {
            audioTone.playMessageTone();
          }
          // v1.0.12: системное уведомление, когда вкладка не в фокусе.
          // NEW (v1.0.29) GC: для группы в заголовке — «Имя · Группа»
          const notifyTitle = isGroupMsg
            ? `${message.senderName} · ${message.recipientName || 'группа'}`
            : message.senderName;
          showDesktopNotification(notifyTitle, message);
        }
      }
    });

    // v1.0.10: собеседник прочитал мои сообщения → ✓ превращаются в ✓✓
    socket.on('chat:read_ack', ({ readerName }: { readerName: string }) => {
      // FIX (v1.0.21): ключ беседы — в нижнем регистре имени читателя
      const readerKey = keyOf(readerName);
      setConversations(prev => {
        const conv = prev[readerKey];
        if (!conv || !conv.some(m => !m.read)) return prev;
        return {
          ...prev,
          [readerKey]: conv.map(m => (m.read ? m : { ...m, read: true })),
        };
      });
    });

    // NEW (v1.0.23) N1: сервер отклонил отправку (раньше молча ронял — теперь NACK).
    // Причины: сессия не зарегистрирована (реконнект), получатель не найден,
    // самому себе, пустое, валидация размера/длительности.
    socket.on('chat:send_failed', ({ reason, preview }: { reason: string; preview?: string }) => {
      const label = preview ? `«${preview}${preview.length >= 80 ? '…' : ''}» не отправлено: ${reason}` : `Сообщение не отправлено: ${reason}`;
      pushToast(label, 'error', 6000);
      // NEW (v1.0.23) N1: несостоявшийся текст возвращаем в черновик текущей
      // беседы (input уже очищен при отправке) — при повторном открытии чата
      // он восстановится. Срезка до 80 симв. (размер preview на сервере).
      const partner = selectedUserRef.current?.username;
      if (partner && preview) {
        try {
          localStorage.setItem(`vm_draft_${partner.toLowerCase()}`, preview);
        } catch { /* приватный режим — просто тост */ }
      }
    });

    // v1.0.10: индикатор «печатает…» с авто-затуханием через 3с
    socket.on('chat:typing', ({ fromName, isTyping }: { fromName: string; isTyping: boolean }) => {
      // FIX (v1.0.21): ключ индикатора — в нижнем регистре имени отправителя
      const fromKey = keyOf(fromName);
      setTypingUsers(prev => {
        const next = { ...prev };
        if (isTyping) next[fromKey] = Date.now();
        else delete next[fromKey];
        return next;
      });
      const timers = typingTimeoutsRef.current;
      if (timers[fromKey]) {
        clearTimeout(timers[fromKey]);
        delete timers[fromKey];
      }
      if (isTyping) {
        timers[fromKey] = window.setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            delete next[fromKey];
            return next;
          });
        }, 3000);
      }
    });

    // v1.0.11: известные пользователи (в т.ч. офлайн) из БД сервера
    socket.on('users:known_list', ({ users: known }: { users: KnownUser[] }) => {
      setKnownUsers(Array.isArray(known) ? known : []);
      // v1.0.12: пополняем кэш последних визитов
      for (const k of known || []) {
        if (k?.username && k.lastSeen) {
          lastSeenCacheRef.current[k.username.toLowerCase()] = k.lastSeen;
        }
      }
    });

    // v1.0.11: собеседник (или мы) удалил сообщение → помечаем удалённым
    socket.on('chat:message_deleted', ({ messageId, partnerUsername, groupId }: { messageId: string; partnerUsername?: string; groupId?: string }) => {
      // NEW (v1.0.29) GC: для групп ключ беседы — по id группы
      const partnerKey = groupId ? groupKeyOf(String(groupId)) : keyOf(partnerUsername || '');
      if (!partnerKey || partnerKey === GROUP_KEY_PREFIX) return;
      setConversations(prev => {
        const conv = prev[partnerKey];
        if (!conv || !conv.some(m => m.id === messageId)) return prev;
        return {
          ...prev,
          [partnerKey]: conv.map(m =>
            m.id === messageId
              ? { ...m, deleted: true, text: undefined, mediaUrl: undefined, duration: undefined, replyTo: undefined }
              : m
          ),
        };
      });
    });

    socket.on('chat:delete_failed', ({ message }: { message?: string }) => {
      console.warn('[chat:delete_failed]', message || 'Не удалось удалить сообщение');
    });

    // NEW (v1.0.24) E1: собеседник (или мы) отредактировал сообщение → обновляем
    // текст и помечаем edited/editedAt — у собеседника обновляется открытая
    // беседа и превью в сайдбаре (ключ беседы — нижний регистр имени)
    socket.on('chat:message_edited', ({ messageId, partnerUsername, groupId, text, editedAt }: { messageId: string; partnerUsername?: string; groupId?: string; text?: string; editedAt?: number }) => {
      // NEW (v1.0.29) GC: для групп ключ беседы — по id группы
      const partnerKey = groupId ? groupKeyOf(String(groupId)) : keyOf(partnerUsername || '');
      if (!partnerKey || partnerKey === GROUP_KEY_PREFIX) return;
      setConversations(prev => {
        const conv = prev[partnerKey];
        if (!conv || !conv.some(m => m.id === messageId)) return prev;
        return {
          ...prev,
          [partnerKey]: conv.map(m =>
            m.id === messageId
              ? { ...m, text: text, edited: true, editedAt: editedAt || Date.now() }
              : m
          ),
        };
      });
    });

    // NEW (v1.0.24) E1: NACK правки — показываем причину тостом (текст остаётся
    // в поле ввода у клиента — ChatArea не очищает его до подтверждения)
    socket.on('chat:edit_failed', ({ reason }: { messageId?: string; reason?: string }) => {
      pushToast(`Не удалось изменить: ${reason || 'неизвестная ошибка'}`, 'error');
    });

    // NEW (v1.0.25) R1: слепок реакций сообщения обновлён (своё эхо или
    // собеседник) — заменяем reactions целиком у сообщения в кэше беседы
    socket.on('chat:reaction_updated', ({ messageId, partnerUsername, groupId, reactions }: { messageId: string; partnerUsername?: string; groupId?: string; reactions?: Record<string, string[]> }) => {
      // NEW (v1.0.29) GC: для групп ключ беседы — по id группы
      const partnerKey = groupId ? groupKeyOf(String(groupId)) : keyOf(partnerUsername || '');
      if (!partnerKey || partnerKey === GROUP_KEY_PREFIX || !messageId) return;
      setConversations(prev => {
        const conv = prev[partnerKey];
        if (!conv || !conv.some(m => m.id === messageId)) return prev;
        return {
          ...prev,
          [partnerKey]: conv.map(m =>
            m.id === messageId
              ? { ...m, reactions: reactions && Object.keys(reactions).length > 0 ? reactions : undefined }
              : m
          ),
        };
      });
    });

    // NEW (v1.0.25) R1: NACK реакции — тост с причиной (пилюля могла уже
    // оптимистично подсветиться — серверное слепо её погасит)
    socket.on('chat:react_failed', ({ reason }: { messageId?: string; reason?: string }) => {
      pushToast(`Реакция не сохранена: ${reason || 'неизвестная ошибка'}`, 'error');
    });

    // ─── NEW (v1.0.27) AI: результаты LLM-помощников ───
    // Устаревшие результаты (пользователь переключил чат до ответа сервера)
    // игнорируются сравнением partnerUsername с текущим собеседником.
    socket.on(
      'ai:suggest_replies_result',
      ({ partnerUsername, groupId, suggestions, error }: { partnerUsername?: string; groupId?: string; suggestions?: string[]; error?: string }) => {
        setAiRepliesLoading(false);
        // NEW (v1.0.29) GC: групповые подсказки приходят с groupId — сверяем
        // по ключу группы, иначе — по имени собеседника
        const openKey = targetKeyOf(selectedUserRef.current);
        const expectedKey = groupId ? groupKeyOf(String(groupId)) : keyOf(partnerUsername || '');
        if (!openKey || openKey !== expectedKey) return;
        if (error) {
          setAiReplies([]);
          pushToast(`Подсказки недоступны: ${error}`, 'error');
          return;
        }
        setAiReplies(
          (Array.isArray(suggestions) ? suggestions : [])
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .slice(0, 3)
        );
      }
    );

    socket.on(
      'ai:summary_result',
      ({ partnerUsername, groupId, summary, messageCount, error }: { partnerUsername?: string; groupId?: string; summary?: string; messageCount?: number; error?: string }) => {
        setAiSummaryLoading(false);
        // NEW (v1.0.29) GC: групповые сводки приходят с groupId — сверяем
        // по ключу группы, иначе — по имени собеседника
        const openKey = targetKeyOf(selectedUserRef.current);
        const expectedKey = groupId ? groupKeyOf(String(groupId)) : keyOf(partnerUsername || '');
        if (!openKey || openKey !== expectedKey) return;
        if (error) {
          setAiSummary(null);
          pushToast(`Сводка недоступна: ${error}`, 'error');
          return;
        }
        setAiSummary({ text: summary || '', messageCount: Number(messageCount) || 0 });
      }
    );

    // ─── NEW (v1.0.28) AI: результат перевода сообщения ───
    // Приходит ТОЛЬКО запрашивающему сокету. Идём по messageId (не по чату):
    // перевод корректен даже если пользователь уже переключил собеседника.
    socket.on(
      'ai:translate_result',
      ({ messageId, translated, sourceLang, error }: { messageId?: string; translated?: string; sourceLang?: string; error?: string }) => {
        const key = String(messageId || '');
        if (!key) return;
        if (error) {
          // снятие 'loading'-скелетона без потери других переводов + тост
          setAiTranslations(prev => {
            if (!prev[key] || prev[key].status !== 'loading') return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
          pushToast(`Перевод недоступен: ${error}`, 'error');
          return;
        }
        const text = String(translated || '').trim();
        if (!text) return;
        // NEW (v1.0.29) AI: сервер определяет исходный язык — показываем на плашке
        const cleanSource = typeof sourceLang === 'string' && sourceLang.trim() ? sourceLang.trim().slice(0, 24) : undefined;
        setAiTranslations(prev => ({ ...prev, [key]: { status: 'done', translated: text, sourceLang: cleanSource } }));
      }
    );

    socket.on(
      'chat:history_loaded',
      ({ recipientId, messages }: { recipientId: string; messages: ChatMessage[] }) => {
        // NEW (v1.0.24) S1: история приехала — гасим скелетоны загрузки
        setHistoryLoading(false);
        // FIX (v1.0.21): ключ беседы — в нижнем регистре (сервер присылает имя собеседника)
        const partnerKey = keyOf(recipientId || '');
        if (!partnerKey) return;
        // FIX (v1.0.21): СЛИЯНИЕ истории с уже полученными в реальном времени
        // сообщениями. Логика выделена в mergeHistory (NEW v1.0.29 GC: общий
        // код и для групповых бесед). Ключ — id; свои копии не теряют read/deleted.
        setConversations(prev => mergeHistory(prev, partnerKey, messages));
      }
    );

    // ─── NEW (v1.0.29) GC: «печатает…» в группе ───
    // Сервер шлёт событие всем, кроме печатающего. Два потребителя:
    // typingUsers[groupKey] — строка в сайдбаре («печатает…», таймаут 3с),
    // groupTyping[groupKey] — имена для индикатора в шапке чата (ChatArea).
    socket.on('chat:typing_group', ({ groupId, fromName, isTyping }: { groupId?: string; fromName?: string; isTyping?: boolean }) => {
      const gid = String(groupId || '');
      const who = String(fromName || '').trim();
      if (!gid || !who) return;
      const gk = groupKeyOf(gid);
      // сайдбар: факт «кто-то печатает» (та же схема, что у ЛС)
      setTypingUsers(prev => {
        const next = { ...prev };
        if (isTyping) next[gk] = Date.now();
        else delete next[gk];
        return next;
      });
      if (typingTimeoutsRef.current[gk]) {
        clearTimeout(typingTimeoutsRef.current[gk]);
        delete typingTimeoutsRef.current[gk];
      }
      if (isTyping) {
        typingTimeoutsRef.current[gk] = window.setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            delete next[gk];
            return next;
          });
        }, 3000);
      }
      // ChatArea: имена печатающих (дедуп по нижнему регистру)
      setGroupTyping(prev => applyGroupTyping(prev, gk, who, Boolean(isTyping)));
      const nameKey = `${gk}::${who.toLowerCase()}`;
      if (groupTypingTimersRef.current[nameKey]) {
        clearTimeout(groupTypingTimersRef.current[nameKey]);
        delete groupTypingTimersRef.current[nameKey];
      }
      if (isTyping) {
        groupTypingTimersRef.current[nameKey] = window.setTimeout(() => {
          setGroupTyping(prev => applyGroupTyping(prev, gk, who, false));
          delete groupTypingTimersRef.current[nameKey];
        }, 3000);
      }
    });

    // ─── NEW (v1.0.29) GC: события групп ───
    // Полный список моих групп (приходит при входе и по запросу groups:list)
    socket.on('groups:list_result', ({ groups: list }: { groups?: GroupInfo[] }) => {
      setGroups(
        Array.isArray(list)
          ? list.filter(g => g && typeof g.id === 'string' && Array.isArray(g.members))
          : []
      );
    });

    // Группа создана/изменилась (invite/rename/leave) — upsert по id
    socket.on('group:updated', ({ group }: { group?: GroupInfo }) => {
      if (!group || typeof group.id !== 'string') return;
      setGroups(prev => {
        const idx = prev.findIndex(g => g.id === group.id);
        if (idx === -1) return [...prev, group];
        const next = [...prev];
        next[idx] = group;
        return next;
      });
      // открыта эта группа — обновляем имя синтетического пользователя
      // (при переименовании шапка чата и черновики остаются на месте)
      setSelectedUser(prev =>
        prev && prev.isGroup && prev.groupId === group.id ? { ...prev, username: group.name } : prev
      );
    });

    // Группа удалена (последний участник вышел) — убираем из списка и закрываем чат
    socket.on('group:deleted', ({ groupId }: { groupId?: string }) => {
      const gid = String(groupId || '');
      if (!gid) return;
      setGroups(prev => prev.filter(g => g.id !== gid));
      setSelectedUser(prev => (prev && prev.isGroup && prev.groupId === gid ? null : prev));
      setUnreadCounts(prev => {
        const next = { ...prev };
        delete next[groupKeyOf(gid)];
        return next;
      });
    });

    // История групповой беседы (снимается скелетон, слияние — как у ЛС)
    socket.on('group:history_loaded', ({ groupId, messages }: { groupId?: string; messages?: ChatMessage[] }) => {
      const gid = String(groupId || '');
      if (!gid) return;
      setHistoryLoading(false);
      setConversations(prev => mergeHistory(prev, groupKeyOf(gid), messages));
    });

    // NEW (v1.0.30) GR: участник дочитал групповую беседу — сервер рассылает
    // read_update ВСЕМ участникам (включая другие окна читающего). Мы точечно
    // обновляем readState внутри группы из состояния groups — это переворачивает
    // ✓ → ✓✓ у отправителей (ChatArea получает readState через activeGroup).
    socket.on('group:read_update', ({ groupId, username, readAt }: { groupId?: string; username?: string; readAt?: number }) => {
      const gid = String(groupId || '');
      const who = String(username || '');
      const at = Number(readAt) || 0;
      if (!gid || !who || !at) return;
      setGroups(prev => {
        const idx = prev.findIndex(g => g.id === gid);
        if (idx === -1) return prev; // чужая группа / устаревшее событие
        const cur = prev[idx];
        // уже более свежее значение (события могут приходить не по порядку) — no-op
        if ((cur.readState?.[who] || 0) >= at) return prev;
        const next = [...prev];
        next[idx] = { ...cur, readState: { ...(cur.readState || {}), [who]: at } };
        return next;
      });
    });

    // Acks групповых операций — ошибки тостом; создание — тост + автопереход
    socket.on('group:create_result', ({ ok, group, error }: { ok?: boolean; group?: GroupInfo; error?: string }) => {
      if (ok && group && group.id) {
        pushToast(`Группа «${group.name}» создана`, 'success');
        // сразу открываем созданную группу (group:updated тоже придёт — идемпотентно)
        handleSelectGroupRef.current(group);
      } else {
        pushToast(`Не удалось создать группу: ${error || 'неизвестная ошибка'}`, 'error');
      }
    });

    socket.on('group:invite_result', ({ ok, error }: { ok?: boolean; error?: string }) => {
      if (ok) pushToast('Участники приглашены', 'success');
      else pushToast(`Не удалось пригласить: ${error || 'неизвестная ошибка'}`, 'error');
    });

    socket.on('group:rename_result', ({ ok, error }: { ok?: boolean; error?: string }) => {
      if (!ok) pushToast(`Не удалось переименовать: ${error || 'неизвестная ошибка'}`, 'error');
    });

    socket.on('group:leave_result', ({ ok, error }: { ok?: boolean; error?: string }) => {
      if (!ok) pushToast(`Не удалось выйти из группы: ${error || 'неизвестная ошибка'}`, 'error');
    });

    // NEW (v1.0.30) GR: ack удаления участника — ошибки тостом; успех виден
    // сразу через group:updated (строка участника исчезает из модалки)
    socket.on('group:kick_result', ({ ok, username, error }: { ok?: boolean; username?: string; error?: string }) => {
      if (!ok) pushToast(`Не удалось удалить участника: ${error || 'неизвестная ошибка'}`, 'error');
      else if (username) pushToast(`${username} удалён из группы`, 'success');
    });

    // NEW (v1.0.30) GR: НАС удалили из группы — тост + закрытие чата, если он
    // открыт (группа исчезает из списка; закрепление чистит Sidebar сам)
    socket.on('group:kicked', ({ groupId, groupName, kickedBy }: { groupId?: string; groupName?: string; kickedBy?: string }) => {
      const gid = String(groupId || '');
      if (!gid) return;
      const gName = String(groupName || '');
      setGroups(prev => prev.filter(g => g.id !== gid));
      setSelectedUser(prev => (prev && prev.isGroup && prev.groupId === gid ? null : prev));
      setUnreadCounts(prev => {
        const next = { ...prev };
        delete next[groupKeyOf(gid)];
        return next;
      });
      pushToast(
        kickedBy
          ? `Вас удалили из группы «${gName}» (удалил: ${kickedBy})`
          : `Вас удалили из группы «${gName}»`,
        'info'
      );
    });

    return () => {
      socket.disconnect();
      // FIX (v1.0.21): чистим таймеры индикаторов «печатает…» при
      // размонтировании/смене сервера — раньше они утечкали
      for (const t of Object.values(typingTimeoutsRef.current)) {
        clearTimeout(t);
      }
      typingTimeoutsRef.current = {};
      // NEW (v1.0.29) GC: таймеры групповых индикаторов «печатает…»
      for (const t of Object.values(groupTypingTimersRef.current)) {
        clearTimeout(t);
      }
      groupTypingTimersRef.current = {};
      if (selfTypingIdleRef.current) {
        clearTimeout(selfTypingIdleRef.current);
        selfTypingIdleRef.current = null;
      }
    };
  }, [serverUrl, pushToast]);

  // v1.0.10: заголовок вкладки с количеством непрочитанных
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((a, b) => a + (b || 0), 0);
    document.title = total > 0 ? `(${total}) Voice Messenger` : 'Voice Messenger';
  }, [unreadCounts]);

  // v1.0.10: при возврате фокуса на вкладку — подтверждаем прочтение открытого чата
  useEffect(() => {
    const handleFocus = () => {
      const open = selectedUserRef.current;
      if (open) {
        // NEW (v1.0.29) GC: для группы — квитанция по groupId, ключ group::id
        if (open.isGroup && open.groupId) {
          socketRef.current?.emit('chat:read', { groupId: open.groupId });
          setUnreadCounts(prev => ({ ...prev, [groupKeyOf(open.groupId!)]: 0 }));
        } else {
          socketRef.current?.emit('chat:read', { partnerUsername: open.username });
          // FIX (v1.0.21): ключ непрочитанных — в нижнем регистре
          setUnreadCounts(prev => ({ ...prev, [keyOf(open.username)]: 0 }));
        }
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // v1.0.10: переключатель звука
  const handleToggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('vm_sound', next ? '1' : '0');
      return next;
    });
  }, []);

  // WebRTC Hook
  const {
    activeCall,
    incomingCall,
    isMuted,
    callDuration,
    localVolume,
    remoteVolume,
    audioMode,
    startCall,
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
    // FIX (v1.0.21): onNotify — тосты вместо alert() внутри хука
  } = useWebRTC(socketRef.current, currentUser?.id || null, pushToast);

  // v1.0.17: успешная регистрация или вход через REST — сохраняем токен сессии
  // и регистрируемся в сокете. Если сокет ещё не подключился, регистрация уйдёт
  // из обработчика on('connect') — кнопка больше не может «молчать».
  const handleAuthed = (payload: { token: string; username: string; avatar?: string | null }) => {
    localStorage.setItem('vm_token', payload.token);
    localStorage.setItem('vm_username', payload.username);
    if (payload.avatar) {
      localStorage.setItem('vm_avatar', payload.avatar);
    }
    setLoginError(null);
    const avatar = payload.avatar || localStorage.getItem('vm_avatar') || undefined;
    if (socketRef.current?.connected) {
      socketRef.current.emit('user:register', {
        username: payload.username,
        avatar,
        token: payload.token,
      });
    }
    // оптимистично показываем имя, чтобы экран входа не мигал
    setCurrentUser(prev => prev && prev.id ? prev : { id: '', socketId: '', username: payload.username, avatar, online: false });
  };

  // Handle Save Avatar
  const handleSaveAvatar = (newAvatar: string) => {
    localStorage.setItem('vm_avatar', newAvatar);
    setCurrentUser(prev => (prev ? { ...prev, avatar: newAvatar } : null));
    if (socketRef.current) {
      socketRef.current.emit('user:update_avatar', { avatar: newAvatar });
    }
  };

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('vm_username');
    localStorage.removeItem('vm_token');
    setCurrentUser(null);
    setSelectedUser(null);
    setLoginError(null);
    // NEW (v1.0.29) GC: чистим групповое состояние (список придёт при новом входе)
    setGroups([]);
    setGroupTyping({});
    setIsGroupCreateOpen(false);
    setIsGroupManageOpen(false);
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }
  };

  // Handle User Selection
  const handleSelectUser = (user: User) => {
    setSelectedUser(user);
    // FIX (v1.0.21): ключи — в нижнем регистре
    const userKey = keyOf(user.username);
    // Clear unread (по имени)
    setUnreadCounts(prev => ({
      ...prev,
      [userKey]: 0,
    }));
    // v1.0.10: сразу подтверждаем прочтение прошлых сообщений
    socketRef.current?.emit('chat:read', { partnerUsername: user.username });
    // Request chat history from server (по стабильному имени)
    if (socketRef.current) {
      // NEW (v1.0.24) S1: история ещё не в кэше — показываем скелетоны, пока
      // едет chat:history_loaded (запрос + страховочный таймаут)
      if (!conversations[userKey] || conversations[userKey].length === 0) {
        setHistoryLoading(true);
        if (historyTimeoutRef.current) window.clearTimeout(historyTimeoutRef.current);
        historyTimeoutRef.current = window.setTimeout(() => setHistoryLoading(false), 12000);
      }
      socketRef.current.emit('chat:history', { recipientId: user.id, recipientUsername: user.username });
    }
  };

  // ─── NEW (v1.0.29) GC: выбор группы в сайдбаре ───
  // Группа представляется «синтетическим пользователем» (isGroup + groupId):
  // весь существующий пайплайн чата работает без изменений, а ключ беседы —
  // group::<id> (см. targetKeyOf) — имя группы меняется при переименовании.
  const handleSelectGroup = (group: GroupInfo) => {
    const synthetic: User = {
      id: group.id,
      socketId: '',
      username: group.name,
      online: true,
      inCallWith: null,
      isGroup: true,
      groupId: group.id,
    };
    setSelectedUser(synthetic);
    const gk = groupKeyOf(group.id);
    setUnreadCounts(prev => ({ ...prev, [gk]: 0 }));
    socketRef.current?.emit('chat:read', { groupId: group.id });
    if (socketRef.current) {
      // скелетоны при первой загрузке истории — как у личных чатов
      if (!conversations[gk] || conversations[gk].length === 0) {
        setHistoryLoading(true);
        if (historyTimeoutRef.current) window.clearTimeout(historyTimeoutRef.current);
        historyTimeoutRef.current = window.setTimeout(() => setHistoryLoading(false), 12000);
      }
      socketRef.current.emit('group:history', { groupId: group.id });
    }
  };
  // реф для колбэков сокета (group:create_result) — всегда свежая версия
  useEffect(() => { handleSelectGroupRef.current = handleSelectGroup; });

  // Send message (v1.0.11: recipientUsername — можно писать и офлайн-собеседнику)
  const handleSendMessage = (payload: {
    text?: string;
    mediaUrl?: string;
    mediaType?: MessageType;
    duration?: number;
    replyTo?: { id: string; senderName: string; text?: string; mediaType?: MessageType };
  }) => {
    if (!selectedUser || !socketRef.current) return;
    // NEW (v1.0.29) GC: групповое сообщение — адресуем по groupId
    if (selectedUser.isGroup && selectedUser.groupId) {
      socketRef.current.emit('chat:send', { groupId: selectedUser.groupId, ...payload });
      return;
    }
    socketRef.current.emit('chat:send', {
      recipientId: selectedUser.id,
      recipientUsername: selectedUser.username,
      ...payload,
    });
  };

  // v1.0.11: удалить своё сообщение
  const handleDeleteMessage = (messageId: string) => {
    if (!selectedUser || !socketRef.current) return;
    // NEW (v1.0.29) GC: в группе — адресуем по groupId
    socketRef.current.emit('chat:delete',
      selectedUser.isGroup && selectedUser.groupId
        ? { groupId: selectedUser.groupId, messageId }
        : { partnerUsername: selectedUser.username, messageId }
    );
  };

  // NEW (v1.0.24) E1: отредактировать своё отправленное сообщение (текст).
  // Оптимистично НЕ обновляем локальную копию — ждём chat:message_edited (эхо
  // сервера), чтобы NACK-сценарии не рассинхронизировали текст с сервером.
  const handleEditMessage = (messageId: string, text: string) => {
    if (!selectedUser || !socketRef.current) return;
    // NEW (v1.0.29) GC: в группе — адресуем по groupId
    socketRef.current.emit('chat:edit',
      selectedUser.isGroup && selectedUser.groupId
        ? { groupId: selectedUser.groupId, messageId, text }
        : { partnerUsername: selectedUser.username, messageId, text }
    );
  };

  // NEW (v1.0.25) R1: поставить/снять свою реакцию на сообщение. Сервер сам
  // разбирается в toggle/переносе и присылает итоговый слепок chat:reaction_updated
  // (обновление кэша — в слушателе выше, обновление UI — оптимистичное не делаем:
  // эхо приходит мгновенно с того же сокета)
  const handleReactMessage = useCallback((messageId: string, emoji: string) => {
    const partner = selectedUserRef.current;
    if (!partner || !socketRef.current) return;
    // NEW (v1.0.29) GC: в группе — адресуем по groupId
    socketRef.current.emit('chat:react',
      partner.isGroup && partner.groupId
        ? { groupId: partner.groupId, messageId, emoji }
        : { partnerUsername: partner.username, messageId, emoji }
    );
  }, []);

  // v1.0.12: пересылка сообщения другому контакту
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const handleForwardMessage = (message: ChatMessage, target: User) => {
    if (!socketRef.current) return;
    // NEW (v1.0.29) GC: пересылка в группу — по groupId
    if (target.isGroup && target.groupId) {
      socketRef.current.emit('chat:send', {
        groupId: target.groupId,
        text: message.text,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        duration: message.duration,
        forwardedFrom: message.forwardedFrom || message.senderName,
      });
    } else {
      socketRef.current.emit('chat:send', {
        recipientId: target.id,
        recipientUsername: target.username,
        text: message.text,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        duration: message.duration,
        forwardedFrom: message.forwardedFrom || message.senderName,
      });
    }
    setForwardingMessage(null);
  };

  // Trigger call
  const handleStartCall = (user: User) => {
    startCall(user.id, user.username, user.avatar);
  };

  // FIX (v1.0.21): «печатает…» — авто-гашение: если пользователь замолчал, не отправив
  // сообщение, через 2.5с шлём isTyping:false (индикатор у собеседника не «висит»)
  const handleTypingChange = useCallback((recipientId: string, isTyping: boolean) => {
    const socket = socketRef.current;
    if (!socket) return;
    // NEW (v1.0.29) GC: для группы recipientId = id группы — сервер различает
    // по полю groupId (personalный путь не задействован)
    const open = selectedUserRef.current;
    const groupId = open?.isGroup ? open.groupId : undefined;
    if (selfTypingIdleRef.current) {
      clearTimeout(selfTypingIdleRef.current);
      selfTypingIdleRef.current = null;
    }
    if (isTyping) {
      socket.emit('chat:typing', { recipientId, isTyping: true, ...(groupId ? { groupId } : {}) });
      selfTypingIdleRef.current = window.setTimeout(() => {
        selfTypingIdleRef.current = null;
        socketRef.current?.emit('chat:typing', { recipientId, isTyping: false, ...(groupId ? { groupId } : {}) });
      }, 2500);
    } else {
      socket.emit('chat:typing', { recipientId, isTyping: false, ...(groupId ? { groupId } : {}) });
    }
  }, []);

  // FIX (v1.0.21): детали обновления — тостом (8с) вместо alert()
  const notifyUpdate = useCallback((text: string) => pushToast(text, 'info', 8000), [pushToast]);

  // ─── NEW (v1.0.29) GC: действия над группой (acks → тосты; актуальное
  // состояние приходит событиями group:updated / group:deleted) ───
  const handleCreateGroup = (name: string, memberUsernames: string[]) => {
    if (!socketRef.current) return;
    socketRef.current.emit('group:create', { name, memberUsernames });
    setIsGroupCreateOpen(false);
  };
  const handleInviteToGroup = (groupId: string, memberUsernames: string[]) => {
    socketRef.current?.emit('group:invite', { groupId, memberUsernames });
  };
  const handleRenameGroup = (groupId: string, name: string) => {
    socketRef.current?.emit('group:rename', { groupId, name });
  };
  const handleLeaveGroup = (groupId: string) => {
    socketRef.current?.emit('group:leave', { groupId });
    setIsGroupManageOpen(false);
  };
  // NEW (v1.0.30) GR: удаление участника из группы (только создатель —
  // проверяет сервер; модалку НЕ закрываем — состав обновится через group:updated)
  const handleKickFromGroup = (groupId: string, username: string) => {
    socketRef.current?.emit('group:kick', { groupId, username });
  };

  // FIX (v1.0.21): ключ беседы — в нижнем регистре
  // NEW (v1.0.29) GC: targetKeyOf покрывает и группы (group::id)
  const currentMessages = selectedUser ? conversations[targetKeyOf(selectedUser)] || [] : [];

  // ─── NEW (v1.0.29) GC: производные для группового чата ───
  // Активная группа (или null, если открыт личный чат / ничего не открыто)
  const activeGroup = selectedUser && selectedUser.isGroup && selectedUser.groupId
    ? groups.find(g => g.id === selectedUser.groupId) || null
    : null;
  // сколько участников группы сейчас в сети (для подзаголовка чата)
  const activeGroupOnlineCount = useMemo(() => {
    if (!activeGroup) return undefined;
    const onlineNames = new Set(users.map(u => u.username.toLowerCase()));
    return activeGroup.members.filter(m => onlineNames.has(m.toLowerCase())).length;
  }, [activeGroup, users]);
  // имена печатающих в открытой группе (индикатор в шапке чата)
  const activeGroupTypingNames = selectedUser && selectedUser.isGroup && selectedUser.groupId
    ? groupTyping[groupKeyOf(selectedUser.groupId)] || []
    : [];
  // цели пересылки: контакты + мои группы (синтетические пользователи)
  const forwardTargets = useMemo(
    () => groups.map(g => ({
      id: g.id,
      socketId: '',
      username: g.name,
      online: true,
      inCallWith: null,
      isGroup: true,
      groupId: g.id,
    } as User)),
    [groups]
  );

  return (
    // NEW (v1.0.23) TH1: корневой слой — двухтемный (светлая по умолчанию, dark: — прежняя тёмная)
    <div className="flex w-full h-full bg-gray-100 dark:bg-gray-950 font-sans text-gray-900 dark:text-gray-100 overflow-hidden relative">
      {/* v1.0.17: экран входа/регистрации (вместо старого LoginModal) */}
      {(!currentUser || !currentUser.id) && (
        <AuthScreen
          serverUrl={serverUrl}
          socketConnected={socketConnected}
          initialName={currentUser?.username || ''}
          error={loginError}
          onAuthed={handleAuthed}
        />
      )}

      {/* Main Messenger Layout */}
      {currentUser && currentUser.id && (
        <>
          <Sidebar
            currentUser={currentUser}
            users={users}
            knownUsers={knownUsers}
            selectedUsername={selectedUser?.username || null}
            unreadCounts={unreadCounts}
            onSelectUser={handleSelectUser}
            onStartCall={handleStartCall}
            onLogout={handleLogout}
            onOpenProfile={() => setIsProfileOpen(true)}
            socketConnected={socketConnected}
            // NEW (v1.0.22) N6: индикатор состояния соединения в шапке сайдбара
            connectionState={connectionState}
            // NEW (v1.0.22) N2: глобальный поиск по сообщениям всех бесед
            conversations={conversations}
            updateInfo={updateInfo}
            serverUrl={serverUrl}
            typingUsers={typingUsers}
            soundEnabled={soundEnabled}
            onToggleSound={handleToggleSound}
            // NEW (v1.0.23) TH1: текущая тема и переключатель (кнопка Sun/Moon)
            theme={theme}
            onToggleTheme={handleToggleTheme}
            // FIX (v1.0.21): уведомления об обновлении — тосты вместо alert()
            onNotify={notifyUpdate}
            // NEW (v1.0.29) GC: группы в сайдбаре
            groups={groups}
            onSelectGroup={handleSelectGroup}
            onRequestCreateGroup={() => setIsGroupCreateOpen(true)}
            selectedGroupKey={selectedUser && selectedUser.isGroup && selectedUser.groupId ? groupKeyOf(selectedUser.groupId) : null}
          />

          <ChatArea
            currentUser={currentUser}
            recipient={selectedUser}
            messages={currentMessages}
            activeCall={activeCall}
            onSendMessage={handleSendMessage}
            onStartCall={handleStartCall}
            onDeleteMessage={handleDeleteMessage}
            // NEW (v1.0.24) E1: правка своих сообщений
            onEditMessage={handleEditMessage}
            // NEW (v1.0.25) R1: реакции-эмодзи на сообщения
            onReactMessage={handleReactMessage}
            // NEW (v1.0.29) GC: групповой режим чата
            activeGroup={activeGroup}
            activeGroupOnlineCount={activeGroupOnlineCount}
            groupTypingNames={activeGroupTypingNames}
            onOpenGroupPanel={() => setIsGroupManageOpen(true)}
            // NEW (v1.0.30) GR: статусы прочтения группы (username → время,
            // регистр ключей не важен — ChatArea приводит к нижнему)
            groupReadState={activeGroup?.readState || null}
            // NEW (v1.0.25) F2: «без звука» для этого чата (звонок/тон/уведомления)
            // NEW (v1.0.29) GC: targetKeyOf — мьют групп тоже работает
            isChatMuted={selectedUser ? mutedChats.has(targetKeyOf(selectedUser)) : false}
            onToggleMute={handleToggleMute}
            // NEW (v1.0.24) S1: скелетоны при первой загрузке истории беседы
            isHistoryLoading={historyLoading}
            // FIX (v1.0.21): ключ индикатора «печатает…» — в нижнем регистре
            // NEW (v1.0.29) GC: targetKeyOf — групповой индикатор «печатает…»
            isPartnerTyping={selectedUser ? Boolean(typingUsers[targetKeyOf(selectedUser)]) : false}
            // FIX (v1.0.21): авто-гашение «печатает…» + тосты ошибок вместо alert()
            onTyping={handleTypingChange}
            onRequestForward={setForwardingMessage}
            onNotify={pushToast}
            // NEW (v1.0.27) AI: подсказки ответов и сводка переписки (LLM на сервере)
            aiReplies={aiReplies}
            aiRepliesLoading={aiRepliesLoading}
            onRequestAiReplies={handleRequestAiReplies}
            aiSummary={aiSummary}
            aiSummaryLoading={aiSummaryLoading}
            onRequestAiSummary={handleRequestAiSummary}
            onDismissAiSummary={handleDismissAiSummary}
            // NEW (v1.0.28) AI: переводчик сообщений + настройки AI-функций
            aiTranslations={aiTranslations}
            onRequestAiTranslation={handleRequestAiTranslation}
            onDismissAiTranslation={handleDismissAiTranslation}
            aiSettings={aiSettings}
            onUpdateAiSettings={handleUpdateAiSettings}
            // FIX (v1.0.21): мобильный режим — возврат к списку собеседников
            onBack={() => setSelectedUser(null)}
          />

          {/* v1.0.12: модалка пересылки сообщения */}
          {/* NEW (v1.0.29) GC: цели пересылки — контакты + мои группы */}
          <ForwardModal
            isOpen={forwardingMessage !== null}
            message={forwardingMessage}
            users={[...users, ...forwardTargets]}
            knownUsers={knownUsers}
            currentUsername={currentUser.username}
            onClose={() => setForwardingMessage(null)}
            onForward={target => forwardingMessage && handleForwardMessage(forwardingMessage, target)}
          />

          {/* NEW (v1.0.29) GC: модалка создания группы */}
          <GroupCreateModal
            isOpen={isGroupCreateOpen}
            users={users}
            knownUsers={knownUsers}
            currentUsername={currentUser.username}
            onClose={() => setIsGroupCreateOpen(false)}
            onCreateGroup={handleCreateGroup}
          />

          {/* NEW (v1.0.29) GC: модалка управления группой (участники/приглашение/переименование/выход) */}
          {activeGroup && (
            <GroupManageModal
              isOpen={isGroupManageOpen}
              group={activeGroup}
              users={users}
              knownUsers={knownUsers}
              currentUsername={currentUser.username}
              onClose={() => setIsGroupManageOpen(false)}
              onInvite={handleInviteToGroup}
              onRename={handleRenameGroup}
              onLeave={handleLeaveGroup}
              // NEW (v1.0.30) GR: удаление участника (кнопки видит только создатель)
              onKick={handleKickFromGroup}
            />
          )}

          {/* Voice Call Active / Incoming Modal */}
          <CallModal
            activeCall={activeCall}
            incomingCall={incomingCall}
            isMuted={isMuted}
            duration={callDuration}
            localVolume={localVolume}
            remoteVolume={remoteVolume}
            audioMode={audioMode}
            onAnswer={answerCall}
            onReject={rejectCall}
            onEnd={endCall}
            onToggleMute={toggleMute}
          />

          {/* User Profile / Avatar Selection Modal */}
          <UserProfileModal
            isOpen={isProfileOpen}
            username={currentUser.username}
            currentAvatar={currentUser.avatar}
            onClose={() => setIsProfileOpen(false)}
            onSaveAvatar={handleSaveAvatar}
          />
        </>
      )}

      {/* FIX (v1.0.21): стек тостов — неблокирующая замена alert(). Последний в DOM —
          перекрывает и экран входа, и модалки (тот же z-50) */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[min(92vw,22rem)]">
          {toasts.map(toast => (
            <div
              key={toast.id}
              onClick={() => dismissToast(toast.id)}
              title="Закрыть уведомление"
              className={`animate-toast-in flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-lg border text-sm cursor-pointer select-none bg-white/95 dark:bg-gray-900/95 ${
                toast.kind === 'error'
                  ? 'border-gray-200 dark:border-gray-800 border-l-4 border-l-red-500 text-red-700 dark:text-red-200'
                  : toast.kind === 'success'
                  ? 'border-gray-200 dark:border-gray-800 border-l-4 border-l-emerald-500 text-emerald-700 dark:text-emerald-200'
                  : 'border-gray-200 dark:border-gray-800 text-gray-800 dark:text-gray-200'
              }`}
            >
              {toast.kind === 'error' ? (
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              ) : toast.kind === 'success' ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
              ) : (
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-indigo-400" />
              )}
              <span className="whitespace-pre-line leading-relaxed min-w-0">{toast.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
