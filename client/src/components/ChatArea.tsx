import React, { useState, useRef, useEffect } from 'react';
import type { User, ChatMessage, ActiveCall, MessageType } from '../types.js';
import { Send, Phone, MessageSquare, Shield, Image as ImageIcon, Mic, X } from 'lucide-react';
import { AudioMessagePlayer } from './AudioMessagePlayer.js';
import { VoiceRecorder } from './VoiceRecorder.js';
import { Avatar } from './Avatar.js';
import { compressImage } from '../utils/imageCompressor.js';

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
  }) => void;
  onStartCall: (user: User) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  currentUser,
  recipient,
  messages,
  activeCall,
  onSendMessage,
  onStartCall,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedLightboxImage, setSelectedLightboxImage] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isRecordingVoice]);

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (previewImage) {
      onSendMessage({
        text: inputText.trim() || undefined,
        mediaUrl: previewImage,
        mediaType: 'image',
      });
      setPreviewImage(null);
      setInputText('');
      return;
    }

    if (inputText.trim()) {
      onSendMessage({
        text: inputText.trim(),
        mediaType: 'text',
      });
      setInputText('');
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
      alert('Не удалось загрузить изображение');
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

  // Empty state when no chat is selected
  if (!recipient) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center p-8 bg-gray-950/40 text-center">
        <div className="w-16 h-16 rounded-3xl bg-gray-900 border border-gray-800 flex items-center justify-center text-gray-400 mb-4 shadow-xl">
          <MessageSquare className="w-8 h-8 text-indigo-400" />
        </div>
        <h3 className="text-xl font-bold text-white mb-2">
          Выберите собеседника
        </h3>
        <p className="text-gray-400 text-sm max-w-sm mb-6">
          Выберите пользователя из списка слева, чтобы начать переписку, отправить фото или голосовое, либо совершить прямой WebRTC аудиозвонок.
        </p>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/80 border border-gray-800 rounded-full text-xs text-gray-400">
          <Shield className="w-3.5 h-3.5 text-indigo-400" />
          <span>Сквозная передача сообщений и аудиопотоков</span>
        </div>
      </div>
    );
  }

  const isCurrentCallWithRecipient =
    activeCall && activeCall.partnerId === recipient.id;

  return (
    <div
      key={recipient.username}
      className="flex-1 h-full flex flex-col bg-gray-950/30 relative animate-chat-switch overflow-hidden"
    >
      {/* Lightbox for viewing full-size images */}
      {selectedLightboxImage && (
        <div
          onClick={() => setSelectedLightboxImage(null)}
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer"
        >
          <button
            onClick={() => setSelectedLightboxImage(null)}
            className="absolute top-6 right-6 p-2 rounded-full bg-gray-800 text-white hover:bg-gray-700"
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

      {/* Top Header */}
      <div className="px-6 py-4 border-b border-gray-800/80 bg-gray-950/60 backdrop-blur-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar
            src={recipient.avatar}
            name={recipient.username}
            status={recipient.inCallWith ? 'busy' : 'online'}
            size="md"
          />
          <div>
            <h3 className="font-bold text-base text-white">
              {recipient.username}
            </h3>
            <p className="text-xs text-gray-400">
              {recipient.inCallWith ? (
                <span className="text-amber-400">В разговоре с другим пользователем</span>
              ) : (
                <span className="text-emerald-400">В сети и готов к общению</span>
              )}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onStartCall(recipient)}
            disabled={isCurrentCallWithRecipient || !!recipient.inCallWith}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-md ${
              isCurrentCallWithRecipient
                ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 cursor-default'
                : recipient.inCallWith
                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-600/20 active:scale-95'
            }`}
          >
            <Phone className="w-4 h-4" />
            <span>{isCurrentCallWithRecipient ? 'Идет звонок' : 'Позвонить'}</span>
          </button>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 max-w-sm mx-auto my-auto animate-in fade-in duration-300">
            <div className="relative mb-3">
              <Avatar
                src={recipient.avatar}
                name={recipient.username}
                size="2xl"
                className="shadow-2xl ring-4 ring-purple-500/20"
              />
            </div>
            <h3 className="text-xl font-bold text-white mb-1.5">
              {recipient.username}
            </h3>
            <p className="text-xs text-gray-400 mb-6 leading-relaxed">
              Это начало вашей личной истории переписки с <span className="text-purple-300 font-semibold">{recipient.username}</span>.
              Начните общение или помашите ручкой, чтобы поздороваться!
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
          </div>
        ) : (
          messages.map(msg => {
            // FIX: сравниваем по СТАБИЛЬНОМУ имени (socket.id меняется при реконнекте,
            // из-за чего старые сообщения «перепутывались» стороны)
            const isMe = msg.senderName === currentUser.username;
            const isWave = msg.mediaUrl === '/wave.webp';

            return (
              <div
                key={msg.id}
                className={`flex gap-2.5 items-end ${isMe ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {/* Sender Avatar */}
                <Avatar
                  src={isMe ? currentUser.avatar : (msg.senderAvatar || recipient.avatar)}
                  name={isMe ? currentUser.username : msg.senderName}
                  size="sm"
                  className="mb-1 shrink-0"
                />

                <div className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[75%]`}>
                  <div className="flex items-baseline gap-2 mb-1 px-1">
                    <span className="text-xs font-semibold text-gray-400">
                      {isMe ? 'Вы' : msg.senderName}
                    </span>
                    <span className="text-[11px] text-gray-500">
                      {formatTime(msg.timestamp)}
                    </span>
                  </div>

                  {isWave ? (
                    /* Discord-style wave greeting card */
                    <div
                      className={`p-3 rounded-2xl shadow-lg border transition-all ${
                        isMe
                          ? 'bg-purple-950/40 border-purple-500/40 text-purple-100 rounded-tr-none'
                          : 'bg-gray-900/90 border-gray-800 text-gray-100 rounded-tl-none'
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
                      className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-md break-words ${
                        isMe
                          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-tr-none'
                          : 'bg-gray-900 border border-gray-800 text-gray-200 rounded-tl-none'
                      }`}
                    >
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
                      {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Image Preview bar when attaching a picture before sending */}
      {previewImage && (
        <div className="px-6 py-2 bg-gray-900/90 border-t border-gray-800 flex items-center gap-3">
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
          <span className="text-xs text-gray-300">
            Изображение готово к отправке. Добавьте подпись ниже или нажмите «Отправить».
          </span>
        </div>
      )}

      {/* Message Input / Voice Recorder Area */}
      <div className="p-4 border-t border-gray-800/80 bg-gray-950/60 backdrop-blur-md">
        {isRecordingVoice ? (
          <VoiceRecorder
            onSendVoice={handleSendVoice}
            onCancel={() => setIsRecordingVoice(false)}
          />
        ) : (
          <form onSubmit={handleSendText} className="flex items-center gap-2">
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
              className="p-3 text-gray-400 hover:text-indigo-400 hover:bg-gray-900 rounded-xl transition-colors"
            >
              <ImageIcon className="w-5 h-5" />
            </button>

            {/* Microphone Button to record voice message */}
            <button
              type="button"
              onClick={() => setIsRecordingVoice(true)}
              title="Записать голосовое сообщение"
              className="p-3 text-gray-400 hover:text-indigo-400 hover:bg-gray-900 rounded-xl transition-colors"
            >
              <Mic className="w-5 h-5" />
            </button>

            {/* Quick Wave Greeting Button */}
            <button
              type="button"
              onClick={handleSendWaveGreeting}
              title="Помахать ручкой 👋 (стикер приветствия Discord)"
              className="p-2 text-gray-400 hover:text-purple-300 hover:bg-gray-900 rounded-xl transition-all hover:scale-110 active:scale-95 shrink-0 flex items-center justify-center"
            >
              <img
                src="/wave.webp"
                alt="Wave"
                className="w-6 h-6 object-contain drop-shadow"
              />
            </button>

            {/* Text input */}
            <input
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder={previewImage ? 'Добавить подпись...' : `Сообщение для ${recipient.username}...`}
              className="flex-1 px-4 py-3 bg-gray-900/90 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
            />

            {/* Send button */}
            <button
              type="submit"
              disabled={!inputText.trim() && !previewImage}
              className="p-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl shadow-lg shadow-indigo-600/25 transition-all transform active:scale-95"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
