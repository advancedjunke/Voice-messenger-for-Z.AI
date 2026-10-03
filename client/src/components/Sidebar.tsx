/* NEW (v1.0.28) S: визуальная полировка сайдбара — градиентный логотип-текст,
   пилюля версии, стеклянный чип соединения, фиолетовый фокус поиска с подсветкой
   иконки, волосяные линии заголовков секций, градиентные бейджи непрочитанных
   (min-w под двузначные), изумрудные кольца онлайн-аватаров, плитка пустого
   состояния, градиентное кольцо аватара своей карточки, custom-scrollbar списка. */
/* NEW (v1.0.29) GC: секция «Группы» между «Закреплёнными» и «Онлайном» —
   плитки-градиенты по хешу id группы, превью последнего сообщения с префиксом
   «Имя: », бейджи непрочитанных, «печатает…», подсветка выбранной группы;
   пунктирная строка «Создать группу» в самом конце списка (видна всегда);
   групповые беседы включены в глобальный поиск (клик — открытие группы). */
/* NEW (v1.0.30) GR: закрепление групп — vm_pinned хранит два вида ключей
   (имена ЛС в нижнем регистре и 'group::<id>'): булавки на строках секции
   «Группы», закреплённые группы рендерятся в разделе «Закреплённые»
   (сначала пользователи, затем группы), авто-чистка «мёртвых» ключей,
   поиск применяется и к закреплённым группам. Полировка: подсветка выбранных
   строк фиолетовым (была indigo), акцент-полоса у выбранной группы,
   hover-лифт пунктирной «Создать группу», active-масштаб строк групп. */
/* NEW (v1.0.24) P1: закрепление чатов — раздел «Закреплённые» вверху списка,
   кнопки Pin/PinOff на строках, персист в localStorage (vm_pinned). */
// NEW (v1.0.23) TH2: двухтемная конвертация — базовое значение = светлый тон,
// dark: = прежний тёмный (вид тёмной темы не изменён). Акценты (purple/emerald/
// indigo/red/amber/градиенты) и индикатор соединения оставлены как есть.
import React, { useState, useMemo, useEffect } from 'react';
import type { User, KnownUser, ChatMessage, ConnectionState, GroupInfo } from '../types.js';
import { Phone, Search, Users, UsersRound, Plus, LogOut, Settings, Bell, BellOff, Clock, MessageCircle, Sun, Moon, Pin, PinOff, MonitorSmartphone } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { formatLastSeen } from '../utils/format.js';
import { ServerSettingsModal } from './ServerSettingsModal.js';

interface SidebarProps {
  currentUser: User;
  users: User[];
  /** v1.0.11: известные пользователи из БД (в т.ч. офлайн) */
  knownUsers?: KnownUser[];
  /** v1.0.11: выбор теперь по СТАБИЛЬНОМУ имени (офлайн-пользователь не имеет socket.id) */
  selectedUsername?: string | null;
  unreadCounts: Record<string, number>;
  onSelectUser: (user: User) => void;
  onStartCall: (user: User) => void;
  onLogout: () => void;
  onOpenProfile?: () => void;
  socketConnected?: boolean;
  updateInfo?: {
    available: boolean;
    latestVersion?: string;
    releaseNotes?: string;
  } | null;
  serverUrl?: string;
  typingUsers?: Record<string, number>;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  /** FIX (v1.0.21): уведомления (тосты App) вместо блокирующих alert() */
  onNotify?: (text: string, kind?: 'info' | 'error' | 'success') => void;
  /** NEW (v1.0.22) N6: состояние соединения для индикатора в шапке */
  connectionState?: ConnectionState;
  /** NEW (v1.0.22) N2: все беседы — для глобального поиска по сообщениям */
  conversations?: Record<string, ChatMessage[]>;
  /** NEW (v1.0.23) TH1: текущая тема ('dark' | 'light') и переключатель */
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  /** NEW (v1.0.29) GC: мои группы (актуальный список с сервера) */
  groups?: GroupInfo[];
  /** NEW (v1.0.29) GC: клик по строке группы — открыть чат группы */
  onSelectGroup?: (group: GroupInfo) => void;
  /** NEW (v1.0.29) GC: «+» — запросить создание группы (модалку рендерит App.tsx) */
  onRequestCreateGroup?: () => void;
  /** NEW (v1.0.29) GC: ключ открытого чата группы ('group::<id>') для подсветки */
  selectedGroupKey?: string | null;
}

// NEW (v1.0.22) N2: сниппет вокруг совпадения (≈60 символов, с многоточиями по краям)
function matchSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + q.length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// NEW (v1.0.22) N2: компактное время результата — «14:32» сегодня, иначе «05.03»
function shortTimeLabel(ts: number): string {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

// NEW (v1.0.26) F4: превью последнего сообщения в строках (Telegram-стиль) + чипы реакций + время
// Хелперы уровня модуля: последнее сообщение беседы, сниппет (удалённое / 🎤 / 📷 / текст,
// префикс «Вы: » для своих, усечение ~40 символов) и список реакций для чипов.

// F4: последнее сообщение беседы (ключ — norm(username), массив хронологический,
// последний элемент = самое новое). Нет беседы / пустая → undefined — тогда строка
// показывает прежний статус-присутствие.
function lastMessageOf(
  conversations: Record<string, ChatMessage[]>,
  key: string
): ChatMessage | undefined {
  const msgs = conversations[key];
  return Array.isArray(msgs) && msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
}

// F4: текст сниппета последнего сообщения: удалённое → «Сообщение удалено» (italic+gray),
// голос → «🎤 Голосовое», фото → «📷 …» (+текст, если есть), иначе — текст. Своё сообщение
// получает префикс «Вы: ». Усечение ~40 символов (по кодпоинтам — чтобы не рвать эмодзи).
// NEW (v1.0.29) GC: withSender — групповой режим превью: чужие сообщения
// получают префикс «Имя: » (в личных чатах отправитель очевиден, префикс не нужен)
function lastMessageSnippet(last: ChatMessage, selfLower: string, withSender = false): { text: string; deleted: boolean } {
  let body: string;
  if (last.deleted) body = 'Сообщение удалено';
  else if (last.mediaType === 'voice') body = '🎤 Голосовое';
  else if (last.mediaType === 'image') body = last.text ? `📷 ${last.text}` : '📷 Фото';
  else body = last.text || '';

  const mine = (last.senderName || '').trim().toLowerCase() === selfLower;
  const prefix = mine ? 'Вы: ' : withSender && last.senderName ? `${last.senderName}: ` : '';
  const full = `${prefix}${body}`;
  const chars = Array.from(full);
  return {
    text: chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : full,
    deleted: !!last.deleted,
  };
}

// F4: реакции последнего сообщения для чипов — только непустые списки, максимум 3 эмодзи.
function lastMessageReactions(last: ChatMessage): Array<[string, string[]]> {
  if (!last.reactions) return [];
  return Object.entries(last.reactions)
    .filter(([, users]) => Array.isArray(users) && users.length > 0)
    .slice(0, 3);
}

// ─── NEW (v1.0.29) GC: группы — хелперы уровня модуля ───
// Ключ групповой беседы в картах App (непрочитанные / «печатает…» / история).
// Группы ключуются по id (НЕ по имени — группу можно переименовать).
const groupKeyOf = (id: string): string => `group::${id}`;

// GC: русская плюрализация «N участников» для строки группы
function membersLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'участник'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'участника'
      : 'участников';
  return `${n} ${word}`;
}

// GC: градиент плитки-«аватара» группы — детерминированный выбор одной из
// трёх пар палитры по хешу id (у группы всегда один и тот же оттенок)
const GROUP_TILE_GRADIENTS = [
  'from-purple-500 to-violet-500',
  'from-violet-500 to-fuchsia-500',
  'from-fuchsia-500 to-pink-500',
];
function groupTileGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % 997;
  return GROUP_TILE_GRADIENTS[hash % GROUP_TILE_GRADIENTS.length];
}

// NEW (v1.0.27) MS: бейдж мульти-сессии — крошечная пилюля рядом с именем
// пользователя, который онлайн сразу из N окон/устройств (поле User.sessions
// от сервера, раунд мульти-сессий). Рендерится ТОЛЬКО при sessions > 1 —
// обычные строки не захламляются. Изумрудный тон — семантика «в сети»
// (существующий акцент), пары light/dark; тайтл/aria — «В сети с N окон».
// NEW (v1.0.28) S: стеклянная полировка — backdrop-blur + плотнее рамка
// (light 500/30, dark 400/30) + изумрудный inset-блик сверху.
const sessionsBadge = (user: User): React.ReactNode => {
  const n = user.sessions ?? 0;
  if (n <= 1) return null;
  return (
    <span
      title={`В сети с ${n} окон`}
      aria-label={`В сети с ${n} окон`}
      className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full bg-emerald-400/15 dark:bg-emerald-500/10 border border-emerald-500/30 dark:border-emerald-400/30 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(16,185,129,0.15)] text-emerald-700 dark:text-emerald-400 text-[10px] font-semibold leading-none shrink-0"
    >
      <MonitorSmartphone className="w-2.5 h-2.5" aria-hidden="true" />
      <span>×{n}</span>
    </span>
  );
};

// NEW (v1.0.24) P1: ключ localStorage со списком закреплённых чатов
// (JSON-массив имён в нижнем регистре).
// NEW (v1.0.30) GR: массив смешанный — имена ЛС (lowercase) и ключи групп
// 'group::<id>' (id групп уже в нижнем регистре, доп. нормализация не нужна).
const PINNED_STORAGE_KEY = 'vm_pinned';

// NEW (v1.0.24) P1: чтение списка закреплённых (приватный режим безопасен —
// любой сбой → пустой список, приложение продолжает работать).
function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

// NEW (v1.0.24) P1: запись списка закреплённых (вызывается на каждом переключении).
function writePinned(list: string[]): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // приватный режим / переполнение — молча игнорируем (персист необязателен)
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentUser,
  users,
  knownUsers = [],
  selectedUsername,
  unreadCounts,
  onSelectUser,
  onStartCall,
  onLogout,
  onOpenProfile,
  socketConnected = true,
  updateInfo = null,
  serverUrl = '',
  typingUsers = {},
  soundEnabled = true,
  onToggleSound,
  onNotify,
  // NEW (v1.0.22) N6: по умолчанию — «подключаемся» (до первого connect)
  connectionState = 'connecting',
  conversations = {},
  // NEW (v1.0.23) TH1: тема оформления
  theme = 'dark',
  onToggleTheme,
  // NEW (v1.0.29) GC: группы — все пропсы опциональны (до подключения
  // App.tsx сайдбар работает как раньше, без секции групп)
  groups = [],
  onSelectGroup,
  onRequestCreateGroup,
  selectedGroupKey = null,
}) => {
  const [search, setSearch] = useState('');
  // v1.0.13: модалка настроек сервера вместо голого prompt()
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  // NEW (v1.0.24) P1: закреплённые чаты — lowercase-имена из localStorage «vm_pinned»
  const [pinned, setPinned] = useState<string[]>(() => readPinned());
  // NEW (v1.0.24) P1: имя только что закреплённого чата — чтобы один раз проиграть
  // анимацию animate-pin-pop на иконке (снимается таймером ниже)
  const [pinPopName, setPinPopName] = useState<string | null>(null);

  // FIX: бейджи статуса встроены в сайдбар вместо fixed-оверлея,
  // который перекрывал кнопку «Позвонить»

  const handleShowUpdate = () => {
    // FIX (v1.0.21): детали обновления — тостом вместо блокирующего alert()
    const text = `🚀 Доступно обновление v${updateInfo?.latestVersion}!\n\nЧто нового:\n${
      updateInfo?.releaseNotes || 'Улучшения стабильности и звонков'
    }\n\nЧтобы обновить приложение, закройте его и запустите ярлык «Voice Launcher» на Рабочем столе (или в папке приложения).`;
    if (onNotify) onNotify(text, 'info');
  };

  const selfLower = currentUser.username.toLowerCase();

  // FIX (v1.0.21): нормализация ключей unread/typing — App ключует карты
  // по нижнему регистру, иначе бейджи и «печатает…» терялись для ников с заглавными
  const norm = (s: string) => s.trim().toLowerCase();

  // FIX (v1.0.21): «N онлайн» считает БЕЗ себя (раньше счётчик включал владельца);
  // заодно сравниваем и по имени — переживает смену socket.id сессии
  const onlineUsers = users.filter(
    u => u.id !== currentUser.id && u.username.toLowerCase() !== selfLower
  );

  // v1.0.11: офлайн-собеседники из «известных» — недавние контакты
  // NEW (v1.0.24) P1: закреплённые исключаются (они — в разделе «Закреплённые»)
  const pinnedSet = new Set(pinned);
  const onlineNames = new Set(onlineUsers.map(u => u.username.toLowerCase()));
  const offlineKnown: KnownUser[] = knownUsers
    .filter(k => k.username.toLowerCase() !== selfLower && !onlineNames.has(k.username.toLowerCase()))
    .filter(k => !pinnedSet.has(k.username.toLowerCase()))
    .filter(k => k.username.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 15);

  // NEW (v1.0.24) P1: закреплённые показываются ТОЛЬКО в разделе «Закреплённые» —
  // из онлайна они исключаются безусловно (в т.ч. во время поиска)
  const filteredOnline = onlineUsers.filter(
    u =>
      u.username.toLowerCase().includes(search.toLowerCase()) &&
      !pinnedSet.has(u.username.toLowerCase())
  );

  // v1.0.11: клик по офлайн-контакту → псевдо-User (чат работает по имени)
  const handleSelectKnown = (known: KnownUser) => {
    onSelectUser({
      id: '',
      socketId: '',
      username: known.username,
      avatar: known.avatar,
      online: false,
      inCallWith: null,
      lastSeen: known.lastSeen,
    });
  };

  // NEW (v1.0.24) P1: закрепить/открепить чат — персист в localStorage на каждом
  // переключении. При закреплении зажигаем pinPopName для анимации иконки
  // (таймер снимает только «своё» имя — безопасно при быстрых переключениях).
  // NEW (v1.0.30) GR: ключ бывает двух видов — имя ЛС (norm → lowercase) или
  // 'group::<id>' группы (id уже в нижнем регистре, norm() безопасен для обоих).
  // Единая точка входа для булавок DM-строк и строк групп; pinPopName ключуется
  // той же строкой, поэтому анимация animate-pin-pop работает и для групп.
  const handleTogglePin = (key: string) => {
    const normKey = norm(key);
    const wasPinned = pinned.includes(normKey);
    const next = wasPinned ? pinned.filter(n => n !== normKey) : [...pinned, normKey];
    setPinned(next);
    writePinned(next);
    if (!wasPinned) {
      setPinPopName(normKey);
      window.setTimeout(() => setPinPopName(cur => (cur === normKey ? null : cur)), 700);
    }
  };

  // NEW (v1.0.26) F1: синк закреплений между вкладками (storage-событие приходит
  // только в ДРУГИЕ вкладки — зацикливания нет)
  // NEW (v1.0.30) GR: массив теперь смешанный (имена ЛС + 'group::<id>') —
  // парсинг не меняется: raw.map(String) сохраняет любые строковые ключи как есть.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PINNED_STORAGE_KEY) return;
      try {
        const raw = JSON.parse(e.newValue || '[]');
        setPinned(Array.isArray(raw) ? raw.map(String) : []);
      } catch {
        // битый JSON в другой вкладке не должен ломать эту — игнорируем
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // NEW (v1.0.24) P1: строки раздела «Закреплённые» — для каждого имени из vm_pinned
  // берём: онлайн-User → псевдо-User из «известных» → синтетический офлайн-User
  // (когда пользователь исчез из БД; оригинальный регистр/аватар — из беседы).
  // Поиск применяется и к закреплённым: несовпадающее имя скрывается.
  // NEW (v1.0.30) GR: vm_pinned смешанный — здесь остаются ТОЛЬКО ключи ЛС;
  // ключи групп ('group::<id>') разбирает отдельный memo pinnedGroupList ниже
  // (иначе из ключа вышел бы мусорный «пользователь» с именем «group::…»).
  const pinnedUsers = useMemo(() => {
    if (pinned.length === 0) return [] as User[];
    const q = search.trim().toLowerCase();
    const matches = (name: string) => !q || name.toLowerCase().includes(q);
    const result: User[] = [];

    for (const name of pinned) {
      if (name === selfLower) continue; // страховка: себя не закрепляем
      // GR: ключи групп пропускаем — их строки строит pinnedGroupList
      if (name.startsWith('group::')) continue;

      const online = onlineUsers.find(u => norm(u.username) === name);
      if (online) {
        if (matches(online.username)) result.push(online);
        continue;
      }

      const known = knownUsers.find(k => norm(k.username) === name);
      if (known) {
        if (matches(known.username)) {
          result.push({
            id: '',
            socketId: '',
            username: known.username,
            avatar: known.avatar,
            online: false,
            inCallWith: null,
            lastSeen: known.lastSeen,
          });
        }
        continue;
      }

      // fallback: пользователь исчез из «известных» — синтетический офлайн-User,
      // оригинальный регистр имени ищем в истории беседы (как в глобальном поиске)
      let display = name;
      let avatar: string | undefined;
      const msgs = conversations[name];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m.senderName && norm(m.senderName) === name) {
            display = m.senderName;
            avatar = m.senderAvatar;
            break;
          }
          if (m.recipientName && norm(m.recipientName) === name) {
            display = m.recipientName;
            break;
          }
        }
      }
      if (matches(display)) {
        result.push({
          id: '',
          socketId: '',
          username: display,
          avatar,
          online: false,
          inCallWith: null,
          lastSeen: undefined,
        });
      }
    }

    return result;
  }, [pinned, search, onlineUsers, knownUsers, conversations, selfLower]);

  // NEW (v1.0.30) GR: ключи закреплённых групп — подмножество vm_pinned с
  // префиксом 'group::' (имена ЛС отфильтрованы выше, в pinnedUsers).
  const pinnedGroupKeys = useMemo(
    () => pinned.filter(k => k.startsWith('group::')),
    [pinned]
  );

  // NEW (v1.0.30) GR: закреплённые группы — ключ ищется в пропсе groups,
  // поиск по названию применяется так же, как к закреплённым пользователям.
  // Группа исчезла (удалена / пользователь вышел) → строки просто нет;
  // «мёртвый» ключ вычищается из vm_pinned эффектом ниже.
  const pinnedGroupList = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result: GroupInfo[] = [];
    for (const key of pinnedGroupKeys) {
      const group = groups.find(g => groupKeyOf(g.id) === key);
      if (group && (!q || group.name.toLowerCase().includes(q))) result.push(group);
    }
    return result;
  }, [pinnedGroupKeys, groups, search]);

  // NEW (v1.0.30) GR: чистка «мёртвых» ключей групп из vm_pinned (группа
  // удалена или пользователь из неё вышел). Гейт groups.length > 0 обязателен:
  // при старте список групп ещё не синкался с сервера (groups=[] до
  // groups:list_result) — без гейта чистка стёрла бы валидные закрепления.
  // Если ВСЕ группы исчезли, ключ безопасно не рендерится и вычистится при
  // следующем непустом синке. Смена pinned перезапускает эффект, но при
  // устранённых stale он сразу выходит — цикла нет.
  useEffect(() => {
    if (groups.length === 0) return;
    const alive = new Set(groups.map(g => groupKeyOf(g.id)));
    const stale = new Set(pinned.filter(k => k.startsWith('group::') && !alive.has(k)));
    if (stale.size === 0) return;
    const next = pinned.filter(k => !stale.has(k));
    setPinned(next);
    writePinned(next);
  }, [groups, pinned]);

  // NEW (v1.0.29) GC: мои группы, отфильтрованные поиском по названию (как
  // остальные секции — несовпадающее имя скрывает строку). Пустой groups →
  // секция «Группы» не рендерится вовсе (чистое пустое состояние).
  // NEW (v1.0.30) GR: закреплённые группы исключаются из секции — они
  // показываются выше, в разделе «Закреплённые» (как пользователи из «Онлайна»).
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pinnedKeys = new Set(pinnedGroupKeys);
    return groups
      .filter(g => !pinnedKeys.has(groupKeyOf(g.id)))
      .filter(g => (q ? g.name.toLowerCase().includes(q) : true));
  }, [groups, search, pinnedGroupKeys]);

  // NEW (v1.0.22) N2: глобальный поиск по сообщениям — до 10 бесед, в каждой
  // берём ПОСЛЕДНЕЕ совпадение по тексту. Клик открывает чат и сбрасывает поиск.
  const messageResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as Array<{
      key: string;
      name: string;
      avatar?: string;
      snippet: string;
      timeLabel: string;
      ts: number;
      user?: User;
      // NEW (v1.0.29) GC: групповой результат поиска — открыт через onSelectGroup
      group?: GroupInfo;
    }>;

    const results: Array<{
      key: string;
      name: string;
      avatar?: string;
      snippet: string;
      timeLabel: string;
      ts: number;
      user?: User;
      group?: GroupInfo;
    }> = [];

    for (const [key, msgs] of Object.entries(conversations)) {
      if (!Array.isArray(msgs) || msgs.length === 0) continue;

      // последнее совпадение по тексту в этой беседе
      let hit: ChatMessage | null = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m.deleted && (m.text || '').toLowerCase().includes(q)) {
          hit = m;
          break;
        }
      }
      if (!hit) continue;

      // NEW (v1.0.29) GC: групповая беседа — имя группы вместо ключа
      // 'group::<id>', плитка-градиент вместо аватара, клик — onSelectGroup.
      // Беседы групп, которых уже нет в пропсе groups, пропускаем.
      if (key.startsWith('group::')) {
        const group = groups.find(g => g.id === key.slice('group::'.length));
        if (!group) continue;
        results.push({
          key,
          name: group.name,
          snippet: matchSnippet(hit.text || '', q),
          timeLabel: shortTimeLabel(hit.timestamp),
          ts: hit.timestamp,
          group,
        });
        continue;
      }

      // имя собеседника в оригинальном регистре (ключ беседы — lowercase)
      let partnerName = key;
      for (const m of msgs) {
        if (m.senderName && norm(m.senderName) === key && norm(m.senderName) !== selfLower) {
          partnerName = m.senderName;
          break;
        }
        if (m.recipientName && norm(m.recipientName) === key) {
          partnerName = m.recipientName;
          break;
        }
      }

      const online = users.find(u => norm(u.username) === key);
      const known = knownUsers.find(k => norm(k.username) === key);
      const user: User = online ?? {
        id: '',
        socketId: '',
        username: known?.username ?? partnerName,
        avatar: known?.avatar ?? (norm(hit.senderName) === key ? hit.senderAvatar : undefined),
        online: false,
        inCallWith: null,
        lastSeen: known?.lastSeen,
      };

      results.push({
        key,
        name: online?.username ?? known?.username ?? partnerName,
        avatar: online?.avatar ?? user.avatar,
        snippet: matchSnippet(hit.text || '', q),
        timeLabel: shortTimeLabel(hit.timestamp),
        ts: hit.timestamp,
        user,
      });
    }

    results.sort((a, b) => b.ts - a.ts);
    return results.slice(0, 10);
  }, [search, conversations, users, knownUsers, selfLower, groups]);

  // NEW (v1.0.24) P1: наличие контактов учитывает и «Закреплённые» — иначе при
  // поиске, совпавшем только с закреплённым, показывалась бы заглушка «Никого…»
  // NEW (v1.0.29) GC: группы тоже прячут заглушку «Никого не найдено»
  // NEW (v1.0.30) GR: закреплённые группы — аналогично (только они в поиске)
  const hasAnyContacts =
    filteredOnline.length > 0 || offlineKnown.length > 0 || pinnedUsers.length > 0 || filteredGroups.length > 0 || pinnedGroupList.length > 0;

  // NEW (v1.0.26) F4: общий рендер строки-превью для разделов «Закреплённые» /
  // «Онлайн» / «Недавние» (функция, а не компонент — тип элемента стабилен,
  // лишних перемонтирований нет). Приоритет: 1) «печатает…» (разметка прежняя,
  // включая sr-only); 2) сниппет последнего сообщения + чипы реакций;
  // 3) fallback — переданное присутствие (В звонке / В сети / «был(а) в сети»).
  // Сниппет — нейтральный text-gray-500 dark:text-gray-400: читается и на
  // выбранной строке в обеих темах (NEW (v1.0.30) GR: фон выбранной строки
  // переведён с indigo на purple — упоминание обновлено). Чипы — shrink-0,
  // не ломают усечение сниппета (внутренний span truncate + min-w-0 у обёртки).
  const renderPreviewLine = (
    isTyping: boolean,
    last: ChatMessage | undefined,
    presence: React.ReactNode,
    // NEW (v1.0.29) GC: групповой режим — сниппет с префиксом «Имя: » у чужих
    groupMode = false
  ): React.ReactNode => {
    if (isTyping) {
      return (
        <div className="flex items-center gap-1 min-w-0 text-xs">
          {/* NEW (v1.0.22) P1: sr-only текст «печатает…» для скринридеров */}
          <span className="sr-only">печатает…</span>
          <span className="text-purple-400 font-medium inline-flex items-center" aria-hidden>
            печатает
            <span className="typing-dots">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
          </span>
        </div>
      );
    }

    if (last) {
      const { text, deleted } = lastMessageSnippet(last, selfLower, groupMode);
      const chips = lastMessageReactions(last);
      return (
        <div className="flex items-center gap-1 min-w-0 text-xs">
          <span className={`truncate text-gray-500 dark:text-gray-400${deleted ? ' italic' : ''}`}>
            {text}
          </span>
          {chips.length > 0 && (
            <span className="flex shrink-0 gap-1">
              {chips.map(([emoji, users]) => (
                <span
                  key={emoji}
                  className="ml-1 inline-flex items-center gap-0.5 px-1 py-px rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-600 dark:text-purple-300 text-[10px] leading-none"
                >
                  {emoji}
                  <span>×{users.length}</span>
                </span>
              ))}
            </span>
          )}
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1 min-w-0 text-xs">
        {presence}
      </div>
    );
  };

  // NEW (v1.0.29) GC: плитка-«аватар» группы — градиент по хешу id + белая
  // иконка Users + мини-бейдж числа участников («99+» у больших групп).
  // 'md' — строки секции «Группы», 'sm' — результаты глобального поиска.
  const renderGroupTile = (group: GroupInfo, size: 'sm' | 'md'): React.ReactNode => {
    const tileCls = size === 'md' ? 'w-10 h-10 rounded-xl' : 'w-8 h-8 rounded-lg';
    const iconCls = size === 'md' ? 'w-[18px] h-[18px]' : 'w-3.5 h-3.5';
    const n = Array.isArray(group.members) ? group.members.length : 0;
    return (
      <div className="relative shrink-0">
        <div
          className={`${tileCls} bg-gradient-to-br ${groupTileGradient(group.id)} flex items-center justify-center shadow-sm shadow-purple-500/20 ring-1 ring-white/15`}
        >
          <Users className={`${iconCls} text-white`} aria-hidden="true" />
        </div>
        {n > 0 && (
          <span
            title={membersLabel(n)}
            className="absolute -bottom-1 -right-1 px-1 py-px rounded-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-[9px] font-semibold text-gray-600 dark:text-gray-300 leading-none"
          >
            {n <= 99 ? n : '99+'}
          </span>
        )}
      </div>
    );
  };

  return (
    // FIX (v1.0.21): мобильный режим — на узких экранах список скрывается, когда открыт чат
    <div
      className={[
        'h-full bg-gray-100/80 dark:bg-gray-950/80 border-r border-gray-200/80 dark:border-gray-800/80 flex-col backdrop-blur-xl shrink-0',
        'w-full md:w-80',
        selectedUsername ? 'hidden md:flex' : 'flex',
      ].join(' ')}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200/80 dark:border-gray-800/80">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            {/* NEW (v1.0.28) S: лёгкий диагональный градиент плитки логотипа (обе темы) */}
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 border border-purple-500/30 overflow-hidden flex items-center justify-center shadow-lg shadow-purple-500/10 shrink-0">
              <img
                src="/icon.png"
                alt="VoiceChat Logo"
                className="w-full h-full object-cover"
                onError={e => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
              />
            </div>
            <div>
              {/* NEW (v1.0.28) S: фирменный градиент логотипа (purple→fuchsia,
                  в тёмной — светлее 400-е тона) */}
              <h1 className="font-bold text-base bg-gradient-to-r from-purple-600 to-fuchsia-600 dark:from-purple-400 dark:to-fuchsia-400 bg-clip-text text-transparent tracking-tight leading-none">
                VoiceChat
              </h1>
              {/* FIX (v1.0.22) F2: версия клиента */}
              {/* NEW (v1.0.27): обновлено на 1.0.27 (раунд мульти-сессий: бейдж «N окон» у онлайн-пользователей) */}
              {/* NEW (v1.0.28) S: версия — пилюля с рамкой и мягким фоном вместо голого текста; 1.0.28 (AI-раунд 2: переводчик + настройки AI) */}
              {/* NEW (v1.0.29) GC: 1.0.29 (групповые чаты: секция «Группы», создание групп, поиск по групповым беседам) */}
              {/* NEW (v1.0.30) GR: 1.0.30 (закрепление групп: булавки на строках групп, закреплённые группы в разделе «Закреплённые», фиолетовая подсветка выбранных строк) */}
              <span className="inline-flex items-center px-1.5 py-px mt-0.5 rounded-full bg-purple-500/10 border border-purple-500/25 text-purple-600 dark:text-purple-300 text-[10px] font-mono leading-none">
                v1.0.30
              </span>
              {/* NEW (v1.0.22) N6: индикатор соединения с сервером
                  (точка 8px + подпись, цвет по состоянию) */}
              {/* NEW (v1.0.28) S: стеклянная пилюля (blur + рамка) + свечение
                  онлайн-точки (arbitrary shadow) */}
              <div className="inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full bg-gray-200/60 dark:bg-gray-800/60 border border-gray-300/60 dark:border-gray-700/60 backdrop-blur-sm" title="Состояние соединения с сервером">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    connectionState === 'online'
                      ? 'bg-emerald-400 animate-online-pulse shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                      : connectionState === 'offline'
                      ? 'bg-red-400'
                      : 'bg-amber-400 animate-pulse'
                  }`}
                />
                <span
                  className={`text-[10px] leading-none whitespace-nowrap ${
                    connectionState === 'online'
                      ? 'text-emerald-400'
                      : connectionState === 'offline'
                      ? 'text-red-400'
                      : 'text-amber-400'
                  }`}
                >
                  {connectionState === 'online'
                    ? 'В сети'
                    : connectionState === 'reconnecting'
                    ? 'Переподключение…'
                    : connectionState === 'connecting'
                    ? 'Подключение…'
                    : 'Нет связи'}
                </span>
              </div>
            </div>
          </div>
          {/* NEW (v1.0.28) S: чип «N онлайн» — полупрозрачный фон + blur + лёгкая тень */}
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-800 rounded-full text-xs text-gray-600 dark:text-gray-400 font-medium backdrop-blur-sm shadow-sm">
            {/* NEW (v1.0.27) S: мягкий пульс онлайн-точек (animate-online-pulse, index.css) */}
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-online-pulse" />
            {/* FIX (v1.0.21): считаем онлайн-собеседников, а не всех подряд (без себя) */}
            {onlineUsers.length} онлайн
          </span>
        </div>

        {/* Search */}
        {/* NEW (v1.0.28) S: фиолетовый фокус-глоу поиска — кольцо ring-2 + мягкое
            свечение (arbitrary shadow) + hover-бордер + подсветка иконки через
            group-focus-within (был узкий indigo-ring); иконка уже была внутри */}
        <div className="relative group">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500 transition-colors group-focus-within:text-purple-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск…"
            className="w-full pl-9 pr-9 py-2 bg-gray-50/90 dark:bg-gray-900/90 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500/50 focus:shadow-[0_0_0_4px_rgba(168,85,247,0.12)] transition-all"
          />
          {/* NEW (v1.0.22) N2: крестик очищает поиск (в т.ч. результаты по сообщениям) */}
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              title="Очистить поиск"
              aria-label="Очистить поиск"
              className="absolute right-2 top-1.5 p-1 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
            >
              <span className="text-base leading-none" aria-hidden>×</span>
            </button>
          )}
        </div>

        {/* FIX: Status & update badges — встроены в сайдбар, не перекрывают кнопки */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button
            type="button"
            onClick={() => setIsServerModalOpen(true)}
            title="Кликните, чтобы настроить адрес сервера (например, IP друга по локальной сети)"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium cursor-pointer hover:scale-105 active:scale-95 transition-all ${
              socketConnected
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                socketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
              }`}
            />
            {socketConnected ? 'Сервер подключен' : 'Настроить сервер'}
          </button>

          {updateInfo?.available && (
            <button
              type="button"
              onClick={handleShowUpdate}
              title="Нажмите для подробностей об обновлении"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 transition-all cursor-pointer animate-pulse"
            >
              <span>🚀 Обновление v{updateInfo.latestVersion}!</span>
            </button>
          )}

          {onToggleSound && (
            <button
              type="button"
              onClick={onToggleSound}
              title={soundEnabled ? 'Выключить звук уведомлений' : 'Включить звук уведомлений'}
              className={`inline-flex items-center justify-center w-6 h-6 rounded-full border cursor-pointer transition-all hover:scale-110 active:scale-95 ${
                soundEnabled
                  ? 'bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-700 hover:text-emerald-400'
                  : 'bg-white/60 dark:bg-gray-800/60 text-gray-400 dark:text-gray-600 border-gray-200 dark:border-gray-800 hover:text-gray-600 dark:hover:text-gray-400'
              }`}
            >
              {soundEnabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
            </button>
          )}

          {/* NEW (v1.0.23) TH1: переключатель темы (Sun/Moon). Классы сразу
              двухтемные — остальную часть сайдбара конвертирует отдельный шаг. */}
          {onToggleTheme && (
            <button
              type="button"
              onClick={onToggleTheme}
              title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
              aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full border cursor-pointer transition-all hover:scale-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none bg-gray-200/60 dark:bg-gray-800/60 text-amber-500 dark:text-gray-400 border-gray-300 dark:border-gray-700 dark:hover:text-amber-300 hover:text-amber-600"
            >
              {theme === 'dark' ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Users List */}
      {/* NEW (v1.0.28) S: существующий .custom-scrollbar (index.css, 6px rounded) — аккуратный скролл списка */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {/* NEW (v1.0.22) N2: если по имени никого не нашлось, но есть совпадения
            в сообщениях — показываем их вместо заглушки «Никого не найдено» */}
        {!hasAnyContacts && messageResults.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4 text-gray-500">
            {/* NEW (v1.0.28) S: плитка-подложка под иконку пустого состояния (как у булавки секции) */}
            <div className="w-14 h-14 mb-3 rounded-2xl bg-gray-200/60 dark:bg-gray-800/60 border border-gray-300/50 dark:border-gray-700/50 flex items-center justify-center shadow-sm">
              <Users className="w-7 h-7 stroke-[1.5] text-gray-400 dark:text-gray-600" />
            </div>
            <p className="text-sm font-medium">
              {search ? 'Никого не найдено' : 'Пока никого нет в сети'}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">
              Откройте мессенджер во второй вкладке, чтобы протестировать чат и звонок!
            </p>
          </div>
        ) : (
          <>
            {/* ─── NEW (v1.0.24) P1: Закреплённые ───
                NEW (v1.0.30) GR: раздел показывает и закреплённые группы —
                порядок простой: сначала пользователи, затем группы. */}
            {(pinnedUsers.length > 0 || pinnedGroupList.length > 0) && (
              <>
                <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                  {/* NEW (v1.0.25) S1: плитка-подложка под иконкой булавки — раздел
                      «Закреплённые» читается как визуальный якорь; purple-акцент
                      одинаков в светлой и тёмной темах */}
                  <span className="w-5 h-5 rounded-md bg-purple-500/15 border border-purple-500/25 flex items-center justify-center">
                    <Pin className="w-3 h-3 text-purple-400" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                    Закреплённые
                  </span>
                  {/* NEW (v1.0.28) S: волосяная градиентная линия до края секции */}
                  <span className="h-px flex-1 bg-gradient-to-r from-purple-500/40 to-transparent" aria-hidden="true" />
                </div>
                {pinnedUsers.map(user => {
                  const key = norm(user.username);
                  const isSelected = user.username === selectedUsername;
                  const unread = unreadCounts[key] || 0;
                  const inCall = !!user.inCallWith;
                  const isTyping = !!typingUsers[key];
                  // NEW (v1.0.26) F4: последнее сообщение — превью строки + метка времени справа
                  const lastMsg = lastMessageOf(conversations, key);
                  // анимация «прикола» — только в момент закрепления (см. handleTogglePin)
                  const popNow = pinPopName === key;

                  // NEW (v1.0.30) GR: подсветка выбранной строки — фиолетовая
                  // (была indigo-600/20): единый акцент с групповыми строками, обе темы
                  return (
                    <div
                      key={`pin_${key}`}
                      onClick={() => onSelectUser(user)}
                      title={
                        user.online
                          ? undefined
                          : `${user.username} сейчас офлайн — сообщение будет доставлено, когда он(а) зайдёт`
                      }
                      className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-purple-600/20 border border-purple-500/30 text-purple-700 dark:text-white'
                          : 'hover:bg-gray-200/70 dark:hover:bg-gray-900/70 border border-transparent text-gray-700 dark:text-gray-300 md:hover:shadow-sm md:hover:-translate-y-px'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {/* NEW (v1.0.28) S: изумрудное кольцо у онлайн-аватаров закреплённых */}
                        <Avatar
                          src={user.avatar}
                          name={user.username}
                          status={user.online ? (inCall ? 'busy' : 'online') : 'offline'}
                          size="md"
                          className={user.online ? 'ring-2 ring-emerald-500/60' : undefined}
                        />

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate text-gray-900 dark:text-white">
                              {user.username}
                            </span>
                            {/* NEW (v1.0.27) MS: бейдж мульти-сессии (только при sessions > 1) */}
                            {sessionsBadge(user)}
                          </div>
                          {/* NEW (v1.0.26) F4: превью последнего сообщения (или статус-присутствие) */}
                          {renderPreviewLine(
                            isTyping,
                            lastMsg,
                            user.online ? (
                              inCall ? (
                                <span className="text-amber-400">В звонке</span>
                              ) : (
                                <span className="text-emerald-500/90">В сети</span>
                              )
                            ) : (
                              <span className="text-gray-500">{formatLastSeen(user.lastSeen)}</span>
                            )
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* F4: метка времени последнего сообщения (до бейджа непрочитанных) */}
                        {lastMsg && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                            {shortTimeLabel(lastMsg.timestamp)}
                          </span>
                        )}
                        {/* NEW (v1.0.28) S: бейдж непрочитанных — градиент purple→fuchsia,
                            min-w под двузначные счётчики + цветная тень */}
                        {unread > 0 && (
                          <span className="min-w-[1.4rem] text-center px-1.5 py-0.5 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-[11px] font-bold rounded-full animate-pop-badge shadow-sm shadow-purple-600/30">
                            {unread}
                          </span>
                        )}

                        {user.online && (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              onStartCall(user);
                            }}
                            title={`Позвонить ${user.username}`}
                            className="p-2 rounded-lg bg-white/80 dark:bg-gray-800/80 hover:bg-emerald-600 text-gray-700 dark:text-gray-300 hover:text-white transition-all transform active:scale-95"
                          >
                            <Phone className="w-4 h-4" />
                          </button>
                        )}

                        {/* NEW (v1.0.24) P1: открепить (виден на hover, на тач — полупрозрачный) */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleTogglePin(user.username);
                          }}
                          title="Открепить чат"
                          aria-label="Открепить чат"
                          className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500 hover:border-purple-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100"
                        >
                          <PinOff
                            className={`w-3.5 h-3.5 ${popNow ? 'animate-pin-pop' : ''}`}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* NEW (v1.0.30) GR: закреплённые группы — ПОСЛЕ пользователей
                    (простой предсказуемый порядок). Строки зеркалят строки секции
                    «Группы»: плитка-градиент, имя, превью («Имя: » у чужих /
                    «Вы: » у своих / «N участников»), время, бейдж непрочитанных,
                    акцент-полоса выбранной и кнопка открепления (снимает ключ
                    'group::<id>' из vm_pinned — единая точка handleTogglePin). */}
                {pinnedGroupList.map(group => {
                  const gkey = groupKeyOf(group.id);
                  const isSelected = selectedGroupKey === gkey;
                  const unread = unreadCounts[gkey] || 0;
                  const isTyping = !!typingUsers[gkey];
                  const lastMsg = lastMessageOf(conversations, gkey);
                  const memberCount = Array.isArray(group.members) ? group.members.length : 0;
                  // анимация «прикола» булавки — в момент закрепления группы
                  const popNow = pinPopName === gkey;

                  return (
                    <div
                      key={`pin_${gkey}`}
                      onClick={() => onSelectGroup?.(group)}
                      title={`Группа «${group.name}» — ${membersLabel(memberCount)}`}
                      className={`group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-purple-600/20 border border-purple-500/30 text-purple-700 dark:text-white'
                          : 'hover:bg-gray-200/70 dark:hover:bg-gray-900/70 border border-transparent text-gray-700 dark:text-gray-300 md:hover:shadow-sm md:hover:-translate-y-px'
                      } active:scale-[0.98]`}
                    >
                      {/* GR: акцент-полоса выбранной закреплённой группы —
                          тот же градиентный маркер, что в секции «Группы» */}
                      {isSelected && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-gradient-to-b from-purple-500 to-fuchsia-500"
                        />
                      )}
                      <div className="flex items-center gap-3 min-w-0">
                        {renderGroupTile(group, 'md')}
                        <div className="min-w-0">
                          <span className="font-medium text-sm truncate text-gray-900 dark:text-white block">
                            {group.name}
                          </span>
                          {/* GR: превью — «печатает…» → последнее сообщение → «N участников» */}
                          {renderPreviewLine(
                            isTyping,
                            lastMsg,
                            <span className="text-gray-500 dark:text-gray-400">{membersLabel(memberCount)}</span>,
                            true
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* GR: метка времени последнего сообщения (до бейджа) */}
                        {lastMsg && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                            {shortTimeLabel(lastMsg.timestamp)}
                          </span>
                        )}
                        {/* GR: бейдж непрочитанных — тот же градиент, что у DM-строк */}
                        {unread > 0 && (
                          <span className="min-w-[1.4rem] text-center px-1.5 py-0.5 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-[11px] font-bold rounded-full animate-pop-badge shadow-sm shadow-purple-600/30">
                            {unread}
                          </span>
                        )}

                        {/* GR: открепить группу (та же булавка, что у DM-строк) */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleTogglePin(gkey);
                          }}
                          title="Открепить группу"
                          aria-label="Открепить группу"
                          className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500 hover:border-purple-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100"
                        >
                          <PinOff
                            className={`w-3.5 h-3.5 ${popNow ? 'animate-pin-pop' : ''}`}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {/* ─── NEW (v1.0.29) GC: Группы (между «Закреплёнными» и «Онлайном») ───
                Секция рендерится ТОЛЬКО когда есть группы (после фильтра поиска);
                при нуле групп создание доступно через пунктирную строку в конце
                списка. Строки зеркалят DM-строки: плитка-градиент, имя, превью
                последнего сообщения («Имя: » у чужих), бейдж непрочитанных.
                NEW (v1.0.30) GR: у каждой строки — булавка закрепления
                (закреплённые группы исключены из секции — см. filteredGroups). */}
            {filteredGroups.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                  <span className="w-5 h-5 rounded-md bg-purple-500/15 border border-purple-500/25 flex items-center justify-center">
                    <Users className="w-3 h-3 text-purple-400" />
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                    Группы
                  </span>
                  {/* NEW (v1.0.28) S: волосяная градиентная линия до края секции */}
                  <span className="h-px flex-1 bg-gradient-to-r from-purple-500/40 to-transparent" aria-hidden="true" />
                  {/* GC: «+» — создать группу (модалку рендерит App.tsx) */}
                  <button
                    type="button"
                    onClick={() => onRequestCreateGroup?.()}
                    title="Создать группу"
                    aria-label="Создать группу"
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-purple-600 dark:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 transition-colors shrink-0"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                {filteredGroups.map(group => {
                  const key = groupKeyOf(group.id);
                  const isSelected = selectedGroupKey === key;
                  const unread = unreadCounts[key] || 0;
                  const isTyping = !!typingUsers[key];
                  // GC: последнее сообщение групповой беседы (ключ 'group::<id>')
                  const lastMsg = lastMessageOf(conversations, key);
                  const memberCount = Array.isArray(group.members) ? group.members.length : 0;

                  return (
                    <div
                      key={`group_${group.id}`}
                      onClick={() => onSelectGroup?.(group)}
                      title={`Группа «${group.name}» — ${membersLabel(memberCount)}`}
                      className={`group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-purple-600/20 border border-purple-500/30 text-purple-700 dark:text-white'
                          : 'hover:bg-gray-200/70 dark:hover:bg-gray-900/70 border border-transparent text-gray-700 dark:text-gray-300 md:hover:shadow-sm md:hover:-translate-y-px'
                      } active:scale-[0.98]`}
                    >
                      {/* NEW (v1.0.30) GR: акцент-полоса выбранной группы —
                          градиентный маркер поверх фона purple-600/20 (обе темы);
                          border-лосу с градиентом в Tailwind не сделать — span */}
                      {isSelected && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-gradient-to-b from-purple-500 to-fuchsia-500"
                        />
                      )}
                      <div className="flex items-center gap-3 min-w-0">
                        {renderGroupTile(group, 'md')}
                        <div className="min-w-0">
                          <span className="font-medium text-sm truncate text-gray-900 dark:text-white block">
                            {group.name}
                          </span>
                          {/* GC: превью — «печатает…» → последнее сообщение
                              (с префиксом «Имя: » у чужих) → «N участников» */}
                          {renderPreviewLine(
                            isTyping,
                            lastMsg,
                            <span className="text-gray-500 dark:text-gray-400">{membersLabel(memberCount)}</span>,
                            true
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* GC: метка времени последнего сообщения (до бейджа) */}
                        {lastMsg && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                            {shortTimeLabel(lastMsg.timestamp)}
                          </span>
                        )}
                        {/* GC: бейдж непрочитанных — тот же градиент, что у DM-строк */}
                        {unread > 0 && (
                          <span className="min-w-[1.4rem] text-center px-1.5 py-0.5 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-[11px] font-bold rounded-full animate-pop-badge shadow-sm shadow-purple-600/30">
                            {unread}
                          </span>
                        )}
                        {/* NEW (v1.0.30) GR: закрепить группу — та же булавка, что у
                            DM-строк (ограничение v1.0.29 снято). Закреплённые
                            исключены из filteredGroups, поэтому здесь всегда
                            «закрепить»; звонков из строки группы по-прежнему нет */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleTogglePin(groupKeyOf(group.id));
                          }}
                          title="Закрепить группу"
                          aria-label="Закрепить группу"
                          className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500 hover:border-purple-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100"
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {/* ─── Онлайн ─── */}
            {filteredOnline.map(user => {
              const isSelected = user.username === selectedUsername;
              // FIX v1.0.11: непрочитанные ключуются по ИМЕНИ (как в App), а не по socket.id
              // FIX (v1.0.21): имя — в нижнем регистре (ключи App нормализованы)
              const unread = unreadCounts[norm(user.username)] || 0;
              const inCall = !!user.inCallWith;
              // NEW (v1.0.26) F4: ключ беседы + «печатает…» + последнее сообщение
              // (превью строки + метка времени справа)
              const key = norm(user.username);
              const isTyping = !!typingUsers[key];
              const lastMsg = lastMessageOf(conversations, key);

              return (
                // NEW (v1.0.25) S1: лёгкий лифт строк на hover — только desktop
                // (md:): тень + подъём на 1px; применён к строкам закреплённых,
                // онлайн и недавних (существующие hover-фоны не конфликтуют)
                // NEW (v1.0.30) GR: подсветка выбранной строки — фиолетовая
                // (была indigo-600/20), в тон закреплённым и групповым строкам
                <div
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-purple-600/20 border border-purple-500/30 text-purple-700 dark:text-white'
                      : 'hover:bg-gray-200/70 dark:hover:bg-gray-900/70 border border-transparent text-gray-700 dark:text-gray-300 md:hover:shadow-sm md:hover:-translate-y-px'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* NEW (v1.0.28) S: изумрудное кольцо у онлайн-аватаров */}
                    <Avatar
                      src={user.avatar}
                      name={user.username}
                      status={inCall ? 'busy' : 'online'}
                      size="md"
                      className="ring-2 ring-emerald-500/60"
                    />

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate text-gray-900 dark:text-white">
                          {user.username}
                        </span>
                        {/* NEW (v1.0.27) MS: бейдж мульти-сессии (только при sessions > 1) */}
                        {sessionsBadge(user)}
                      </div>
                      {/* NEW (v1.0.26) F4: превью последнего сообщения (или статус-присутствие) */}
                      {renderPreviewLine(
                        isTyping,
                        lastMsg,
                        inCall ? (
                          <span className="text-amber-400">В звонке</span>
                        ) : (
                          <span className="text-emerald-500/90">В сети</span>
                        )
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* F4: метка времени последнего сообщения (до бейджа непрочитанных) */}
                    {lastMsg && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                        {shortTimeLabel(lastMsg.timestamp)}
                      </span>
                    )}
                    {/* NEW (v1.0.28) S: бейдж непрочитанных — градиент purple→fuchsia,
                        min-w под двузначные счётчики + цветная тень */}
                    {unread > 0 && (
                      <span className="min-w-[1.4rem] text-center px-1.5 py-0.5 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-[11px] font-bold rounded-full animate-pop-badge shadow-sm shadow-purple-600/30">
                        {unread}
                      </span>
                    )}

                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onStartCall(user);
                      }}
                      title={`Позвонить ${user.username}`}
                      className="p-2 rounded-lg bg-white/80 dark:bg-gray-800/80 hover:bg-emerald-600 text-gray-700 dark:text-gray-300 hover:text-white transition-all transform active:scale-95"
                    >
                      <Phone className="w-4 h-4" />
                    </button>

                    {/* NEW (v1.0.24) P1: закрепить чат (виден на hover, на тач — полупрозрачный) */}
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        handleTogglePin(user.username);
                      }}
                      title={pinnedSet.has(norm(user.username)) ? 'Открепить чат' : 'Закрепить чат'}
                      aria-label={pinnedSet.has(norm(user.username)) ? 'Открепить чат' : 'Закрепить чат'}
                      className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500 hover:border-purple-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100"
                    >
                      {pinnedSet.has(norm(user.username)) ? (
                        <PinOff className="w-3.5 h-3.5" />
                      ) : (
                        <Pin className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ─── v1.0.11: Недавние (офлайн) ─── */}
            {offlineKnown.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                  <Clock className="w-3 h-3 text-gray-400 dark:text-gray-600" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                    Недавние · не в сети
                  </span>
                  {/* NEW (v1.0.28) S: волосяная градиентная линия до края секции */}
                  <span className="h-px flex-1 bg-gradient-to-r from-purple-500/40 to-transparent" aria-hidden="true" />
                </div>
                {offlineKnown.map(known => {
                  const isSelected = known.username === selectedUsername;
                  // FIX (v1.0.21): ключ непрочитанных — в нижнем регистре (как в App)
                  const unread = unreadCounts[norm(known.username)] || 0;
                  // NEW (v1.0.26) F4: ключ беседы + «печатает…» + последнее сообщение
                  // (превью строки + метка времени справа)
                  const key = norm(known.username);
                  const isTyping = !!typingUsers[key];
                  const lastMsg = lastMessageOf(conversations, key);

                  return (
                    <div
                      key={known.username}
                      onClick={() => handleSelectKnown(known)}
                      title={`${known.username} сейчас офлайн — сообщение будет доставлено, когда он(а) зайдёт`}
                      className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-white/60 dark:bg-gray-800/60 border border-gray-300/60 dark:border-gray-700/60 text-gray-900 dark:text-white'
                          : 'hover:bg-gray-200/50 dark:hover:bg-gray-900/50 border border-transparent text-gray-600 dark:text-gray-400 md:hover:shadow-sm md:hover:-translate-y-px'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 opacity-80 hover:opacity-100 transition-opacity">
                        <Avatar
                          src={known.avatar}
                          name={known.username}
                          status="offline"
                          size="md"
                        />
                        <div className="min-w-0">
                          <span className="font-medium text-sm truncate text-gray-700 dark:text-gray-300 block">
                            {known.username}
                          </span>
                          {/* NEW (v1.0.26) F4: превью последнего сообщения (или «был(а) в сети»);
                              прежняя строка была text-[11px] — теперь единый text-xs, как
                              у остальных строк (было 11px, отклонение задокументировано) */}
                          {renderPreviewLine(
                            isTyping,
                            lastMsg,
                            <span className="text-gray-500">{formatLastSeen(known.lastSeen)}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* F4: метка времени последнего сообщения (до бейджа непрочитанных) */}
                        {lastMsg && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                            {shortTimeLabel(lastMsg.timestamp)}
                          </span>
                        )}
                        {/* NEW (v1.0.28) S: серый бейдж офлайн-строк — тот же min-w/центрирование */}
                        {unread > 0 && (
                          <span className="min-w-[1.4rem] text-center px-1.5 py-0.5 bg-gray-300 dark:bg-gray-700 text-gray-800 dark:text-gray-200 text-[11px] font-bold rounded-full animate-pop-badge shadow-sm">
                            {unread}
                          </span>
                        )}

                        {/* NEW (v1.0.24) P1: закрепить офлайн-чат (виден на hover, на тач — полупрозрачный) */}
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            handleTogglePin(known.username);
                          }}
                          title={pinnedSet.has(norm(known.username)) ? 'Открепить чат' : 'Закрепить чат'}
                          aria-label={pinnedSet.has(norm(known.username)) ? 'Открепить чат' : 'Закрепить чат'}
                          className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-purple-500 hover:border-purple-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100"
                        >
                          {pinnedSet.has(norm(known.username)) ? (
                            <PinOff className="w-3.5 h-3.5" />
                          ) : (
                            <Pin className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {/* NEW (v1.0.22) N2: глобальный поиск — блок «Сообщения» (до 10 бесед,
            последняя совпадающая фраза в каждой). Клик — открыть чат и сбросить поиск */}
        {search.trim() !== '' && messageResults.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
              <MessageCircle className="w-3 h-3 text-gray-400 dark:text-gray-600" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                Сообщения
              </span>
              {/* NEW (v1.0.28) S: волосяная градиентная линия до края секции */}
              <span className="h-px flex-1 bg-gradient-to-r from-purple-500/40 to-transparent" aria-hidden="true" />
            </div>
            {messageResults.map(result => (
              // NEW (v1.0.27) S: единый hover-лифт с остальными строками (тень + 1px, desktop)
              <div
                key={`msg_${result.key}`}
                onClick={() => {
                  // NEW (v1.0.29) GC: групповой результат — открываем группу
                  if (result.group) {
                    onSelectGroup?.(result.group);
                  } else if (result.user) {
                    onSelectUser(result.user);
                  }
                  setSearch('');
                }}
                title={result.group ? `Открыть группу «${result.name}»` : `Открыть чат с ${result.name}`}
                className="group flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-gray-200/70 dark:hover:bg-gray-900/70 border border-transparent hover:border-gray-200 dark:hover:border-gray-800 text-gray-700 dark:text-gray-300 transition-all md:hover:shadow-sm md:hover:-translate-y-px"
              >
                {/* GC: группам — плитка-градиент вместо аватара-инициалов */}
                {result.group ? (
                  renderGroupTile(result.group, 'sm')
                ) : (
                  <Avatar
                    src={result.avatar}
                    name={result.name}
                    size="sm"
                    className="shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-sm truncate text-gray-900 dark:text-white">
                      {result.name}
                    </span>
                    <span className="text-[10px] text-gray-500 shrink-0 tabular-nums">
                      {result.timeLabel}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
                    {result.snippet}
                  </p>
                </div>
              </div>
            ))}
          </>
        )}

        {/* NEW (v1.0.29) GC: универсальная точка входа «Создать группу» — пунктирная
            строка в самом конце списка контактов. Видна ВСЕГДА: и пока групп нет
            (секция «Группы» не рендерится), и когда группы уже есть (тогда у неё
            есть дубль-кнопка «+» в заголовке секции) — создание доступно в любой
            момент. Оба входа вызывают onRequestCreateGroup (модалку рендерит App). */}
        {/* NEW (v1.0.30) GR: полировка строки — hover-лифт как у остальных строк
            (тень + 1px, только desktop) и лёгкий активный масштаб-отклик */}
        <button
          type="button"
          onClick={() => onRequestCreateGroup?.()}
          title="Создать группу"
          aria-label="Создать группу"
          className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-dashed border-purple-500/30 hover:border-purple-500/60 hover:bg-purple-500/5 dark:hover:bg-purple-500/10 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-300 transition-all cursor-pointer group md:hover:shadow-sm md:hover:-translate-y-px active:scale-[0.99]"
        >
          <span className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center shrink-0 transition-colors group-hover:bg-purple-500/20">
            <UsersRound className="w-4 h-4" />
          </span>
          <span className="text-xs font-medium text-left">Создать группу</span>
        </button>
      </div>

      {/* v1.0.13: модалка настроек сервера (LAN-ссылки для друга, смена адреса) */}
      <ServerSettingsModal
        isOpen={isServerModalOpen}
        currentServerUrl={serverUrl}
        socketConnected={socketConnected}
        onClose={() => setIsServerModalOpen(false)}
      />

      {/* Current User Card */}
      <div
        onClick={onOpenProfile}
        className="p-3 border-t border-gray-200/80 dark:border-gray-800/80 bg-gray-50/40 dark:bg-gray-900/40 hover:bg-gray-200/80 dark:hover:bg-gray-900/80 cursor-pointer flex items-center justify-between group transition-all"
        title="Нажмите, чтобы настроить аватарку и профиль"
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* NEW (v1.0.28) S: градиентное кольцо аватара своей карточки
              (тот же purple→fuchsia→amber, что в модалке профиля) */}
          <div className="relative shrink-0 p-[2px] rounded-full bg-gradient-to-tr from-purple-500 via-fuchsia-500 to-amber-500">
            <Avatar
              src={currentUser.avatar}
              name={currentUser.username}
              online={true}
              size="md"
            />
            <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-[11px] text-white backdrop-blur-[1px]">
              <Settings className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h4 className="font-semibold text-sm text-gray-900 dark:text-white truncate">
                {currentUser.username}
              </h4>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 group-hover:text-purple-600 dark:group-hover:text-purple-300 transition-colors">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 group-hover:bg-purple-400 animate-online-pulse" />
              <span className="group-hover:hidden">Вы в сети</span>
              <span className="hidden group-hover:inline">Сменить аватар</span>
            </div>
          </div>
        </div>

        <button
          onClick={e => {
            e.stopPropagation();
            onLogout();
          }}
          title="Сменить ник / Выйти"
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-red-400 transition-colors shrink-0"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
