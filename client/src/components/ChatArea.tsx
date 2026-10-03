/* NEW (v1.0.23) TH2: двухтемная конвертация — базовое (светлое) значение без
   префикса, прежнее тёмное — под dark: (тёмный вид не изменён ни на пиксель).
   Акценты (purple/indigo/emerald/rose/amber/градиенты, bg-black-оверлеи,
   тени) не тронуты. */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type {
  User, ChatMessage, ActiveCall, MessageType, ReplyMeta,
  // NEW (v1.0.28) AI: переводы сообщений + настройки AI-функций (типы — в types.ts)
  AiSettings, AiTranslationState, AiTranslateTarget,
  // NEW (v1.0.29) GC: слепок активной группы (recipient.isGroup — синтетический User)
  GroupInfo,
} from '../types.js';
import {
  Send, Phone, MessageSquareText, Shield, Image as ImageIcon, Mic, X, Smile,
  Check, CheckCheck, CornerUpLeft, Trash2, Search, Ban, ChevronUp, ChevronDown,
  Forward, Copy, ArrowDown, ArrowLeft, Pencil,
  // NEW (v1.0.25) R1/F2: SmilePlus — кнопка реакций; Bell/BellOff — «без звука» в чате
  SmilePlus, Bell, BellOff,
  // NEW (v1.0.26) F2: Download — экспорт переписки в .txt
  Download,
  // NEW (v1.0.27) AI: Sparkles — подсказки ответов; FileText — сводка переписки (LLM)
  Sparkles, FileText,
  // NEW (v1.0.28) AI: Languages — перевод сообщений; Settings2 — настройки AI;
  // Loader2 — спиннер запроса перевода в ряду действий сообщения
  Languages, Settings2, Loader2,
  // NEW (v1.0.29) GC: Users — плитка группы в шапке/пустом состоянии;
  // UsersRound — кнопка управления группой в шапке (вместо звонка)
  Users, UsersRound,
} from 'lucide-react';
import { AudioMessagePlayer } from './AudioMessagePlayer.js';
import { VoiceRecorder } from './VoiceRecorder.js';
import { Avatar } from './Avatar.js';
import { compressImage } from '../utils/imageCompressor.js';
import { formatDayLabel, formatLastSeen } from '../utils/format.js';

interface ChatAreaProps {
  currentUser: User;
  recipient: User | null;
  messages: ChatMessage[];
  activeCall: ActiveCall | null;
  onSendMessage: (payload: {
    text?: string;
    mediaUrl?: string;
    mediaType?: MessageType;
    duration?: number;
    replyTo?: ReplyMeta;
  }) => void;
  onStartCall: (user: User) => void;
  /** v1.0.11: удалить своё сообщение */
  onDeleteMessage?: (messageId: string) => void;
  /** NEW (v1.0.24) E1: отредактировать своё сообщение (id + новый текст) */
  onEditMessage?: (messageId: string, text: string) => void;
  /** NEW (v1.0.24) S1: история беседы ещё грузится с сервера — показываем скелетоны */
  isHistoryLoading?: boolean;
  /** v1.0.12: переслать сообщение другому контакту */
  onRequestForward?: (message: ChatMessage) => void;
  /** NEW (v1.0.25) R1: поставить/снять свою реакцию на сообщение (emoji из REACTION_EMOJIS) */
  onReactMessage?: (messageId: string, emoji: string) => void;
  /** NEW (v1.0.25) F2: этот чат заглушён (без звука уведомлений) */
  isChatMuted?: boolean;
  /** NEW (v1.0.25) F2: переключить «без звука» для этого чата */
  onToggleMute?: () => void;
  isPartnerTyping?: boolean;
  onTyping?: (recipientId: string, isTyping: boolean) => void;
  /** FIX (v1.0.21): тосты ошибок вместо блокирующих alert() */
  onNotify?: (text: string, kind?: 'info' | 'error' | 'success') => void;
  /** FIX (v1.0.21): мобильный режим — «назад к списку собеседников» */
  onBack?: () => void;
  // NEW (v1.0.27) AI: подсказки ответов и сводка переписки (LLM на сервере;
  // сокеты и состояние — в App.tsx, здесь только UI). Пропсы опциональные с
  // дефолтами — паттерн onReactMessage (v1.0.25): пока App.tsx не пробрасывает
  // их, tsc зелёный и «мёртвых» кнопок нет; имена и типы контракта не изменены
  /** готовые варианты ответов для текущего собеседника; [] — скрыть блок */
  aiReplies?: string[];
  /** запрос подсказок в полёте */
  aiRepliesLoading?: boolean;
  /** запросить подсказки ответов */
  onRequestAiReplies?: () => void;
  /** сводка переписки; null — панель закрыта */
  aiSummary?: { text: string; messageCount: number } | null;
  /** запрос сводки в полёте */
  aiSummaryLoading?: boolean;
  /** запросить сводку */
  onRequestAiSummary?: () => void;
  /** закрыть панель сводки */
  onDismissAiSummary?: () => void;
  // NEW (v1.0.28) AI: переводы сообщений (LLM на сервере) и настройки AI-функций.
  // Сокеты и состояние — в App.tsx, здесь только UI; пропсы опциональные с
  // дефолтами — тот же паттерн, что у aiReplies/aiSummary (v1.0.27)
  /** NEW (v1.0.28) AI: переводы сообщений — id сообщения → состояние (loading/done) */
  aiTranslations?: Record<string, AiTranslationState>;
  /** NEW (v1.0.28) AI: запросить перевод сообщения (id + исходный текст) */
  onRequestAiTranslation?: (messageId: string, text: string) => void;
  /** NEW (v1.0.28) AI: скрыть перевод сообщения */
  onDismissAiTranslation?: (messageId: string) => void;
  /** NEW (v1.0.28) AI: настройки AI-функций (undefined = всё включено, дефолты) */
  aiSettings?: AiSettings;
  /** NEW (v1.0.28) AI: обновить настройки AI-функций */
  onUpdateAiSettings?: (settings: AiSettings) => void;
  // NEW (v1.0.29) GC: групповой режим чата (данные и сокеты — в App.tsx,
  // здесь только UI). Пропсы опциональные — до вайринга App.tsx tsc зелёный
  // и групповых деталей нет (тот же паттерн, что у aiReplies в v1.0.27)
  /** NEW (v1.0.29) GC: активная группа (когда recipient.isGroup) — актуальный слепок */
  activeGroup?: GroupInfo | null;
  /** NEW (v1.0.29) GC: сколько участников группы сейчас в сети (считает App.tsx) */
  activeGroupOnlineCount?: number;
  /** NEW (v1.0.29) GC: имена участников, печатающих сейчас в группе */
  groupTypingNames?: string[];
  /** NEW (v1.0.29) GC: открыть панель управления группой (модалка в App.tsx) */
  onOpenGroupPanel?: () => void;
  // NEW (v1.0.30) GR: квитанции прочтения в группах. Карта «username участника
  // (ключ в НИЖНЕМ регистре) → время (ms), до которого он дочитал беседу».
  // Своё сообщение считается прочитанным, когда readState каждого ДРУГОГО
  // участника >= timestamp сообщения. null/undefined (пока App.tsx не
  // пробрасывает или сервер старый) — прогресс неизвестен: одиночная ✓
  // с нулевым счётчиком в тултипе. Паттерн опциональных пропсов — как у
  // activeGroup (v1.0.29)
  /** NEW (v1.0.30) GR: статусы прочтения участников активной группы */
  groupReadState?: Record<string, number> | null;
}

// v1.0.10: набор эмодзи для быстрой вставки
// NEW (v1.0.22) N8: расширено до 48 частых эмодзи (лица/жесты/сердца/праздники)
const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎',
  '🤔', '😐', '😴', '😭', '😡', '🤯', '😇', '🙃',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🫡',
  '🔥', '❤️', '💜', '✨', '🎉', '🎁', '💯', '⚡',
  '☕', '🍕', '⚽', '🚀', '🎮', '🎵', '🐱', '🌙',
  '🥰', '🤗', '😅', '🤩', '🫶', '👋', '🌟', '🏆',
];

// NEW (v1.0.22) N7: кнопка «вниз» показывается, когда пользователь прокрутил
// вверх дальше этого расстояния от низа ленты (~300px)
const SCROLL_BTN_THRESHOLD = 300;

// NEW (v1.0.24) E1: окно правки своих сообщений — синхронизировано с сервером
// (chat:edit отклоняет правки старше 48 часов)
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

// NEW (v1.0.25) R1: быстрый набор реакций (синхронизирован с серверным allowlist)
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🙏', '⭐'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// NEW (v1.0.23) D1: ключ localStorage для черновика ввода — по username
// собеседника в нижнем регистре (устойчиво к регистру имени при входе).
// NEW (v1.0.30) GR: это теперь ключ ТОЛЬКО личных чатов — групповые черновики
// переехали на vm_draft_g_<groupId> (draftStorageKey ниже), чтобы переименование
// группы не рвало черновик. Заодно функция задаёт СТАРЫЙ (v1.0.23–v1.0.29)
// групповой ключ «по имени группы» — его читает одноразовая миграция при
// открытии группового чата (см. эффект восстановления черновика)
function draftKeyFor(username: string): string {
  return `vm_draft_${username.toLowerCase()}`;
}

// NEW (v1.0.30) GR: ключ черновика по получателю. Группы — по id (id стабилен,
// имя меняется переименованием): vm_draft_g_<groupId>. Личные чаты — прежний
// ключ по username (draftKeyFor, поведение v1.0.23 не изменилось). Деградированный
// групповой recipient без groupId (слепок ещё не приехал) — ключ по имени, как
// в v1.0.29
function draftStorageKey(recipient: Pick<User, 'username' | 'isGroup' | 'groupId'>): string {
  return recipient.isGroup && recipient.groupId
    ? `vm_draft_g_${recipient.groupId}`
    : draftKeyFor(recipient.username);
}

// NEW (v1.0.23) D1: безопасная запись черновика (пустой текст = удаление ключа;
// приватный режим браузера не роняет приложение).
// NEW (v1.0.30) GR: принимает получателя ЦЕЛИКОМ (не только username) — ключ
// выбирается draftStorageKey (группы по id, личные по имени)
function saveDraft(recipient: User | null | undefined, value: string): void {
  if (!recipient?.username) return;
  try {
    const key = draftStorageKey(recipient);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* localStorage недоступен — черновики просто не сохраняются */ }
}

/** Короткий сниппет для цитаты ответа / превью */
function replySnippet(m: Pick<ChatMessage, 'text' | 'mediaType' | 'deleted'>): string {
  if (m.deleted) return 'Сообщение удалено';
  if (m.mediaType === 'image') return m.text ? `📷 ${m.text}` : '📷 Фото';
  if (m.mediaType === 'voice') return '🎤 Голосовое сообщение';
  const t = (m.text || '').trim();
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

// NEW (v1.0.26) F2: экспорт переписки в .txt — чистые модульные функции (без
// состояния компонента): сборка текста файла и скачивание Blob. Формат —
// шапка файла (беседа/дата экспорта/число сообщений/период), затем блоки
// сообщений: [дата время] отправитель, тело (текст/🎤/📷, [удалено]), метки
// правки/ответа/реакций с отступом. Обычный текст + эмодзи, без markdown.

function twoDigits(n: number): string {
  return String(n).padStart(2, '0');
}

// dd.MM.yyyy HH:mm — локальная таймзона (файл для человека, не для машин)
function exportDateTime(ts: number): string {
  const d = new Date(ts);
  return `${twoDigits(d.getDate())}.${twoDigits(d.getMonth() + 1)}.${d.getFullYear()} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

// HH:mm — для метки «изменено»
function exportTime(ts: number): string {
  const d = new Date(ts);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`;
}

// сниппет цитируемого сообщения для строки «↳ Ответ на …» (≤60 символов)
function exportReplySnippet(m: ReplyMeta): string {
  if (m.mediaType === 'image') {
    const s = m.text ? `📷 ${m.text}` : '📷 Фото';
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  if (m.mediaType === 'voice') return '🎤 Голосовое сообщение';
  const t = (m.text || '').trim();
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

function buildChatExport(
  messages: ChatMessage[],
  selfUsername: string,
  partnerUsername: string
): string {
  const selfLower = selfUsername.toLowerCase();
  const first = messages[0];
  const last = messages[messages.length - 1];
  const lines: string[] = [
    'VoiceChat — экспорт переписки',
    `Беседа: ${selfUsername} ↔ ${partnerUsername}`,
    `Экспортировано: ${new Date().toLocaleString()}`,
    `Сообщений: ${messages.length} (период: ${new Date(first.timestamp).toLocaleString()} — ${new Date(last.timestamp).toLocaleString()})`,
    '',
    '──────────────────────────────',
    '',
  ];

  for (const msg of messages) {
    lines.push(`[${exportDateTime(msg.timestamp)}] ${msg.senderName}:`);
    if (msg.deleted) {
      // удалённое — единственная строка тела, без правок/ответа/реакций
      lines.push('  [сообщение удалено]');
      lines.push('');
      continue;
    }
    // тело: голосовое / фото (с подписью) / текст (многострочный — как есть, без отступа)
    if (msg.mediaType === 'voice') {
      lines.push(`  🎤 Голосовое (${msg.duration ?? 0} сек)`);
    } else if (msg.mediaType === 'image') {
      lines.push(msg.text ? `  📷 Фото — ${msg.text}` : '  📷 Фото');
    } else if (msg.text) {
      lines.push(msg.text);
    }
    if (msg.edited) {
      lines.push(`  ✏️ (изменено ${exportTime(msg.editedAt ?? msg.timestamp)})`);
    }
    if (msg.replyTo) {
      lines.push(`  ↳ Ответ на ${msg.replyTo.senderName}: «${exportReplySnippet(msg.replyTo)}»`);
    }
    const reactionEntries = msg.reactions
      ? Object.entries(msg.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0)
      : [];
    for (const [emoji, users] of reactionEntries) {
      const names = users
        .map(u => (u.toLowerCase() === selfLower ? 'вы' : u))
        .join(', ');
      lines.push(`  ${emoji} ×${users.length}: ${names}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// NEW (v1.0.26) F2: скачивание текста как файла — временный <a> с Blob-URL;
// revokeObjectURL отложенно (сразу после click() URL ещё нужен Safari)
function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// NEW (v1.0.27) AI: подпись «на основе последних N сообщений» под текстом
// сводки — с корректной русской плюрализацией (1 — «последнего сообщения»,
// 2–4 — «сообщения», 5+ — «сообщений»), чтобы не было «1 сообщений»
function aiSummaryCaption(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'На основе последнего сообщения';
  const plural =
    mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'сообщения' : 'сообщений';
  return `На основе последних ${count} ${plural}`;
}

// NEW (v1.0.28) AI: названия языков перевода (код → русское имя) — для селекта
// настроек и подписи «Перевод (AI) · на …» под пузырём; ключи = AiTranslateTarget
const AI_LANG_NAMES: Record<string, string> = {
  ru: 'русский', en: 'английский', de: 'немецкий', es: 'испанский',
  fr: 'французский', it: 'итальянский', pt: 'португальский', zh: 'китайский',
  ja: 'японский', ko: 'корейский', tr: 'турецкий', uk: 'украинский',
};

// NEW (v1.0.28) AI: настройки AI-функций по умолчанию — всё включено
// (пока App.tsx не пробрасывает aiSettings, функции ведут себя как в v1.0.27)
const AI_SETTINGS_DEFAULTS: AiSettings = {
  suggestions: true,
  summary: true,
  translation: true,
  suggestionCount: 3,
  translateTarget: 'ru',
};

// NEW (v1.0.29) GC: палитра участников группы — 6 акцентов (без blue/indigo).
// Цвет детерминирован хешем имени: один участник всегда одного цвета в чипе
// имени и градиенте мини-аватара (Telegram-style). text — пара light+dark
// для чипа имени отправителя, grad — градиент мини-аватара в шапке.
const GROUP_PALETTE = [
  { text: 'text-purple-600 dark:text-purple-400', grad: 'from-purple-500 to-purple-600' },
  { text: 'text-violet-600 dark:text-violet-400', grad: 'from-violet-500 to-violet-600' },
  { text: 'text-fuchsia-600 dark:text-fuchsia-400', grad: 'from-fuchsia-500 to-fuchsia-600' },
  { text: 'text-rose-600 dark:text-rose-400', grad: 'from-rose-500 to-rose-600' },
  { text: 'text-amber-600 dark:text-amber-400', grad: 'from-amber-500 to-amber-600' },
  { text: 'text-emerald-600 dark:text-emerald-400', grad: 'from-emerald-500 to-emerald-600' },
] as const;

// NEW (v1.0.29) GC: индекс палитры по имени — тот же хеш-алгоритм, что у
// градиентов аватаров в Avatar.tsx (charCode + сдвиг), своя палитра из 6
function groupMemberIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % GROUP_PALETTE.length;
}

/** NEW (v1.0.29) GC: цвет чипа имени отправителя в групповой ленте —
 *  light+dark-пара Tailwind-классов (детерминированно по имени). */
export function groupMemberColor(name: string): string {
  return GROUP_PALETTE[groupMemberIndex(name)].text;
}

// NEW (v1.0.29) GC: градиент мини-аватара участника в шапке — тот же хеш,
// что и у цвета имени (участник «одного цвета» во всех местах UI)
function groupMemberGradient(name: string): string {
  return GROUP_PALETTE[groupMemberIndex(name)].grad;
}

// NEW (v1.0.29) GC: «N участников» с корректной русской плюрализацией
// (1 участник / 2–4 участника / 5+ участников; 11–14 — «участников»)
function groupMembersLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} участник`;
  const plural =
    mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'участника' : 'участников';
  return `${count} ${plural}`;
}

// NEW (v1.0.28) AI: строка-переключатель AI-функции в модалке настроек —
// иконка + название + описание слева, switch-кнопка (role="switch") справа;
// изумрудный трек во включённом состоянии — как статусы «В сети»
function AiSettingsToggleRow(props: {
  icon: React.ReactNode;
  name: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { icon, name, description, checked, onChange } = props;
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-500 dark:text-purple-300">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200 leading-tight">{name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        title={checked ? `Выключить: ${name}` : `Включить: ${name}`}
        aria-label={checked ? `Выключить: ${name}` : `Включить: ${name}`}
        className={`w-10 h-6 rounded-full transition-colors relative shrink-0 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
          checked ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-700'
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  currentUser,
  recipient,
  messages,
  activeCall,
  onSendMessage,
  onStartCall,
  onDeleteMessage,
  onEditMessage,
  isHistoryLoading = false,
  onRequestForward,
  // NEW (v1.0.25) R1/F2: реакции на сообщения и «без звука» для этого чата
  onReactMessage,
  isChatMuted = false,
  onToggleMute,
  isPartnerTyping = false,
  onTyping,
  onNotify,
  onBack,
  // NEW (v1.0.27) AI: подсказки ответов и сводка переписки (данные — из App.tsx)
  aiReplies = [],
  aiRepliesLoading = false,
  onRequestAiReplies,
  aiSummary = null,
  aiSummaryLoading = false,
  onRequestAiSummary,
  onDismissAiSummary,
  // NEW (v1.0.28) AI: переводы сообщений + настройки AI-функций (данные — из App.tsx)
  aiTranslations = {},
  onRequestAiTranslation,
  onDismissAiTranslation,
  aiSettings,
  onUpdateAiSettings,
  // NEW (v1.0.29) GC: групповой режим (слепок группы/онлайн-счётчик/печатальщики/
  // кнопка управления — всё считает и хранит App.tsx)
  activeGroup = null,
  activeGroupOnlineCount,
  groupTypingNames,
  onOpenGroupPanel,
  // NEW (v1.0.30) GR: статусы прочтения участников группы (username → ms;
  // считает и хранит App.tsx, здесь только рендер квитанций)
  groupReadState = null,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedLightboxImage, setSelectedLightboxImage] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  // NEW (v1.0.22) QA-FIX: рефы для закрытия эмодзи-панели по клику вне
  const emojiPopoverRef = useRef<HTMLDivElement | null>(null);
  const emojiToggleRef = useRef<HTMLButtonElement | null>(null);

  // NEW (v1.0.22) QA-FIX: закрытие эмодзи-панели по клику ВНЕ — document-level
  // mousedown. Прежний fixed-inset-0-оверлей из-за will-change:transform на колонке
  // чата покрывал только область чата (fixed считался от колонки, не от вьюпорта) —
  // клики по сайдбару его не ловили, и панель оставалась открытой; заодно гигантский
  // невидимый <button> засорял accessibility-дерево.
  useEffect(() => {
    if (!showEmoji) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (emojiPopoverRef.current?.contains(t)) return;
      if (emojiToggleRef.current?.contains(t)) return; // тоггл сам переключает состояние
      setShowEmoji(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [showEmoji]);

  // NEW (v1.0.22) QA-FIX: смена собеседника закрывает эмодзи-панель
  useEffect(() => {
    setShowEmoji(false);
    // NEW (v1.0.23) D1: при открытии беседы восстанавливаем её черновик;
    // черновики ДРУГИХ бесед остаются в localStorage и вернутся при возврате.
    // NEW (v1.0.30) GR: ключ — draftStorageKey (группы по id). Для группы,
    // у которой нового ключа ещё нет, выполняем ОДНОРАЗОВУЮ миграцию со
    // старого ключа v1.0.23–v1.0.29 (vm_draft_<имя группы lowercase>):
    // значение переносим в новый ключ, старый удаляем — черновик переживает
    // апгрейд на v1.0.30 (и дальнейшие переименования группы)
    try {
      let restored = '';
      if (recipient) {
        const key = draftStorageKey(recipient);
        const stored = localStorage.getItem(key);
        if (stored === null && recipient.isGroup && recipient.groupId) {
          // нового ключа нет — возможно, черновик остался под старым ключом
          const legacyKey = draftKeyFor(recipient.username);
          const legacy = localStorage.getItem(legacyKey);
          if (legacy !== null) {
            try {
              if (legacy) localStorage.setItem(key, legacy);
              localStorage.removeItem(legacyKey);
            } catch { /* перенос не удался (приватный режим) — читаем без удаления */ }
            restored = legacy;
          }
        } else {
          restored = stored ?? '';
        }
      }
      setInputText(restored);
    } catch { /* localStorage недоступен (приватный режим) — пустой ввод */ }
    // NEW (v1.0.24) E1: смена собеседника гасит режим правки (правка относится
    // к конкретной беседе; черновик выше уже восстановлен — ввод в согласованном
    // состоянии, без «протечки» редактируемого текста в другой чат)
    setEditingMessage(null);
    // NEW (v1.0.25) R1: смена собеседника закрывает и пикер реакций
    setReactionPickerFor(null);
    // NEW (v1.0.26) F3: ... и поповер «кто отреагировал» (реакции относятся к беседе)
    setReactorsFor(null);
    // NEW (v1.0.27) AI: ... и флаг скрытия чипов подсказок (App при этом уже
    // обнулил сами подсказки — ряд скрывается и без этого, флаг — гигиена)
    setAiChipsDismissed(false);
  // NEW (v1.0.23) QA-FIX: зависимость — username, а НЕ socket id: у офлайн-
  // собеседников id === '' (синтетический объект из Sidebar), и переключение
  // между двумя офлайн-чатами НЕ меняло recipient?.id → черновик не
  // восстанавливался (текст собеседника «протекал» в чужой чат), эмодзи-панель
  // не закрывалась. username уникален и всегда не пуст.
  }, [recipient?.id, recipient?.username]);

  // v1.0.11: ответ на сообщение
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);

  // NEW (v1.0.24) E1: режим правки своего сообщения. Ввод (inputText) временно
  // содержит редактируемый текст; исходный черновик запоминаем в ref и
  // возвращаем при сохранении/отмене (черновик в localStorage при этом НЕ
  // затирается — saveDraft при активной правке отключён).
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const preEditTextRef = useRef<string>('');

  const startEditMessage = (msg: ChatMessage) => {
    setReplyTo(null); // правка и ответ — несовместимые режимы ввода
    preEditTextRef.current = inputText;
    setEditingMessage(msg);
    setInputText(msg.text || '');
    messageInputRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditingMessage(null);
    setInputText(preEditTextRef.current); // возвращаем черновик, который был до правки
    messageInputRef.current?.focus();
  };

  const submitEdit = () => {
    if (!editingMessage) return;
    const newText = inputText.trim();
    if (!newText || newText === (editingMessage.text || '')) {
      // пустое/неизменённое — просто выходим из режима без запроса к серверу
      cancelEdit();
      return;
    }
    onEditMessage?.(editingMessage.id, newText);
    setEditingMessage(null);
    setInputText(preEditTextRef.current); // черновик собеседника возвращаем на место
  };

  // v1.0.11: поиск по переписке
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // NEW (v1.0.25) R1: пикер реакций — id сообщения, у которого он открыт (null — закрыт).
  // Пикер один на всю ленту: клик по кнопке-смайлу ДРУГОГО сообщения переключает его.
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  // NEW (v1.0.25) R1: контейнер пикера — для закрытия по клику вне (mousedown на document)
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);

  // NEW (v1.0.26) F3: клик по пилюле — поповер «кто отреагировал» (toggle остаётся
  // в пикере/двойном клике). Один поповер на ленту: messageId + emoji определяют
  // пилюлю, у которой он открыт (null — закрыт).
  const [reactorsFor, setReactorsFor] = useState<
    { messageId: string; emoji: string } | null
  >(null);
  // NEW (v1.0.26) F3: контейнер поповера — для закрытия по клику вне (mousedown на document)
  const reactorsPopoverRef = useRef<HTMLDivElement | null>(null);

  // NEW (v1.0.27) AI: чипы подсказок скрыты крестиком — «до следующего запроса»:
  // флаг сбрасывается кликом по кнопке Sparkles и сменой собеседника; сами
  // данные (aiReplies/aiRepliesLoading) живут в App.tsx — здесь только скрытие ряда
  const [aiChipsDismissed, setAiChipsDismissed] = useState(false);

  // NEW (v1.0.28) AI: модалка настроек AI-функций (открыта/закрыта) и ЛОКАЛЬНЫЙ
  // черновик настроек внутри неё — правки применяются по кнопке «Готово»
  // (не мгновенно); при открытии модалки черновик сбрасывается к текущим
  // настройкам из App.tsx (undefined = дефолты «всё включено»)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiSettingsDraft, setAiSettingsDraft] = useState<AiSettings>(AI_SETTINGS_DEFAULTS);

  // NEW (v1.0.25) R1: закрытие пикера реакций по клику ВНЕ — document-level mousedown
  // (тот же паттерн, что у эмодзи-панели выше). Кнопки-тогглы помечены data-reaction-toggle:
  // клик по ним (в т.ч. по кнопке другого сообщения) обрабатывает их собственный onClick.
  useEffect(() => {
    if (reactionPickerFor === null) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (reactionPickerRef.current?.contains(t)) return; // клик внутри пикера — не закрываем
      const el = t as Element;
      if (typeof el.closest === 'function' && el.closest('[data-reaction-toggle]')) {
        return; // тоггл сам переключает/закрывает пикер
      }
      setReactionPickerFor(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [reactionPickerFor]);

  // NEW (v1.0.26) F3: закрытие поповера «кто отреагировал» по клику ВНЕ — тот же
  // паттерн, что у пикера реакций. Пилюли помечены data-reactors-toggle: клик по
  // пилюле (той же или другой) обрабатывает её собственный onClick (закрыть/переключить)
  useEffect(() => {
    if (reactorsFor === null) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (reactorsPopoverRef.current?.contains(t)) return; // клик внутри поповера — не закрываем
      const el = t as Element;
      if (typeof el.closest === 'function' && el.closest('[data-reactors-toggle]')) {
        return; // пилюля сама переключает/закрывает поповер
      }
      setReactorsFor(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [reactorsFor]);

  // NEW (v1.0.27) AI: Esc закрывает панель сводки переписки — глобальный keydown,
  // подписка только пока панель открыта (паттерн условных подписок выше)
  useEffect(() => {
    if (aiSummary === null) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismissAiSummary?.();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [aiSummary, onDismissAiSummary]);

  // NEW (v1.0.28) AI: Esc закрывает модалку настроек — тот же паттерн, что у
  // сводки (глобальный keydown, подписка только пока модалка открыта)
  useEffect(() => {
    if (!aiSettingsOpen) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAiSettingsOpen(false);
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [aiSettingsOpen]);

  // NEW (v1.0.28) AI: открытие модалки — черновик настроек сбрасывается к
  // текущим (aiSettings из App.tsx; undefined = дефолты «всё включено»).
  // Зависимость только aiSettingsOpen: пока модалка открыта, aiSettings извне
  // не меняется (единственный «писатель» — сама модалка по «Готово»)
  useEffect(() => {
    if (aiSettingsOpen) setAiSettingsDraft(aiSettings ?? AI_SETTINGS_DEFAULTS);
  }, [aiSettingsOpen]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSentRef = useRef(0);
  // NEW (v1.0.22) N8: рефокс поля ввода после вставки эмодзи (клик по панели уводит фокус)
  const messageInputRef = useRef<HTMLInputElement | null>(null);

  // NEW (v1.0.26) F1: синк черновика между вкладками (storage-событие приходит
  // только в ДРУГИЕ вкладки — зацикливания нет). Применяем ТОЛЬКО когда поле
  // ввода не в фокусе — не отбираем ввод у активной вкладки. В режиме правки
  // чужой черновик тоже не применяем: иначе текст правки в поле был бы заменён
  // и Enter сохранил бы черновик другой вкладки как новый текст сообщения.
  // NEW (v1.0.30) GR: слушаем ключ draftStorageKey (группы — по id). В deps
  // добавлен recipient?.id: у двух групп-однофамильцев username одинаковый,
  // а ключи (по id) разные — без id в deps слушали бы чужой ключ
  useEffect(() => {
    if (!recipient?.username) return;
    const key = draftStorageKey(recipient);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      if (editingMessage) return;
      if (document.activeElement === messageInputRef.current) return; // активная вкладка владеет полем
      setInputText(e.newValue ?? '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [recipient?.id, recipient?.username, editingMessage]);
  // v1.0.11: refs сообщений для перехода к найденному/цитируемому
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // v1.0.12: контейнер ленты + состояние «пользователь прокрутил вверх»
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastSeenCountRef = useRef(0); // messages.length, когда пользователь был у низа
  const messagesLenRef = useRef(0); // актуальная длина ленты для handleScroll
  messagesLenRef.current = messages.length;
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [newBelowCount, setNewBelowCount] = useState(0);
  // v1.0.12: копирование текста сообщения
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance < 120;
    isNearBottomRef.current = near;
    // NEW (v1.0.22) N7: кнопка «вниз» — порог ~300px от низа (раньше 120px,
    // из-за чего она мелькала при малейшей прокрутке)
    setShowScrollDown(distance > SCROLL_BTN_THRESHOLD);
    if (near) {
      // досмотрели до конца — все сообщения «увидены»
      lastSeenCountRef.current = messagesLenRef.current;
      setNewBelowCount(0);
    }
  }, []);

  // v1.0.12: автоскролл только когда пользователь у низа; иначе — счётчик на кнопке.
  // Счётчик считается ДЕЛЬТОЙ длины ленты (устойчиво к батчингу нескольких
  // сообщений в одном рендере — раньше инкремент терял часть сообщений).
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom();
      lastSeenCountRef.current = messages.length;
      setNewBelowCount(0);
    } else {
      setNewBelowCount(Math.max(0, messages.length - lastSeenCountRef.current));
    }
    // NEW (v1.0.23) TB1: isPartnerTyping в deps — появление/скрытие пузыря
    // «печатает…» тоже докручивает ленту, если пользователь у низа
  }, [messages, isRecordingVoice, isPartnerTyping, scrollToBottom]);

  const handleScrollDownClick = () => {
    lastSeenCountRef.current = messages.length;
    setNewBelowCount(0);
    scrollToBottom();
  };

  // v1.0.12: копировать текст сообщения в буфер обмена
  const handleCopyMessage = async (msg: ChatMessage) => {
    const text = (msg.text || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback для старых браузеров/без HTTPS
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* игнорируем */ }
      document.body.removeChild(ta);
    }
    setCopiedId(msg.id);
    window.setTimeout(() => setCopiedId(prev => (prev === msg.id ? null : prev)), 1500);
  };

  // NEW (v1.0.26) F2: экспорт текущей переписки в .txt (кнопка Download в шапке):
  // имя файла VoiceChat_<собеседник>_<YYYY-MM-DD>.txt — имя собеседника
  // санитизировано (всё вне букв/цифр/_- → '_'), уведомление с числом сообщений
  const handleExportChat = () => {
    if (!recipient || messages.length === 0) return;
    const now = new Date();
    const datePart = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
    const safePartner = recipient.username.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_');
    downloadTextFile(
      `VoiceChat_${safePartner}_${datePart}.txt`,
      buildChatExport(messages, currentUser.username, recipient.username)
    );
    onNotify?.(`Экспортировано ${messages.length} сообщений`, 'success');
  };

  // NEW (v1.0.27) AI: запросить подсказки ответов (emit и состояние — в App.tsx).
  // Повторный клик по Sparkles возвращает чипы, даже если ряд был скрыт
  // крестиком; клик во время запроса игнорируется (кнопка disabled + guard)
  const handleRequestAiReplies = () => {
    if (aiRepliesLoading) return;
    setAiChipsDismissed(false);
    onRequestAiReplies?.();
  };

  // NEW (v1.0.27) AI: выбрать подсказку — текст в поле ввода через существующий
  // сеттер handleInputChange (черновик и «печатает…» сохраняются), БЕЗ отправки:
  // пользователь проверяет текст и сам жмёт Enter
  const handlePickAiReply = (suggestion: string) => {
    handleInputChange(suggestion);
    messageInputRef.current?.focus();
  };

  // NEW (v1.0.25) R1: открыть/закрыть пикер реакций сообщения; клик по кнопке
  // другого сообщения переключает пикер на него (один пикер на ленту)
  const toggleReactionPicker = (messageId: string) => {
    setReactionPickerFor(prev => (prev === messageId ? null : messageId));
  };

  // NEW (v1.0.25) R1: выбор эмодзи в пикере — шлём на сервер (сервер делает toggle:
  // тот же эмодзи снимает реакцию, другой — переносит) и закрываем пикер
  const handleReact = (messageId: string, emoji: string) => {
    onReactMessage?.(messageId, emoji);
    setReactionPickerFor(null);
  };

  // v1.0.11: id сообщений, совпадающих с поиском
  // NEW (v1.0.22) N1: голосовые/фото матчатся по слову-типу («голосовое»/«фото»)
  const matchIds = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return [];
    const typeQuery: MessageType | null =
      q === 'голосовое' ? 'voice' : q === 'фото' ? 'image' : null;
    return messages
      .filter(m => !m.deleted && (
        (m.text || '').toLowerCase().includes(q) ||
        (typeQuery !== null && m.mediaType === typeQuery)
      ))
      .map(m => m.id);
  }, [messages, searchText]);

  // NEW (v1.0.22) N5: первое непрочитанное входящее сообщение (не первое в списке)
  // — над ним рисуем разделитель «Новые сообщения»
  const firstUnreadId = useMemo(() => {
    const idx = messages.findIndex(
      m => !m.deleted && !m.read && m.senderName !== currentUser.username
    );
    return idx > 0 ? messages[idx].id : null;
  }, [messages, currentUser.username]);

  // NEW (v1.0.22) N7: число непрочитанных входящих в этой беседе (для бейджа
  // кнопки «вниз»); берём максимум с дельтой «новых снизу» — она ловит сообщения,
  // которые уже помечены прочитанными, пока вкладка в фокусе
  const unreadIncoming = useMemo(
    () => messages.filter(m => !m.deleted && !m.read && m.senderName !== currentUser.username).length,
    [messages, currentUser.username]
  );
  const scrollBadgeCount = Math.max(newBelowCount, unreadIncoming);

  // NEW (v1.0.29) GC: подпись «кто печатает» для групповой шапки — 1/2/3+ имён
  // (text — видимая строка без многоточия, роль «…» играет анимация точек;
  // sr — полная фраза для скринридеров). Рендер в ОДНОМ месте — подзаголовок
  // шапки (там, где в личных чатах живёт isPartnerTyping)
  const groupTyping = useMemo(() => {
    const names = (groupTypingNames ?? []).filter(n => typeof n === 'string' && n.trim());
    if (names.length === 0) return null;
    if (names.length === 1) {
      return { text: `${names[0]} печатает`, sr: `${names[0]} печатает…` };
    }
    if (names.length === 2) {
      return {
        text: `${names[0]} и ${names[1]} печатают`,
        sr: `${names[0]} и ${names[1]} печатают…`,
      };
    }
    const rest = names.length - 2;
    return {
      text: `${names[0]}, ${names[1]} и ещё ${rest} печатают`,
      sr: `${names[0]}, ${names[1]} и ещё ${rest} печатают…`,
    };
  }, [groupTypingNames]);

  // NEW (v1.0.29) GC: мини-аватары участников для шапки — до 4 членов группы
  // без себя. Поимённых онлайн-статусов у ChatArea нет (только счётчик
  // activeGroupOnlineCount), поэтому порядок — как в members; App.tsx может
  // отдавать members, отсортированные онлайн-первыми
  const groupMiniMembers = useMemo(() => {
    if (!activeGroup) return [];
    const selfLower = currentUser.username.toLowerCase();
    return activeGroup.members
      .filter(m => m.toLowerCase() !== selfLower)
      .slice(0, 4);
  }, [activeGroup, currentUser.username]);

  // NEW (v1.0.30) GR: карта статусов прочтения группы с ключами в НИЖНЕМ
  // регистре — собирается ОДИН раз на рендер (deps только groupReadState),
  // а не по объекту на каждое сообщение в ленте. Боевые значения — числа (ms);
  // мусорные (NaN/бесконечность) отбрасываем, чтобы сравнение >= не лгало
  const groupReadStateLower = useMemo(() => {
    const map = new Map<string, number>();
    if (groupReadState) {
      for (const [name, ts] of Object.entries(groupReadState)) {
        if (typeof ts === 'number' && Number.isFinite(ts)) {
          map.set(name.toLowerCase(), ts);
        }
      }
    }
    return map;
  }, [groupReadState]);

  // NEW (v1.0.30) GR: участники группы БЕЗ себя — знаменатель «прочитали N из M»
  // у квитанций своих сообщений (сравнение с собой регистронезависимое —
  // регистр имени при входе может отличаться от канонического в members)
  const groupOtherMembers = useMemo(() => {
    if (!activeGroup) return [];
    const selfLower = currentUser.username.toLowerCase();
    return activeGroup.members.filter(m => m.toLowerCase() !== selfLower);
  }, [activeGroup, currentUser.username]);

  useEffect(() => {
    setSearchIndex(0);
  }, [searchText]);

  const jumpToMessage = (id: string) => {
    const el = messageRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(id);
    window.setTimeout(() => setHighlightId(prev => (prev === id ? null : prev)), 1400);
  };

  const handleSearchNav = (dir: 1 | -1) => {
    if (matchIds.length === 0) return;
    const next = (searchIndex + dir + matchIds.length) % matchIds.length;
    setSearchIndex(next);
    jumpToMessage(matchIds[next]);
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    // NEW (v1.0.24) E1: активная правка — Enter сохраняет правку, а не отправляет
    // новое сообщение (черновик восстанавливается из preEditTextRef)
    if (editingMessage) {
      submitEdit();
      return;
    }
    // v1.0.10: при отправке гасим индикатор «печатает…» и закрываем эмодзи-панель
    if (recipient && onTyping) onTyping(recipient.id, false);
    setShowEmoji(false);

    // v1.0.11: метаданные ответа
    const replyMeta: ReplyMeta | undefined = replyTo
      ? {
          id: replyTo.id,
          senderName: replyTo.senderName,
          text: (replyTo.text || '').trim().slice(0, 160) || undefined,
          mediaType: replyTo.mediaType,
        }
      : undefined;
    setReplyTo(null);

    if (previewImage) {
      onSendMessage({
        text: inputText.trim() || undefined,
        mediaUrl: previewImage,
        mediaType: 'image',
        replyTo: replyMeta,
      });
      setPreviewImage(null);
      setInputText('');
      // NEW (v1.0.23) D1: отправлено — черновик собеседника удаляем
      // NEW (v1.0.30) GR: получатель целиком — ключ групп по id (draftStorageKey)
      saveDraft(recipient, '');
      return;
    }

    if (inputText.trim()) {
      onSendMessage({
        text: inputText.trim(),
        mediaType: 'text',
        replyTo: replyMeta,
      });
      setInputText('');
      // NEW (v1.0.23) D1: отправлено — черновик собеседника удаляем
      // NEW (v1.0.30) GR: получатель целиком — ключ групп по id (draftStorageKey)
      saveDraft(recipient, '');
    }
  };

  // v1.0.10: ввод текста → информируем собеседника «печатает…» (не чаще раза в 1.5с)
  const handleInputChange = (value: string) => {
    setInputText(value);
    // NEW (v1.0.24) E1: при активной правке черновик НЕ затираем — в поле
    // редактируемый текст, а черновик собеседника лежит в preEditTextRef
    if (!editingMessage) {
      // NEW (v1.0.23) D1: черновик пишется сразу при вводе (ключ — по собеседнику;
      // NEW (v1.0.30) GR: группы — по id, переименование черновик не рвёт)
      saveDraft(recipient, value);
    }
    if (!recipient || !onTyping) return;
    const now = Date.now();
    if (value.trim() && now - lastTypingSentRef.current > 1500) {
      lastTypingSentRef.current = now;
      onTyping(recipient.id, true);
    }
  };

  // v1.0.10: вставка эмодзи в конец текста (или в конец) + возврат фокуса в поле
  const handleEmojiSelect = (emoji: string) => {
    const next = inputText + emoji;
    setInputText(next);
    // NEW (v1.0.23) D1: вставка эмодзи тоже сохраняется в черновик
    // NEW (v1.0.30) GR: получатель целиком — ключ групп по id (draftStorageKey)
    saveDraft(recipient, next);
    setShowEmoji(false);
    // NEW (v1.0.22) N8: возвращаем фокус в поле ввода (клик по поповеру его уводил)
    messageInputRef.current?.focus();
  };

  // v1.0.11: Escape закрывает ответ / эмодзи / поиск
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showEmoji) setShowEmoji(false);
      // NEW (v1.0.24) E1: Escape в режиме правки — отмена правки (текст поля
      // возвращается к черновику, редактируемое сообщение не трогаем)
      else if (editingMessage) cancelEdit();
      else if (replyTo) setReplyTo(null);
      else if (searchOpen) {
        setSearchOpen(false);
        setSearchText('');
      }
    } else if (e.key === 'Enter' && !e.shiftKey && searchOpen && searchText.trim()) {
      e.preventDefault();
      handleSearchNav(1);
    }
  };

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressedDataUrl = await compressImage(file);
      setPreviewImage(compressedDataUrl);
    } catch (err) {
      console.error('Error compressing image:', err);
      // FIX (v1.0.21): тост вместо блокирующего alert()
      onNotify?.('Не удалось загрузить изображение', 'error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSendVoice = (audioDataUrl: string, duration: number) => {
    onSendMessage({
      mediaUrl: audioDataUrl,
      mediaType: 'voice',
      duration,
    });
    setIsRecordingVoice(false);
  };

  const handleSendWaveGreeting = () => {
    if (!recipient) return;
    onSendMessage({
      text: `👋 ${currentUser.username} машет ручкой!`,
      mediaUrl: '/wave.webp',
      mediaType: 'image',
    });
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // v1.0.11: подсветка совпадений поиска в тексте сообщения
  // NEW (v1.0.22) N1: кастомный фиолетовый <mark> (.search-highlight в index.css) —
  // дефолтный жёлтый mark выбивался из палитры
  const highlightText = (text: string): React.ReactNode => {
    const q = searchText.trim();
    if (!searchOpen || !q) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'ig'));
    return parts.map((p, i) =>
      p.toLowerCase() === q.toLowerCase() ? (
        <mark key={i} className="search-highlight">{p}</mark>
      ) : (
        <React.Fragment key={i}>{p}</React.Fragment>
      )
    );
  };

  // Empty state when no chat is selected
  if (!recipient) {
    return (
      // FIX (v1.0.21): на мобильных без выбранного чата показываем только список (Sidebar)
      <div className="hidden md:flex flex-1 h-full flex-col items-center justify-center p-8 bg-gray-100/40 dark:bg-gray-950/40 text-center">
        {/* NEW (v1.0.22) P3: заглушка — иконка в полупрозрачном круге + градиентный заголовок */}
        <div className="w-24 h-24 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mb-5">
          <MessageSquareText className="w-10 h-10 text-purple-400/80" />
        </div>
        <h3 className="text-2xl font-extrabold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-purple-600 via-fuchsia-600 to-emerald-600 dark:from-purple-300 dark:via-fuchsia-300 dark:to-emerald-300">
          Выберите собеседника
        </h3>
        <p className="text-gray-600 dark:text-gray-400 text-sm max-w-sm mb-6">
          История сохранится автоматически
        </p>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50/80 dark:bg-gray-900/80 border border-gray-200 dark:border-gray-800 rounded-full text-xs text-gray-600 dark:text-gray-400">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span>Сквозная передача сообщений и аудиопотоков</span>
        </div>
      </div>
    );
  }

  const isCurrentCallWithRecipient =
    activeCall && activeCall.partnerId === recipient.id;
  const isRecipientOnline = Boolean(recipient.online);
  // NEW (v1.0.25) R1: своё имя в нижнем регистре — регистронезависимая проверка
  // «я уже реагировал этим эмодзи» (регистр имени при входе может отличаться)
  const selfUsernameLower = currentUser.username.toLowerCase();

  // NEW (v1.0.29) GC: групповой режим. isGroupRecipient — синтетический
  // «пользователь»-группа от Sidebar/App (звонки ему недоступны в любом
  // случае); group — узкая копия слепка для JSX-гардов (null вне групп).
  // Активная группа может быть null, пока слепок не приехал из App.tsx —
  // каждый доступ к ней только через group/его проверки
  const isGroupRecipient = Boolean(recipient.isGroup);
  const group: GroupInfo | null = recipient.isGroup && activeGroup ? activeGroup : null;
  const isGroupChat = group !== null;

  // NEW (v1.0.28) AI: видимость AI-функций по настройкам — undefined = включено
  // (пока App.tsx не пробрасывает aiSettings, всё работает как в v1.0.27)
  const aiTranslationEnabled = aiSettings?.translation !== false;
  const aiSuggestionsEnabled = aiSettings?.suggestions !== false;
  const aiSummaryEnabled = aiSettings?.summary !== false;
  // NEW (v1.0.28) AI: имя целевого языка перевода для подписи под пузырём
  // (дефолт — русский, как в AI_SETTINGS_DEFAULTS)
  const aiTranslateTargetName =
    AI_LANG_NAMES[aiSettings?.translateTarget ?? 'ru'] || 'русский';

  return (
    <div
      key={recipient.username}
      className="flex-1 h-full flex flex-col bg-gray-100/30 dark:bg-gray-950/30 relative animate-chat-switch overflow-hidden"
    >
      {/* Lightbox for viewing full-size images */}
      {selectedLightboxImage && (
        <div
          onClick={() => setSelectedLightboxImage(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer"
        >
          <button
            onClick={() => setSelectedLightboxImage(null)}
            className="absolute top-6 right-6 p-2 rounded-full bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-700"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={selectedLightboxImage}
            alt="Enlarged view"
            className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
          />
        </div>
      )}

      {/* NEW (v1.0.27) AI: модальная панель сводки переписки — по образцу
          ForwardModal (тёмный backdrop, клик по фону и Esc закрывают; панель —
          animate-scale-in). Текст сводки приходит из App.tsx (LLM на сервере);
          null — панель закрыта. Скелетоны (.skeleton из index.css), пока
          aiSummaryLoading; после — текст + подпись и дисклеймер ИИ */}
      {aiSummary !== null && (
        <div
          onClick={() => onDismissAiSummary?.()}
          className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in cursor-pointer"
          role="dialog"
          aria-modal="true"
          aria-label="Сводка переписки"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md bg-white dark:bg-gray-900 border border-gray-300/80 dark:border-gray-700/80 rounded-3xl shadow-2xl overflow-hidden animate-scale-in flex flex-col max-h-[80vh] cursor-default"
          >
            {/* Заголовок: иконка + название + градиентная AI-пилюля + крестик */}
            <div className="px-5 pt-5 pb-3 border-b border-gray-200/80 dark:border-gray-800/80 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-2 rounded-xl bg-purple-500/15 border border-purple-500/30 shrink-0">
                  <FileText className="w-4 h-4 text-purple-500 dark:text-purple-300" aria-hidden />
                </div>
                <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-none truncate">
                  Сводка переписки
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white text-[10px] font-extrabold tracking-widest uppercase leading-none shrink-0">
                  AI
                </span>
              </div>
              <button
                type="button"
                onClick={() => onDismissAiSummary?.()}
                title="Закрыть"
                aria-label="Закрыть сводку"
                className="p-2 rounded-xl text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Тело: скелетоны во время запроса, иначе текст сводки + подпись */}
            <div className="flex-1 overflow-y-auto px-5 py-4 vm-scroll">
              {aiSummaryLoading ? (
                <div role="status" aria-label="Генерация сводки">
                  <span className="sr-only">Генерация сводки…</span>
                  <div className="flex flex-col gap-3" aria-hidden>
                    <div className="h-3 w-3/4 rounded-full skeleton" />
                    <div className="h-3 w-full rounded-full skeleton" />
                    <div className="h-3 w-5/6 rounded-full skeleton" />
                    <div className="h-3 w-2/3 rounded-full skeleton" />
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed whitespace-pre-line">
                    {aiSummary.text}
                  </p>
                  {aiSummary.messageCount > 0 && (
                    <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                      {aiSummaryCaption(aiSummary.messageCount)}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Подвал: «Закрыть» + дисклеймер ИИ */}
            <div className="px-5 py-3 border-t border-gray-200/80 dark:border-gray-800/80 flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => onDismissAiSummary?.()}
                className="px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 shadow-lg shadow-purple-600/25 transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
              >
                Закрыть
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Сгенерировано ИИ · может ошибаться
              </p>
            </div>
          </div>
        </div>
      )}

      {/* NEW (v1.0.28) AI: модалка настроек AI-функций — по образцу модалки
          сводки (тёмный backdrop, клик по фону и Esc закрывают, панель —
          animate-scale-in). Внутри — локальный ЧЕРНОВИК настроек: тумблеры
          подсказок/сводки/переводчика, сегмент-контроль числа подсказок и
          селект языка перевода; применяются кнопкой «Готово» (не мгновенно) */}
      {aiSettingsOpen && (
        <div
          onClick={() => setAiSettingsOpen(false)}
          className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in cursor-pointer"
          role="dialog"
          aria-modal="true"
          aria-label="Настройки AI"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-[min(92vw,420px)] max-h-[80vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl overflow-hidden animate-scale-in flex flex-col cursor-default"
          >
            {/* Заголовок: иконка + название + градиентная AI-пилюля + крестик */}
            <div className="px-5 pt-5 pb-3 border-b border-gray-200/80 dark:border-gray-800/80 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-2 rounded-xl bg-purple-500/15 border border-purple-500/30 shrink-0">
                  <Settings2 className="w-4 h-4 text-purple-500 dark:text-purple-300" aria-hidden />
                </div>
                <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-none truncate">
                  Настройки AI
                </h3>
                <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-600 to-fuchsia-500 text-white text-[10px] font-extrabold tracking-widest uppercase leading-none shrink-0">
                  AI
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAiSettingsOpen(false)}
                title="Закрыть"
                aria-label="Закрыть настройки AI"
                className="p-2 rounded-xl text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Тело: три тумблера функций + число подсказок + язык перевода */}
            <div className="flex-1 overflow-y-auto px-5 py-4 vm-scroll flex flex-col gap-4">
              <AiSettingsToggleRow
                icon={<Sparkles className="w-4 h-4" aria-hidden />}
                name="Подсказки ответов"
                description="Варианты быстрых ответов над полем ввода"
                checked={aiSettingsDraft.suggestions}
                onChange={next => setAiSettingsDraft(d => ({ ...d, suggestions: next }))}
              />
              <AiSettingsToggleRow
                icon={<FileText className="w-4 h-4" aria-hidden />}
                name="Сводка переписки"
                description="Краткая выжимка диалога одной кнопкой"
                checked={aiSettingsDraft.summary}
                onChange={next => setAiSettingsDraft(d => ({ ...d, summary: next }))}
              />
              <AiSettingsToggleRow
                icon={<Languages className="w-4 h-4" aria-hidden />}
                name="Переводчик сообщений"
                description="Перевод любого сообщения на выбранный язык"
                checked={aiSettingsDraft.translation}
                onChange={next => setAiSettingsDraft(d => ({ ...d, translation: next }))}
              />

              {/* Число подсказок: сегмент-контроль 1/2/3 (гаснет без подсказок) */}
              <div
                className={`flex items-center justify-between gap-3 transition-opacity ${
                  !aiSettingsDraft.suggestions ? 'opacity-40 pointer-events-none' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 leading-tight">
                    Число подсказок
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                    Сколько вариантов ответа запрашивать
                  </p>
                </div>
                <div className="flex gap-1 p-1 rounded-xl bg-gray-200/70 dark:bg-black/30 shrink-0">
                  {[1, 2, 3].map(n => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setAiSettingsDraft(d => ({ ...d, suggestionCount: n }))}
                      aria-pressed={aiSettingsDraft.suggestionCount === n}
                      title={`${n} ${n === 1 ? 'подсказка' : 'подсказки'}`}
                      className={`w-8 h-7 rounded-lg text-xs font-bold transition-colors focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
                        aiSettingsDraft.suggestionCount === n
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Язык перевода: нативный select с 12 языками (гаснет без переводчика) */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 leading-tight">
                    Язык перевода
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 leading-snug">
                    На него переводятся сообщения
                  </p>
                </div>
                <select
                  value={aiSettingsDraft.translateTarget}
                  onChange={e =>
                    setAiSettingsDraft(d => ({
                      ...d,
                      translateTarget: e.target.value as AiTranslateTarget,
                    }))
                  }
                  disabled={!aiSettingsDraft.translation}
                  title="Язык перевода"
                  aria-label="Язык перевода"
                  className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-gray-800 dark:text-gray-200 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  {Object.entries(AI_LANG_NAMES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Подвал: «Готово» применяет черновик (onUpdateAiSettings в App.tsx) */}
            <div className="px-5 py-3 border-t border-gray-200/80 dark:border-gray-800/80 flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  onUpdateAiSettings?.(aiSettingsDraft);
                  setAiSettingsOpen(false);
                }}
                className="px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 shadow-lg shadow-purple-600/25 transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
              >
                Готово
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Настройки общие для всех чатов
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Top Header */}
      <div className="px-3 sm:px-6 py-4 border-b border-gray-200/80 dark:border-gray-800/80 bg-gray-100/60 dark:bg-gray-950/60 backdrop-blur-md flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {/* FIX (v1.0.21): мобильный режим — кнопка «назад» к списку собеседников */}
          {onBack && (
            <button
              onClick={onBack}
              title="Назад к списку"
              aria-label="Назад к списку собеседников"
              className="md:hidden shrink-0 p-2 -ml-1 rounded-full text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100/80 dark:hover:bg-gray-800/80 active:scale-95 transition-all"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          {/* NEW (v1.0.29) GC: групповой чат — плитка-градиент с Users вместо
              аватара собеседника (у группы нет одного аватара и единого статуса) */}
          {group ? (
            <div
              className="w-10 h-10 rounded-2xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 flex items-center justify-center shrink-0 shadow-md shadow-purple-500/20"
              aria-hidden="true"
            >
              <Users className="w-5 h-5 text-white" />
            </div>
          ) : (
            /* NEW (v1.0.26) S1: градиентное кольцо шапки — консистентно с модалкой профиля
                (purple → fuchsia → amber, p-[2px], +4px к аватару — вёрстку не ломает);
                шапка одна на мобильную и десктопную версии */
            <div className="p-[2px] rounded-full bg-gradient-to-tr from-purple-500 via-fuchsia-500 to-amber-500 shrink-0">
              <Avatar
                src={recipient.avatar}
                name={recipient.username}
                status={recipient.inCallWith ? 'busy' : isRecipientOnline ? 'online' : 'offline'}
                size="md"
              />
            </div>
          )}
          {/* NEW (v1.0.29) GC: min-w-0 — название группы может быть длинным (truncate) */}
          <div className="min-w-0">
            {/* NEW (v1.0.29) GC: в группе — название группы (с усечением) */}
            <h3 className={`font-bold text-base text-gray-900 dark:text-white ${group ? 'truncate' : ''}`}>
              {group ? group.name : recipient.username}
            </h3>
            <p className={`text-xs text-gray-600 dark:text-gray-400 truncate ${group ? 'truncate' : ''}`}>
              {group ? (
                /* NEW (v1.0.29) GC: «N участников · M в сети», M — изумрудным при M>0;
                    печатающие — здесь же (паттерн точек как у личных чатов) */
                groupTyping ? (
                  <>
                    <span className="sr-only">{groupTyping.sr}</span>
                    <span className="text-purple-400 font-medium inline-flex items-center" aria-hidden>
                      {groupTyping.text}
                      <span className="typing-dots">
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    {groupMembersLabel(group.members.length)}
                    {typeof activeGroupOnlineCount === 'number' && activeGroupOnlineCount >= 0 && (
                      <>
                        {' · '}
                        <span className={activeGroupOnlineCount > 0 ? 'text-emerald-400 font-medium' : ''}>
                          {activeGroupOnlineCount} в сети
                        </span>
                      </>
                    )}
                  </>
                )
              ) : isGroupRecipient ? (
                /* NEW (v1.0.29) GC: слепок группы ещё не приехал — нейтральная подпись */
                <span className="text-gray-500">Группа</span>
              ) : isPartnerTyping ? (
                // NEW (v1.0.22) P1: sr-only текст «печатает…» для скринридеров
                <>
                  <span className="sr-only">печатает…</span>
                  <span className="text-purple-400 font-medium inline-flex items-center" aria-hidden>
                    печатает
                    <span className="typing-dots">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </span>
                  </span>
                </>
              ) : recipient.inCallWith ? (
                <span className="text-amber-400">В разговоре с другим пользователем</span>
              ) : isRecipientOnline ? (
                <span className="text-emerald-400">В сети и готов к общению</span>
              ) : (
                <span className="text-gray-500">{formatLastSeen(recipient.lastSeen)}</span>
              )}
            </p>
          </div>
          {/* NEW (v1.0.29) GC: стопка мини-аватаров участников (до 4, без себя) —
              22px, перекрытие -ml-1.5, кольцо в цвет фона шапки; инициалы на
              детерминированном градиенте (тот же хеш, что у цвета имени).
              Скрыта на <640px — в шапке мобильного нет места (счётчик есть в подписи) */}
          {group && groupMiniMembers.length > 0 && (
            <div className="hidden sm:flex items-center pl-1 shrink-0" aria-hidden="true">
              {groupMiniMembers.map((m, i) => (
                <span
                  key={m}
                  title={m}
                  className={`w-[22px] h-[22px] rounded-full bg-gradient-to-br ${groupMemberGradient(m)} ring-2 ring-white dark:ring-gray-900 flex items-center justify-center text-[10px] font-semibold text-white uppercase ${
                    i === 0 ? '' : '-ml-1.5'
                  }`}
                >
                  {Array.from(m.trim())[0] ?? '?'}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {/* v1.0.11: поиск по переписке */}
          <button
            type="button"
            onClick={() => {
              setSearchOpen(v => !v);
              if (searchOpen) setSearchText('');
            }}
            title="Поиск в переписке"
            aria-label="Поиск в переписке"
            // NEW (v1.0.29) QA-MOBILE: на узких экранах шапка перегружена кнопками
            // (текст собеседника сжимался в столбец 52px) — второстепенные кнопки
            // (поиск/экспорт/сводка/настройки AI) скрываем на <640px
            className={`hidden sm:inline-flex p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
              searchOpen
                ? 'bg-indigo-600/20 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30'
                : 'bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <Search className="w-4 h-4" />
          </button>

          {/* NEW (v1.0.25) F2: «без звука» для этого чата — подавляет тон и
              десктоп-уведомления новых сообщений (состояние и персист — в App.tsx).
              Активное (заглушённое) состояние — янтарное, в тон статуса «В разговоре» */}
          {onToggleMute && (
            <button
              type="button"
              onClick={() => onToggleMute()}
              title={isChatMuted ? 'Включить звук уведомлений' : 'Отключить звук уведомлений для этого чата'}
              aria-label={isChatMuted ? 'Включить звук уведомлений' : 'Отключить звук уведомлений для этого чата'}
              aria-pressed={isChatMuted}
              className={`p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
                isChatMuted
                  ? 'text-amber-500 bg-amber-500/15 border border-amber-500/30'
                  : 'bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:text-amber-500 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {isChatMuted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
            </button>
          )}

          {/* NEW (v1.0.26) F2: экспорт переписки в файл .txt — вся текущая беседа
              (шапка файла, тела сообщений, метки правки/ответа/реакций) в один клик.
              Изумрудный hover-акцент (индиговый — поиск, янтарный — звук); только
              когда в беседе есть сообщения */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleExportChat}
              title="Экспорт переписки в файл"
              aria-label="Экспорт переписки в файл"
              className="hidden sm:inline-flex p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-emerald-500"
            >
              <Download className="w-4 h-4" />
            </button>
          )}

          {/* NEW (v1.0.27) AI: сводка переписки (LLM на сервере) — запрашивает
              саммари беседы и открывает модальную панель; в полёте иконка
              крутится и кнопка заблокирована. Фиолетовый акцент — семейство
              AI-элементов (Sparkles/чипы — в композере, та же гамма).
              NEW (v1.0.28) AI: скрывается, если сводка выключена в настройках */}
          {aiSummaryEnabled && onRequestAiSummary && (
            <button
              type="button"
              onClick={() => onRequestAiSummary()}
              disabled={aiSummaryLoading}
              title="Сводка переписки (AI)"
              aria-label="Сводка переписки (AI)"
              className={`hidden sm:inline-flex p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                aiSummaryLoading
                  ? 'text-purple-500 bg-purple-500/10'
                  : 'bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-purple-400'
              }`}
            >
              <FileText className={`w-4 h-4 ${aiSummaryLoading ? 'animate-spin' : ''}`} />
            </button>
          )}

          {/* NEW (v1.0.28) AI: настройки AI-функций (подсказки/сводка/переводчик)
              — шестерёнка открывает модалку; стиль зеркалит кнопку сводки.
              Гейт на onUpdateAiSettings — паттерн «кнопки только при переданном
              колбэке» (до вайринга App.tsx кнопки нет) */}
          {onUpdateAiSettings && (
            <button
              type="button"
              onClick={() => setAiSettingsOpen(true)}
              title="Настройки AI"
              aria-label="Настройки AI"
              className="hidden sm:inline-flex p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-purple-400"
            >
              <Settings2 className="w-4 h-4" />
            </button>
          )}

          {/* NEW (v1.0.29) GC: в групповом чате кнопки звонка нет (звонки —
              только 1-на-1): вместо неё — ghost-кнопка управления группой
              (модалка живёт в App.tsx), фиолетовый hover. Гейт на
              onOpenGroupPanel: пока App.tsx не пробрасывает колбэк, кнопки нет
              (паттерн onUpdateAiSettings из v1.0.28) */}
          {isGroupRecipient ? (
            onOpenGroupPanel ? (
              <button
                type="button"
                onClick={() => onOpenGroupPanel()}
                title="Управление группой"
                aria-label="Управление группой"
                className="p-2.5 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:text-purple-500 dark:hover:text-purple-300 hover:bg-purple-500/10"
              >
                <UsersRound className="w-4 h-4" />
              </button>
            ) : null
          ) : (
            <button
              onClick={() => onStartCall(recipient)}
              disabled={isCurrentCallWithRecipient || !!recipient.inCallWith || !isRecipientOnline}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-md ${
                isCurrentCallWithRecipient
                  ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 cursor-default'
                  : !isRecipientOnline || recipient.inCallWith
                  ? 'bg-white dark:bg-gray-800 text-gray-500 cursor-not-allowed'
                  : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-600/20 active:scale-95'
              }`}
            >
              <Phone className="w-4 h-4" />
              {/* NEW (v1.0.29) QA-MOBILE: на <640px — только иконка (текст
                  «Позвонить» съедал ~70px шапки), подсказка — в title кнопки */}
              <span className="hidden sm:inline" title={isCurrentCallWithRecipient ? 'Идет звонок' : isRecipientOnline ? 'Позвонить' : 'Не в сети'}>
                {isCurrentCallWithRecipient ? 'Идет звонок' : isRecipientOnline ? 'Позвонить' : 'Не в сети'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* v1.0.11: панель поиска по переписке (на мобильных — отдельной строкой под шапкой) */}
      {searchOpen && (
        <div className="px-3 sm:px-6 py-2.5 border-b border-gray-200/80 dark:border-gray-800/80 bg-gray-100/80 dark:bg-gray-950/80 backdrop-blur-md flex items-center gap-2 animate-reply-bar">
          <Search className="w-4 h-4 text-gray-500 shrink-0" />
          <input
            autoFocus
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Найти сообщение в этой переписке..."
            className="flex-1 min-w-0 bg-transparent text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 rounded-lg px-1"
          />
          {searchText.trim() && (
            <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums">
              {/* NEW (v1.0.22) N1: счётчик «Найдено: N» (или «Ничего не найдено») */}
              {matchIds.length > 0
                ? `Найдено: ${matchIds.length}`
                : 'Ничего не найдено'}
            </span>
          )}
          <button
            type="button"
            onClick={() => handleSearchNav(-1)}
            disabled={matchIds.length === 0}
            title="Предыдущее совпадение"
            className="p-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => handleSearchNav(1)}
            disabled={matchIds.length === 0}
            title="Следующее совпадение (Enter)"
            className="p-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearchText(''); }}
            title="Закрыть поиск"
            className="p-1.5 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Messages Stream */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        // NEW (v1.0.22) P7: чуть более толстый скроллбар (8px) для области сообщений
        // NEW (v1.0.25) S2: точечный фон-паттерн ленты (.chat-dots-bg в index.css —
        // очень тонкий в обеих темах; фон статичен относительно контейнера)
        className="chat-scroll chat-dots-bg flex-1 overflow-y-auto p-6"
      >
        {/* NEW (v1.0.24) S1: скелетоны загрузки истории — пока chat:history едет
            с сервера (первое открытие беседы), вместо пустого состояния показываем
            шиммер-заглушки (класс .skeleton из index.css), имитирующие ленту.
            Роль status + sr-only — скринридеры слышат «Загрузка истории…». */}
        {messages.length === 0 && isHistoryLoading ? (
          <div
            role="status"
            aria-label="Загрузка истории сообщений"
            className="max-w-3xl w-full mx-auto flex flex-col gap-5 py-4 px-2"
          >
            <span className="sr-only">Загрузка истории сообщений…</span>
            {[0, 1, 0, 1, 0].map((side, i) => (
              <div
                key={i}
                className={`flex gap-2.5 items-end ${side ? 'flex-row-reverse' : 'flex-row'}`}
                aria-hidden
              >
                <div className="w-8 h-8 rounded-full skeleton shrink-0" />
                <div className={`flex flex-col gap-1.5 max-w-[60%] ${side ? 'items-end' : 'items-start'}`}>
                  <div className="h-2.5 w-16 rounded-full skeleton" />
                  <div
                    className={`h-10 rounded-2xl skeleton ${
                      side ? 'rounded-tr-none' : 'rounded-tl-none'
                    } ${['w-44', 'w-60', 'w-36', 'w-52', 'w-64'][i % 5]}`}
                  />
                  {i % 2 === 0 && <div className="h-2.5 w-12 rounded-full skeleton" />}
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 max-w-sm mx-auto my-auto animate-in fade-in duration-300">
            {group ? (
              /* NEW (v1.0.29) GC: пустая группа — плитка-градиент с Users вместо
                 аватара собеседника + подсказка «напишите первым»; без кнопки
                 «помашите ручкой» (личное приветствие — фича личных чатов) */
              <>
                <div className="relative mb-3">
                  <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 flex items-center justify-center shadow-2xl ring-4 ring-purple-500/20">
                    <Users className="w-10 h-10 text-white/90" aria-hidden />
                  </div>
                </div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-1.5">
                  {group.name}
                </h3>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-6 leading-relaxed">
                  Нет сообщений — напишите первым!
                </p>
              </>
            ) : (
              <>
                <div className="relative mb-3">
                  <Avatar
                    src={recipient.avatar}
                    name={recipient.username}
                    size="2xl"
                    className="shadow-2xl ring-4 ring-purple-500/20"
                  />
                </div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-1.5">
                  {recipient.username}
                </h3>
                <p className="text-xs text-gray-600 dark:text-gray-400 mb-6 leading-relaxed">
                  {/* NEW (v1.0.22) P3: единая подсказка для пустой беседы */}
                  {isRecipientOnline ? (
                    <>Напишите первое сообщение — текст или голосовое 🎤</>
                  ) : (
                    <>Напишите первое сообщение — текст или голосовое 🎤 — <span className="text-gray-700 dark:text-gray-300 font-semibold">{recipient.username}</span> увидит его, когда зайдёт в сеть.</>
                  )}
                </p>

                {/* Discord-style wave button */}
                <button
                  type="button"
                  onClick={handleSendWaveGreeting}
                  className="inline-flex items-center gap-3 px-6 py-3 bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold rounded-2xl shadow-xl shadow-purple-600/25 transition-all transform hover:scale-105 active:scale-95 group border border-purple-400/30 cursor-pointer"
                >
                  <img
                    src="/wave.webp"
                    alt="Wave"
                    className="w-7 h-7 object-contain group-hover:rotate-12 transition-transform drop-shadow"
                  />
                  <span>Помашите ручкой 👋</span>
                </button>
              </>
            )}
          </div>
        ) : (
          (() => {
            let prevMsg: ChatMessage | null = null;
            let lastDay = '';
            return messages.map((msg, idx) => {
              const isMe = msg.senderName === currentUser.username;
              const isWave = msg.mediaUrl === '/wave.webp' && !msg.deleted;

              // NEW (v1.0.25) R1: записи реакций с непустыми списками реагировавших
              // (эмодзи → usernames); удалённым сообщениям реакции не показываем.
              // Array.isArray — страховка от битой формы в кэше/истории.
              const reactionEntries =
                !msg.deleted && msg.reactions
                  ? Object.entries(msg.reactions).filter(
                      ([, users]) => Array.isArray(users) && users.length > 0
                    )
                  : [];

              // NEW (v1.0.28) AI: состояние перевода ЭТОГО сообщения (undefined —
              // перевода нет, 'loading' — запрос в полёте, 'done' — готовый текст);
              // копия в локальную константу — узкий тип внутри JSX без повторных
              // обращений к Record
              const aiTr = aiTranslations[msg.id];

              // NEW (v1.0.26) F5: реакции ЦИТИРУЕМОГО сообщения (для чипов в цитате
              // ответа): лукап replyTo.id в текущей ленте; если цитируемого нет в
              // ленте или оно удалено — чипов не показываем
              const quotedReactionEntries = (() => {
                if (msg.deleted || !msg.replyTo) return [];
                const quoted = messages.find(m => m.id === msg.replyTo!.id);
                if (!quoted || quoted.deleted || !quoted.reactions) return [];
                return Object.entries(quoted.reactions).filter(
                  ([, users]) => Array.isArray(users) && users.length > 0
                );
              })();

              // v1.0.11: разделитель дней (Сегодня / Вчера / дата)
              const day = new Date(msg.timestamp).toDateString();
              const dayChanged = day !== lastDay;
              if (dayChanged) lastDay = day;

              // v1.0.10: группировка подряд идущих сообщений одного автора
              const isGrouped = Boolean(
                prevMsg &&
                !isWave &&
                !dayChanged &&
                prevMsg.senderName === msg.senderName &&
                msg.mediaType !== 'image' &&
                (msg.timestamp - prevMsg.timestamp) < 3 * 60 * 1000
              );
              const rowMargin = idx === 0 || !isGrouped ? (dayChanged ? 'mt-4' : 'mt-0') : 'mt-0.5';

              // запоминаем предыдущее сообщение для группировки на следующей итерации
              const prevForNext = msg;

              // v1.0.10: галочка прочтения для своих сообщений
              // NEW (v1.0.30) GR: в группе — квитанции по участникам. Своё
              // сообщение «прочитано», когда КАЖДЫЙ другой участник дочитал
              // беседу до его timestamp (groupReadState от App: имя → ms).
              // Все дочитали → ✓✓ emerald «Прочитано» (с soft-переходом
              // transition-colors при смене ✓→✓✓); иначе одиночная серая ✓
              // с прогрессом в тултипе «Отправлено · прочитали N из M».
              // Без слепка группы (activeGroup ещё не приехал) и в группе
              // из одного себя — прежняя одиночная ✓ «Отправлено» (v1.0.29).
              // Личные чаты — без изменений (msg.read)
              // NEW (v1.0.30) GR: счётчик читателей — примитив, считается
              // простым циклом по groupOtherMembers (≤20 имён); Map'ы
              // groupReadStateLower/groupOtherMembers подготовлены выше
              // в useMemo — новых объектов на сообщение не создаём
              let groupReadByCount = 0;
              if (isGroupChat && isMe && !msg.deleted && groupOtherMembers.length > 0) {
                for (const memberName of groupOtherMembers) {
                  if ((groupReadStateLower.get(memberName.toLowerCase()) ?? 0) >= msg.timestamp) {
                    groupReadByCount++;
                  }
                }
              }
              const groupOthersTotal = groupOtherMembers.length;
              // полный прогресс возможен только при непустом списке других участников
              const groupFullyRead = groupOthersTotal > 0 && groupReadByCount === groupOthersTotal;
              const groupReceiptLabel =
                isGroupChat && groupOthersTotal > 0
                  ? `Отправлено · прочитали ${groupReadByCount} из ${groupOthersTotal}`
                  : 'Отправлено';
              const receipt = isMe && !msg.deleted ? (
                isGroupRecipient ? (
                  groupFullyRead ? (
                    <CheckCheck
                      className="w-3.5 h-3.5 text-emerald-400 shrink-0 transition-colors"
                      aria-label="Прочитано"
                    >
                      <title>Прочитано</title>
                    </CheckCheck>
                  ) : (
                    <Check
                      className="w-3.5 h-3.5 text-gray-500 shrink-0 transition-colors"
                      aria-label={groupReceiptLabel}
                    >
                      <title>{groupReceiptLabel}</title>
                    </Check>
                  )
                ) : msg.read ? (
                  <CheckCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-label="Прочитано" />
                ) : (
                  <Check className="w-3.5 h-3.5 text-gray-500 shrink-0" aria-label="Отправлено" />
                )
              ) : null;

              const node = (
                <div
                  key={msg.id}
                  ref={el => {
                    if (el) messageRefs.current.set(msg.id, el);
                    else messageRefs.current.delete(msg.id);
                  }}
                  className={`flex gap-2.5 items-end ${isMe ? 'flex-row-reverse' : 'flex-row'} ${rowMargin} ${idx === messages.length - 1 ? 'animate-msg-in' : ''} ${highlightId === msg.id ? 'flash-msg rounded-2xl' : ''}`}
                >
                  {/* Sender Avatar (в группировке — прозрачный распорка) */}
                  {isGrouped ? (
                    <div className="w-8 shrink-0" aria-hidden />
                  ) : (
                    <Avatar
                      src={isMe ? currentUser.avatar : (msg.senderAvatar || recipient.avatar)}
                      name={isMe ? currentUser.username : msg.senderName}
                      size="sm"
                      className="mb-1 shrink-0"
                    />
                  )}

                  <div className={`relative flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[75%] group/msg`}>
                    {!isGrouped && (
                      <div className="flex items-baseline gap-2 mb-1 px-1">
                        {/* NEW (v1.0.29) GC: в группе имя отправителя-«не себя» —
                            чип 11px font-semibold цветом палитры (hash имени);
                            свои сообщения в группе — без имени (только время
                            и галочка). В личных чатах — прежнее серое имя/«Вы» */}
                        {isGroupChat && !isMe ? (
                          <span className={`text-[11px] font-semibold ${groupMemberColor(msg.senderName)}`}>
                            {msg.senderName}
                          </span>
                        ) : !isGroupChat ? (
                          <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                            {isMe ? 'Вы' : msg.senderName}
                          </span>
                        ) : null}
                        <span className="text-[11px] text-gray-500">
                          {formatTime(msg.timestamp)}
                        </span>
                        {receipt}
                      </div>
                    )}

                    {/* v1.0.12: hover-действия — ответить / копировать / переслать / удалить */}
                    {/* FIX (v1.0.21): на тач-устройствах действия ВСЕГДА видимы (opacity-60),
                        на десктопе — как раньше, проявляются при наведении. Заодно
                        на узких экранах ряд прижат к пузырю, а не уезжает за экран */}
                    {!msg.deleted && (
                      <div
                        className={`msg-actions absolute -top-2 z-10 flex flex-row gap-1 opacity-60 transition-all duration-150 sm:translate-y-1 sm:opacity-0 sm:group-hover/msg:translate-y-0 sm:group-hover/msg:opacity-100 ${
                          isMe
                            ? 'right-0 sm:right-auto sm:-left-32'
                            : 'left-0 sm:left-auto sm:-right-32'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setReplyTo(msg)}
                          title="Ответить"
                          className="p-1.5 rounded-lg bg-white/90 dark:bg-gray-800/90 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-indigo-300 hover:border-indigo-500/50 transition-colors shadow-lg"
                        >
                          <CornerUpLeft className="w-3.5 h-3.5" />
                        </button>
                        {msg.text && (
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(msg)}
                            title={copiedId === msg.id ? 'Скопировано!' : 'Копировать текст'}
                            className={`p-1.5 rounded-lg bg-white/90 dark:bg-gray-800/90 border transition-colors shadow-lg ${
                              copiedId === msg.id
                                ? 'border-emerald-500/60 text-emerald-400'
                                : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-emerald-300 hover:border-emerald-500/50'
                            }`}
                          >
                            {copiedId === msg.id ? (
                              <Check className="w-3.5 h-3.5 animate-pop-badge" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {/* NEW (v1.0.28) AI: перевод сообщения (LLM на сервере) —
                            небесный акцент ряда действий (индиговый — ответ,
                            изумрудный — копия, янтарный — реакция, фиолетовый —
                            правка, красный — удаление). Нет записи в aiTranslations —
                            запросить перевод; в полёте — спиннер (заблокирована);
                            готово — активная небесная кнопка скрывает перевод */}
                        {!msg.deleted && msg.text && aiTranslationEnabled && onRequestAiTranslation && (
                          <button
                            type="button"
                            onClick={() => {
                              if (aiTr?.status === 'loading') return; // в полёте кнопка disabled — это страховка
                              if (aiTr) onDismissAiTranslation?.(msg.id); // перевод показан — скрыть
                              else if (msg.text) onRequestAiTranslation(msg.id, msg.text);
                            }}
                            disabled={aiTr?.status === 'loading'}
                            title={
                              aiTr?.status === 'loading'
                                ? 'Переводим…'
                                : aiTr
                                ? 'Скрыть перевод'
                                : 'Перевести сообщение'
                            }
                            aria-label={
                              aiTr?.status === 'loading'
                                ? 'Переводим сообщение'
                                : aiTr
                                ? 'Скрыть перевод'
                                : 'Перевести сообщение'
                            }
                            aria-busy={aiTr?.status === 'loading'}
                            className={`p-1.5 rounded-lg border transition-colors shadow-lg disabled:cursor-not-allowed ${
                              aiTr
                                ? 'bg-sky-500/15 border-sky-500/40 text-sky-400 hover:bg-sky-500/25'
                                : 'bg-white/90 dark:bg-gray-800/90 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-sky-400 hover:border-sky-500/50'
                            }`}
                          >
                            {aiTr?.status === 'loading' ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Languages className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {onRequestForward && (
                          <button
                            type="button"
                            onClick={() => onRequestForward(msg)}
                            title="Переслать сообщение"
                            className="p-1.5 rounded-lg bg-white/90 dark:bg-gray-800/90 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-indigo-300 hover:border-indigo-500/50 transition-colors shadow-lg"
                          >
                            <Forward className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* NEW (v1.0.25) R1: реакция — доступна на ЛЮБОЕ сообщение
                            беседы (своё и собеседника), открывает пикер 8 эмодзи.
                            Янтарный акцент (индиговый — ответ, фиолетовый — правка,
                            красный — удаление); data-reaction-toggle — чтобы клик
                            по тогглу НЕ закрывал пикер раньше собственного onClick */}
                        {onReactMessage && (
                          <button
                            type="button"
                            data-reaction-toggle
                            onClick={() => toggleReactionPicker(msg.id)}
                            title="Поставить реакцию"
                            aria-label="Реакция"
                            aria-expanded={reactionPickerFor === msg.id}
                            className={`p-1.5 rounded-lg border transition-colors shadow-lg ${
                              reactionPickerFor === msg.id
                                ? 'bg-amber-500/15 border-amber-500/40 text-amber-500'
                                : 'bg-white/90 dark:bg-gray-800/90 border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-amber-500 hover:border-amber-500/50'
                            }`}
                          >
                            <SmilePlus className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* NEW (v1.0.24) E1: правка СВОЕГО текстового сообщения —
                            только в 48-часовом окне (синхронизировано с сервером) */}
                        {isMe && msg.text && !msg.deleted && onEditMessage &&
                          Date.now() - msg.timestamp < EDIT_WINDOW_MS && (
                          <button
                            type="button"
                            onClick={() => startEditMessage(msg)}
                            title="Изменить сообщение"
                            aria-label="Изменить сообщение"
                            className="p-1.5 rounded-lg bg-white/90 dark:bg-gray-800/90 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-purple-400 hover:border-purple-500/50 transition-colors shadow-lg active:scale-90"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isMe && onDeleteMessage && (
                          <button
                            type="button"
                            onClick={() => onDeleteMessage(msg.id)}
                            title="Удалить сообщение"
                            className="p-1.5 rounded-lg bg-white/90 dark:bg-gray-800/90 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:text-red-400 hover:border-red-500/50 transition-colors shadow-lg"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {/* NEW (v1.0.25) R1: пикер реакций — стеклянный поповер над
                        сообщением (z-20 над пузырями): 8 эмодзи серверного allowlist.
                        Клик — отправить реакцию (сервер делает toggle) и закрыть;
                        уже стоящая своя реакция подсвечена фиолетовым фоном */}
                    {reactionPickerFor === msg.id && (
                      <div
                        ref={reactionPickerRef}
                        role="group"
                        aria-label="Выбор реакции"
                        className={`animate-reaction-picker absolute bottom-full z-20 mb-2 ${
                          isMe ? 'right-0' : 'left-0'
                        } bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border border-gray-200 dark:border-gray-700 shadow-xl shadow-black/10 dark:shadow-black/40 rounded-2xl px-2 py-1.5 flex gap-0.5`}
                      >
                        {REACTION_EMOJIS.map(emoji => {
                          const mine = Boolean(
                            msg.reactions?.[emoji]?.some(
                              u => u.toLowerCase() === selfUsernameLower
                            )
                          );
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => handleReact(msg.id, emoji)}
                              title={mine ? `Убрать реакцию ${emoji}` : `Поставить реакцию ${emoji}`}
                              aria-label={`Реакция ${emoji}`}
                              aria-pressed={mine}
                              className={`w-8 h-8 flex items-center justify-center rounded-xl text-lg leading-none transition-all duration-150 hover:scale-125 active:scale-95 ${
                                mine
                                  ? 'bg-purple-500/20 hover:bg-purple-500/30'
                                  : 'hover:bg-purple-500/15'
                              }`}
                            >
                              {emoji}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {msg.deleted ? (
                      /* v1.0.11: удалённое сообщение */
                      <div className="px-4 py-2.5 rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-900/40 text-gray-500 text-sm italic flex items-center gap-2">
                        <Ban className="w-4 h-4 shrink-0" aria-hidden />
                        <span>Сообщение удалено</span>
                      </div>
                    ) : isWave ? (
                      /* Discord-style wave greeting card */
                      <div
                        className={`p-3 rounded-2xl shadow-lg border transition-all ${
                          isMe
                            ? 'bg-purple-950/40 border-purple-500/40 text-purple-100 rounded-tr-none'
                            : 'bg-gray-50/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100 rounded-tl-none'
                        }`}
                      >
                        <div className="flex flex-col items-center gap-2">
                          <img
                            src="/wave.webp"
                            alt="Wave greeting"
                            className="w-28 h-auto object-contain rounded-xl hover:scale-105 transition-transform drop-shadow"
                          />
                          <span className="text-xs font-semibold tracking-wide text-center px-2 py-0.5 bg-black/40 rounded-lg text-purple-200">
                            {msg.text || `👋 ${msg.senderName} машет ручкой!`}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div
                        // NEW (v1.0.25) R1: двойной клик по текстовому пузырю —
                        // быстрая реакция ❤️ (сервер делает toggle ❤️). На фото и
                        // голосовые не вешаем: там первый клик открывает лайтбокс/
                        // плеер; одиночный клик по текстовому пузырю ничего не
                        // делает — конфликта нет.
                        onDoubleClick={
                          !msg.deleted && msg.mediaType !== 'image' && msg.mediaType !== 'voice'
                            ? () => onReactMessage?.(msg.id, '❤️')
                            : undefined
                        }
                        title={`${msg.senderName} · ${formatTime(msg.timestamp)}`}
                        className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-md break-words transition-shadow hover:shadow-lg ${
                          isMe
                            ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white ' + (isGrouped ? 'rounded-tr-xl' : 'rounded-tr-none')
                            : 'bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-800 dark:text-gray-200 ' + (isGrouped ? 'rounded-tl-xl' : 'rounded-tl-none')
                        }`}
                      >
                        {/* v1.0.12: метка пересланного сообщения */}
                        {msg.forwardedFrom && (
                          <div className="flex items-center gap-1.5 mb-1.5 text-[11px] italic text-indigo-600/80 dark:text-indigo-200/80">
                            <Forward className="w-3 h-3 shrink-0" />
                            <span>
                              Переслано от{' '}
                              <span className="font-semibold not-italic">
                                {msg.forwardedFrom === currentUser.username ? 'вас' : msg.forwardedFrom}
                              </span>
                            </span>
                          </div>
                        )}

                        {/* v1.0.11: цитата ответа */}
                        {msg.replyTo && (
                          <div
                            onClick={() => jumpToMessage(msg.replyTo!.id)}
                            title="Перейти к сообщению"
                            className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-[3px] cursor-pointer transition-colors ${
                              isMe
                                ? 'bg-black/20 border-white/70 hover:bg-black/30'
                                : 'bg-white/80 dark:bg-gray-800/80 border-indigo-400/80 hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                          >
                            <p className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-300 leading-tight">
                              {msg.replyTo.senderName === currentUser.username ? 'Вы' : msg.replyTo.senderName}
                            </p>
                            <p className="text-[11px] text-gray-700/90 dark:text-gray-300/90 leading-snug">
                              {replySnippet({ text: msg.replyTo.text, mediaType: msg.replyTo.mediaType, deleted: false })}
                            </p>
                            {/* NEW (v1.0.26) F5: чипы реакций цитируемого сообщения —
                                «emoji ×счётчик»; цвета приглушённые, у цитаты свой фон */}
                            {quotedReactionEntries.length > 0 && (
                              <div className="mt-1 flex gap-1 flex-wrap">
                                {quotedReactionEntries.map(([emoji, users]) => (
                                  <span
                                    key={emoji}
                                    className="text-[10px] leading-none px-1 py-0.5 rounded-full bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10"
                                  >
                                    {emoji} ×{users.length}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Image Attachment */}
                        {msg.mediaType === 'image' && msg.mediaUrl && (
                          <div className="mb-2">
                            <img
                              src={msg.mediaUrl}
                              alt="Photo"
                              onClick={() => setSelectedLightboxImage(msg.mediaUrl || null)}
                              className="rounded-xl max-h-72 w-auto object-cover cursor-pointer hover:opacity-95 transition-opacity border border-black/20"
                            />
                          </div>
                        )}

                        {/* Voice Note */}
                        {msg.mediaType === 'voice' && msg.mediaUrl && (
                          <AudioMessagePlayer
                            src={msg.mediaUrl}
                            duration={msg.duration}
                            isMe={isMe}
                          />
                        )}

                        {/* Text content if present */}
                        {msg.text && <p className="whitespace-pre-wrap">{highlightText(msg.text)}</p>}

                        {/* NEW (v1.0.24) E1: метка правки — «изменено в ЧЧ:ММ».
                            У своих пузырей текст белый (акцентный градиент одинаков
                            в обеих темах), у входящих — приглушённый серый по теме */}
                        {msg.edited && (
                          <span
                            className={`flex items-center justify-end gap-1 text-[10px] italic mt-0.5 ${
                              isMe
                                ? 'text-white/60'
                                : 'text-gray-500 dark:text-gray-500'
                            }`}
                            title={msg.editedAt ? `Изменено: ${new Date(msg.editedAt).toLocaleString()}` : 'Изменено'}
                          >
                            <Pencil className="w-2.5 h-2.5 shrink-0" aria-hidden />
                            изменено{msg.editedAt ? ` в ${formatTime(msg.editedAt)}` : ''}
                          </span>
                        )}
                      </div>
                    )}

                    {/* NEW (v1.0.28) AI: блок перевода под пузырём — стеклянная
                        небесная плашка с левой полосой-акцентом (или скелетон-полоса
                        с подписью «Перевод…», пока запрос в полёте); выравнивание —
                        по стороне пузыря (isMe), крестик скрывает перевод.
                        Удалённым сообщениям перевод не показываем (кнопки там нет) */}
                    {!msg.deleted && aiTr && (
                      <div
                        className={`mt-1 max-w-[85%] sm:max-w-[70%] ${isMe ? 'self-end' : 'self-start'}`}
                      >
                        {aiTr.status === 'loading' ? (
                          <div role="status">
                            <span className="sr-only">Переводим сообщение…</span>
                            <div
                              className="w-3/5 animate-pulse h-4 rounded-md bg-gray-200 dark:bg-gray-700"
                              aria-hidden
                            />
                            <p className="mt-1 text-[11px] text-gray-400">Перевод…</p>
                          </div>
                        ) : aiTr.translated ? (
                          <div
                            className={`rounded-xl border border-sky-500/20 border-l-2 border-l-sky-400/70 bg-sky-50/80 dark:bg-sky-500/5 px-3 py-2 ${
                              isMe ? 'rounded-tr-sm' : 'rounded-tl-sm'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
                                {/* NEW (v1.0.29) AI: LLM определяет исходный язык —
                                  «английский → русский»; без sourceLang — просто «на русский» */}
                              Перевод (AI) ·{' '}
                              {aiTr.sourceLang
                                ? `${aiTr.sourceLang} → ${aiTranslateTargetName}`
                                : `на ${aiTranslateTargetName}`}
                              </span>
                              <button
                                type="button"
                                onClick={() => onDismissAiTranslation?.(msg.id)}
                                title="Скрыть перевод"
                                aria-label="Скрыть перевод"
                                className="p-0.5 rounded text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 transition-colors shrink-0"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                            <p className="mt-0.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">
                              {aiTr.translated}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    )}

                    {/* v1.0.10: в группировке время + галочка — под пузырём */}
                    {isGrouped && !msg.deleted && (
                      <div className={`flex items-center gap-1 px-1 mt-0.5 ${isMe ? 'flex-row-reverse' : ''}`}>
                        <span className="text-[10px] text-gray-400 dark:text-gray-600">{formatTime(msg.timestamp)}</span>
                        {receipt}
                      </div>
                    )}

                    {/* NEW (v1.0.25) R1: пилюли реакций под пузырём — по одной на
                        эмодзи со счётчиком; своя реакция подсвечена фиолетовым;
                        у своих сообщений пилюли читаются справа налево (flex-row-reverse).
                        NEW (v1.0.26) F3: клик по пилюле — поповер «кто отреагировал»
                        (toggle остаётся в пикере/двойном клике); каждая пилюля
                        обёрнута в relative-спан — от него позиционируется поповер */}
                    {reactionEntries.length > 0 && (
                      <div className={`mt-1 flex flex-wrap gap-1 ${isMe ? 'flex-row-reverse' : ''}`}>
                        {reactionEntries.map(([emoji, users]) => {
                          const selfReacted = users.some(
                            u => u.toLowerCase() === selfUsernameLower
                          );
                          const reactors = users
                            .map(u => (u.toLowerCase() === selfUsernameLower ? 'вы' : u))
                            .join(', ');
                          // NEW (v1.0.26) F3: клик по пилюле — поповер «кто отреагировал» (toggle остаётся в пикере/двойном клике)
                          const popoverOpen =
                            reactorsFor !== null &&
                            reactorsFor.messageId === msg.id &&
                            reactorsFor.emoji === emoji;
                          return (
                            <span
                              key={emoji}
                              className="relative inline-flex"
                              data-reactors-toggle
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setReactorsFor(
                                    popoverOpen ? null : { messageId: msg.id, emoji }
                                  )
                                }
                                aria-expanded={popoverOpen}
                                aria-label={`Реакция ${emoji}: ${users.length} — кто отреагировал`}
                                title={`Реакция ${emoji} — кто отреагировал: ${reactors}`}
                                className={`px-1.5 py-0.5 rounded-full flex items-center gap-1 border transition-all active:scale-90 cursor-pointer animate-reaction-pop ${
                                  selfReacted
                                    ? 'bg-purple-500/15 border-purple-500/40 text-purple-700 dark:text-purple-300 shadow-sm'
                                    : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-purple-400/50'
                                }`}
                              >
                                <span className="text-xs leading-none">{emoji}</span>
                                <span className="text-[10px] font-bold">{users.length}</span>
                              </button>
                              {popoverOpen && (
                                /* NEW (v1.0.26) F3: поповер «кто отреагировал» —
                                   стеклянный, с Avatar-инициалами и именами (своё
                                   имя — «вы» + галочка); клик вне закрывает */
                                <div
                                  ref={reactorsPopoverRef}
                                  role="dialog"
                                  aria-label={`Отреагировали ${emoji}`}
                                  className="animate-reaction-picker absolute bottom-full mb-1.5 z-30 left-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border border-gray-200 dark:border-gray-700 shadow-xl rounded-xl p-2 min-w-[9rem] max-w-[14rem]"
                                >
                                  <div className="flex items-center gap-1.5 px-1.5 py-1">
                                    <span className="text-sm leading-none" aria-hidden>{emoji}</span>
                                    <span className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                                      отреагировали
                                    </span>
                                  </div>
                                  {users.map(u => {
                                    const isSelf = u.toLowerCase() === selfUsernameLower;
                                    return (
                                      <div key={u} className="flex items-center gap-2 px-1.5 py-1">
                                        <Avatar name={u} size="xs" />
                                        <span className="text-xs text-gray-700 dark:text-gray-200 truncate">
                                          {isSelf ? 'вы' : u}
                                        </span>
                                        {isSelf && (
                                          <Check
                                            className="w-3 h-3 text-purple-500 shrink-0 ml-auto"
                                            aria-label="Это вы"
                                          />
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );

              prevMsg = prevForNext;
              // если день изменился — сначала вставляем разделитель
              // NEW (v1.0.22) N5: заодно — разделитель «Новые сообщения» над первым
              // непрочитанным входящим (не первым в списке)
              if (dayChanged || msg.id === firstUnreadId) {
                return (
                  <React.Fragment key={`frag_${msg.id}`}>
                    {dayChanged && (
                      <div key={`day_${day}`} className="flex items-center gap-3 my-4 animate-fade-in">
                        <div className="h-px flex-1 bg-gray-200/80 dark:bg-gray-800/80" />
                        {/* NEW (v1.0.22) N4: чип даты — bg-white/5 вместо серого бокса */}
                        <span className="px-3 py-1 bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-gray-800 rounded-full text-[11px] text-gray-600 dark:text-gray-400 font-medium whitespace-nowrap">
                          {formatDayLabel(msg.timestamp)}
                        </span>
                        <div className="h-px flex-1 bg-gray-200/80 dark:bg-gray-800/80" />
                      </div>
                    )}
                    {msg.id === firstUnreadId && (
                      <div key={`new_${msg.id}`} className="flex justify-center my-2 animate-fade-in">
                        <span className="px-3 py-1 rounded-full bg-purple-500/15 text-purple-700 dark:text-purple-300 text-[11px] font-semibold border border-purple-500/30">
                          Новые сообщения
                        </span>
                      </div>
                    )}
                    {node}
                  </React.Fragment>
                );
              }
              return node;
            });
          })()
        )}
        {/* NEW (v1.0.23) TB1: пузырь «печатает…» в конце ленты — аватар партнёра +
            три точки (.typing-dots из index.css, цвет точек = currentColor).
            Подпись «печатает…» в шапке чата остаётся (не дублируется текстом).
            NEW (v1.0.29) GC: в группах пузырь не показываем — «кто печатает»
            живут в подзаголовке шапки (isPartnerTyping — только личные чаты) */}
        {!isGroupChat && isPartnerTyping && (
          <div className="flex gap-2.5 items-end mt-0.5 animate-msg-in">
            <Avatar
              src={recipient.avatar}
              name={recipient.username}
              size="sm"
              className="mb-1 shrink-0"
            />
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-bl-md px-3.5 py-2 text-gray-500">
              <span className="sr-only">печатает…</span>
              <span className="typing-dots" aria-hidden>
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* v1.0.12: плавающая кнопка «вниз» */}
      {/* NEW (v1.0.22) N7: круглая кнопка (ArrowDown) с бейджем непрочитанных
          входящих; показывается при прокрутке >~300px от низа, плавное
          появление/скрытие (opacity), у низа не видна */}
      <button
        type="button"
        onClick={handleScrollDownClick}
        title={scrollBadgeCount > 0 ? `Новых сообщений: ${scrollBadgeCount}` : 'Прокрутить вниз'}
        aria-label={scrollBadgeCount > 0 ? `Прокрутить вниз, новых сообщений: ${scrollBadgeCount}` : 'Прокрутить вниз'}
        tabIndex={showScrollDown ? 0 : -1}
        className={`absolute bottom-28 right-4 z-20 w-11 h-11 rounded-full flex items-center justify-center bg-gray-50/95 dark:bg-gray-900/95 border border-gray-300 dark:border-gray-700 shadow-2xl shadow-black/40 hover:border-purple-500/60 hover:bg-gray-100/95 dark:hover:bg-gray-800/95 transition-all duration-200 cursor-pointer active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
          showScrollDown
            ? 'opacity-100 scale-100'
            : 'opacity-0 scale-75 pointer-events-none'
        }`}
      >
        <span className="relative">
          <ArrowDown className="w-5 h-5 text-purple-600 dark:text-purple-300" />
          {scrollBadgeCount > 0 && (
            <span className="absolute -top-2 -right-2.5 px-1.5 min-w-[18px] h-[18px] flex items-center justify-center bg-purple-600 text-white text-[10px] font-bold rounded-full animate-pop-badge">
              {scrollBadgeCount > 99 ? '99+' : scrollBadgeCount}
            </span>
          )}
        </span>
      </button>

      {/* v1.0.11: панель ответа на сообщение */}
      {replyTo && (
        <div className="mx-4 mb-1 px-3 py-2 bg-gray-50/90 dark:bg-gray-900/90 border-l-4 border-indigo-500 rounded-r-xl flex items-center gap-2.5 animate-reply-bar shadow-lg">
          <CornerUpLeft className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-indigo-600 dark:text-indigo-300 leading-tight">
              {replyTo.senderName === currentUser.username ? 'Отвечаете себе' : `Ответ ${replyTo.senderName}`}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 truncate leading-snug">
              {replySnippet(replyTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            title="Отменить ответ"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* NEW (v1.0.24) E1: панель правки сообщения — как панель ответа, но с
          фиолетовым акцентом (Pencil). Enter в поле — сохранить, Esc/крестик —
          отмена; исходный черновик ввода возвращается в обоих случаях. */}
      {editingMessage && (
        <div className="mx-4 mb-1 px-3 py-2 bg-gray-50/90 dark:bg-gray-900/90 border-l-4 border-purple-500 rounded-r-xl flex items-center gap-2.5 animate-reply-bar shadow-lg">
          <Pencil className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-purple-600 dark:text-purple-300 leading-tight">
              Редактирование сообщения
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400 truncate leading-snug">
              {replySnippet(editingMessage)}
            </p>
          </div>
          <button
            type="button"
            onClick={cancelEdit}
            title="Отменить правку (Esc)"
            aria-label="Отменить правку"
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Image Preview bar when attaching a picture before sending */}
      {previewImage && (
        <div className="px-6 py-2 bg-gray-50/90 dark:bg-gray-900/90 border-t border-gray-200 dark:border-gray-800 flex items-center gap-3">
          <div className="relative">
            <img
              src={previewImage}
              alt="Preview"
              className="w-16 h-16 object-cover rounded-xl border border-indigo-500/50 shadow"
            />
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-1.5 -right-1.5 p-1 bg-red-600 text-white rounded-full hover:bg-red-500 shadow"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <span className="text-xs text-gray-700 dark:text-gray-300">
            Изображение готово к отправке. Добавьте подпись ниже или нажмите «Отправить».
          </span>
        </div>
      )}

      {/* Message Input / Voice Recorder Area */}
      <div className={`p-4 border-t border-gray-200/80 dark:border-gray-800/80 bg-gray-100/60 dark:bg-gray-950/60 backdrop-blur-md ${replyTo ? 'pt-2' : ''}`}>
        {/* NEW (v1.0.27) AI: ряд чипов-подсказок над полем ввода — один чип =
            один готовый вариант ответа (LLM на сервере). Клик подставляет текст
            в поле БЕЗ отправки (пользователь проверяет и жмёт Enter), крестик
            справа прячет ряд до следующего запроса; пока запрос в полёте —
            три скелетон-чипа (.skeleton из index.css). Данные — из App.tsx.
            NEW (v1.0.28) AI: ряд скрыт, если подсказки выключены в настройках */}
        {aiSuggestionsEnabled && !aiChipsDismissed && (aiRepliesLoading || aiReplies.length > 0) && (
          <div className="mb-2.5 flex items-center gap-2 overflow-x-auto vm-scroll animate-reply-bar">
            <Sparkles
              className={`w-3.5 h-3.5 shrink-0 text-purple-500 dark:text-purple-400 ${
                aiRepliesLoading ? 'animate-spin' : ''
              }`}
              aria-hidden
            />
            <span className="sr-only">
              {aiRepliesLoading ? 'Подбираем ответы…' : 'Подсказки ответов (AI)'}
            </span>
            {aiRepliesLoading
              ? ['w-24', 'w-36', 'w-28'].map((w, i) => (
                  <div key={i} className={`h-8 rounded-full skeleton shrink-0 ${w}`} aria-hidden />
                ))
              : aiReplies.map((suggestion, i) => (
                  <button
                    key={`${i}_${suggestion}`}
                    type="button"
                    onClick={() => handlePickAiReply(suggestion)}
                    title={suggestion}
                    aria-label={`Подставить ответ: ${suggestion}`}
                    className="flex items-center min-w-0 max-w-[16rem] sm:max-w-[20rem] shrink-0 px-3.5 py-1.5 rounded-full text-left text-xs sm:text-sm font-medium bg-purple-500/10 dark:bg-purple-500/15 border border-purple-500/30 dark:border-purple-400/30 text-purple-800 dark:text-purple-200 hover:bg-purple-500/20 hover:shadow-md hover:shadow-purple-500/20 hover:-translate-y-0.5 active:scale-95 transition-all focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
                  >
                    <span className="truncate">{suggestion}</span>
                  </button>
                ))}
            {/* NEW (v1.0.27) AI: крестик — скрыть подсказки до следующего запроса */}
            <button
              type="button"
              onClick={() => setAiChipsDismissed(true)}
              title="Скрыть подсказки до следующего запроса"
              aria-label="Скрыть подсказки ответов"
              className="p-1.5 rounded-full text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-900 shrink-0 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {isRecordingVoice ? (
          <VoiceRecorder
            onSendVoice={handleSendVoice}
            onCancel={() => setIsRecordingVoice(false)}
            // FIX (v1.0.21): ошибки микрофона — тостом вместо alert()
            onError={onNotify ? (text) => onNotify(text, 'error') : undefined}
          />
        ) : (
          <form onSubmit={handleSendText} className="relative flex items-center gap-2">
            {/* Hidden File Input for images */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageFileChange}
              accept="image/*"
              className="hidden"
            />

            {/* Attach Image Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Прикрепить изображение"
              className="p-3 text-gray-600 dark:text-gray-400 hover:text-indigo-400 hover:bg-gray-200 dark:hover:bg-gray-900 rounded-xl transition-colors"
            >
              <ImageIcon className="w-5 h-5" />
            </button>

            {/* Microphone Button to record voice message */}
            <button
              type="button"
              onClick={() => setIsRecordingVoice(true)}
              title="Записать голосовое сообщение"
              className="p-3 text-gray-600 dark:text-gray-400 hover:text-indigo-400 hover:bg-gray-200 dark:hover:bg-gray-900 rounded-xl transition-colors"
            >
              <Mic className="w-5 h-5" />
            </button>

            {/* Quick Wave Greeting Button */}
            <button
              type="button"
              onClick={handleSendWaveGreeting}
              title="Помахать ручкой 👋 (стикер приветствия Discord)"
              className="p-2 text-gray-600 dark:text-gray-400 hover:text-purple-300 hover:bg-gray-200 dark:hover:bg-gray-900 rounded-xl transition-all hover:scale-110 active:scale-95 shrink-0 flex items-center justify-center"
            >
              <img
                src="/wave.webp"
                alt="Wave"
                className="w-6 h-6 object-contain drop-shadow"
              />
            </button>

            {/* v1.0.10: Emoji picker */}
            <div className="relative shrink-0">
              <button
                ref={emojiToggleRef}
                type="button"
                onClick={() => setShowEmoji(v => !v)}
                title="Эмодзи"
                aria-label="Эмодзи"
                className={`p-3 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${showEmoji ? 'text-purple-400 bg-gray-50 dark:bg-gray-900' : 'text-gray-600 dark:text-gray-400 hover:text-purple-400 hover:bg-gray-200 dark:hover:bg-gray-900'}`}
              >
                <Smile className="w-5 h-5" />
              </button>
            </div>

            {/* NEW (v1.0.27) AI: подсказать ответы (LLM на сервере) — запрос для
                текущего собеседника; в полёте иконка крутится и кнопка заблокирована.
                NEW (v1.0.28) AI: скрыта, если подсказки выключены в настройках */}
            {aiSuggestionsEnabled && onRequestAiReplies && (
              <button
                type="button"
                onClick={handleRequestAiReplies}
                disabled={aiRepliesLoading}
                title="Подсказать ответы (AI)"
                aria-label="Подсказать ответы (AI)"
                className={`p-3 rounded-xl transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none shrink-0 disabled:cursor-not-allowed disabled:opacity-60 ${
                  aiRepliesLoading
                    ? 'text-purple-500 bg-purple-500/10'
                    : 'text-gray-600 dark:text-gray-400 hover:text-purple-400 hover:bg-gray-200 dark:hover:bg-gray-900'
                }`}
              >
                <Sparkles className={`w-5 h-5 ${aiRepliesLoading ? 'animate-spin' : ''}`} />
              </button>
            )}

            {/* Text input */}
            <input
              ref={messageInputRef}
              type="text"
              value={inputText}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={
                editingMessage
                  ? 'Изменение сообщения… (Enter — сохранить, Esc — отмена)'
                  : previewImage
                  ? 'Добавить подпись...'
                  : group
                  /* NEW (v1.0.29) GC: плейсхолдер с названием группы */
                  ? `Сообщение в «${group.name}»…`
                  : `Сообщение для ${recipient.username}...`
              }
              // NEW (v1.0.25) QA-FIX (mobile): + min-w-0 — иначе intrinsic-ширина
              // <input> (default size≈20) не давала flex-1 сжиматься: на узких
              // экранах (390px) поле вылезало за правый край формы на ~45px,
              // обрезая placeholder «Сообщение для …»
              className={`flex-1 min-w-0 px-4 py-3 border rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:border-transparent transition-all focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                editingMessage
                  ? 'bg-purple-50/90 dark:bg-gray-900/90 border-purple-400/70 ring-1 ring-purple-400/30 edit-mode-input'
                  : 'bg-gray-50/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800 focus:ring-indigo-500'
              }`}
            />

            {/* Send button — NEW (v1.0.24) E1: в режиме правки становится кнопкой
                сохранения (фиолетовый акцент + Pencil вместо Send) */}
            <button
              type="submit"
              disabled={!inputText.trim() && !previewImage}
              title={editingMessage ? 'Сохранить правку (Enter)' : 'Отправить'}
              aria-label={editingMessage ? 'Сохранить правку' : 'Отправить сообщение'}
              className={`p-3 text-white rounded-xl shadow-lg transition-all transform active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                editingMessage
                  ? 'bg-purple-600 hover:bg-purple-500 shadow-purple-600/25'
                  : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/25'
              }`}
            >
              {editingMessage ? <Pencil className="w-5 h-5" /> : <Send className="w-5 h-5" />}
            </button>

            {showEmoji && (
              /* NEW (v1.0.22) QA-FIX: панель эмодзи привязана к СТРОКЕ ВВОДА (right-0
                 относительно формы), а не к 44px-обёртке кнопки. Раньше w-72-панель,
                 выровненная по кнопке слева от поля, вылезала левее колонки чата:
                 на десктопе её левые ~2 столбца перекрывал сайдбар (клики по эмодзи
                 «проваливались» в список контактов — прозрачная область сайдбара
                 била по хит-тесту выше панели), на мобильных панель уходила за
                 левый край экрана. */
              <div
                ref={emojiPopoverRef}
                className="absolute bottom-full right-0 mb-2 z-50 animate-emoji-pop bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-xl p-2 shadow-xl grid grid-cols-8 gap-1 w-72"
              >
                {EMOJIS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => handleEmojiSelect(emoji)}
                    className="text-xl p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 hover:scale-110 transition-all text-center leading-none"
                    aria-label={`Вставить ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
};
