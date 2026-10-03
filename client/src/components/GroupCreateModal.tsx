/* NEW (v1.0.29) GC: модалка создания группы — название + выбор участников
   (онлайн-пользователи + офлайн-контакты из БД, дедуп по имени без учёта
   регистра). Двухтемная (light + dark:), акценты purple/violet, стеклянный
   стиль как у остальных модалок приложения (ForwardModal / настройки AI).
   Здесь же живёт ОБЩИЙ пикер участников MemberPicker + сборщик кандидатов
   buildMemberCandidates — GroupManageModal импортирует их отсюда, чтобы не
   дублировать разметку выбора людей. */
import React, { useState, useEffect, useMemo } from 'react';
import type { User, KnownUser } from '../types.js';
import { Users, X, Search, Check, Loader2 } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { formatLastSeen } from '../utils/format.js';

interface GroupCreateModalProps {
  isOpen: boolean;
  /** онлайн-пользователи (self фильтруется внутри) */
  users: User[];
  /** офлайн-контакты из БД сервера */
  knownUsers: KnownUser[];
  currentUsername: string;
  onClose: () => void;
  /** создать группу: имя + имена участников (исходный регистр); модалку
      закрывает родитель (оптимистично — после успеха) */
  onCreateGroup: (name: string, memberUsernames: string[]) => void;
  /** запрос создания в полёте: кнопка крутится, поля заблокированы */
  busy?: boolean;
}

// NEW (v1.0.29) GC: кандидат на участие в группе — онлайн-пользователь или
// офлайн-контакт из БД (lastSeen — для подписи «был(а) в сети …»)
export interface MemberCandidate {
  username: string;
  avatar?: string;
  online: boolean;
  lastSeen?: number;
}

// NEW (v1.0.29) GC: сборка списка кандидатов — онлайн-пользователи (кроме
// себя) + офлайн-контакты, дедуп по имени в нижнем регистре (онлайн
// выигрывает). excludeUsernames — уже состоящие в группе (для модалки
// управления: приглашать можно только «новичков»)
export function buildMemberCandidates(
  users: User[],
  knownUsers: KnownUser[],
  currentUsername: string,
  excludeUsernames: string[] = []
): MemberCandidate[] {
  const selfLower = currentUsername.toLowerCase();
  const excluded = new Set(excludeUsernames.map(n => n.toLowerCase()));
  const seen = new Set<string>();
  const out: MemberCandidate[] = [];
  for (const u of users) {
    const lower = u.username.toLowerCase();
    if (lower === selfLower || excluded.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push({ username: u.username, avatar: u.avatar, online: true });
  }
  for (const k of knownUsers) {
    const lower = k.username.toLowerCase();
    if (lower === selfLower || excluded.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    out.push({ username: k.username, avatar: k.avatar, online: false, lastSeen: k.lastSeen });
  }
  return out;
}

interface MemberPickerProps {
  /** полный список кандидатов (без себя/без исключённых — собирает родитель) */
  candidates: MemberCandidate[];
  /** выбранные имена (исходный регистр; сравнение — без учёта регистра) */
  selected: string[];
  /** добавить/убрать участника */
  onToggle: (username: string) => void;
  /** плейсхолдер строки поиска */
  placeholder?: string;
  /** заблокировать интерактив (запрос в полёте) */
  disabled?: boolean;
}

/** NEW (v1.0.29) GC: общий пикер участников — поиск + прокручиваемый список с
    кастомными чекбоксами (checked → фиолетовый градиент + галочка) + чипы
    выбранных над списком («Выбрано: N», чип снимается крестиком). Общая
    разметка для модалок создания и управления группой. */
export function MemberPicker({
  candidates,
  selected,
  onToggle,
  placeholder = 'Поиск людей…',
  disabled = false,
}: MemberPickerProps) {
  const [query, setQuery] = useState('');

  const lowerSelected = useMemo(
    () => new Set(selected.map(n => n.toLowerCase())),
    [selected]
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter(c => c.username.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      {/* Поиск по людям */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none"
          aria-hidden
        />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder}
          className="w-full pl-9 pr-4 py-2.5 bg-gray-100/80 dark:bg-gray-950/80 border border-gray-200 dark:border-gray-800 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>

      {/* Чипы выбранных — снимаются крестиком */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 shrink-0">
            Выбрано: {selected.length}
          </span>
          {selected.map(name => (
            <span
              key={name}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-purple-500/10 dark:bg-purple-500/15 border border-purple-500/30 text-purple-700 dark:text-purple-300 text-xs font-medium max-w-full"
            >
              <span className="max-w-[10rem] truncate">{name}</span>
              <button
                type="button"
                onClick={() => onToggle(name)}
                disabled={disabled}
                title={`Убрать ${name}`}
                aria-label={`Убрать ${name}`}
                className="p-0.5 rounded-full hover:bg-purple-500/20 transition-colors disabled:opacity-50 shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Список кандидатов (онлайн сверху — их отдаёт сборщик первыми) */}
      <div className="max-h-64 overflow-y-auto custom-scrollbar flex flex-col gap-1 pr-1">
        {filtered.length === 0 ? (
          <div className="py-8 text-center text-gray-500 dark:text-gray-400 text-sm">
            <Search className="w-6 h-6 mx-auto mb-2 text-gray-400 dark:text-gray-600" aria-hidden />
            Контакты не найдены
          </div>
        ) : (
          filtered.map(c => {
            const isSelected = lowerSelected.has(c.username.toLowerCase());
            return (
              <button
                key={c.username}
                type="button"
                onClick={() => onToggle(c.username)}
                disabled={disabled}
                aria-pressed={isSelected}
                title={isSelected ? `Убрать ${c.username}` : `Выбрать ${c.username}`}
                className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all border disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
                  isSelected
                    ? 'bg-purple-500/10 dark:bg-purple-500/15 border-purple-500/40'
                    : 'bg-white/40 dark:bg-gray-900/40 border-transparent hover:bg-gray-100/80 dark:hover:bg-gray-800/70 hover:border-gray-200 dark:hover:border-gray-700'
                }`}
              >
                {/* Кастомный чекбокс: checked → фиолетовый градиент + галочка */}
                <span
                  aria-hidden
                  className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${
                    isSelected
                      ? 'bg-gradient-to-br from-purple-500 to-violet-500 border-transparent text-white shadow-sm shadow-purple-500/30'
                      : 'border-purple-500/30 bg-white/70 dark:bg-gray-800/70'
                  }`}
                >
                  {isSelected && <Check className="w-3.5 h-3.5" />}
                </span>
                <Avatar src={c.avatar} name={c.username} size="sm" online={c.online} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900 dark:text-white truncate">
                    {c.username}
                  </span>
                  <span
                    className={`block text-[11px] truncate ${
                      c.online ? 'text-emerald-500/90' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
                    {c.online ? 'В сети' : formatLastSeen(c.lastSeen)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export const GroupCreateModal: React.FC<GroupCreateModalProps> = ({
  isOpen,
  users,
  knownUsers,
  currentUsername,
  onClose,
  onCreateGroup,
  busy = false,
}) => {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  // NEW (v1.0.29) GC: Esc закрывает модалку — глобальный keydown, подписка
  // только пока открыта (паттерн модалки настроек AI в ChatArea). Пока запрос
  // создания в полёте — не закрываем (родитель закроет после результата)
  useEffect(() => {
    if (!isOpen) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [isOpen, busy, onClose]);

  // сброс полей при каждом открытии (черновик прошлого раза не «протекает»)
  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelected([]);
    }
  }, [isOpen]);

  const candidates = useMemo(
    () => (isOpen ? buildMemberCandidates(users, knownUsers, currentUsername) : []),
    [isOpen, users, knownUsers, currentUsername]
  );

  const toggleMember = (username: string) => {
    setSelected(prev => {
      const lower = username.toLowerCase();
      return prev.some(n => n.toLowerCase() === lower)
        ? prev.filter(n => n.toLowerCase() !== lower)
        : [...prev, username];
    });
  };

  const canSubmit = name.trim().length > 0 && selected.length > 0;

  const handleSubmit = () => {
    if (!canSubmit || busy) return;
    // родитель создаёт группу и закрывает модалку (оптимистично — onClose сами не зовём)
    onCreateGroup(name.trim(), selected);
  };

  if (!isOpen) return null;

  return (
    <div
      onClick={() => {
        if (!busy) onClose();
      }}
      className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-label="Новая группа"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] rounded-2xl bg-white dark:bg-gray-900 border border-purple-500/20 shadow-2xl shadow-purple-500/20 overflow-hidden animate-scale-in flex flex-col cursor-default"
      >
        {/* Шапка: градиентная плитка Users + название + крестик */}
        <div className="px-5 pt-5 pb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 shadow-md shadow-purple-500/30 shrink-0">
              <Users className="w-4 h-4 text-white" aria-hidden />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-none">
                Новая группа
              </h3>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-none">
                Соберите участников для общения
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!busy) onClose();
            }}
            title="Закрыть"
            aria-label="Закрыть"
            className="p-2 rounded-xl text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Тело: название группы + пикер участников */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-4 flex flex-col gap-4">
          {/* Название с счётчиком N/40 */}
          <div>
            <label
              htmlFor="group-create-name"
              className="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5"
            >
              Название
            </label>
            <div className="relative">
              <input
                id="group-create-name"
                autoFocus
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={40}
                placeholder="Название группы"
                disabled={busy}
                className="w-full px-4 py-2.5 pr-12 bg-gray-100/80 dark:bg-gray-950/80 border border-gray-200 dark:border-gray-800 rounded-xl text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 dark:text-gray-500 tabular-nums pointer-events-none"
                aria-hidden
              >
                {name.length}/40
              </span>
            </div>
          </div>

          {/* Пикер участников (общий с модалкой управления) */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">
              Участники
            </label>
            <MemberPicker
              candidates={candidates}
              selected={selected}
              onToggle={toggleMember}
              placeholder="Поиск людей…"
              disabled={busy}
            />
          </div>
        </div>

        {/* Подвал: CTA «Создать группу» + подсказка в заблокированном виде */}
        <div className="px-5 py-4 border-t border-gray-200/80 dark:border-gray-800/80 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
            className="w-full px-5 py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-purple-500 to-violet-500 hover:brightness-110 active:scale-[0.98] shadow-lg shadow-purple-600/25 transition-all focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                Создание…
              </>
            ) : (
              'Создать группу'
            )}
          </button>
          {!canSubmit && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center leading-snug">
              Введите название и выберите хотя бы одного участника
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
