import React, { useState } from 'react';
import type { User, KnownUser } from '../types.js';
import { Phone, Search, Users, LogOut, Settings, Bell, BellOff, Clock } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { formatLastSeen } from '../utils/format.js';

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
}) => {
  const [search, setSearch] = useState('');

  // FIX: бейджи статуса встроены в сайдбар вместо fixed-оверлея,
  // который перекрывал кнопку «Позвонить»
  const handleChangeServer = () => {
    const current = localStorage.getItem('vm_server_url') || serverUrl;
    const next = prompt('Адрес сервера мессенджера (например, IP друга или облачный хостинг):', current);
    if (next !== null) {
      if (next.trim()) {
        localStorage.setItem('vm_server_url', next.trim());
      } else {
        localStorage.removeItem('vm_server_url');
      }
      window.location.reload();
    }
  };

  const handleShowUpdate = () => {
    alert(
      `🚀 Доступно обновление v${updateInfo?.latestVersion}!\n\nЧто нового:\n${
        updateInfo?.releaseNotes || 'Улучшения стабильности и звонков'
      }\n\nЧтобы обновить приложение, закройте его и запустите ярлык «Voice Launcher» на Рабочем столе (или в папке приложения).`
    );
  };

  const selfLower = currentUser.username.toLowerCase();

  // Онлайн-собеседники (кроме себя)
  const onlineUsers = users.filter(u => u.id !== currentUser.id);

  // v1.0.11: офлайн-собеседники из «известных» — недавние контакты
  const onlineNames = new Set(onlineUsers.map(u => u.username.toLowerCase()));
  const offlineKnown: KnownUser[] = knownUsers
    .filter(k => k.username.toLowerCase() !== selfLower && !onlineNames.has(k.username.toLowerCase()))
    .filter(k => k.username.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 15);

  const filteredOnline = onlineUsers.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
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

  const hasAnyContacts = filteredOnline.length > 0 || offlineKnown.length > 0;

  return (
    <div className="w-80 h-full bg-gray-950/80 border-r border-gray-800/80 flex flex-col backdrop-blur-xl">
      {/* Header */}
      <div className="p-4 border-b border-gray-800/80">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-slate-900 border border-purple-500/30 overflow-hidden flex items-center justify-center shadow-lg shadow-purple-500/10 shrink-0">
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
              <h1 className="font-bold text-base text-white tracking-tight leading-none">
                VoiceChat
              </h1>
              <span className="text-[10px] text-purple-400 font-mono">v1.0.12</span>
            </div>
          </div>
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-900 border border-gray-800 rounded-full text-xs text-gray-400 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            {users.length} онлайн
          </span>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск собеседника..."
            className="w-full pl-9 pr-4 py-2 bg-gray-900/90 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
          />
        </div>

        {/* FIX: Status & update badges — встроены в сайдбар, не перекрывают кнопки */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button
            type="button"
            onClick={handleChangeServer}
            title="Кликните, чтобы изменить адрес сервера"
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
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 transition-all cursor-pointer animate-pulse"
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
                  ? 'bg-gray-800/60 text-gray-400 border-gray-700 hover:text-emerald-400'
                  : 'bg-gray-800/60 text-gray-600 border-gray-800 hover:text-gray-400'
              }`}
            >
              {soundEnabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Users List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {!hasAnyContacts ? (
          <div className="h-48 flex flex-col items-center justify-center text-center p-4 text-gray-500">
            <Users className="w-8 h-8 mb-2 stroke-[1.5] text-gray-600" />
            <p className="text-sm font-medium">
              {search ? 'Никого не найдено' : 'Пока никого нет в сети'}
            </p>
            <p className="text-xs text-gray-600 mt-1">
              Откройте мессенджер во второй вкладке, чтобы протестировать чат и звонок!
            </p>
          </div>
        ) : (
          <>
            {/* ─── Онлайн ─── */}
            {filteredOnline.map(user => {
              const isSelected = user.username === selectedUsername;
              // FIX v1.0.11: непрочитанные ключуются по ИМЕНИ (как в App), а не по socket.id
              const unread = unreadCounts[user.username] || 0;
              const inCall = !!user.inCallWith;

              return (
                <div
                  key={user.id}
                  onClick={() => onSelectUser(user)}
                  className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-indigo-600/20 border border-indigo-500/30 text-white'
                      : 'hover:bg-gray-900/70 border border-transparent text-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      src={user.avatar}
                      name={user.username}
                      status={inCall ? 'busy' : 'online'}
                      size="md"
                    />

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate text-white">
                          {user.username}
                        </span>
                      </div>
                      <p className="text-xs truncate">
                        {typingUsers[user.username] ? (
                          <span className="text-purple-400 font-medium inline-flex items-center">
                            печатает
                            <span className="typing-dots">
                              <span className="typing-dot" />
                              <span className="typing-dot" />
                              <span className="typing-dot" />
                            </span>
                          </span>
                        ) : inCall ? (
                          <span className="text-amber-400">В звонке</span>
                        ) : (
                          <span className="text-emerald-500/90">В сети</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {unread > 0 && (
                      <span className="px-2 py-0.5 bg-indigo-600 text-white text-xs font-bold rounded-full animate-pop-badge">
                        {unread}
                      </span>
                    )}

                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onStartCall(user);
                      }}
                      title={`Позвонить ${user.username}`}
                      className="p-2 rounded-lg bg-gray-800/80 hover:bg-emerald-600 text-gray-300 hover:text-white transition-all transform active:scale-95"
                    >
                      <Phone className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ─── v1.0.11: Недавние (офлайн) ─── */}
            {offlineKnown.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
                  <Clock className="w-3 h-3 text-gray-600" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
                    Недавние · не в сети
                  </span>
                </div>
                {offlineKnown.map(known => {
                  const isSelected = known.username === selectedUsername;
                  const unread = unreadCounts[known.username] || 0;

                  return (
                    <div
                      key={known.username}
                      onClick={() => handleSelectKnown(known)}
                      title={`${known.username} сейчас офлайн — сообщение будет доставлено, когда он(а) зайдёт`}
                      className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-gray-800/60 border border-gray-700/60 text-white'
                          : 'hover:bg-gray-900/50 border border-transparent text-gray-400'
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
                          <span className="font-medium text-sm truncate text-gray-300 block">
                            {known.username}
                          </span>
                          <p className="text-[11px] text-gray-500 truncate">
                            {formatLastSeen(known.lastSeen)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        {unread > 0 && (
                          <span className="px-2 py-0.5 bg-gray-700 text-gray-200 text-xs font-bold rounded-full animate-pop-badge">
                            {unread}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {/* Current User Card */}
      <div
        onClick={onOpenProfile}
        className="p-3 border-t border-gray-800/80 bg-gray-900/40 hover:bg-gray-900/80 cursor-pointer flex items-center justify-between group transition-all"
        title="Нажмите, чтобы настроить аватарку и профиль"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative shrink-0">
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
              <h4 className="font-semibold text-sm text-white truncate">
                {currentUser.username}
              </h4>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 group-hover:text-purple-300 transition-colors">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 group-hover:bg-purple-400" />
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
          className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-red-400 transition-colors shrink-0"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
