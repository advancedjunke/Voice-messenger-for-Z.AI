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
  // v1.0.12: имя первоначального отправителя (если сообщение переслано)
  forwardedFrom?: string;
  timestamp: number;
}

// v1.0.11: известный пользователь (в т.ч. офлайн) из БД сервера
export interface KnownUser {
  username: string;
  avatar?: string;
  lastSeen: number;
}

export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

export interface ActiveCall {
  partnerId: string;
  partnerName: string;
  partnerAvatar?: string;
  isCaller: boolean;
  status: CallStatus;
  startTime?: number;
}
