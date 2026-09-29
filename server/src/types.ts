export type MessageType = 'text' | 'image' | 'voice';

export interface User {
  id: string;
  socketId: string;
  username: string;
  online: boolean;
  inCallWith?: string | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: MessageType;
  duration?: number; // in seconds for voice messages
  timestamp: number;
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
