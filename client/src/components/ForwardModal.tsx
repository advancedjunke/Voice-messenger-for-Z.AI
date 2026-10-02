import React, { useState, useMemo } from 'react';
import type { User, KnownUser, ChatMessage } from '../types.js';
import { Forward, Search, X, Check, MessageSquare, Mic, Image as ImageIcon } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { formatLastSeen } from '../utils/format.js';

interface ForwardModalProps {
  isOpen: boolean;
  /** v1.0.12: сообщение, которое пересылаем */
  message: ChatMessage | null;
  users: User[];
  knownUsers: KnownUser[];
  currentUsername: string;
  onClose: () => void;
  onForward: (target: User) => void;
}

/** Короткое описание пересылаемого сообщения (для превью в модалке) */
function messagePreview(m: ChatMessage): string {
  if (m.deleted) return 'Сообщение удалено';
  if (m.mediaType === 'voice') return '🎤 Голосовое сообщение';
  if (m.mediaType === 'image') return m.text ? `📷 ${m.text}` : '📷 Фото';
  const t = (m.text || '').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

function mediaIcon(m: ChatMessage) {
  if (m.mediaType === 'voice') return <Mic className="w-3.5 h-3.5 text-purple-300" />;
  if (m.mediaType === 'image') return <ImageIcon className="w-3.5 h-3.5 text-purple-300" />;
  return <MessageSquare className="w-3.5 h-3.5 text-gray-500" />;
}

export const ForwardModal: React.FC<ForwardModalProps> = ({
  isOpen,
  message,
  users,
  knownUsers,
  currentUsername,
  onClose,
  onForward,
}) => {
  const [search, setSearch] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  const selfLower = currentUsername.toLowerCase();

  const contacts = useMemo(() => {
    if (!isOpen) return [];
    const online = users.filter(u => u.username.toLowerCase() !== selfLower);
    const onlineNames = new Set(online.map(u => u.username.toLowerCase()));
    const offline: KnownUser[] = knownUsers.filter(
      k => k.username.toLowerCase() !== selfLower && !onlineNames.has(k.username.toLowerCase())
    );
    const merged = [
      ...online.map(u => ({
        username: u.username,
        avatar: u.avatar,
        online: true,
        lastSeen: undefined as number | undefined,
      })),
      ...offline.map(k => ({
        username: k.username,
        avatar: k.avatar,
        online: false,
        lastSeen: k.lastSeen,
      })),
    ];
    const q = search.trim().toLowerCase();
    return q ? merged.filter(c => c.username.toLowerCase().includes(q)) : merged;
  }, [isOpen, users, knownUsers, selfLower, search]);

  // сброс поиска/статуса при открытии
  React.useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSentTo(null);
    }
  }, [isOpen]);

  if (!isOpen || !message) return null;

  const handlePick = (c: { username: string; avatar?: string; online: boolean; lastSeen?: number }) => {
    if (sentTo) return; // защита от двойного клика
    setSentTo(c.username);
    // небольшая задержка, чтобы показать галочку «Отправлено»
    window.setTimeout(() => {
      onForward({
        id: c.online ? (users.find(u => u.username === c.username)?.id || '') : '',
        socketId: '',
        username: c.username,
        avatar: c.avatar,
        online: c.online,
        inCallWith: null,
        lastSeen: c.lastSeen,
      });
    }, 450);
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Переслать сообщение"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-sm bg-gray-900 border border-gray-700/80 rounded-3xl shadow-2xl overflow-hidden animate-emoji-pop flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-gray-800/80">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-indigo-600/20 border border-indigo-500/30">
                <Forward className="w-4 h-4 text-indigo-300" />
              </div>
              <div>
                <h3 className="font-bold text-white text-sm leading-none">Переслать сообщение</h3>
                <p className="text-[11px] text-gray-500 mt-1">Выберите, кому отправить</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Закрыть"
              className="p-2 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Превью пересылаемого сообщения */}
          <div className="px-3 py-2 rounded-xl bg-gray-950/80 border border-gray-800 flex items-center gap-2.5 min-w-0">
            {mediaIcon(message)}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-indigo-300 font-semibold leading-tight">
                {message.senderName === currentUsername ? 'Ваше сообщение' : `От ${message.forwardedFrom || message.senderName}`}
              </p>
              <p className="text-xs text-gray-300 truncate leading-snug">{messagePreview(message)}</p>
            </div>
          </div>

          {/* Поиск контакта */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск контакта..."
              className="w-full pl-9 pr-4 py-2 bg-gray-950/80 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
            />
          </div>
        </div>

        {/* Contacts list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1 vm-scroll">
          {contacts.length === 0 ? (
            <div className="py-10 text-center text-gray-500 text-sm">
              <Search className="w-6 h-6 mx-auto mb-2 text-gray-600" />
              Контакты не найдены
            </div>
          ) : (
            contacts.map(c => {
              const isSent = sentTo === c.username;
              const disabled = Boolean(sentTo) && !isSent;
              return (
                <button
                  key={c.username}
                  type="button"
                  onClick={() => handlePick(c)}
                  disabled={disabled}
                  className={`w-full flex items-center justify-between gap-3 p-3 rounded-xl text-left transition-all ${
                    isSent
                      ? 'bg-emerald-600/20 border border-emerald-500/40'
                      : disabled
                      ? 'opacity-40 cursor-not-allowed border border-transparent'
                      : 'hover:bg-gray-800/70 border border-transparent cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      src={c.avatar}
                      name={c.username}
                      status={c.online ? 'online' : 'offline'}
                      size="md"
                    />
                    <div className="min-w-0">
                      <span className="block font-medium text-sm text-white truncate">{c.username}</span>
                      <p className="text-[11px] truncate">
                        {c.online ? (
                          <span className="text-emerald-500/90">В сети</span>
                        ) : (
                          <span className="text-gray-500">{formatLastSeen(c.lastSeen)}</span>
                        )}
                      </p>
                    </div>
                  </div>
                  {isSent && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400 shrink-0 animate-pop-badge">
                      <Check className="w-4 h-4" /> Отправлено
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <p className="px-5 py-2.5 border-t border-gray-800/80 text-[10px] text-gray-600 text-center">
          Пересланные сообщения сохраняют метку об исходном авторе
        </p>
      </div>
    </div>
  );
};
