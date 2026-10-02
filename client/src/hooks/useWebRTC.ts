import { useState, useRef, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type { ActiveCall } from '../types.js';
import { audioTone } from '../utils/audioTone.js';

// STUN + Free Public TURN (OpenRelay) for NAT traversal across different networks
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['stun:stun.nextcloud.com:443'] },
    {
      urls: [
        'stun:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelay',
      credential: 'openrelay',
    },
  ],
  iceCandidatePoolSize: 10,
};

// How long to wait for WebRTC ICE to connect before falling back to relay (ms)
const ICE_TIMEOUT_MS = 6000;

type AudioMode = 'webrtc' | 'relay';

export function useWebRTC(socket: Socket | null, currentUserId: string | null) {
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    callerId: string;
    callerName: string;
    callerAvatar?: string;
    offer: RTCSessionDescriptionInit;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [localVolume, setLocalVolume] = useState(0);
  const [remoteVolume, setRemoteVolume] = useState(0);
  const [audioMode, setAudioMode] = useState<AudioMode>('webrtc');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Queue for ICE candidates that arrive before setRemoteDescription completes
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // Socket.io audio relay refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const relayActiveRef = useRef(false);
  const partnerIdRef = useRef<string | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const iceTimeoutRef = useRef<number | null>(null);
  const audioModeRef = useRef<AudioMode>('webrtc');

  // MSE (MediaSource) refs для непрерывного relay-звука
  // FIX: decodeAudioData не может декодировать webm-чанки MediaRecorder после первого
  // (они без заголовка EBML) — теперь чанки аппендятся в MediaSource буфер
  const relayAudioElRef = useRef<HTMLAudioElement | null>(null);
  const relaySourceBufferRef = useRef<SourceBuffer | null>(null);
  const relayQueueRef = useRef<ArrayBuffer[]>([]);
  const relayAppendingRef = useRef(false);
  const relayHeaderRef = useRef<ArrayBuffer | null>(null);
  const relayAnalyserAttachedRef = useRef(false);
  const disconnectGraceRef = useRef<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    audioModeRef.current = audioMode;
  }, [audioMode]);

  // Initialize and attach audio element to DOM so browser autoplay policies never block sound
  useEffect(() => {
    let audio = document.getElementById('webrtc-remote-audio') as HTMLAudioElement;
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'webrtc-remote-audio';
      audio.autoplay = true;
      (audio as any).playsInline = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    remoteAudioRef.current = audio;

    return () => {
      if (audio) {
        audio.pause();
        audio.srcObject = null;
      }
    };
  }, []);

  // Visualizer loop for volume levels
  const startVolumeVisualizer = useCallback(() => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioCtx();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const localData = new Uint8Array(32);
    const remoteData = new Uint8Array(32);

    const updateVolume = () => {
      if (localAnalyserRef.current) {
        localAnalyserRef.current.getByteFrequencyData(localData);
        let sum = 0;
        for (let i = 0; i < localData.length; i++) sum += localData[i];
        setLocalVolume(Math.min(100, Math.round((sum / localData.length) * 1.5)));
      }

      if (remoteAnalyserRef.current) {
        remoteAnalyserRef.current.getByteFrequencyData(remoteData);
        let sum = 0;
        for (let i = 0; i < remoteData.length; i++) sum += remoteData[i];
        setRemoteVolume(Math.min(100, Math.round((sum / remoteData.length) * 1.5)));
      }

      animationFrameRef.current = requestAnimationFrame(updateVolume);
    };

    updateVolume();
  }, []);

  const attachAnalyser = (stream: MediaStream, isLocal: boolean) => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioCtx();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      if (isLocal) {
        localAnalyserRef.current = analyser;
      } else {
        // Connect to destination with 0 gain so Chrome does not mute the audio element
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        analyser.connect(silentGain);
        silentGain.connect(ctx.destination);
        remoteAnalyserRef.current = analyser;
      }
    } catch (e) {
      console.warn('Could not attach audio analyser:', e);
    }
  };

  // Helper to drain queued ICE candidates once remoteDescription is set
  const drainCandidateQueue = async (pc: RTCPeerConnection) => {
    while (iceCandidateQueueRef.current.length > 0) {
      const candidate = iceCandidateQueueRef.current.shift();
      if (candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('[WebRTC] Added queued ICE candidate');
        } catch (err) {
          console.error('[WebRTC] Failed to add queued ICE candidate', err);
        }
      }
    }
  };

  // ────────────────────────────────────────────────────────────
  // Socket.io Audio Relay — fallback when WebRTC P2P fails
  // ────────────────────────────────────────────────────────────

  /** Start sending local mic audio via Socket.io */
  const startRelayAudio = useCallback((partnerId: string) => {
    if (!socket || !localStreamRef.current) return;
    relayActiveRef.current = true;
    partnerIdRef.current = partnerId;

    console.log('[Relay] Starting audio relay to', partnerId);

    // Use MediaRecorder with very small timeslice for low latency
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const recorder = new MediaRecorder(localStreamRef.current, {
      mimeType,
      audioBitsPerSecond: 32000, // Low bitrate for relay
    });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && relayActiveRef.current && partnerIdRef.current) {
        // FIX: отправляем бинарный ArrayBuffer вместо base64 — меньше трафика и задержка ниже
        event.data
          .arrayBuffer()
          .then(buffer => {
            if (relayActiveRef.current && partnerIdRef.current && socket) {
              socket.emit('audio:data', {
                targetUserId: partnerIdRef.current,
                audio: buffer,
              });
            }
          })
          .catch(() => {});
      }
    };

    recorder.start(100); // 100ms chunks for balance of latency/overhead
    mediaRecorderRef.current = recorder;
  }, [socket]);

  /** Stop relay audio sending */
  const stopRelayAudio = useCallback(() => {
    relayActiveRef.current = false;
    partnerIdRef.current = null;
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
    }
    if (playbackCtxRef.current) {
      try { playbackCtxRef.current.close(); } catch {}
      playbackCtxRef.current = null;
    }
    // Cleanup MSE relay playback
    relayQueueRef.current = [];
    relayAppendingRef.current = false;
    relayHeaderRef.current = null;
    relaySourceBufferRef.current = null;
    relayAnalyserAttachedRef.current = false;
    if (relayAudioElRef.current) {
      try {
        relayAudioElRef.current.pause();
        relayAudioElRef.current.removeAttribute('src');
        relayAudioElRef.current.load();
      } catch {}
      relayAudioElRef.current.remove();
      relayAudioElRef.current = null;
    }
  }, []);

  /** Switch from WebRTC to Socket.io relay */
  const switchToRelay = useCallback((partnerId: string) => {
    console.log('[Relay] ⚡ Switching to Socket.io audio relay (WebRTC P2P failed)');
    setAudioMode('relay');

    // Close WebRTC peer connection — we don't need it
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    // Detach audio element from WebRTC stream
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    // Start sending audio via relay
    startRelayAudio(partnerId);
  }, [startRelayAudio]);

  // Cleanup all call connections & timers
  const cleanupCall = useCallback((playHangup = true) => {
    if (playHangup) {
      audioTone.playHangupTone();
    } else {
      audioTone.stopAll();
    }

    if (iceTimeoutRef.current) {
      clearTimeout(iceTimeoutRef.current);
      iceTimeoutRef.current = null;
    }

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    if (disconnectGraceRef.current) {
      clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    // Stop relay
    stopRelayAudio();

    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    iceCandidateQueueRef.current = [];

    setActiveCall(null);
    setIncomingCall(null);
    setIsMuted(false);
    setCallDuration(0);
    setLocalVolume(0);
    setRemoteVolume(0);
    setAudioMode('webrtc');
  }, [stopRelayAudio]);

  // Timer for connected call
  useEffect(() => {
    if (activeCall?.status === 'connected') {
      setCallDuration(0);
      durationTimerRef.current = window.setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
      startVolumeVisualizer();
    } else {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    }
    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [activeCall?.status, startVolumeVisualizer]);

  // ────────────────────────────────────────────────────────────
  // Receive relayed audio from partner via Socket.io
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    /** Создаём (или переиспользуем) скрытый audio-элемент для relay-воспроизведения */
    const ensureRelayAudioEl = (): HTMLAudioElement => {
      if (!relayAudioElRef.current) {
        const audio = document.createElement('audio');
        audio.id = 'relay-remote-audio';
        audio.autoplay = true;
        (audio as any).playsInline = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        relayAudioElRef.current = audio;
      }
      return relayAudioElRef.current;
    };

    /** MSE-плейбек: чанки MediaRecorder аппендятся в непрерывный буфер */
    const setupMsePlayback = (audio: HTMLAudioElement): boolean => {
      const canMse =
        typeof MediaSource !== 'undefined' &&
        (MediaSource as any).isTypeSupported?.('audio/webm;codecs=opus');
      if (!canMse) return false;
      try {
        const ms = new MediaSource();
        audio.src = URL.createObjectURL(ms);
        audio.play().catch(() => {});
        ms.addEventListener('sourceopen', () => {
          try {
            const sb = ms.addSourceBuffer('audio/webm;codecs=opus');
            sb.mode = 'sequence'; // терпим к «дырам» в таймстампах между чанками
            sb.addEventListener('updateend', () => {
              relayAppendingRef.current = false;
              const next = relayQueueRef.current.shift();
              if (next && !sb.updating) {
                try {
                  relayAppendingRef.current = true;
                  sb.appendBuffer(next);
                } catch {
                  relayAppendingRef.current = false;
                }
              }
            });
            relaySourceBufferRef.current = sb;
            // Прокачиваем уже ожидающие чанки
            const first = relayQueueRef.current.shift();
            if (first) {
              relayAppendingRef.current = true;
              try {
                sb.appendBuffer(first);
              } catch {
                relayAppendingRef.current = false;
              }
            }
          } catch {}
        });
        return true;
      } catch {
        return false;
      }
    };

    const handleRelayAudio = async ({ audio }: { fromUserId: string; audio: ArrayBuffer | Uint8Array | string }) => {
      try {
        let chunk: ArrayBuffer;
        if (typeof audio === 'string') {
          // Совместимость со старым клиентом (base64 data URL)
          const response = await fetch(audio);
          chunk = await response.arrayBuffer();
        } else if (audio instanceof ArrayBuffer) {
          chunk = audio;
        } else {
          // Двоичные данные приходят как Uint8Array — копируем в ArrayBuffer
          const u8 = audio as Uint8Array;
          chunk = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
        }

        // Первый чанк содержит WebM-заголовки — сохраняем для фолбэка
        if (!relayHeaderRef.current) {
          relayHeaderRef.current = chunk.slice(0);
        }

        const audioEl = ensureRelayAudioEl();
        const mseReady = Boolean(relaySourceBufferRef.current);
        if (!mseReady && !audioEl.src) {
          if (!setupMsePlayback(audioEl)) {
            (audioEl as any).__useDecodeFallback = true;
          }
        }

        const sb = relaySourceBufferRef.current;
        if (sb) {
          // Основной путь — MSE: непрерывный плавный звук
          if (sb.updating || relayAppendingRef.current) {
            relayQueueRef.current.push(chunk);
          } else {
            try {
              relayAppendingRef.current = true;
              sb.appendBuffer(chunk);
            } catch {
              relayAppendingRef.current = false;
              relayQueueRef.current.push(chunk);
            }
          }

          // Подключаем анализатор громкости к media-элементу (один раз)
          if (!relayAnalyserAttachedRef.current) {
            try {
              const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
              if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
                audioContextRef.current = new AudioCtx();
              }
              const ctx = audioContextRef.current;
              if (ctx.state === 'suspended') ctx.resume().catch(() => {});
              const srcNode = ctx.createMediaElementSource(audioEl);
              const analyser = ctx.createAnalyser();
              analyser.fftSize = 64;
              srcNode.connect(analyser);
              analyser.connect(ctx.destination);
              remoteAnalyserRef.current = analyser;
              relayAnalyserAttachedRef.current = true;
            } catch {}
          }
        } else {
          // Фолбэк: decodeAudioData с подстановкой WebM-заголовка (чанки без заголовка иначе не декодируются)
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
            playbackCtxRef.current = new AudioCtx({ sampleRate: 48000 });
          }
          const ctx = playbackCtxRef.current;
          if (ctx.state === 'suspended') await ctx.resume();

          const header = relayHeaderRef.current;
          const blob = header
            ? new Blob([header, chunk], { type: 'audio/webm' })
            : new Blob([chunk], { type: 'audio/webm' });
          const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          source.start(0);

          if (audioBuffer.numberOfChannels > 0) {
            const channelData = audioBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < channelData.length; i++) sum += Math.abs(channelData[i]);
            const avg = sum / channelData.length;
            setRemoteVolume(Math.min(100, Math.round(avg * 500)));
          }
        }
      } catch (e) {
        // Silently skip corrupt chunks
      }
    };

    socket.on('audio:data', handleRelayAudio);
    return () => { socket.off('audio:data', handleRelayAudio); };
  }, [socket]);

  // Handle incoming socket signaling events
  useEffect(() => {
    if (!socket) return;

    // Incoming call event
    const handleIncomingCall = ({
      callerId,
      callerName,
      callerAvatar,
      offer,
    }: {
      callerId: string;
      callerName: string;
      callerAvatar?: string;
      offer: RTCSessionDescriptionInit;
    }) => {
      console.log('[WebRTC] Incoming call from:', callerName);
      if (activeCall || incomingCall) {
        socket.emit('call:reject', { callerId, reason: 'Занят' });
        return;
      }

      setIncomingCall({ callerId, callerName, callerAvatar, offer });
      audioTone.playIncomingRing();
    };

    // Caller receives accepted answer
    const handleCallAccepted = async ({
      answer,
    }: {
      targetUserId: string;
      answer: RTCSessionDescriptionInit;
    }) => {
      console.log('[WebRTC] Call accepted, setting remote description...');
      audioTone.stopAll();
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await drainCandidateQueue(pcRef.current);
        setActiveCall(prev => (prev ? { ...prev, status: 'connected' } : null));
      }
    };

    // Call was rejected
    const handleCallRejected = ({ reason }: { reason?: string }) => {
      cleanupCall(true);
      alert(reason || 'Собеседник отклонил звонок');
    };

    // Received ICE Candidate
    const handleIceCandidate = async ({
      candidate,
    }: {
      fromUserId: string;
      candidate: RTCIceCandidateInit;
    }) => {
      if (!candidate) return;

      const pc = pcRef.current;
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('[WebRTC] Directly added ICE candidate');
        } catch (err) {
          console.error('[WebRTC] Error adding ICE candidate', err);
        }
      } else {
        // Queue until remote description is set!
        console.log('[WebRTC] Queuing ICE candidate (remoteDescription not set yet)');
        iceCandidateQueueRef.current.push(candidate);
      }
    };

    // Call ended by remote peer
    const handleCallEnded = () => {
      cleanupCall(true);
    };

    socket.on('call:incoming', handleIncomingCall);
    socket.on('call:accepted', handleCallAccepted);
    socket.on('call:rejected', handleCallRejected);
    socket.on('call:ice_candidate', handleIceCandidate);
    socket.on('call:ended', handleCallEnded);

    return () => {
      socket.off('call:incoming', handleIncomingCall);
      socket.off('call:accepted', handleCallAccepted);
      socket.off('call:rejected', handleCallRejected);
      socket.off('call:ice_candidate', handleIceCandidate);
      socket.off('call:ended', handleCallEnded);
    };
  }, [socket, activeCall, incomingCall, cleanupCall]);

  /** Set up WebRTC peer connection with ICE timeout fallback to relay */
  const setupPeerConnection = (partnerId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    // Add local audio tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
    }

    // Handle remote audio stream (only relevant if WebRTC connects)
    pc.ontrack = (event) => {
      console.log('[WebRTC] Remote audio track received!', event.track.kind);
      const remoteStream = (event.streams && event.streams[0])
        ? event.streams[0]
        : new MediaStream([event.track]);

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.volume = 1.0;
        remoteAudioRef.current.play().catch(e => {
          console.warn('[WebRTC] remoteAudio.play() failed:', e);
        });
        attachAnalyser(remoteStream, false);
      }
    };

    // Send ICE candidates to signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket?.emit('call:ice_candidate', {
          targetUserId: partnerId,
          candidate: event.candidate,
        });
      }
    };

    let iceConnected = false;

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log('[WebRTC] ICE Connection state:', state);

      if (state === 'connected' || state === 'completed') {
        iceConnected = true;
        setAudioMode('webrtc');
        console.log('[WebRTC] ✅ P2P connected! Audio via WebRTC');
        if (iceTimeoutRef.current) {
          clearTimeout(iceTimeoutRef.current);
          iceTimeoutRef.current = null;
        }
      }

      if (state === 'failed' || state === 'disconnected') {
        // FIX: 'disconnected' часто кратковременный (переключение сети, роутинг) — даём 2.5с
        // на автоматическое восстановление, прежде чем уходить в relay. 'failed' → сразу relay.
        if (disconnectGraceRef.current) {
          clearTimeout(disconnectGraceRef.current);
          disconnectGraceRef.current = null;
        }
        const graceDelay = state === 'failed' ? 0 : 2500;
        disconnectGraceRef.current = window.setTimeout(() => {
          disconnectGraceRef.current = null;
          if (audioModeRef.current !== 'relay' && pcRef.current === pc) {
            const ice = pc.iceConnectionState;
            if (ice === 'failed' || ice === 'disconnected' || ice === 'closed') {
              console.log('[WebRTC] ❌ ICE не восстановился, переключаюсь на relay');
              switchToRelay(partnerId);
            }
          }
        }, graceDelay);
      }
    };

    // Timeout: if ICE hasn't connected in N seconds, switch to relay
    iceTimeoutRef.current = window.setTimeout(() => {
      if (!iceConnected && audioModeRef.current !== 'relay') {
        console.log(`[WebRTC] ⏰ ICE timeout (${ICE_TIMEOUT_MS}ms), switching to relay`);
        switchToRelay(partnerId);
      }
    }, ICE_TIMEOUT_MS);

    return pc;
  };

  // Initiate an outgoing call
  const startCall = async (partnerId: string, partnerName: string, partnerAvatar?: string) => {
    if (!socket || !currentUserId) return;

    try {
      audioTone.playOutgoingRing();
      setActiveCall({
        partnerId,
        partnerName,
        partnerAvatar,
        isCaller: true,
        status: 'calling',
      });

      // 1. Get audio stream with optimal codecs and noise suppression
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      localStreamRef.current = stream;
      attachAnalyser(stream, true);

      // Unlock browser autoplay policy on user click
      if (remoteAudioRef.current) {
        remoteAudioRef.current.play().catch(() => {});
      }

      // 2. Initialize RTCPeerConnection with STUN & TURN + relay fallback
      const pc = setupPeerConnection(partnerId);

      // Create and send SDP Offer
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
      });
      await pc.setLocalDescription(offer);

      socket.emit('call:initiate', {
        targetUserId: partnerId,
        offer,
      });
    } catch (err: any) {
      console.error('[WebRTC] Failed to start call:', err);
      cleanupCall(false);
      alert('Не удалось получить доступ к микрофону: ' + (err.message || err));
    }
  };

  // Answer an incoming call
  const answerCall = async () => {
    if (!socket || !incomingCall) return;

    audioTone.stopAll();
    const { callerId, callerName, offer } = incomingCall;

    try {
      setActiveCall({
        partnerId: callerId,
        partnerName: callerName,
        partnerAvatar: incomingCall.callerAvatar,
        isCaller: false,
        status: 'connected',
      });
      setIncomingCall(null);

      // 1. Get audio stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      localStreamRef.current = stream;
      attachAnalyser(stream, true);

      // Unlock browser autoplay policy on user click
      if (remoteAudioRef.current) {
        remoteAudioRef.current.play().catch(() => {});
      }

      // 2. Initialize RTCPeerConnection with relay fallback
      const pc = setupPeerConnection(callerId);

      // Set remote offer & drain any early queued candidates
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await drainCandidateQueue(pc);

      // Create and send SDP answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('call:accept', {
        callerId,
        answer,
      });
    } catch (err: any) {
      console.error('[WebRTC] Failed to answer call:', err);
      cleanupCall(false);
      alert('Ошибка при ответе на звонок: ' + (err.message || err));
    }
  };

  // Reject incoming call
  const rejectCall = () => {
    if (!socket || !incomingCall) return;
    audioTone.stopAll();
    socket.emit('call:reject', {
      callerId: incomingCall.callerId,
      reason: 'Звонок отклонен',
    });
    setIncomingCall(null);
  };

  // End active call
  const endCall = () => {
    if (!socket || !activeCall) return;
    socket.emit('call:end', {
      targetUserId: activeCall.partnerId,
    });
    cleanupCall(true);
  };

  // Toggle microphone mute
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  return {
    activeCall,
    incomingCall,
    isMuted,
    callDuration,
    localVolume,
    remoteVolume,
    audioMode,
    startCall,
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
  };
}
