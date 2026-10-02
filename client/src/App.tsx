import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { User, ChatMessage, MessageType, KnownUser } from './types.js';
import { useWebRTC } from './hooks/useWebRTC.js';
import { audioTone } from './utils/audioTone.js';
import { isNewerVersion } from './utils/format.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { AuthScreen } from './components/AuthScreen.js';
import { CallModal } from './components/CallModal.js';
import { UserProfileModal } from './components/UserProfileModal.js';
import { ForwardModal } from './components/ForwardModal.js';

const CLOUD_SERVER_URL = 'https://f2f9c29f9c574a2c-217-199-233-97.serveousercontent.com';

function getEffectiveServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('server');

  // v1.0.14: в настольном приложении (Electron, file://) адрес приходит от
  // умной цепочки запуска (localhost → UDP-поиск → встроенный хост). Он ВСЕГДА
  // актуальнее сохранённого в localStorage — иначе после смены хоста приложение
  // навсегда цеплялось бы за старый мёртвый IP.
  if (fromQuery && window.location.protocol === 'file:') return fromQuery;

  const saved = localStorage.getItem('vm_server_url');
  if (saved) return saved;

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

// v1.0.12: системные desktop-уведомления о новых сообщениях (когда вкладка не в фокусе)
function showDesktopNotification(senderName: string, message: ChatMessage) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;

    const body = message.deleted
      ? 'Сообщение удалено'
      : message.mediaType === 'voice'
      ? '🎤 Голосовое сообщение'
      : message.mediaType === 'image'
      ? message.text || '📷 Фото'
      : (message.text || '').slice(0, 120);

    const n = new Notification(`${senderName} · Voice Messenger`, {
      body: body || 'Новое сообщение',
      icon: '/icon.png',
      tag: `vm_${senderName}`, // не плодим кучу уведомлений от одного человека
      silent: true, // звук уже играет audioTone
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch { /* уведомления не критичны */ }
}

export function App() {
  const APP_VERSION = '1.0.20'; // синхронизировано с package.json и Sidebar

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
  // v1.0.12: кэш последних визитов (чтобы при уходе собеседника в офлайн
  // шапка чата показывала время, а не «давно» — онлайн-список lastSeen не содержит)
  const lastSeenCacheRef = useRef<Record<string, number>>({});

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

      // v1.0.17: вход в аккаунт — имя + токен сессии (REST-авторизация).
      // Если аккаунта/токена нет — просто открывается экран входа.
      const savedName = localStorage.getItem('vm_username');
      const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
      const savedToken = localStorage.getItem('vm_token') || undefined;
      if (savedName) {
        socket.emit('user:register', { username: savedName, avatar: savedAvatar, token: savedToken });
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setSocketConnected(false);
    });

    socket.on('user:registered', ({ user, allUsers }: { user: User; allUsers: User[] }) => {
      setCurrentUser(user);
      setLoginError(null);
      if (user.avatar) {
        localStorage.setItem('vm_avatar', user.avatar);
      }
      setUsers(allUsers);
      // v1.0.11: запрашиваем известных (в т.ч. офлайн) пользователей
      socket.emit('users:known');
      // v1.0.12: спрашиваем разрешение на системные уведомления (после первого входа)
      try {
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      } catch { /* не критично */ }
    });

    // Регистрация/вход не прошли (имя занято, неверный пароль, токен истёк)
    socket.on('user:register_failed', ({ message }: { message: string; needPassword?: boolean }) => {
      setLoginError(message || 'Не удалось войти');
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
      // v1.0.12 FIX: сверяем ВЫБРАННОГО собеседника по СТАБИЛЬНОМУ имени, а не socket.id.
      // Раньше офлайн-контакт не «оживал» в шапке открытого чата, когда входил в сеть
      // (новый объект пользователя имеет новый socket.id, а офлайн-User имеет id='') —
      // статус обновлялся только после перевыбора чата.
      setSelectedUser(prev => {
        if (!prev) return null;
        const fresh = allUsers.find(
          u => u.username.toLowerCase() === prev.username.toLowerCase()
        );
        if (fresh) return { ...fresh };
        // v1.0.12: собеседник исчез из списка онлайн → помечаем офлайн
        // (иначе шапка чата зависала в «В сети», пока не перевыберешь чат)
        if (prev.online) {
          const cached = lastSeenCacheRef.current[prev.username.toLowerCase()];
          return { ...prev, online: false, inCallWith: null, lastSeen: cached ?? prev.lastSeen };
        }
        return prev;
      });
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
          // v1.0.12: системное уведомление, когда вкладка не в фокусе
          showDesktopNotification(partnerName, message);
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
      // v1.0.12: пополняем кэш последних визитов
      for (const k of known || []) {
        if (k?.username && k.lastSeen) {
          lastSeenCacheRef.current[k.username.toLowerCase()] = k.lastSeen;
        }
      }
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

  // v1.0.17: успешная регистрация или вход через REST — сохраняем токен сессии
  // и регистрируемся в сокете. Если сокет ещё не подключился, регистрация уйдёт
  // из обработчика on('connect') — кнопка больше не может «молчать».
  const handleAuthed = (payload: { token: string; username: string; avatar?: string | null }) => {
    localStorage.setItem('vm_token', payload.token);
    localStorage.setItem('vm_username', payload.username);
    if (payload.avatar) {
      localStorage.setItem('vm_avatar', payload.avatar);
    }
    setLoginError(null);
    const avatar = payload.avatar || localStorage.getItem('vm_avatar') || undefined;
    if (socketRef.current?.connected) {
      socketRef.current.emit('user:register', {
        username: payload.username,
        avatar,
        token: payload.token,
      });
    }
    // оптимистично показываем имя, чтобы экран входа не мигал
    setCurrentUser(prev => prev && prev.id ? prev : { id: '', socketId: '', username: payload.username, avatar, online: false });
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
    localStorage.removeItem('vm_token');
    setCurrentUser(null);
    setSelectedUser(null);
    setLoginError(null);
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

  // v1.0.12: пересылка сообщения другому контакту
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const handleForwardMessage = (message: ChatMessage, target: User) => {
    if (!socketRef.current) return;
    socketRef.current.emit('chat:send', {
      recipientId: target.id,
      recipientUsername: target.username,
      text: message.text,
      mediaUrl: message.mediaUrl,
      mediaType: message.mediaType,
      duration: message.duration,
      forwardedFrom: message.forwardedFrom || message.senderName,
    });
    setForwardingMessage(null);
  };

  // Trigger call
  const handleStartCall = (user: User) => {
    startCall(user.id, user.username, user.avatar);
  };

  const currentMessages = selectedUser ? conversations[selectedUser.username] || [] : [];

  return (
    <div className="flex w-full h-full bg-gray-950 font-sans text-gray-100 overflow-hidden relative">
      {/* v1.0.17: экран входа/регистрации (вместо старого LoginModal) */}
      {(!currentUser || !currentUser.id) && (
        <AuthScreen
          serverUrl={serverUrl}
          socketConnected={socketConnected}
          initialName={currentUser?.username || ''}
          error={loginError}
          onAuthed={handleAuthed}
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
            onRequestForward={setForwardingMessage}
          />

          {/* v1.0.12: модалка пересылки сообщения */}
          <ForwardModal
            isOpen={forwardingMessage !== null}
            message={forwardingMessage}
            users={users}
            knownUsers={knownUsers}
            currentUsername={currentUser.username}
            onClose={() => setForwardingMessage(null)}
            onForward={target => forwardingMessage && handleForwardMessage(forwardingMessage, target)}
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
