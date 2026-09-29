import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { User, ChatMessage, MessageType } from './types.js';
import { useWebRTC } from './hooks/useWebRTC.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { LoginModal } from './components/LoginModal.js';
import { CallModal } from './components/CallModal.js';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (window.location.port === '5173'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : window.location.origin);

export function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('vm_username');
    return saved ? { id: '', socketId: '', username: saved, online: false } : null;
  });

  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Record<string, ChatMessage[]>>({});
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);

  // Setup Socket.io connection
  useEffect(() => {
    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server with ID:', socket.id);
      setSocketConnected(true);

      // Re-register user if username exists
      const savedName = localStorage.getItem('vm_username');
      if (savedName) {
        socket.emit('user:register', { username: savedName });
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setSocketConnected(false);
    });

    socket.on('user:registered', ({ user, allUsers }: { user: User; allUsers: User[] }) => {
      setCurrentUser(user);
      setUsers(allUsers);
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
  }, []);

  // WebRTC Hook
  const {
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
  } = useWebRTC(socketRef.current, currentUser?.id || null);

  // Handle Login
  const handleLogin = (username: string) => {
    localStorage.setItem('vm_username', username);
    if (socketRef.current) {
      socketRef.current.emit('user:register', { username });
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
    startCall(user.id, user.username);
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
            onAnswer={answerCall}
            onReject={rejectCall}
            onEnd={endCall}
            onToggleMute={toggleMute}
          />
        </>
      )}

      {/* Connectivity badge */}
      <div className="fixed top-2 right-4 z-50 pointer-events-none">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium backdrop-blur-md ${
            socketConnected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              socketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
            }`}
          />
          {socketConnected ? 'Сервер подключен' : 'Соединение с сервером...'}
        </span>
      </div>
    </div>
  );
}

export default App;
