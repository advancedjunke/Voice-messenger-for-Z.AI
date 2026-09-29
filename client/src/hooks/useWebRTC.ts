import { useState, useRef, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import type { ActiveCall } from '../types.js';
import { audioTone } from '../utils/audioTone.js';

// STUN + Free Public TURN (OpenRelay) for NAT traversal across different networks
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
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

export function useWebRTC(socket: Socket | null, currentUserId: string | null) {
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    callerId: string;
    callerName: string;
    offer: RTCSessionDescriptionInit;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [localVolume, setLocalVolume] = useState(0);
  const [remoteVolume, setRemoteVolume] = useState(0);

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

  // Initialize audio element for remote stream
  useEffect(() => {
    const audio = new Audio();
    audio.autoplay = true;
    remoteAudioRef.current = audio;

    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, []);

  // Visualizer loop for volume levels
  const startVolumeVisualizer = useCallback(() => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioCtx();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') ctx.resume();

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
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      if (isLocal) {
        localAnalyserRef.current = analyser;
      } else {
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

  // Cleanup all call connections & timers
  const cleanupCall = useCallback((playHangup = true) => {
    if (playHangup) {
      audioTone.playHangupTone();
    } else {
      audioTone.stopAll();
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

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    iceCandidateQueueRef.current = [];

    setActiveCall(null);
    setIncomingCall(null);
    setIsMuted(false);
    setCallDuration(0);
    setLocalVolume(0);
    setRemoteVolume(0);
  }, []);

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

  // Handle incoming socket signaling events
  useEffect(() => {
    if (!socket) return;

    // Incoming call event
    const handleIncomingCall = ({
      callerId,
      callerName,
      offer,
    }: {
      callerId: string;
      callerName: string;
      offer: RTCSessionDescriptionInit;
    }) => {
      console.log('[WebRTC] Incoming call from:', callerName);
      if (activeCall || incomingCall) {
        socket.emit('call:reject', { callerId, reason: 'Занят' });
        return;
      }

      setIncomingCall({ callerId, callerName, offer });
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

  // Initiate an outgoing call
  const startCall = async (partnerId: string, partnerName: string) => {
    if (!socket || !currentUserId) return;

    try {
      audioTone.playOutgoingRing();
      setActiveCall({
        partnerId,
        partnerName,
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
      localStreamRef.current = stream;
      attachAnalyser(stream, true);

      // 2. Initialize RTCPeerConnection with STUN & TURN
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;

      // Add local audio tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Handle remote audio stream
      pc.ontrack = (event) => {
        console.log('[WebRTC] Remote audio track received!');
        if (remoteAudioRef.current && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
          remoteAudioRef.current.play().catch(e => {
            console.warn('[WebRTC] remoteAudio.play() failed:', e);
          });
          attachAnalyser(event.streams[0], false);
        }
      };

      // Send ICE candidates to signaling server
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('call:ice_candidate', {
            targetUserId: partnerId,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WebRTC] Connection state:', pc.connectionState);
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] ICE Connection state:', pc.iceConnectionState);
      };

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
      localStreamRef.current = stream;
      attachAnalyser(stream, true);

      // 2. Initialize RTCPeerConnection with STUN & TURN
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;

      // Add local audio tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Handle remote audio stream
      pc.ontrack = (event) => {
        console.log('[WebRTC] Remote audio track received!');
        if (remoteAudioRef.current && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
          remoteAudioRef.current.play().catch(e => {
            console.warn('[WebRTC] remoteAudio.play() failed:', e);
          });
          attachAnalyser(event.streams[0], false);
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('call:ice_candidate', {
            targetUserId: callerId,
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WebRTC] Connection state:', pc.connectionState);
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[WebRTC] ICE Connection state:', pc.iceConnectionState);
      };

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
    startCall,
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
  };
}
