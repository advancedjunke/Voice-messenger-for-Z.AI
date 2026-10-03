/* NEW (v1.0.29) S: полировка плеера — play-кнопка входящих на градиенте
   палитры (purple→violet, была indigo), заполненная часть волны — мягкий
   перелив purple-500→violet-500 по длине, иконка Pause пульсирует при
   воспроизведении, время — tabular-nums (уже было), светлая пара у кнопки
   скорости. Функциональных изменений нет. */
/* NEW (v1.0.23) TH2: двухтемная конвертация. Play-кнопки (isMe: bg-white+
   text-indigo-700 с hover:bg-gray-100; входящая: bg-indigo-600+text-white) и
   цвета волны в inline-стилях — АКЦЕНТЫ, не тронуты (кнопка/пузырь одинаковы
   в обеих темах). Конвертирована только серая кнопка скорости входящих. */
import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause } from 'lucide-react';

interface AudioMessagePlayerProps {
  src: string;
  duration?: number;
  isMe: boolean;
}

// NEW (v1.0.22) N3: скорость воспроизведения — на уровне МОДУЛЯ, а не useState
// компонента: выбранный темп сохраняется при переходе между сообщениями
// (у каждого нового плеера раньше скорость сбрасывалась на 1×)
let sharedPlaybackRate = 1;
const NEXT_RATE = (rate: number): number => (rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1);

export const AudioMessagePlayer: React.FC<AudioMessagePlayerProps> = ({
  src,
  duration = 0,
  isMe,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // NEW (v1.0.22) N3: стартуем с общей (разделяемой) скорости
  const [playbackRate, setPlaybackRate] = useState(sharedPlaybackRate);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(src);
    // NEW (v1.0.22) N3: применяем выбранную ранее скорость сразу
    audio.playbackRate = sharedPlaybackRate;
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audioRef.current = null;
    };
  }, [src]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const cycleSpeed = () => {
    // NEW (v1.0.22) N3: 1× → 1.5× → 2× → 1×; выбор пишем в module-level,
    // чтобы он переживал переходы между сообщениями
    const nextRate = NEXT_RATE(playbackRate);
    sharedPlaybackRate = nextRate;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainder = Math.floor(secs % 60);
    return `${mins}:${remainder.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  // Waveform bars with static randomized aesthetic heights
  const bars = [40, 75, 55, 90, 60, 80, 45, 100, 70, 85, 50, 95, 65, 80, 40];

  // NEW (v1.0.29) S: цвет заполненной полоски — интерполяция purple-500 →
  // violet-500 по индексу: волна «наливается» градиентом по мере прогресса
  const playedColor = (idx: number): string => {
    const t = bars.length > 1 ? idx / (bars.length - 1) : 0;
    const from = [168, 85, 247]; // #a855f7 purple-500
    const to = [139, 92, 246]; // #8b5cf6 violet-500
    const mix = from.map((c, i) => Math.round(c + (to[i] - c) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  };

  return (
    <div className="flex items-center gap-3 py-1 min-w-[210px] max-w-[280px]">
      {/* Play/Pause Button */}
      {/* NEW (v1.0.29) S: кнопка — градиент палитры (purple→violet) вместо indigo */}
      <button
        type="button"
        onClick={togglePlay}
        className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 shadow-md focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
          isMe
            ? 'bg-white text-purple-700 hover:bg-gray-100'
            : 'bg-gradient-to-br from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white'
        }`}
      >
        {/* NEW (v1.0.29) S: иконка паузы мягко пульсирует — виден факт воспроизведения */}
        {isPlaying ? (
          <Pause className="w-5 h-5 fill-current animate-pulse" />
        ) : (
          <Play className="w-5 h-5 fill-current ml-0.5" />
        )}
      </button>

      {/* NEW (v1.0.22) N3: кнопка скорости рядом с play — 1× / 1.5× / 2×,
          выбор общий для всех голосовых сообщений (module-level) */}
      <button
        type="button"
        onClick={cycleSpeed}
        title="Скорость воспроизведения"
        aria-label={`Скорость воспроизведения: ${playbackRate}×`}
        className={`px-2 py-1 rounded-lg font-mono text-[11px] font-semibold tabular-nums shrink-0 transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:outline-none ${
          isMe
            ? 'bg-white/20 hover:bg-white/30 text-white'
            : 'bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-purple-700 dark:text-purple-300'
        }`}
      >
        {playbackRate}×
      </button>

      {/* Waveform & Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-end gap-1 h-6 py-0.5 cursor-pointer">
          {bars.map((barHeight, idx) => {
            const barProgress = (idx / bars.length) * 100;
            const isFilled = progress >= barProgress;

            return (
              <span
                key={idx}
                className="w-1 rounded-full transition-all duration-75"
                style={{
                  height: `${barHeight}%`,
                  backgroundColor: isFilled
                    ? isMe
                      ? '#ffffff'
                      : playedColor(idx)
                    : isMe
                    ? 'rgba(255, 255, 255, 0.35)'
                    : '#4b5563',
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between text-[11px] mt-1 opacity-80">
          <span className="tabular-nums">{isPlaying ? formatTime(currentTime) : formatTime(duration || 0)}</span>
        </div>
      </div>
    </div>
  );
};
