import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { User, ChatMessage, ReplyMeta, KnownUser } from './types.js';
import { initDatabase, dbSaveUser, dbGetUser, dbSaveMessage, dbGetHistory, dbGetLatestRelease, dbGetReleasePayload, dbPublishRelease, dbDeleteRelease, dbMarkMessageDeleted, dbSetLastSeen, dbGetKnownUsers } from './db.js';
import { startDiscoveryResponder } from './discovery.js';

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

// v1.0.13: LAN-хостинг — клиент (и владелец ПК) видит, какие адреса раздать друзьям.
// Друг открывает http://<LAN-IP>:<PORT> прямо в браузере — сервер раздаёт собранный клиент.
function getLanAddresses(): string[] {
  const urls: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Пропускаем internal (loopback) и IPv6 — друзьям нужен IPv4 локальной сети
      if (net.internal || net.family !== 'IPv4') continue;
      urls.push(`http://${net.address}:${PORT}`);
    }
  }
  return urls;
}

app.get('/api/server-info', (_req, res) => {
  res.json({
    status: 'ok',
    port: Number(PORT) || 3001,
    hostname: os.hostname(),
    lanUrls: getLanAddresses(),
    onlineCount: usersBySocketId.size,
  });
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

// v1.0.11: удалить релиз (очистка тестовых/битых публикаций, чтобы клиенты
// не видели фантомный бейдж «Обновление»)
app.delete('/api/updates/publish/:version', async (req, res) => {
  try {
    const version = req.params.version;
    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }
    const success = await dbDeleteRelease(version);
    res.json({ success, version });
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
    // Сохраняем пользователя всегда — так last_seen обновляется при каждом входе,
    // и пользователь попадает в список «известных» (сайдбар с офлайн-собеседниками)
    await dbSaveUser(cleanName, userAvatar, password ? hashPassword(password) : undefined);

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

    // v1.0.11: сразу отправляем список известных (в т.ч. офлайн) пользователей
    try {
      const known = await dbGetKnownUsers(30);
      socket.emit('users:known_list', { users: known });
      // v1.0.12: бродкаст всем — у остальных в сайдбаре сразу появится новый контакт
      socket.broadcast.emit('users:known_list', { users: known });
    } catch { /* не критично */ }
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

  // v1.0.11: список известных пользователей (в т.ч. офлайн) по запросу
  socket.on('users:known', async () => {
    try {
      const known = await dbGetKnownUsers(30);
      socket.emit('users:known_list', { users: known });
    } catch { /* не критично */ }
  });

  // 3. Send Direct Message
  // v1.0.11: получателя можно указать И ПО socket.id, И ПО имени — теперь можно
  // писать офлайн-собеседнику (сообщение сохранится и будет доставлено в историю).
  socket.on(
    'chat:send',
    ({
      recipientId,
      recipientUsername,
      text,
      mediaUrl,
      mediaType,
      duration,
      replyTo,
      forwardedFrom,
    }: {
      recipientId?: string;
      recipientUsername?: string;
      text?: string;
      mediaUrl?: string;
      mediaType?: 'text' | 'image' | 'voice';
      duration?: number;
      replyTo?: ReplyMeta;
      // v1.0.12: имя первоначального отправителя при пересылке
      forwardedFrom?: string;
    }) => {
      const sender = usersBySocketId.get(socket.id);
      if (!sender) return;

      // Поиск получателя: по socket.id или по стабильному имени (в т.ч. офлайн)
      const recipientUser =
        (recipientId && usersBySocketId.get(recipientId)) ||
        Array.from(usersBySocketId.values()).find(
          u => u.username.toLowerCase() === (recipientUsername || '').toLowerCase()
        );
      const offlineName = (recipientUsername || '').trim().slice(0, 24);
      if (!recipientUser && !offlineName) return;

      const recipientName = recipientUser ? recipientUser.username : offlineName;
      // Нельзя писать самому себе
      if (recipientName.toLowerCase() === sender.username.toLowerCase()) return;

      const trimmedText = (text || '').trim();
      if (!trimmedText && !mediaUrl) return;

      // v1.0.11: валидируем и нормализуем метаданные ответа (сниппет ≤ 160 символов)
      let replyMeta: ReplyMeta | undefined;
      if (replyTo && typeof replyTo.id === 'string' && replyTo.id.length <= 100) {
        const qt = (replyTo.text || '').trim().slice(0, 160);
        replyMeta = {
          id: replyTo.id,
          senderName: (replyTo.senderName || '').slice(0, 24),
          text: qt || undefined,
          mediaType: replyTo.mediaType,
        };
      }

      // v1.0.12: пересланные сообщения не сохраняют исходный replyTo (это новая ветка)
      const cleanForwardedFrom = (forwardedFrom || '').trim().slice(0, 24) || undefined;

      const message: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        senderId: sender.id,
        senderName: sender.username,
        senderAvatar: sender.avatar,
        recipientId: recipientUser?.id || recipientName,
        recipientName,
        text: trimmedText || undefined,
        mediaUrl: mediaUrl || undefined,
        mediaType: mediaType || 'text',
        duration: duration || undefined,
        read: false,
        replyTo: cleanForwardedFrom ? undefined : replyMeta,
        forwardedFrom: cleanForwardedFrom,
        timestamp: Date.now(),
      };

      // Conversation key is based on usernames → history survives reconnects
      const key = getConversationKey(sender.username, recipientName);
      const existing = messageHistory.get(key) || [];
      existing.push(message);
      // Keep last 200 messages per conversation
      if (existing.length > 200) existing.shift();
      messageHistory.set(key, existing);

      // Save to Neon PostgreSQL asynchronously
      dbSaveMessage(message, key).catch(err => console.error('[Neon DB Save Message Error]', err));

      // Deliver to recipient if online (офлайн-собеседник увидит сообщение в истории)
      if (recipientUser) {
        socket.to(recipientUser.id).emit('chat:receive', message);
      }
      // Echo back to sender (всегда — и для офлайн-отправки)
      socket.emit('chat:receive', message);
    }
  );

  // v1.0.11: удаление своего сообщения (мягкое — остаётся «Сообщение удалено»)
  socket.on('chat:delete', ({ partnerUsername, messageId }: { partnerUsername: string; messageId: string }) => {
    const user = usersBySocketId.get(socket.id);
    if (!user || !partnerUsername || !messageId) return;

    const key = getConversationKey(user.username, partnerUsername);
    const history = messageHistory.get(key);
    const msg = history?.find(m => m.id === messageId);

    // Удалять можно только СВОЁ сообщение
    if (!msg || msg.senderName.toLowerCase() !== user.username.toLowerCase() || msg.deleted) {
      socket.emit('chat:delete_failed', {
        messageId,
        message: 'Можно удалять только свои сообщения',
      });
      return;
    }

    msg.deleted = true;
    msg.text = undefined;
    msg.mediaUrl = undefined;
    msg.duration = undefined;
    msg.replyTo = undefined;

    dbMarkMessageDeleted(key, messageId).catch(err => console.error('[Neon DB Delete Message Error]', err));
    console.log(`[Message Deleted] ${user.username} удалил ${messageId}`);

    // уведомляем отправителя (эхо) и все сокеты собеседника
    socket.emit('chat:message_deleted', { messageId, partnerUsername });
    for (const [sId, u] of usersBySocketId.entries()) {
      if (u.username.toLowerCase() === partnerUsername.toLowerCase()) {
        io.to(sId).emit('chat:message_deleted', { messageId, partnerUsername: user.username });
      }
    }
  });

  // 3.5 Typing indicator — relay only, без состояния на сервере
  socket.on('chat:typing', ({ recipientId, isTyping }: { recipientId: string; isTyping: boolean }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender || !recipientId) return;
    socket.to(recipientId).emit('chat:typing', {
      fromName: sender.username,
      isTyping: Boolean(isTyping),
    });
  });

  // 3.6 Read receipts: получатель подтверждает прочтение
  socket.on('chat:read', ({ partnerUsername }: { partnerUsername: string }) => {
    const reader = usersBySocketId.get(socket.id);
    if (!reader || !partnerUsername) return;

    const key = getConversationKey(reader.username, partnerUsername);
    const history = messageHistory.get(key);
    let changed = 0;
    if (history) {
      for (const m of history) {
        // отмечаем прочитанными сообщения, ОТПРАВЛЕННЫЕ СОБЕСЕДНИКОМ
        if (m.senderName.toLowerCase() === partnerUsername.toLowerCase() && !m.read) {
          m.read = true;
          changed++;
        }
      }
    }
    if (changed > 0) console.log(`[Chat Read] ${reader.username} прочитал ${changed} сообщ. от ${partnerUsername}`);

    // уведомляем все сокеты собеседника — его ✓ станут ✓✓
    for (const [sId, u] of usersBySocketId.entries()) {
      if (u.username.toLowerCase() === partnerUsername.toLowerCase()) {
        io.to(sId).emit('chat:read_ack', { readerName: reader.username, partnerName: u.username });
      }
    }
  });

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
      // v1.0.11: фиксируем время последнего визита (для «был(а) в сети»)
      dbSetLastSeen(user.username).catch(() => {});
      broadcastUsersList();
    }
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// v1.0.14: ЯВНЫЙ биндинг на все интерфейсы (0.0.0.0) — раньше listen(PORT) без хоста
// на некоторых системах Windows/фаервол ловил неоднозначность, и друг не мог подключиться.
// Защита от падения: в встроенном режиме (Electron) ошибка порта не должна валить всё приложение.
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`❌ [Server Error] ${err.code || ''} ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('   Порт уже занят — возможно, сервер уже запущен на этом ПК (в другом окне/приложении).');
  }
  if (!process.env.VM_EMBEDDED) {
    process.exit(1); // standalone (батник/консоль) — честно показываем ошибку и закрываемся
  }
  // VM_EMBEDDED=1 (встроен в Electron) — не завершаем процесс, main-процесс сам
  // проверит /health и перейдёт к следующему варианту цепочки.
});

server.listen(Number(PORT), '0.0.0.0', () => {
  const lanUrls = getLanAddresses();
  console.log(`🚀 Voice Messenger Server v1.0.16 запущен`);
  console.log(`   Локально:       http://localhost:${PORT}`);
  if (lanUrls.length > 0) {
    console.log(`   Для друзей (LAN):`);
    for (const u of lanUrls) console.log(`     → ${u}`);
    console.log(`   Если друг не подключается:`);
    console.log(`     1) Разрешите порты ${PORT} (TCP+UDP) и 3002 (UDP) в брандмауэре Windows (см. README)`);
    console.log(`     2) Оба устройства должны быть в одной Wi-Fi/проводной сети`);
  } else {
    console.log(`   LAN-адреса не найдены — проверьте сетевые подключения`);
  }

  // v1.0.14: UDP-ответчик — приложение друзей найдёт этот сервер в локальной
  // сети автоматически (без ручного ввода IP) через broadcast на порт 3002.
  startDiscoveryResponder(Number(PORT) || 3001);
});
