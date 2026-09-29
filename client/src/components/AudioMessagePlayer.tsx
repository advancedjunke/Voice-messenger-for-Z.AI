import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause } from 'lucide-react';

interface AudioMessagePlayerProps {
  src: string;
  duration?: number;
  isMe: boolean;
}

export const AudioMessagePlayer: React.FC<AudioMessagePlayerProps> = ({
  src,
  duration = 0,
  isMe,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(src);
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
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
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

  return (
    <div className="flex items-center gap-3 py-1 min-w-[210px] max-w-[280px]">
      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 shadow-md ${
          isMe
            ? 'bg-white text-indigo-700 hover:bg-gray-100'
            : 'bg-indigo-600 text-white hover:bg-indigo-500'
        }`}
      >
        {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
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
                      : '#818cf8'
                    : isMe
                    ? 'rgba(255, 255, 255, 0.35)'
                    : '#4b5563',
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between text-[11px] mt-1 opacity-80">
          <span>{isPlaying ? formatTime(currentTime) : formatTime(duration || 0)}</span>
          <button
            type="button"
            onClick={cycleSpeed}
            className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-semibold transition-colors ${
              isMe
                ? 'bg-white/20 hover:bg-white/30 text-white'
                : 'bg-gray-800 hover:bg-gray-700 text-indigo-400'
            }`}
          >
            {playbackRate}x
          </button>
        </div>
      </div>
    </div>
  );
};
