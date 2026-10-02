import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { User, ChatMessage } from './types.js';
import { initDatabase, dbSaveUser, dbGetUser, dbSaveMessage, dbGetHistory, dbGetLatestRelease, dbGetReleasePayload, dbPublishRelease } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(clientDistPath));

// Initialize PostgreSQL database connection
initDatabase().catch(err => console.error('[Neon DB Init Error]', err));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 25 * 1024 * 1024, // 25MB for voice messages & images
});

const PORT = process.env.PORT || 3001;

// In-memory data store
const usersBySocketId = new Map<string, User>();
// Conversation key: [user1Id, user2Id].sort().join('::') -> array of ChatMessages
const messageHistory = new Map<string, ChatMessage[]>();
// FIX звонков: таймеры гудков (авто-отмена неотвеченных звонков) и активные соединения
const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
const connectedCalls = new Set<string>(); // ключ: [callerSocketId, targetSocketId].sort().join('::')

function getConversationKey(id1: string, id2: string): string {
  // Keys are built from STABLE usernames (not socket ids), so chat history
  // survives reconnects / page refreshes (fix: history lost between sessions)
  return [id1.toLowerCase(), id2.toLowerCase()].sort().join('::');
}

// ─── Password protection (optional, per username) ───
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

function getOnlineUsersList(): User[] {
  return Array.from(usersBySocketId.values()).map(u => ({
    id: u.id,
    socketId: u.socketId,
    username: u.username,
    avatar: u.avatar,
    online: u.online,
    inCallWith: u.inCallWith,
  }));
}

function broadcastUsersList() {
  io.emit('users:update', getOnlineUsersList());
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', onlineCount: usersBySocketId.size });
});

// Auto-updater endpoints
app.get('/api/updates/check', async (_req, res) => {
  try {
    const release = await dbGetLatestRelease(false);
    if (!release) {
      return res.json({ available: false });
    }
    res.json({
      available: true,
      latestVersion: release.version,
      releaseNotes: release.releaseNotes || '',
      downloadUrl: release.downloadUrl || null,
      hasPayload: (release as any).hasPayload,
      timestamp: release.timestamp,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/updates/download/:version', async (req, res) => {
  try {
    const version = req.params.version;
    const localAsarPath = path.resolve(__dirname, '../../release/win-unpacked/resources/app.asar');
    if (fs.existsSync(localAsarPath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="app-${version}.asar"`);
      return res.sendFile(localAsarPath);
    }
    const base64 = await dbGetReleasePayload(version);
    if (!base64) {
      return res.status(404).json({ error: 'Release payload not found for version ' + version });
    }
    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="app-${version}.asar"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/updates/publish', async (req, res) => {
  try {
    const { version, downloadUrl, releaseNotes, payloadBase64 } = req.body;
    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }
    const success = await dbPublishRelease(version, downloadUrl, releaseNotes, payloadBase64);
    if (success) {
      res.json({ success: true, version });
    } else {
      res.status(500).json({ error: 'Failed to publish release' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket: Socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // 1. User Registration
  socket.on('user:register', async ({ username, avatar, password }: { username: string; avatar?: string; password?: string }) => {
    const cleanName = (username || '').trim().slice(0, 24) || `User_${socket.id.slice(0, 4)}`;

    // ─── Optional password protection: if the name is taken in DB and protected, require the password ───
    const existingDbUser = await dbGetUser(cleanName);
    if (existingDbUser?.passwordHash) {
      if (!password) {
        socket.emit('user:register_failed', {
          message: `Имя «${cleanName}» защищено паролем. Введите пароль, чтобы войти.`,
          needPassword: true,
        });
        return;
      }
      if (!verifyPassword(password, existingDbUser.passwordHash)) {
        socket.emit('user:register_failed', {
          message: 'Неверный пароль для этого имени.',
          needPassword: true,
        });
        return;
      }
    }

    let userAvatar = avatar;
    if (!userAvatar && existingDbUser?.avatar) {
      userAvatar = existingDbUser.avatar;
    }
    // Сохраняем пользователя при наличии аватара ИЛИ пароля
    // (fix: раньше пароль сохранялся только вместе с аватаром)
    if (userAvatar || password) {
      await dbSaveUser(cleanName, userAvatar, password ? hashPassword(password) : undefined);
    }

    // ─── Fix: same name opened twice (second tab / reconnect) — replace the old session ───
    for (const [sId, u] of usersBySocketId.entries()) {
      if (sId !== socket.id && u.username.toLowerCase() === cleanName.toLowerCase()) {
        console.log(`[Session Replaced] ${u.username}: old socket ${sId} kicked by ${socket.id}`);
        // End active call of the replaced session politely
        if (u.inCallWith) {
          for (const [otherId, other] of usersBySocketId.entries()) {
            if (other.username === u.inCallWith && otherId !== sId) {
              other.inCallWith = null;
              io.to(otherId).emit('call:ended', { fromUserId: sId, reason: 'Собеседник переподключился' });
            }
          }
        }
        io.to(sId).emit('user:replaced', { message: 'Этот ник открыт в другом окне. Соединение закрыто.' });
        const oldSocket = io.sockets.sockets.get(sId);
        if (oldSocket) oldSocket.disconnect(true);
        usersBySocketId.delete(sId);
      }
    }

    const user: User = {
      id: socket.id,
      socketId: socket.id,
      username: cleanName,
      avatar: userAvatar,
      online: true,
      inCallWith: null,
    };

    usersBySocketId.set(socket.id, user);
    console.log(`[User Registered] ${cleanName} (${socket.id}) with avatar: ${Boolean(userAvatar)}`);

    socket.emit('user:registered', {
      user,
      allUsers: getOnlineUsersList(),
    });

    broadcastUsersList();
  });

  // 1.1. Update User Avatar
  socket.on('user:update_avatar', async ({ avatar }: { avatar: string }) => {
    const user = usersBySocketId.get(socket.id);
    if (!user) return;
    user.avatar = avatar;
    await dbSaveUser(user.username, avatar);
    console.log(`[Avatar Updated] ${user.username} (${socket.id})`);
    socket.emit('user:updated', user);
    broadcastUsersList();
  });

  // 2. Load conversation history (keyed by STABLE usernames — survives reconnects)
  socket.on('chat:history', async ({ recipientId, recipientUsername }: { recipientId?: string; recipientUsername?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;

    const otherName = recipientUsername || usersBySocketId.get(recipientId || '')?.username;
    if (!otherName) return;

    const key = getConversationKey(sender.username, otherName);
    let history = messageHistory.get(key);
    if (!history || history.length === 0) {
      history = await dbGetHistory(key);
      messageHistory.set(key, history);
    }
    socket.emit('chat:history_loaded', { recipientId: otherName, messages: history });
  });

  // 3. Send Direct Message
  socket.on(
    'chat:send',
    ({
      recipientId,
      text,
      mediaUrl,
      mediaType,
      duration,
    }: {
      recipientId: string;
      text?: string;
      mediaUrl?: string;
      mediaType?: 'text' | 'image' | 'voice';
      duration?: number;
    }) => {
      const sender = usersBySocketId.get(socket.id);
      const recipientUser = usersBySocketId.get(recipientId);
      if (!sender || !recipientUser) return;

      const trimmedText = (text || '').trim();
      if (!trimmedText && !mediaUrl) return;

      const message: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        senderId: sender.id,
        senderName: sender.username,
        senderAvatar: sender.avatar,
        recipientId: recipientUser.id,
        recipientName: recipientUser.username,
        text: trimmedText || undefined,
        mediaUrl: mediaUrl || undefined,
        mediaType: mediaType || 'text',
        duration: duration || undefined,
        timestamp: Date.now(),
      };

      // Conversation key is based on usernames → history survives reconnects
      const key = getConversationKey(sender.username, recipientUser.username);
      const existing = messageHistory.get(key) || [];
      existing.push(message);
      // Keep last 200 messages per conversation
      if (existing.length > 200) existing.shift();
      messageHistory.set(key, existing);

      // Save to Neon PostgreSQL asynchronously
      dbSaveMessage(message, key).catch(err => console.error('[Neon DB Save Message Error]', err));

      // Deliver to recipient if online
      socket.to(recipientId).emit('chat:receive', message);
      // Echo back to sender
      socket.emit('chat:receive', message);
    }
  );

  // 4. WebRTC Signaling: Initiate Call (Offer)
  socket.on('call:initiate', ({ targetUserId, offer }: { targetUserId: string; offer: any }) => {
    const caller = usersBySocketId.get(socket.id);
    const target = usersBySocketId.get(targetUserId);

    if (!caller) return;
    if (caller.inCallWith) {
      socket.emit('call:failed', { message: 'Вы уже в звонке' });
      return;
    }
    if (!target) {
      socket.emit('call:failed', { message: 'Пользователь не найден или не в сети' });
      return;
    }

    if (target.inCallWith) {
      socket.emit('call:rejected', {
        callerId: socket.id,
        reason: 'Пользователь сейчас занят другим звонком',
      });
      return;
    }

    // FIX: помечаем занятыми ОБЕИХ на стадии гудков — раньше второй звонящий
    // мог дозвониться к тому, кому уже звонят
    caller.inCallWith = target.username;
    target.inCallWith = caller.username;
    broadcastUsersList();

    // FIX: авто-отмена через 45с если никто не ответил (иначе «занят» висит вечно)
    const prevTimer = ringTimers.get(socket.id);
    if (prevTimer) clearTimeout(prevTimer);
    const callKey = [socket.id, targetUserId].sort().join('::');
    ringTimers.set(socket.id, setTimeout(() => {
      ringTimers.delete(socket.id);
      if (connectedCalls.has(callKey)) return; // звонок принят — не трогаем
      const c = usersBySocketId.get(socket.id);
      const t = usersBySocketId.get(targetUserId);
      if (c) c.inCallWith = null;
      if (t) t.inCallWith = null;
      broadcastUsersList();
      console.log(`[Call Missed] ${c?.username || socket.id} → ${t?.username || targetUserId}`);
      socket.emit('call:failed', { message: 'Абонент не отвечает' });
      socket.to(targetUserId).emit('call:ended', { fromUserId: socket.id, reason: 'Пропущенный звонок' });
    }, 45000));

    console.log(`[Call Initiate] From ${caller.username} to ${target.username}`);
    socket.to(targetUserId).emit('call:incoming', {
      callerId: caller.id,
      callerName: caller.username,
      callerAvatar: caller.avatar,
      offer,
    });
  });

  // 5. WebRTC Signaling: Accept Call (Answer)
  socket.on('call:accept', ({ callerId, answer }: { callerId: string; answer: any }) => {
    const receiver = usersBySocketId.get(socket.id);
    const caller = usersBySocketId.get(callerId);

    if (receiver && caller) {
      receiver.inCallWith = caller.username;
      caller.inCallWith = receiver.username;
      connectedCalls.add([callerId, socket.id].sort().join('::'));
      broadcastUsersList();
    }

    // Звонок принят — снимаем таймер гудков звонящего
    const timer = ringTimers.get(callerId);
    if (timer) { clearTimeout(timer); ringTimers.delete(callerId); }

    console.log(`[Call Accepted] by ${receiver?.username} from ${caller?.username}`);
    socket.to(callerId).emit('call:accepted', {
      targetUserId: socket.id,
      answer,
    });
  });

  // 6. WebRTC Signaling: Reject Call
  socket.on('call:reject', ({ callerId, reason }: { callerId: string; reason?: string }) => {
    const caller = usersBySocketId.get(callerId);
    if (caller && caller.inCallWith) {
      caller.inCallWith = null;
      broadcastUsersList();
    }
    const receiver = usersBySocketId.get(socket.id);
    if (receiver && receiver.inCallWith) {
      receiver.inCallWith = null;
      broadcastUsersList();
    }

    // Чистим состояние звонка
    const timer = ringTimers.get(callerId);
    if (timer) { clearTimeout(timer); ringTimers.delete(callerId); }
    connectedCalls.delete([callerId, socket.id].sort().join('::'));

    console.log(`[Call Rejected] callerId: ${callerId}, reason: ${reason}`);
    socket.to(callerId).emit('call:rejected', {
      reason: reason || 'Звонок отклонен пользователем',
    });
  });

  // 7. WebRTC Signaling: ICE Candidate Exchange
  socket.on('call:ice_candidate', ({ targetUserId, candidate }: { targetUserId: string; candidate: any }) => {
    socket.to(targetUserId).emit('call:ice_candidate', {
      fromUserId: socket.id,
      candidate,
    });
  });

  // 7.5 Audio Relay: forward raw audio data between call partners (fallback for when WebRTC P2P fails)
  socket.on('audio:data', ({ targetUserId, audio }: { targetUserId: string; audio: ArrayBuffer | Buffer | string }) => {
    socket.to(targetUserId).emit('audio:data', {
      fromUserId: socket.id,
      audio,
    });
  });

  // 8. End active call
  socket.on('call:end', ({ targetUserId }: { targetUserId: string }) => {
    const user = usersBySocketId.get(socket.id);
    if (user) user.inCallWith = null;

    const target = usersBySocketId.get(targetUserId);
    if (target) target.inCallWith = null;

    // Чистим состояние звонка
    connectedCalls.delete([socket.id, targetUserId].sort().join('::'));
    const t1 = ringTimers.get(socket.id);
    if (t1) { clearTimeout(t1); ringTimers.delete(socket.id); }
    const t2 = ringTimers.get(targetUserId);
    if (t2) { clearTimeout(t2); ringTimers.delete(targetUserId); }

    broadcastUsersList();

    console.log(`[Call Ended] by ${user?.username} with ${target?.username}`);
    socket.to(targetUserId).emit('call:ended', { fromUserId: socket.id });
  });

  // 9. Disconnect cleanup
  socket.on('disconnect', () => {
    const user = usersBySocketId.get(socket.id);
    // Чистим таймер гудков и активные звонки с участием этого сокета
    const ownTimer = ringTimers.get(socket.id);
    if (ownTimer) { clearTimeout(ownTimer); ringTimers.delete(socket.id); }
    for (const key of Array.from(connectedCalls)) {
      if (key.includes(socket.id)) connectedCalls.delete(key);
    }
    if (user) {
      console.log(`[User Disconnected] ${user.username} (${socket.id})`);
      // Notify active call partner if in call
      for (const [sId, u] of usersBySocketId.entries()) {
        if (u.inCallWith === user.username) {
          u.inCallWith = null;
          socket.to(sId).emit('call:ended', { fromUserId: socket.id, reason: 'Собеседник отключился' });
        }
      }
      usersBySocketId.delete(socket.id);
      broadcastUsersList();
    }
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 Voice Messenger Server running on http://localhost:${PORT}`);
});
