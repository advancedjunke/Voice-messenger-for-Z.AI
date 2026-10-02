import React, { useState } from 'react';
import type { User } from '../types.js';
import { Phone, Search, Users, LogOut, Settings } from 'lucide-react';
import { Avatar } from './Avatar.js';

interface SidebarProps {
  currentUser: User;
  users: User[];
  selectedUserId: string | null;
  unreadCounts: Record<string, number>;
  onSelectUser: (user: User) => void;
  onStartCall: (user: User) => void;
  onLogout: () => void;
  onOpenProfile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentUser,
  users,
  selectedUserId,
  unreadCounts,
  onSelectUser,
  onStartCall,
  onLogout,
  onOpenProfile,
}) => {
  const [search, setSearch] = useState('');

  // Exclude current user from the contact list
  const otherUsers = users.filter(u => u.id !== currentUser.id);

  const filteredUsers = otherUsers.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
  );

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
              <span className="text-[10px] text-purple-400 font-mono">v1.0.8</span>
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
      </div>

      {/* Users List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredUsers.length === 0 ? (
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
          filteredUsers.map(user => {
            const isSelected = user.id === selectedUserId;
            const unread = unreadCounts[user.id] || 0;
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
                    <p className="text-xs text-gray-500 truncate">
                      {inCall ? (
                        <span className="text-amber-400">В звонке</span>
                      ) : (
                        <span className="text-emerald-500/90">В сети</span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {unread > 0 && (
                    <span className="px-2 py-0.5 bg-indigo-600 text-white text-xs font-bold rounded-full">
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
          })
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
