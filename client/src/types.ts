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
  duration?: number;
  timestamp: number;
}

export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

export interface ActiveCall {
  partnerId: string;
  partnerName: string;
  isCaller: boolean;
  status: CallStatus;
  startTime?: number;
}
