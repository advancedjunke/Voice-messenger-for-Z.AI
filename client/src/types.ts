export type MessageType = 'text' | 'image' | 'voice';

// v1.0.11: метаданные сообщения, на которое отвечает текущее
export interface ReplyMeta {
  id: string;
  senderName: string;
  text?: string;
  mediaType?: MessageType;
}

export interface User {
  id: string;
  socketId: string;
  username: string;
  avatar?: string;
  online: boolean;
  inCallWith?: string | null;
  lastSeen?: number;
  // NEW (v1.0.27) MS: число активных сессий (окон/устройств) пользователя
  sessions?: number;
  // NEW (v1.0.29) GC: синтетический «пользователь» для выбранной ГРУППЫ.
  // Конструирует только App.tsx: id = group.id, username = group.name,
  // online = true. Ключ беседы для групп — `group::<groupId>` (НЕ имя —
  // группы можно переименовывать), см. targetKey в App.tsx.
  isGroup?: boolean;
  groupId?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  recipientId: string;
  recipientName?: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: MessageType;
  duration?: number;
  read?: boolean;
  replyTo?: ReplyMeta;
  deleted?: boolean;
  // NEW (v1.0.24) E1: сообщение отредактировано автором (текст заменён)
  edited?: boolean;
  editedAt?: number;
  // NEW (v1.0.25) R1: реакции на сообщение — эмодзи → список username отреагировавших
  reactions?: Record<string, string[]>;
  // v1.0.12: имя первоначального отправителя (если сообщение переслано)
  forwardedFrom?: string;
  // NEW (v1.0.29) GC: сообщение группового чата (recipientId = groupId,
  // recipientName = название группы). Для личных сообщений поле отсутствует.
  groupId?: string;
  timestamp: number;
}

// v1.0.11: известный пользователь (в т.ч. офлайн) из БД сервера
export interface KnownUser {
  username: string;
  avatar?: string;
  lastSeen: number;
}

// NEW (v1.0.22) N6: состояние соединения с сервером для индикатора в сайдбаре.
// 'connecting' — до первого connect; 'reconnecting' — транспортный сбой,
// socket.io сам переподключается; 'offline' — ручной дисконнект (выход/замена сессии)
export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

// FIX (v1.0.21): промежуточный статус 'connecting' — ответ/акцепт отправлены,
// но ICE ещё не соединился; 'connected' выставляет только ICE-колбэк (или relay)
export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connecting' | 'connected';

export interface ActiveCall {
  partnerId: string;
  partnerName: string;
  partnerAvatar?: string;
  isCaller: boolean;
  status: CallStatus;
  startTime?: number;
}

// ─── NEW (v1.0.28) AI: настройки AI-функций (persist в localStorage vm_ai_settings) ───
// Управление видимостью AI-кнопок (подсказки/сводка/переводчик) + параметры.
export type AiTranslateTarget =
  | 'ru' | 'en' | 'de' | 'es' | 'fr' | 'it' | 'pt' | 'zh' | 'ja' | 'ko' | 'tr' | 'uk';

export interface AiSettings {
  /** подсказки ответов (✨ над полем ввода) */
  suggestions: boolean;
  /** сводка переписки (кнопка в шапке чата) */
  summary: boolean;
  /** переводчик сообщений (кнопка на пузыре) */
  translation: boolean;
  /** число вариантов подсказки: 1..3 */
  suggestionCount: number;
  /** целевой язык перевода сообщений */
  translateTarget: AiTranslateTarget;
}

// NEW (v1.0.28) AI: состояние перевода конкретного сообщения (ключ — id сообщения).
// 'loading' — запрос в полёте (скелетон под пузырем), 'done' — готовый перевод.
// sourceLang (v1.0.29): определённый LLM исходный язык (имя на русском: «английский»…).
export interface AiTranslationState {
  status: 'loading' | 'done';
  translated?: string;
  sourceLang?: string;
}

// ─── NEW (v1.0.29) GC: групповые чаты ───
// Группа хранится на сервере (groups.json, переживает рестарт) и приходит
// клиенту целиком. members — имена пользователей (включая создателя),
// регистр сохранён, уникальность — без учёта регистра.
export interface GroupInfo {
  id: string;
  name: string;
  createdBy: string;
  members: string[];
  createdAt: number;
  // NEW (v1.0.30) GR: статусы прочтения группы — username (канонический
  // регистр из members) → время (ms), до которого участник дочитал беседу.
  // Своё сообщение считается прочитанным, когда readState всех ДРУГИХ
  // участников >= timestamp сообщения. Поле опционально (старые серверы).
  readState?: Record<string, number>;
}
