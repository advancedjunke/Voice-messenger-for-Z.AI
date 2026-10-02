import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { User, ChatMessage, MessageType } from './types.js';
import { useWebRTC } from './hooks/useWebRTC.js';
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
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('vm_username');
    const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
    return saved ? { id: '', socketId: '', username: saved, avatar: savedAvatar, online: false } : null;
  });

  const [serverUrl, setServerUrl] = useState<string>(getEffectiveServerUrl);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [appVersion] = useState('1.0.6');
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

  // Check for updates on mount
  useEffect(() => {
    fetch(`${serverUrl}/api/updates/check`)
      .then(res => res.json())
      .then(data => {
        if (data && data.available && data.latestVersion && data.latestVersion !== appVersion) {
          setUpdateInfo(data);
        }
      })
      .catch(() => {});
  }, [serverUrl, appVersion]);

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
      if (user.avatar) {
        localStorage.setItem('vm_avatar', user.avatar);
      }
      setUsers(allUsers);
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
      const partnerId =
        message.senderId === socket.id ? message.recipientId : message.senderId;

      setConversations(prev => ({
        ...prev,
        [partnerId]: [...(prev[partnerId] || []), message],
      }));

      // Update unread count if message is from another user and not currently active chat
      if (message.senderId !== socket.id) {
        setSelectedUser(currSelected => {
          if (!currSelected || currSelected.id !== message.senderId) {
            setUnreadCounts(prevCounts => ({
              ...prevCounts,
              [message.senderId]: (prevCounts[message.senderId] || 0) + 1,
            }));
          }
          return currSelected;
        });
      }
    });

    socket.on(
      'chat:history_loaded',
      ({ recipientId, messages }: { recipientId: string; messages: ChatMessage[] }) => {
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

  // Handle Login
  const handleLogin = (username: string) => {
    localStorage.setItem('vm_username', username);
    const savedAvatar = localStorage.getItem('vm_avatar') || undefined;
    if (socketRef.current) {
      socketRef.current.emit('user:register', { username, avatar: savedAvatar });
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
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current.connect();
    }
  };

  // Handle User Selection
  const handleSelectUser = (user: User) => {
    setSelectedUser(user);
    // Clear unread
    setUnreadCounts(prev => ({
      ...prev,
      [user.id]: 0,
    }));
    // Request chat history from server
    if (socketRef.current) {
      socketRef.current.emit('chat:history', { recipientId: user.id });
    }
  };

  // Send message
  const handleSendMessage = (payload: {
    text?: string;
    mediaUrl?: string;
    mediaType?: MessageType;
    duration?: number;
  }) => {
    if (!selectedUser || !socketRef.current) return;
    socketRef.current.emit('chat:send', {
      recipientId: selectedUser.id,
      ...payload,
    });
  };

  // Trigger call
  const handleStartCall = (user: User) => {
    startCall(user.id, user.username, user.avatar);
  };

  const currentMessages = selectedUser ? conversations[selectedUser.id] || [] : [];

  return (
    <div className="flex w-full h-full bg-gray-950 font-sans text-gray-100 overflow-hidden relative">
      {/* Show Login modal if user is not registered or logged in */}
      {(!currentUser || !currentUser.id) && <LoginModal onLogin={handleLogin} />}

      {/* Main Messenger Layout */}
      {currentUser && currentUser.id && (
        <>
          <Sidebar
            currentUser={currentUser}
            users={users}
            selectedUserId={selectedUser?.id || null}
            unreadCounts={unreadCounts}
            onSelectUser={handleSelectUser}
            onStartCall={handleStartCall}
            onLogout={handleLogout}
            onOpenProfile={() => setIsProfileOpen(true)}
          />

          <ChatArea
            currentUser={currentUser}
            recipient={selectedUser}
            messages={currentMessages}
            activeCall={activeCall}
            onSendMessage={handleSendMessage}
            onStartCall={handleStartCall}
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

      {/* Connectivity & Update badges */}
      <div className="fixed top-2.5 right-4 z-50 flex items-center gap-2">
        {updateInfo?.available && (
          <button
            type="button"
            onClick={() => {
              alert(
                `🚀 Доступно обновление v${updateInfo.latestVersion}!\n\nЧто нового:\n${
                  updateInfo.releaseNotes || 'Улучшения стабильности и звонков'
                }\n\nЧтобы обновить приложение, закройте его и запустите ярлык «Voice Launcher» на Рабочем столе (или в папке приложения).`
              );
            }}
            title="Нажмите для подробностей об обновлении"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold backdrop-blur-md bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30 transition-all cursor-pointer shadow-lg animate-pulse"
          >
            <span>🚀 Обновление v{updateInfo.latestVersion}!</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            const current = localStorage.getItem('vm_server_url') || serverUrl;
            const next = prompt('Адрес сервера мессенджера (например, IP друга или облачный хостинг):', current);
            if (next !== null) {
              if (next.trim()) {
                localStorage.setItem('vm_server_url', next.trim());
              } else {
                localStorage.removeItem('vm_server_url');
              }
              window.location.reload();
            }
          }}
          title="Кликните, чтобы изменить адрес сервера"
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium backdrop-blur-md cursor-pointer hover:scale-105 active:scale-95 transition-all shadow-sm ${
            socketConnected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              socketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
            }`}
          />
          {socketConnected ? 'Сервер подключен' : 'Настроить сервер'}
        </button>
      </div>
    </div>
  );
}

export default App;
