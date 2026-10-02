import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { User, ChatMessage, ActiveCall, MessageType, ReplyMeta } from '../types.js';
import {
  Send, Phone, MessageSquare, Shield, Image as ImageIcon, Mic, X, Smile,
  Check, CheckCheck, CornerUpLeft, Trash2, Search, Ban, ChevronUp, ChevronDown,
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
  isPartnerTyping?: boolean;
  onTyping?: (recipientId: string, isTyping: boolean) => void;
}

// v1.0.10: набор эмодзи для быстрой вставки
const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎',
  '🤔', '😐', '😴', '😭', '😡', '🤯', '😇', '🙃',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🫡',
  '🔥', '❤️', '💜', '✨', '🎉', '🎁', '💯', '⚡',
  '☕', '🍕', '⚽', '🚀', '🎮', '🎵', '🐱', '🌙',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Короткий сниппет для цитаты ответа / превью */
function replySnippet(m: Pick<ChatMessage, 'text' | 'mediaType' | 'deleted'>): string {
  if (m.deleted) return 'Сообщение удалено';
  if (m.mediaType === 'image') return m.text ? `📷 ${m.text}` : '📷 Фото';
  if (m.mediaType === 'voice') return '🎤 Голосовое сообщение';
  const t = (m.text || '').trim();
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  currentUser,
  recipient,
  messages,
  activeCall,
  onSendMessage,
  onStartCall,
  onDeleteMessage,
  isPartnerTyping = false,
  onTyping,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [selectedLightboxImage, setSelectedLightboxImage] = useState<string | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);

  // v1.0.11: ответ на сообщение
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);

  // v1.0.11: поиск по переписке
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastTypingSentRef = useRef(0);
  // v1.0.11: refs сообщений для перехода к найденному/цитируемому
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isRecordingVoice]);

  // v1.0.11: id сообщений, совпадающих с поиском
  const matchIds = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return [];
    return messages
      .filter(m => !m.deleted && (m.text || '').toLowerCase().includes(q))
      .map(m => m.id);
  }, [messages, searchText]);

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
      return;
    }

    if (inputText.trim()) {
      onSendMessage({
        text: inputText.trim(),
        mediaType: 'text',
        replyTo: replyMeta,
      });
      setInputText('');
    }
  };

  // v1.0.10: ввод текста → информируем собеседника «печатает…» (не чаще раза в 1.5с)
  const handleInputChange = (value: string) => {
    setInputText(value);
    if (!recipient || !onTyping) return;
    const now = Date.now();
    if (value.trim() && now - lastTypingSentRef.current > 1500) {
      lastTypingSentRef.current = now;
      onTyping(recipient.id, true);
    }
  };

  // v1.0.10: вставка эмодзи в позицию курсора (или в конец)
  const handleEmojiSelect = (emoji: string) => {
    setInputText(prev => prev + emoji);
    setShowEmoji(false);
  };

  // v1.0.11: Escape закрывает ответ / эмодзи / поиск
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showEmoji) setShowEmoji(false);
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

  // v1.0.11: подсветка совпадений поиска в тексте сообщения
  const highlightText = (text: string): React.ReactNode => {
    const q = searchText.trim();
    if (!searchOpen || !q) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'ig'));
    return parts.map((p, i) =>
      p.toLowerCase() === q.toLowerCase() ? (
        <mark key={i} className="search-hit">{p}</mark>
      ) : (
        <React.Fragment key={i}>{p}</React.Fragment>
      )
    );
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
  const isRecipientOnline = Boolean(recipient.online);

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
            status={recipient.inCallWith ? 'busy' : isRecipientOnline ? 'online' : 'offline'}
            size="md"
          />
          <div>
            <h3 className="font-bold text-base text-white">
              {recipient.username}
            </h3>
            <p className="text-xs text-gray-400">
              {isPartnerTyping ? (
                <span className="text-purple-400 font-medium inline-flex items-center">
                  печатает
                  <span className="typing-dots">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </span>
                </span>
              ) : recipient.inCallWith ? (
                <span className="text-amber-400">В разговоре с другим пользователем</span>
              ) : isRecipientOnline ? (
                <span className="text-emerald-400">В сети и готов к общению</span>
              ) : (
                <span className="text-gray-500">{formatLastSeen(recipient.lastSeen)}</span>
              )}
            </p>
          </div>
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
            className={`p-2.5 rounded-xl transition-colors ${
              searchOpen
                ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                : 'bg-gray-800/60 text-gray-400 hover:text-indigo-300 hover:bg-gray-800'
            }`}
          >
            <Search className="w-4 h-4" />
          </button>

          <button
            onClick={() => onStartCall(recipient)}
            disabled={isCurrentCallWithRecipient || !!recipient.inCallWith || !isRecipientOnline}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-md ${
              isCurrentCallWithRecipient
                ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 cursor-default'
                : !isRecipientOnline || recipient.inCallWith
                ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-600/20 active:scale-95'
            }`}
          >
            <Phone className="w-4 h-4" />
            <span>{isCurrentCallWithRecipient ? 'Идет звонок' : isRecipientOnline ? 'Позвонить' : 'Не в сети'}</span>
          </button>
        </div>
      </div>

      {/* v1.0.11: панель поиска по переписке */}
      {searchOpen && (
        <div className="px-6 py-2.5 border-b border-gray-800/80 bg-gray-950/80 backdrop-blur-md flex items-center gap-2 animate-reply-bar">
          <Search className="w-4 h-4 text-gray-500 shrink-0" />
          <input
            autoFocus
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Найти сообщение в этой переписке..."
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
          />
          {searchText.trim() && (
            <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums">
              {matchIds.length > 0
                ? `${searchIndex + 1} из ${matchIds.length}`
                : 'Ничего не найдено'}
            </span>
          )}
          <button
            type="button"
            onClick={() => handleSearchNav(-1)}
            disabled={matchIds.length === 0}
            title="Предыдущее совпадение"
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => handleSearchNav(1)}
            disabled={matchIds.length === 0}
            title="Следующее совпадение (Enter)"
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => { setSearchOpen(false); setSearchText(''); }}
            title="Закрыть поиск"
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Messages Stream */}
      <div className="flex-1 overflow-y-auto p-6">
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
              {isRecipientOnline ? (
                <>Это начало вашей личной истории переписки с <span className="text-purple-300 font-semibold">{recipient.username}</span>.
                Начните общение или помашите ручкой, чтобы поздороваться!</>
              ) : (
                <><span className="text-gray-300 font-semibold">{recipient.username}</span> сейчас не в сети — напишите сообщение, и он(а) увидит его, когда зайдёт.</>
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
          </div>
        ) : (
          (() => {
            let prevMsg: ChatMessage | null = null;
            let lastDay = '';
            return messages.map((msg, idx) => {
              const isMe = msg.senderName === currentUser.username;
              const isWave = msg.mediaUrl === '/wave.webp' && !msg.deleted;

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
              const receipt = isMe && !msg.deleted ? (
                msg.read ? (
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
                        <span className="text-xs font-semibold text-gray-400">
                          {isMe ? 'Вы' : msg.senderName}
                        </span>
                        <span className="text-[11px] text-gray-500">
                          {formatTime(msg.timestamp)}
                        </span>
                        {receipt}
                      </div>
                    )}

                    {/* v1.0.11: hover-действия — ответить / удалить */}
                    {!msg.deleted && (
                      <div
                        className={`absolute -top-1 ${isMe ? '-left-11' : '-right-11'} hidden sm:flex flex-col gap-1 opacity-0 translate-y-1 group-hover/msg:opacity-100 group-hover/msg:translate-y-0 transition-all duration-150`}
                      >
                        <button
                          type="button"
                          onClick={() => setReplyTo(msg)}
                          title="Ответить"
                          className="p-1.5 rounded-lg bg-gray-800/90 border border-gray-700 text-gray-300 hover:text-indigo-300 hover:border-indigo-500/50 transition-colors"
                        >
                          <CornerUpLeft className="w-3.5 h-3.5" />
                        </button>
                        {isMe && onDeleteMessage && (
                          <button
                            type="button"
                            onClick={() => onDeleteMessage(msg.id)}
                            title="Удалить сообщение"
                            className="p-1.5 rounded-lg bg-gray-800/90 border border-gray-700 text-gray-300 hover:text-red-400 hover:border-red-500/50 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {msg.deleted ? (
                      /* v1.0.11: удалённое сообщение */
                      <div className="px-4 py-2.5 rounded-2xl border border-dashed border-gray-700 bg-gray-900/40 text-gray-500 text-sm italic flex items-center gap-2">
                        <Ban className="w-4 h-4 shrink-0" aria-hidden />
                        <span>Сообщение удалено</span>
                      </div>
                    ) : isWave ? (
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
                        title={`${msg.senderName} · ${formatTime(msg.timestamp)}`}
                        className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-md break-words transition-shadow hover:shadow-lg ${
                          isMe
                            ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white ' + (isGrouped ? 'rounded-tr-xl' : 'rounded-tr-none')
                            : 'bg-gray-900 border border-gray-800 text-gray-200 ' + (isGrouped ? 'rounded-tl-xl' : 'rounded-tl-none')
                        }`}
                      >
                        {/* v1.0.11: цитата ответа */}
                        {msg.replyTo && (
                          <div
                            onClick={() => jumpToMessage(msg.replyTo!.id)}
                            title="Перейти к сообщению"
                            className={`mb-1.5 px-2.5 py-1.5 rounded-lg border-l-[3px] cursor-pointer transition-colors ${
                              isMe
                                ? 'bg-black/20 border-white/70 hover:bg-black/30'
                                : 'bg-gray-800/80 border-indigo-400/80 hover:bg-gray-800'
                            }`}
                          >
                            <p className="text-[11px] font-semibold text-indigo-300 leading-tight">
                              {msg.replyTo.senderName === currentUser.username ? 'Вы' : msg.replyTo.senderName}
                            </p>
                            <p className="text-[11px] text-gray-300/90 leading-snug">
                              {replySnippet({ text: msg.replyTo.text, mediaType: msg.replyTo.mediaType, deleted: false })}
                            </p>
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
                      </div>
                    )}

                    {/* v1.0.10: в группировке время + галочка — под пузырём */}
                    {isGrouped && !msg.deleted && (
                      <div className={`flex items-center gap-1 px-1 mt-0.5 ${isMe ? 'flex-row-reverse' : ''}`}>
                        <span className="text-[10px] text-gray-600">{formatTime(msg.timestamp)}</span>
                        {receipt}
                      </div>
                    )}
                  </div>
                </div>
              );

              prevMsg = prevForNext;
              // если день изменился — сначала вставляем разделитель
              if (dayChanged) {
                const separator = (
                  <div key={`day_${day}`} className="flex items-center gap-3 my-4 animate-fade-in">
                    <div className="h-px flex-1 bg-gray-800/80" />
                    <span className="px-3 py-1 bg-gray-900/80 border border-gray-800 rounded-full text-[11px] text-gray-400 font-medium whitespace-nowrap">
                      {formatDayLabel(msg.timestamp)}
                    </span>
                    <div className="h-px flex-1 bg-gray-800/80" />
                  </div>
                );
                return <React.Fragment key={`frag_${msg.id}`}>{separator}{node}</React.Fragment>;
              }
              return node;
            });
          })()
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* v1.0.11: панель ответа на сообщение */}
      {replyTo && (
        <div className="mx-4 mb-1 px-3 py-2 bg-gray-900/90 border-l-4 border-indigo-500 rounded-r-xl flex items-center gap-2.5 animate-reply-bar shadow-lg">
          <CornerUpLeft className="w-4 h-4 text-indigo-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-indigo-300 leading-tight">
              {replyTo.senderName === currentUser.username ? 'Отвечаете себе' : `Ответ ${replyTo.senderName}`}
            </p>
            <p className="text-xs text-gray-400 truncate leading-snug">
              {replySnippet(replyTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            title="Отменить ответ"
            className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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
      <div className={`p-4 border-t border-gray-800/80 bg-gray-950/60 backdrop-blur-md ${replyTo ? 'pt-2' : ''}`}>
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

            {/* v1.0.10: Emoji picker */}
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowEmoji(v => !v)}
                title="Эмодзи"
                className={`p-3 rounded-xl transition-colors ${showEmoji ? 'text-purple-400 bg-gray-900' : 'text-gray-400 hover:text-purple-400 hover:bg-gray-900'}`}
              >
                <Smile className="w-5 h-5" />
              </button>

              {showEmoji && (
                <>
                  {/* Невидимый фон для закрытия по клику вне */}
                  <button
                    type="button"
                    aria-label="Закрыть эмодзи"
                    onClick={() => setShowEmoji(false)}
                    className="fixed inset-0 z-40 cursor-default"
                    tabIndex={-1}
                  />
                  <div className="absolute bottom-full mb-2 right-0 z-50 animate-emoji-pop bg-gray-900 border border-gray-700 rounded-2xl p-3 shadow-2xl grid grid-cols-8 gap-1 w-[268px]">
                    {EMOJIS.map(emoji => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => handleEmojiSelect(emoji)}
                        className="text-xl p-1 rounded-lg hover:bg-gray-800 hover:scale-110 transition-all text-center leading-none"
                        aria-label={`Вставить ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Text input */}
            <input
              type="text"
              value={inputText}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={previewImage ? 'Добавить подпись...' : `Сообщение для ${recipient.username}...`}
              className="flex-1 px-4 py-3 bg-gray-900/90 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
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
