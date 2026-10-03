/* NEW (v1.0.29) S: полировка звонков — палитра приведена к фиолетовой
   (остаточные indigo-акценты конвертированы в purple), входящий/завершение —
   градиент rose, пульсирующее кольцо аватара на гудках/соединении,
   градиентная волосяная линия сверху карточки, анимированное многоточие
   статуса, tabular-nums у таймера. Функциональных изменений нет. */
/* NEW (v1.0.23) TH2: двухтемная конвертация — базовое (светлое) значение без
   префикса, прежнее тёмное — под dark: (тёмный вид не изменён). Фон модалки —
   bg-white (по контекстному исключению); затемняющий оверлей bg-black/75,
   red/emerald/indigo-кнопки и эквалайзер громкости — акценты, не тронуты. */
import React from 'react';
import { Phone, PhoneOff, Mic, MicOff, Volume2 } from 'lucide-react';
import type { ActiveCall } from '../types.js';
import { Avatar } from './Avatar.js';

interface CallModalProps {
  activeCall: ActiveCall | null;
  incomingCall: { callerId: string; callerName: string; callerAvatar?: string } | null;
  isMuted: boolean;
  duration: number;
  localVolume: number;
  remoteVolume: number;
  audioMode?: 'webrtc' | 'relay';
  onAnswer: () => void;
  onReject: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
}

export const CallModal: React.FC<CallModalProps> = ({
  activeCall,
  incomingCall,
  isMuted,
  duration,
  localVolume,
  remoteVolume,
  audioMode,
  onAnswer,
  onReject,
  onEnd,
  onToggleMute,
}) => {
  if (!activeCall && !incomingCall) return null;

  const formatDuration = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainder = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  };

  // 1. Incoming Call Dialog
  if (incomingCall && !activeCall) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
        <div className="w-full max-w-sm bg-white dark:bg-gray-900 border border-purple-500/30 rounded-3xl p-6 text-center shadow-2xl relative">
          <div className="relative mx-auto w-24 h-24 mb-4 flex items-center justify-center">
            {/* Animated ringing pulse rings */}
            {/* NEW (v1.0.29) S: кольца — фиолетовая палитра приложения */}
            <span className="absolute inset-0 rounded-full bg-purple-500/30 animate-ping" />
            <span className="absolute inset-2 rounded-full bg-purple-500/40 animate-pulse" />
            <div className="relative">
              <Avatar
                src={incomingCall.callerAvatar}
                name={incomingCall.callerName}
                size="2xl"
                className="shadow-xl"
              />
            </div>
          </div>

          <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
            {incomingCall.callerName}
          </h3>
          <p className="text-purple-600 dark:text-purple-300 text-sm font-medium mb-8 animate-pulse">
            Входящий аудиозвонок...
          </p>

          <div className="flex items-center justify-center gap-6">
            <button
              onClick={onReject}
              className="flex flex-col items-center gap-2 group"
            >
              {/* NEW (v1.0.29) S: отклонение — градиент rose (danger-палитра) */}
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-rose-500 to-rose-600 hover:from-rose-400 hover:to-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-600/30 transition-all transform group-hover:scale-105 active:scale-95">
                <PhoneOff className="w-6 h-6" />
              </div>
              <span className="text-xs text-gray-600 dark:text-gray-400">Отклонить</span>
            </button>

            <button
              onClick={onAnswer}
              className="flex flex-col items-center gap-2 group"
            >
              <div className="w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center shadow-lg shadow-emerald-600/30 transition-all transform group-hover:scale-110 active:scale-95 animate-bounce">
                <Phone className="w-6 h-6" />
              </div>
              <span className="text-xs text-emerald-400 font-medium">Ответить</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. Outgoing or Active Connected Call
  if (!activeCall) return null;

  return (
    <div className="fixed bottom-6 right-6 z-40 w-80 bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border border-gray-300/80 dark:border-gray-700/80 rounded-2xl shadow-2xl p-4 text-gray-900 dark:text-white transition-all transform animate-in slide-in-from-bottom-5 relative overflow-hidden">
      {/* NEW (v1.0.29) S: градиентная волосяная линия по верхнему краю карточки
          звонка — фирменный акцент, как у карточек профиля/входа */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-purple-500/50 to-transparent" aria-hidden="true" />
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          {/* NEW (v1.0.29) S: пульсирующее кольцо аватара, пока звонок не
              соединён (гудки/установка ICE) — «живое» ожидание */}
          <div className="relative">
            {(activeCall.status === 'calling' || activeCall.status === 'connecting') && (
              <span
                className="absolute inset-0 rounded-full bg-purple-500/30 animate-ping"
                aria-hidden="true"
              />
            )}
            <Avatar
              src={activeCall.partnerAvatar}
              name={activeCall.partnerName}
              size="lg"
              status={activeCall.status === 'connected' ? 'busy' : 'online'}
            />
          </div>
          <div>
            <h4 className="font-semibold text-sm leading-tight text-gray-900 dark:text-white">
              {activeCall.partnerName}
            </h4>
            <p className="text-xs text-gray-600 dark:text-gray-400 font-mono mt-0.5">
              {activeCall.status === 'calling' ? (
                // NEW (v1.0.29) S: статус — фиолетовая палитра + мягко пульсирующее
                // многоточие (без новых кейфреймов — animate-pulse на «…»)
                <span className="text-purple-600 dark:text-purple-300">
                  Гудки<span className="animate-pulse">…</span>
                </span>
              ) : activeCall.status === 'connecting' ? (
                // FIX (v1.0.21): статус до завершения ICE — не считаем таймер впустую
                <span className="text-purple-600 dark:text-purple-300">
                  Соединение<span className="animate-pulse">…</span>
                </span>
              ) : (
                <span className="text-emerald-400 font-medium tabular-nums">{formatDuration(duration)}</span>
              )}
            </p>
          </div>
        </div>

        {activeCall.status === 'connected' && (
          <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-200/80 dark:bg-gray-800/80 rounded-lg text-xs text-gray-700 dark:text-gray-300">
            <Volume2 className="w-3.5 h-3.5 text-purple-400" />
            <div className="flex items-end gap-0.5 h-3">
              {/* NEW (v1.0.29) S: эквалайзер громкости — фиолетовая палитра */}
              <span
                className="w-1 bg-purple-500 rounded-full transition-all"
                style={{ height: `${Math.max(15, (remoteVolume / 100) * 12)}px` }}
              />
              <span
                className="w-1 bg-purple-400 rounded-full transition-all"
                style={{ height: `${Math.max(25, (remoteVolume / 100) * 16)}px` }}
              />
              <span
                className="w-1 bg-violet-400 rounded-full transition-all"
                style={{ height: `${Math.max(10, (remoteVolume / 100) * 10)}px` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Voice indicator bar */}
      {activeCall.status === 'connected' && (
        <div className="my-3 py-1.5 px-3 bg-gray-100/60 dark:bg-gray-950/60 rounded-xl flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
          <span>Громкость микрофона:</span>
          <div className="w-24 h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-75 ${
                isMuted ? 'bg-red-500' : 'bg-emerald-500'
              }`}
              style={{ width: isMuted ? '0%' : `${localVolume}%` }}
            />
          </div>
        </div>
      )}

      {/* Audio mode indicator */}
      {activeCall.status === 'connected' && audioMode && (
        <div className="mb-2 flex items-center justify-center">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            audioMode === 'webrtc'
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
              : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${audioMode === 'webrtc' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {audioMode === 'webrtc' ? 'P2P' : 'Relay'}
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 mt-2 pt-2 border-t border-gray-200 dark:border-gray-800">
        <button
          onClick={onToggleMute}
          title={isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
          className={`p-3 rounded-full transition-all ${
            isMuted
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
              : 'bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'
          }`}
        >
          {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>

        <button
          onClick={onEnd}
          title="Завершить звонок"
          className="p-3 bg-gradient-to-br from-rose-500 to-rose-600 hover:from-rose-400 hover:to-rose-500 text-white rounded-full shadow-lg shadow-rose-600/30 transition-all transform active:scale-95"
        >
          <PhoneOff className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};
