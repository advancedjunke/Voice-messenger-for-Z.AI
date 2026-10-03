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
  // NEW (v1.0.27) MS: сколько живых сокетов у этого имени (несколько окон =
  // один пользователь с sessions > 1). Заполняется только в снапшоте присутствия
  // (users:update / user:registered) — в usersBySocketId не хранится.
  sessions?: number;
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
  // NEW (v1.0.25) R1: реакции на сообщение — эмодзи → список username
  // отреагировавших (у одного пользователя — максимум одна реакция на сообщение)
  reactions?: Record<string, string[]>;
  // v1.0.12: имя первоначального отправителя (если сообщение переслано)
  forwardedFrom?: string;
  // NEW (v1.0.29) GC: сообщение группового чата (recipientId = groupId,
  // recipientName = название группы). Для личных сообщений поле отсутствует.
  groupId?: string;
  timestamp: number;
}

// v1.0.11: известный пользователь (из БД), возможно офлайн
export interface KnownUser {
  username: string;
  avatar?: string;
  lastSeen: number;
}

export interface CallSignalPayload {
  callerId?: string;
  callerName?: string;
  targetUserId: string;
  offer?: any;
  answer?: any;
  candidate?: any;
  reason?: string;
}

// ─── NEW (v1.0.29) GC: групповые чаты ───
// Группы хранятся в server/data/groups.json (переживают рестарт сервера)
// и кэшируются в памяти (groupsById). members — имена пользователей
// (включая создателя), регистр сохранён, уникальность — без учёта регистра.
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
