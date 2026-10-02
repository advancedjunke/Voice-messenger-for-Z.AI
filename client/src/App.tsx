import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { User, ChatMessage, MessageType, KnownUser } from './types.js';
import { useWebRTC } from './hooks/useWebRTC.js';
import { audioTone } from './utils/audioTone.js';
import { isNewerVersion } from './utils/format.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { LoginModal } from './components/LoginModal.js';
import { CallModal } from './components/CallModal.js';
import { UserProfileModal } from './components/UserProfileModal.js';

const CLOUD_SERVER_URL = 'https://f2f9c29f9c574a2c-217-199-233-97.serveousercontent.com';

function getEffectiveServerUrl(): string {
  const saved = localStorage.getItem('vm_server_url');
  if (saved) return saved;

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('server');
  if (fromQuery) return fromQuery;

  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;

  // In regular browser running through web server (e.g. cloudflare or local preview)
  if (window.location.protocol.startsWith('http') && window.location.port !== '5173') {
    return window.location.origin;
  }

  // If in local dev
  if (window.location.port === '5173') {
    return 'http://localhost:3001';
  }

  // Fallback for desktop app if query not present
  return CLOUD_SERVER_URL;
}

export function App() {
  const APP_VERSION = '1.0.11'; // синхронизировано с package.json и Sidebar

  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('vm_username');
    const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
    return saved ? { id: '', socketId: '', username: saved, avatar: savedAvatar, online: false } : null;
  });

  const [serverUrl, setServerUrl] = useState<string>(getEffectiveServerUrl);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  // FIX: беседы ключуются по СТАБИЛЬНОМУ имени пользователя (не socket.id),
  // чтобы история не терялась при переподключении
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);

  // v1.0.10: индикаторы «печатает…» (username → таймстамп последнего события)
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const typingTimeoutsRef = useRef<Record<string, number>>({});
  // v1.0.11: известные пользователи (в т.ч. офлайн) — для сайдбара
  const [knownUsers, setKnownUsers] = useState<KnownUser[]>([]);
  // v1.0.10: звук уведомлений (сохраняется в localStorage)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => localStorage.getItem('vm_sound') !== '0');
  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  // ref текущего выбранного пользователя (для read-квитанций и звуков)
  const selectedUserRef = useRef<User | null>(null);
  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);

  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean;
    latestVersion?: string;
    releaseNotes?: string;
  } | null>(null);

  // Auto-detect host mode if running locally in Electron desktop app
  useEffect(() => {
    if (window.location.protocol === 'file:' && !localStorage.getItem('vm_server_url')) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 400);
      fetch('http://localhost:3001/health', { signal: ctrl.signal })
        .then(res => {
          clearTimeout(timer);
          if (res.ok) {
            console.log('✅ Host machine detected: switching to local server http://localhost:3001');
            setServerUrl('http://localhost:3001');
          }
        })
        .catch(() => {});
    }
  }, []);

  // Check for updates on mount (v1.0.11: бейдж только если версия ДЕЙСТВИТЕЛЬНО новее)
  useEffect(() => {
    fetch(`${serverUrl}/api/updates/check`)
      .then(res => res.json())
      .then(data => {
        if (data && data.available && data.latestVersion && isNewerVersion(data.latestVersion, APP_VERSION)) {
          setUpdateInfo(data);
        }
      })
      .catch(() => {});
  }, [serverUrl]);

  // Setup Socket.io connection
  useEffect(() => {
    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server with ID:', socket.id);
      setSocketConnected(true);

      // Re-register user if username exists
      const savedName = localStorage.getItem('vm_username');
      const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
      if (savedName) {
        socket.emit('user:register', { username: savedName, avatar: savedAvatar });
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setSocketConnected(false);
    });

    socket.on('user:registered', ({ user, allUsers }: { user: User; allUsers: User[] }) => {
      setCurrentUser(user);
      setLoginError(null);
      setNeedPassword(false);
      if (user.avatar) {
        localStorage.setItem('vm_avatar', user.avatar);
      }
      setUsers(allUsers);
      // v1.0.11: запрашиваем известных (в т.ч. офлайн) пользователей
      socket.emit('users:known');
    });

    // Регистрация не прошла (имя занято/пароль неверный)
    socket.on('user:register_failed', ({ message, needPassword: np }: { message: string; needPassword?: boolean }) => {
      setLoginError(message || 'Не удалось войти');
      if (np) setNeedPassword(true);
    });

    // Этот ник открыли с другого устройства — разлогиниваем текущую сессию
    socket.on('user:replaced', ({ message }: { message?: string }) => {
      alert(message || 'Этот ник открыт в другом окне.');
      localStorage.removeItem('vm_username');
      setCurrentUser(null);
      setSelectedUser(null);
      // v1.0.11: сервер принудительно закрыл сокет — пересоздаём соединение,
      // чтобы следующий вход в сеть гарантированно дошёл до сервера
      // (найдено при QA: после replace старый сокет «зависал» и emit терялся)
      socket.disconnect();
      socket.connect();
    });

    socket.on('user:updated', (updatedUser: User) => {
      if (updatedUser) {
        setCurrentUser(updatedUser);
        if (updatedUser.avatar) {
          localStorage.setItem('vm_avatar', updatedUser.avatar);
        }
      }
    });

    socket.on('users:update', (allUsers: User[]) => {
      setUsers(allUsers);
      // Update selectedUser reference if it was changed
      setSelectedUser(prev => (prev ? allUsers.find(u => u.id === prev.id) || prev : null));
    });

    socket.on('chat:receive', (message: ChatMessage) => {
      // FIX: определяем собеседника по имени (стабильно), а не по socket.id.
      // Для своих (эхо) сообщений сервер присылает recipientName.
      const isMine = message.senderId === socket.id;
      const partnerName = isMine
        ? (message.recipientName || '')
        : message.senderName;
      if (!partnerName) return;

      setConversations(prev => ({
        ...prev,
        [partnerName]: [...(prev[partnerName] || []), message],
      }));

      // v1.0.10: счётчик непрочитанных, звук и read-квитанции
      if (!isMine) {
        const openPartner = selectedUserRef.current?.username;
        if (openPartner === partnerName && document.hasFocus()) {
          // чат открыт и вкладка в фокусе — сразу подтверждаем прочтение
          socketRef.current?.emit('chat:read', { partnerUsername: partnerName });
        } else {
          setUnreadCounts(prevCounts => ({
            ...prevCounts,
            [partnerName]: (prevCounts[partnerName] || 0) + 1,
          }));
          if (soundEnabledRef.current) {
            audioTone.playMessageTone();
          }
        }
      }
    });

    // v1.0.10: собеседник прочитал мои сообщения → ✓ превращаются в ✓✓
    socket.on('chat:read_ack', ({ readerName }: { readerName: string }) => {
      setConversations(prev => {
        const conv = prev[readerName];
        if (!conv || !conv.some(m => !m.read)) return prev;
        return {
          ...prev,
          [readerName]: conv.map(m => (m.read ? m : { ...m, read: true })),
        };
      });
    });

    // v1.0.10: индикатор «печатает…» с авто-затуханием через 3с
    socket.on('chat:typing', ({ fromName, isTyping }: { fromName: string; isTyping: boolean }) => {
      setTypingUsers(prev => {
        const next = { ...prev };
        if (isTyping) next[fromName] = Date.now();
        else delete next[fromName];
        return next;
      });
      const timers = typingTimeoutsRef.current;
      if (timers[fromName]) {
        clearTimeout(timers[fromName]);
        delete timers[fromName];
      }
      if (isTyping) {
        timers[fromName] = window.setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            delete next[fromName];
            return next;
          });
        }, 3000);
      }
    });

    // v1.0.11: известные пользователи (в т.ч. офлайн) из БД сервера
    socket.on('users:known_list', ({ users: known }: { users: KnownUser[] }) => {
      setKnownUsers(Array.isArray(known) ? known : []);
    });

    // v1.0.11: собеседник (или мы) удалил сообщение → помечаем удалённым
    socket.on('chat:message_deleted', ({ messageId, partnerUsername }: { messageId: string; partnerUsername: string }) => {
      if (!partnerUsername) return;
      setConversations(prev => {
        const conv = prev[partnerUsername];
        if (!conv || !conv.some(m => m.id === messageId)) return prev;
        return {
          ...prev,
          [partnerUsername]: conv.map(m =>
            m.id === messageId
              ? { ...m, deleted: true, text: undefined, mediaUrl: undefined, duration: undefined, replyTo: undefined }
              : m
          ),
        };
      });
    });

    socket.on('chat:delete_failed', ({ message }: { message?: string }) => {
      console.warn('[chat:delete_failed]', message || 'Не удалось удалить сообщение');
    });

    socket.on(
      'chat:history_loaded',
      ({ recipientId, messages }: { recipientId: string; messages: ChatMessage[] }) => {
        // Сервер теперь возвращает recipientId = имя собеседника
        setConversations(prev => ({
          ...prev,
          [recipientId]: messages,
        }));
      }
    );

    return () => {
      socket.disconnect();
    };
  }, [serverUrl]);

  // v1.0.10: заголовок вкладки с количеством непрочитанных
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((a, b) => a + (b || 0), 0);
    document.title = total > 0 ? `(${total}) Voice Messenger` : 'Voice Messenger';
  }, [unreadCounts]);

  // v1.0.10: при возврате фокуса на вкладку — подтверждаем прочтение открытого чата
  useEffect(() => {
    const handleFocus = () => {
      const open = selectedUserRef.current;
      if (open) {
        socketRef.current?.emit('chat:read', { partnerUsername: open.username });
        setUnreadCounts(prev => ({ ...prev, [open.username]: 0 }));
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // v1.0.10: переключатель звука
  const handleToggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('vm_sound', next ? '1' : '0');
      return next;
    });
  }, []);

  // WebRTC Hook
  const {
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
  } = useWebRTC(socketRef.current, currentUser?.id || null);

  // Handle Login (пароль опционален — защищает имя от угона)
  const handleLogin = (username: string, password?: string) => {
    localStorage.setItem('vm_username', username);
    const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
    if (socketRef.current) {
      socketRef.current.emit('user:register', { username, avatar: savedAvatar, password: password || undefined });
    }
  };

  // Handle Save Avatar
  const handleSaveAvatar = (newAvatar: string) => {
    localStorage.setItem('vm_avatar', newAvatar);
    setCurrentUser(prev => (prev ? { ...prev, avatar: newAvatar } : null));
    if (socketRef.current) {
      socketRef.current.emit('user:update_avatar', { avatar: newAvatar });
    }
  };

  // Handle Logout
  const handleLogout = () => {
    localStorage.removeItem('vm_username');
    setCurrentUser(null);
    setSelectedUser(null);
    setLoginError(null);
    setNeedPassword(false);
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }
  };

  // Handle User Selection
  const handleSelectUser = (user: User) => {
    setSelectedUser(user);
    // Clear unread (по имени)
    setUnreadCounts(prev => ({
      ...prev,
      [user.username]: 0,
    }));
    // v1.0.10: сразу подтверждаем прочтение прошлых сообщений
    socketRef.current?.emit('chat:read', { partnerUsername: user.username });
    // Request chat history from server (по стабильному имени)
    if (socketRef.current) {
      socketRef.current.emit('chat:history', { recipientId: user.id, recipientUsername: user.username });
    }
  };

  // Send message (v1.0.11: recipientUsername — можно писать и офлайн-собеседнику)
  const handleSendMessage = (payload: {
    text?: string;
    mediaUrl?: string;
    mediaType?: MessageType;
    duration?: number;
    replyTo?: { id: string; senderName: string; text?: string; mediaType?: MessageType };
  }) => {
    if (!selectedUser || !socketRef.current) return;
    socketRef.current.emit('chat:send', {
      recipientId: selectedUser.id,
      recipientUsername: selectedUser.username,
      ...payload,
    });
  };

  // v1.0.11: удалить своё сообщение
  const handleDeleteMessage = (messageId: string) => {
    if (!selectedUser || !socketRef.current) return;
    socketRef.current.emit('chat:delete', {
      partnerUsername: selectedUser.username,
      messageId,
    });
  };

  // Trigger call
  const handleStartCall = (user: User) => {
    startCall(user.id, user.username, user.avatar);
  };

  const currentMessages = selectedUser ? conversations[selectedUser.username] || [] : [];

  return (
    <div className="flex w-full h-full bg-gray-950 font-sans text-gray-100 overflow-hidden relative">
      {/* Show Login modal if user is not registered or logged in */}
      {(!currentUser || !currentUser.id) && (
        <LoginModal
          onLogin={handleLogin}
          initialName={currentUser?.username || ''}
          error={loginError}
          needPassword={needPassword}
        />
      )}

      {/* Main Messenger Layout */}
      {currentUser && currentUser.id && (
        <>
          <Sidebar
            currentUser={currentUser}
            users={users}
            knownUsers={knownUsers}
            selectedUsername={selectedUser?.username || null}
            unreadCounts={unreadCounts}
            onSelectUser={handleSelectUser}
            onStartCall={handleStartCall}
            onLogout={handleLogout}
            onOpenProfile={() => setIsProfileOpen(true)}
            socketConnected={socketConnected}
            updateInfo={updateInfo}
            serverUrl={serverUrl}
            typingUsers={typingUsers}
            soundEnabled={soundEnabled}
            onToggleSound={handleToggleSound}
          />

          <ChatArea
            currentUser={currentUser}
            recipient={selectedUser}
            messages={currentMessages}
            activeCall={activeCall}
            onSendMessage={handleSendMessage}
            onStartCall={handleStartCall}
            onDeleteMessage={handleDeleteMessage}
            isPartnerTyping={selectedUser ? Boolean(typingUsers[selectedUser.username]) : false}
            onTyping={(recipientId, isTyping) => socketRef.current?.emit('chat:typing', { recipientId, isTyping })}
          />

          {/* Voice Call Active / Incoming Modal */}
          <CallModal
            activeCall={activeCall}
            incomingCall={incomingCall}
            isMuted={isMuted}
            duration={callDuration}
            localVolume={localVolume}
            remoteVolume={remoteVolume}
            audioMode={audioMode}
            onAnswer={answerCall}
            onReject={rejectCall}
            onEnd={endCall}
            onToggleMute={toggleMute}
          />

          {/* User Profile / Avatar Selection Modal */}
          <UserProfileModal
            isOpen={isProfileOpen}
            username={currentUser.username}
            currentAvatar={currentUser.avatar}
            onClose={() => setIsProfileOpen(false)}
            onSaveAvatar={handleSaveAvatar}
          />
        </>
      )}
    </div>
  );
}

export default App;
