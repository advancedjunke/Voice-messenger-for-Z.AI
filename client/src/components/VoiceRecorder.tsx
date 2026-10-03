/* NEW (v1.0.29) S: полировка записи — рамка и CTA приведены к фиолетовой
   палитре (indigo → purple→violet gradient), REC-точка — rose (danger-палитра).
   Эквалайзер остаётся на существующем .rec-eq (кейфрейм recBar в index.css);
   per-bar animate-pulse не добавлен — конфликтует с animation у .rec-eq span
   (специфичность селектора выше) и без него полоски уже анимированы. */
/* NEW (v1.0.23) TH2: двухтемная конвертация — базовое (светлое) значение без
   префикса, прежнее тёмное — под dark: (тёмный вид не изменён). RED-точка,
   эквалайзер, amber-индикатор и indigo-кнопка «Отправить» — акценты, не тронуты. */
import React, { useState, useRef, useEffect } from 'react';
import { Trash2, Send } from 'lucide-react';

interface VoiceRecorderProps {
  onSendVoice: (audioDataUrl: string, duration: number) => void;
  onCancel: () => void;
  /** FIX (v1.0.21): ошибка доступа к микрофону — тост вместо блокирующего alert() */
  onError?: (message: string) => void;
}

// FIX (v1.0.21): максимальная длина голосового сообщения — 120 секунд,
// дальше запись останавливается и отправляется автоматически
const MAX_RECORD_SECONDS = 120;

/**
 * FIX (v1.0.21): реальная длительность записи из метаданных блоба.
 * UI-таймер на setInterval дрейфует (браузер троттлит фоновые интервалы),
 * из-за чего присылаемая длительность расходилась с фактическим звуком.
 * Гард одноразового резолва + таймаут 1.5с → фолбэк на счётчик UI.
 */
function probeRealDuration(blob: Blob, fallbackSeconds: number): Promise<number> {
  return new Promise<number>(resolve => {
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const url = URL.createObjectURL(blob);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.style.display = 'none';
      document.body.appendChild(audio);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.remove();
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        finish(fallbackSeconds); // метаданные не пришли за 1.5с — берём UI-счётчик
      }, 1500);
      audio.addEventListener(
        'loadedmetadata',
        () => {
          window.clearTimeout(timeout);
          const d = audio.duration;
          cleanup();
          finish(Number.isFinite(d) && d > 0 ? Math.max(1, Math.round(d)) : fallbackSeconds);
        },
        { once: true }
      );
      audio.addEventListener(
        'error',
        () => {
          window.clearTimeout(timeout);
          cleanup();
          finish(fallbackSeconds);
        },
        { once: true }
      );
      audio.src = url;
    } catch {
      finish(fallbackSeconds);
    }
  });
}

export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({
  onSendVoice,
  onCancel,
  onError,
}) => {
  const [seconds, setSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // FIX (v1.0.21): собранный после остановки blob (см. onstop ниже)
  const recordedBlobRef = useRef<Blob | null>(null);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // FIX (v1.0.21): секунды в ref — для авто-стопа на 120с и фолбэка длительности
  const secondsRef = useRef(0);
  // FIX (v1.0.21): намерение отправить (кнопка/авто-стоп) + защита от двойной отправки
  const wantSendRef = useRef(false);
  const sentRef = useRef(false);

  // FIX (v1.0.21): свежие колбэки — через ref. Эффект записи теперь выполняется
  // один раз: раньше нестабильный onCancel в deps перезапускал запись на каждом
  // ре-рендере родителя (сбрасывая счётчик и теряя записанные чанки)
  const onSendVoiceRef = useRef(onSendVoice);
  const onCancelRef = useRef(onCancel);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSendVoiceRef.current = onSendVoice;
    onCancelRef.current = onCancel;
    onErrorRef.current = onError;
  });

  // FIX (v1.0.21): единый путь отправки — и для кнопки, и для авто-стопа.
  // Сначала уточняем длительность по метаданным, затем превращаем в base64.
  const finalizeSend = (blob: Blob) => {
    void (async () => {
      const fallback = Math.max(1, secondsRef.current);
      const duration = await probeRealDuration(blob, fallback);
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64Audio = reader.result as string;
        if (base64Audio) {
          onSendVoiceRef.current(base64Audio, duration);
        } else {
          onCancelRef.current();
        }
      };
      reader.onerror = () => onCancelRef.current();
      reader.readAsDataURL(blob);
    })();
  };

  useEffect(() => {
    let isMounted = true;

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!isMounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : '';

        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];
        recordedBlobRef.current = null;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        // FIX (v1.0.21): onstop назначается ОДИН раз при старте и ВСЕГДА собирает
        // blob в ref — раньше onstop назначался только в кнопке «Отправить», и
        // внешняя остановка (ошибка рекордера, остановка треков) теряла запись.
        // Отправка происходит лишь при wantSendRef (кнопка или авто-стоп).
        recorder.onstop = () => {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          const blob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          recordedBlobRef.current = blob;
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
          }
          if (wantSendRef.current && !sentRef.current && blob.size > 0 && isMounted) {
            sentRef.current = true; // защита от повторной отправки
            finalizeSend(blob);
          }
        };

        recorder.start(100);

        timerRef.current = window.setInterval(() => {
          secondsRef.current += 1;
          setSeconds(secondsRef.current);
          // FIX (v1.0.21): авто-стоп и отправка на 120-й секунде
          if (secondsRef.current >= MAX_RECORD_SECONDS) {
            wantSendRef.current = true;
            const r = mediaRecorderRef.current;
            if (r && r.state !== 'inactive') {
              try { r.stop(); } catch { /* уже остановлен */ }
            }
          }
        }, 1000);
      } catch (err) {
        console.error('Failed to start audio recording:', err);
        // FIX (v1.0.21): ошибка микрофона — тост вместо блокирующего alert()
        onErrorRef.current?.('Не удалось получить доступ к микрофону для записи голосового сообщения');
        onCancelRef.current();
      }
    }

    startRecording();

    return () => {
      isMounted = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
    // FIX (v1.0.21): запись стартует один раз; колбэки читаются через ref выше
  }, []);

  const handleStopAndSend = () => {
    if (sentRef.current) return; // двойной клик — игнорируем
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      wantSendRef.current = true;
      try { recorder.stop(); } catch { /* уже остановлен */ }
    } else if (recordedBlobRef.current && recordedBlobRef.current.size > 0) {
      // FIX (v1.0.21): рекордер уже остановлен извне — отправляем собранный blob
      sentRef.current = true;
      finalizeSend(recordedBlobRef.current);
    }
  };

  const handleCancel = () => {
    // FIX (v1.0.21): гасим и возможный авто-стоп — отмена отменяет отправку
    wantSendRef.current = false;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* уже остановлен */ }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    onCancelRef.current();
  };

  const formatTimer = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // FIX (v1.0.21): индикатор остатка до лимита 120с (появляется после 100с)
  const remaining = Math.max(0, MAX_RECORD_SECONDS - seconds);

  return (
    <div className="flex items-center justify-between w-full bg-gray-50 dark:bg-gray-900 border border-purple-500/30 rounded-xl px-4 py-2 animate-in fade-in">
      <div className="flex items-center gap-3 min-w-0">
        {/* NEW (v1.0.22) P4: анимация записи — пульсирующая точка REC
            + 5 полосок-эквалайзера (см. .rec-eq в index.css) */}
        {/* NEW (v1.0.29) S: REC-точка — rose (danger-палитра приложения) */}
        <span className="flex items-center gap-1.5 shrink-0" aria-hidden>
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
          <span className="rec-eq">
            <span /><span /><span /><span /><span />
          </span>
        </span>
        <span className="text-sm font-medium text-gray-900 dark:text-white font-mono tabular-nums">
          {formatTimer(seconds)}
        </span>
        {seconds > 100 && remaining > 0 && (
          <span className="text-[11px] text-amber-400 whitespace-nowrap">
            осталось {remaining} с
          </span>
        )}
        <span className="text-xs text-gray-600 dark:text-gray-400 hidden sm:inline truncate">
          Идет запись голосового сообщения...
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {/* Cancel */}
        <button
          type="button"
          onClick={handleCancel}
          title="Отменить запись"
          className="p-2 text-gray-600 dark:text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Send */}
        {/* NEW (v1.0.29) S: CTA — градиент палитры (purple→violet) вместо indigo */}
        <button
          type="button"
          onClick={handleStopAndSend}
          title="Отправить голосовое"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white rounded-lg shadow-md shadow-purple-600/20 transition-all active:scale-95 text-xs font-medium"
        >
          <span>Отправить</span>
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
