import React, { useState, useRef, useEffect } from 'react';
import { Trash2, Send } from 'lucide-react';

interface VoiceRecorderProps {
  onSendVoice: (audioDataUrl: string, duration: number) => void;
  onCancel: () => void;
}

export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({
  onSendVoice,
  onCancel,
}) => {
  const [seconds, setSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        recorder.start(100);

        timerRef.current = window.setInterval(() => {
          setSeconds(prev => prev + 1);
        }, 1000);
      } catch (err) {
        console.error('Failed to start audio recording:', err);
        alert('Не удалось получить доступ к микрофону для записи голосового сообщения');
        onCancel();
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
  }, [onCancel]);

  const handleStopAndSend = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const duration = Math.max(1, seconds);

    recorder.onstop = () => {
      const audioBlob = new Blob(audioChunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      });

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64Audio = reader.result as string;
        onSendVoice(base64Audio, duration);
      };
      reader.readAsDataURL(audioBlob);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };

    recorder.stop();
  };

  const handleCancel = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    onCancel();
  };

  const formatTimer = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center justify-between w-full bg-gray-900 border border-indigo-500/40 rounded-xl px-4 py-2 animate-in fade-in">
      <div className="flex items-center gap-3">
        <span className="w-3 h-3 rounded-full bg-red-500 animate-ping" />
        <span className="text-sm font-medium text-white font-mono">
          {formatTimer(seconds)}
        </span>
        <span className="text-xs text-gray-400 hidden sm:inline">
          Идет запись голосового сообщения...
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/* Cancel */}
        <button
          type="button"
          onClick={handleCancel}
          title="Отменить запись"
          className="p-2 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-800 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        {/* Send */}
        <button
          type="button"
          onClick={handleStopAndSend}
          title="Отправить голосовое"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shadow-md transition-all active:scale-95 text-xs font-medium"
        >
          <span>Отправить</span>
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
