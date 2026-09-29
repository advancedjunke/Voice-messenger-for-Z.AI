import React, { useState } from 'react';
import type { User } from '../types.js';
import { Phone, Search, Users, LogOut, Radio } from 'lucide-react';

interface SidebarProps {
  currentUser: User;
  users: User[];
  selectedUserId: string | null;
  unreadCounts: Record<string, number>;
  onSelectUser: (user: User) => void;
  onStartCall: (user: User) => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentUser,
  users,
  selectedUserId,
  unreadCounts,
  onSelectUser,
  onStartCall,
  onLogout,
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
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-md">
              <Radio className="w-4 h-4 text-white" />
            </div>
            <h1 className="font-bold text-lg text-white tracking-tight">
              VoiceChat
            </h1>
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
                  <div className="relative flex-shrink-0">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-gray-700 to-gray-800 flex items-center justify-center font-semibold text-sm text-white shadow">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                    {/* Status Dot */}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-950 ${
                        inCall ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      title={inCall ? 'В звонке' : 'Онлайн'}
                    />
                  </div>

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
      <div className="p-3 border-t border-gray-800/80 bg-gray-900/40 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow-sm flex-shrink-0">
            {currentUser.username.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h4 className="font-semibold text-sm text-white truncate">
              {currentUser.username}
            </h4>
            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>Вы в сети</span>
            </div>
          </div>
        </div>

        <button
          onClick={onLogout}
          title="Сменить ник / Выйти"
          className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-red-400 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
