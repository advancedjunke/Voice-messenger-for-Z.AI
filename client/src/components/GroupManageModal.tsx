/* NEW (v1.0.29) GC: модалка управления группой — список участников с
   онлайн-статусами, переименование (только создатель), приглашение новых
   участников и выход из группы с инлайн-подтверждением (без window.confirm).
   Переиспользует MemberPicker/buildMemberCandidates из GroupCreateModal.
   Двухтемная (light + dark:), секции разделены градиентными волосками,
   «опасная зона» — розовая.
   NEW (v1.0.30) GR: создатель может УДАЛЯТЬ участников (UserX в строке,
   инлайн-подтверждение в строке — паттерн выхода из группы). Esc —
   поэтапная отмена (СТРОГО в этом порядке): правка названия → подтверждение
   удаления участника → подтверждение выхода → закрытие модалки. */
import React, { useState, useEffect, useMemo } from 'react';
import type { User, KnownUser, GroupInfo } from '../types.js';
// NEW (v1.0.30) GR: UserX — кнопка удаления участника в строке списка
import { Users, X, Check, Pencil, Loader2, UserPlus, LogOut, UserX } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { MemberPicker, buildMemberCandidates } from './GroupCreateModal.js';

interface GroupManageModalProps {
  isOpen: boolean;
  group: GroupInfo;
  /** онлайн-пользователи — для статусов «В сети» у участников */
  users: User[];
  knownUsers: KnownUser[];
  currentUsername: string;
  onClose: () => void;
  /** пригласить участников в группу (имена — исходный регистр) */
  onInvite: (groupId: string, memberUsernames: string[]) => void;
  /** переименовать группу */
  onRename: (groupId: string, name: string) => void;
  /** выйти из группы */
  onLeave: (groupId: string) => void;
  /** NEW (v1.0.30) GR: удалить участника из группы (только создатель;
   *  username — исходный регистр из members). Модалку НЕ закрываем — список
   *  обновится живым group:updated от сервера */
  onKick?: (groupId: string, username: string) => void;
  /** запрос в полёте: спиннеры на кнопках действий */
  busy?: boolean;
}

// NEW (v1.0.29) GC: градиентный волосок между секциями модалки
function SectionHairline() {
  return (
    <div
      className="h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent"
      aria-hidden
    />
  );
}

export const GroupManageModal: React.FC<GroupManageModalProps> = ({
  isOpen,
  group,
  users,
  knownUsers,
  currentUsername,
  onClose,
  onInvite,
  onRename,
  onLeave,
  // NEW (v1.0.30) GR: удаление участника (вызывает App → group:kick на сервере)
  onKick,
  busy = false,
}) => {
  // NEW (v1.0.29) GC: inline-правка названия — черновик + флаг режима;
  // выбор приглашённых; инлайн-подтверждение выхода (без window.confirm)
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [inviteSelected, setInviteSelected] = useState<string[]>([]);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  // NEW (v1.0.30) GR: имя участника, чья строка в режиме подтверждения
  // удаления (null — ни одна). Одна строка за раз: клик по X другой строки
  // просто переключает подтверждение на неё
  const [kickConfirmName, setKickConfirmName] = useState<string | null>(null);

  const selfLower = currentUsername.toLowerCase();
  const creatorLower = group.createdBy.toLowerCase();
  // создателя определяем без учёта регистра (регистр имени при входе может отличаться)
  const isCreator = selfLower === creatorLower;

  // имена онлайн-пользователей в нижнем регистре — для статусов участников
  const onlineNames = useMemo(
    () => new Set(users.map(u => u.username.toLowerCase())),
    [users]
  );

  // кандидаты на приглашение: все люди, КРОМЕ себя и уже состоящих в группе
  const inviteCandidates = useMemo(
    () =>
      isOpen
        ? buildMemberCandidates(users, knownUsers, currentUsername, group.members)
        : [],
    [isOpen, users, knownUsers, currentUsername, group.members]
  );

  // сброс локального состояния при каждом открытии (и смене группы)
  useEffect(() => {
    if (isOpen) {
      setRenaming(false);
      setRenameDraft('');
      setInviteSelected([]);
      setLeaveConfirm(false);
      // NEW (v1.0.30) GR: подтверждение удаления участника тоже сбрасываем
      setKickConfirmName(null);
    }
  }, [isOpen, group.id]);

  // NEW (v1.0.29) GC: Esc — поэтапная отмена: правка названия → подтверждение
  // выхода → закрытие модалки (паттерн условных подписок на document keydown).
  // NEW (v1.0.30) GR: в цепочку добавлено подтверждение удаления участника —
  // ПОРЯДОК: правка названия → удаление участника → выход → закрытие
  useEffect(() => {
    if (!isOpen) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renaming) {
        setRenaming(false);
        return;
      }
      if (kickConfirmName) {
        setKickConfirmName(null);
        return;
      }
      if (leaveConfirm) {
        setLeaveConfirm(false);
        return;
      }
      if (!busy) onClose();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, [isOpen, renaming, kickConfirmName, leaveConfirm, busy, onClose]);

  const startRename = () => {
    setRenameDraft(group.name);
    setRenaming(true);
  };

  // NEW (v1.0.29) GC: сохранить название — пустой/неизменный черновик просто
  // выходит из режима правки без запроса к серверу
  const commitRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === group.name) return;
    onRename(group.id, next);
  };

  const toggleInvite = (username: string) => {
    setInviteSelected(prev => {
      const lower = username.toLowerCase();
      return prev.some(n => n.toLowerCase() === lower)
        ? prev.filter(n => n.toLowerCase() !== lower)
        : [...prev, username];
    });
  };

  const handleInvite = () => {
    if (inviteSelected.length === 0 || busy) return;
    onInvite(group.id, inviteSelected);
    // сброс выбора: состав группы обновится приходом нового GroupInfo
    setInviteSelected([]);
  };

  // NEW (v1.0.30) GR: подтвердить удаление участника. Модалку НЕ закрываем —
  // список участников обновится живым group:updated (App перерендерит модалку
  // со свежим group); сбрасываем только режим подтверждения строки.
  // «Удалить» получает фокус при входе в режим → Enter подтверждает,
  // Esc отменяет (цепочка в эффекте keydown выше)
  const confirmKickMember = (member: string) => {
    setKickConfirmName(null);
    onKick?.(group.id, member);
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
      aria-label="Управление группой"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] rounded-2xl bg-white dark:bg-gray-900 border border-purple-500/20 shadow-2xl shadow-purple-500/20 overflow-hidden animate-scale-in flex flex-col cursor-default"
      >
        {/* Шапка: плитка Users + название (создателю — inline-редактируемое) + крестик */}
        <div className="px-5 pt-5 pb-4 flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <div className="p-2 rounded-xl bg-gradient-to-br from-purple-500 via-violet-500 to-fuchsia-500 shadow-md shadow-purple-500/30 shrink-0">
              <Users className="w-4 h-4 text-white" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              {isCreator ? (
                renaming ? (
                  /* Режим правки: input + Check/X (Enter = Check, Esc = X) */
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      type="text"
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') setRenaming(false);
                      }}
                      maxLength={40}
                      placeholder="Название группы"
                      aria-label="Новое название группы"
                      className="min-w-0 flex-1 px-3 py-1.5 bg-gray-100/80 dark:bg-gray-950/80 border border-purple-500/40 rounded-lg text-sm font-bold text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 transition-all"
                    />
                    <button
                      type="button"
                      onClick={commitRename}
                      title="Сохранить название (Enter)"
                      aria-label="Сохранить название"
                      className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-500/10 transition-colors shrink-0"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(false)}
                      title="Отменить переименование (Esc)"
                      aria-label="Отменить переименование"
                      className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  /* Обычный вид: название + карандаш */
                  <div className="flex items-center gap-1.5 min-w-0">
                    <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-tight truncate">
                      {group.name}
                    </h3>
                    <button
                      type="button"
                      onClick={startRename}
                      title="Переименовать группу"
                      aria-label="Переименовать группу"
                      className="p-1.5 rounded-lg text-gray-500 hover:text-purple-500 hover:bg-purple-500/10 transition-colors shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              ) : (
                /* Не создатель: просто название + подпись с именем создателя */
                <>
                  <h3 className="font-bold text-gray-900 dark:text-white text-sm leading-tight truncate">
                    {group.name}
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    Создатель: {group.createdBy}
                  </p>
                </>
              )}
              {isCreator && !renaming && (
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                  Вы создатель группы
                </p>
              )}
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

        <SectionHairline />

        {/* Тело: участники → приглашение → опасная зона */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-4">
          {/* Секция «Участники · N» */}
          <section aria-label="Участники группы">
            <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
              Участники · {group.members.length}
            </h4>
            <div className="max-h-56 overflow-y-auto custom-scrollbar flex flex-col gap-0.5 pr-1">
              {group.members.map(member => {
                const isOnline = onlineNames.has(member.toLowerCase());
                const isSelf = member.toLowerCase() === selfLower;
                const isMemberCreator = member.toLowerCase() === creatorLower;
                // NEW (v1.0.30) GR: удалять участников может только создатель,
                // и только не себя и не создателя (самого себя); кнопка живёт
                // только когда App пробрасывает onKick (до вайринга — нет
                // «мёртвых» кнопок, паттерн onOpenGroupPanel из v1.0.29)
                const canKick = isCreator && !isSelf && !isMemberCreator && Boolean(onKick);
                return (
                  <div
                    key={member}
                    className="group flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-gray-100/70 dark:hover:bg-gray-800/70 transition-colors"
                  >
                    {/* Аватар-инициал: онлайн → изумрудное кольцо (паттерн
                        сайдбара) + точка статуса; офлайн → серая точка */}
                    <Avatar
                      name={member}
                      size="sm"
                      online={isOnline}
                      className={isOnline ? 'ring-2 ring-emerald-500/60' : ''}
                    />
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate min-w-0 flex-1">
                      {member}
                      {isSelf && (
                        <span className="text-gray-500 dark:text-gray-400 font-normal"> (вы)</span>
                      )}
                    </span>
                    {isMemberCreator && (
                      <span className="px-2 py-0.5 rounded-full bg-gradient-to-r from-purple-500 to-violet-500 text-white text-[10px] font-bold leading-none shrink-0">
                        создатель
                      </span>
                    )}
                    <span
                      className={`text-[11px] shrink-0 ${
                        isOnline
                          ? 'text-emerald-500/90'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {isOnline ? 'В сети' : 'не в сети'}
                    </span>
                    {/* NEW (v1.0.30) GR: удаление участника (только создатель).
                        X виден на hover строки (на тач — полупрозрачный) —
                        паттерн кнопок-булавок Sidebar; клик → инлайн-подтверждение
                        ПРЯМО В СТРОКЕ (замещает X): «Удалить» (rose) + «Отмена»
                        (ghost). «Удалить» берёт фокус → Enter подтверждает,
                        Esc отменяет (цепочка в эффекте keydown выше) */}
                    {canKick &&
                      (kickConfirmName === member ? (
                        <span className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            autoFocus
                            onClick={() => confirmKickMember(member)}
                            disabled={busy}
                            title={`Удалить ${member} из группы (Enter)`}
                            aria-label={`Удалить ${member} из группы`}
                            className="px-2.5 py-1 rounded-lg text-xs font-semibold text-white bg-rose-500 hover:bg-rose-600 active:scale-[0.98] transition-all disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:outline-none"
                          >
                            Удалить
                          </button>
                          <button
                            type="button"
                            onClick={() => setKickConfirmName(null)}
                            disabled={busy}
                            title="Отмена (Esc)"
                            aria-label="Отменить удаление участника"
                            className="px-2.5 py-1 rounded-lg text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-all disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
                          >
                            Отмена
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setKickConfirmName(prev => (prev === member ? null : member))
                          }
                          disabled={busy}
                          title={`Удалить ${member} из группы`}
                          aria-label={`Удалить ${member} из группы`}
                          className="p-1.5 rounded-lg bg-white/80 dark:bg-gray-800/80 border border-gray-300 dark:border-gray-700 text-gray-400 hover:text-rose-500 hover:border-rose-400/50 transition-all active:scale-90 opacity-60 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:outline-none disabled:opacity-30 shrink-0"
                        >
                          <UserX className="w-3.5 h-3.5" />
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </section>

          <SectionHairline />

          {/* Секция «Пригласить» */}
          <section aria-label="Пригласить участников">
            <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
              Пригласить
            </h4>
            <MemberPicker
              candidates={inviteCandidates}
              selected={inviteSelected}
              onToggle={toggleInvite}
              placeholder="Поиск людей…"
              disabled={busy}
            />
            <button
              type="button"
              onClick={handleInvite}
              disabled={inviteSelected.length === 0 || busy}
              className="mt-2.5 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-purple-500 to-violet-500 hover:brightness-110 active:scale-[0.98] shadow-lg shadow-purple-600/25 transition-all focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              ) : (
                <UserPlus className="w-4 h-4" aria-hidden />
              )}
              Пригласить
            </button>
          </section>

          <SectionHairline />

          {/* Опасная зона — розовый тинт; выход через инлайн-подтверждение */}
          <section
            aria-label="Опасная зона"
            className="rounded-2xl border border-rose-500/30 bg-rose-500/5 dark:bg-rose-500/10 p-3.5"
          >
            <h4 className="text-xs font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400 mb-2.5">
              Опасная зона
            </h4>
            {leaveConfirm ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-gray-800 dark:text-gray-200 font-medium">
                  Точно выйти?
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onLeave(group.id)}
                    disabled={busy}
                    className="flex-1 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:outline-none"
                  >
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                    ) : (
                      <LogOut className="w-4 h-4" aria-hidden />
                    )}
                    Да, выйти
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeaveConfirm(false)}
                    disabled={busy}
                    className="flex-1 px-4 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-200/70 dark:bg-gray-800/70 hover:bg-gray-300/70 dark:hover:bg-gray-700/70 active:scale-[0.98] transition-all disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLeaveConfirm(true)}
                disabled={busy}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold border border-rose-500/30 bg-rose-600/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:outline-none"
              >
                <LogOut className="w-4 h-4" aria-hidden />
                Выйти из группы
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
