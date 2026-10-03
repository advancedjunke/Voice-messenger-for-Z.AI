import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { User, ChatMessage, ReplyMeta, KnownUser, GroupInfo } from './types.js';
import { initDatabaseWithRetry, dbSaveUser, dbFindUserByName, dbGetUserByToken, dbSaveMessage, dbGetHistory, dbGetLatestRelease, dbGetReleasePayload, dbPublishRelease, dbDeleteRelease, dbMarkMessageDeleted, dbEditMessage, dbSetReactions, dbMarkConversationRead, dbSetLastSeen, dbGetKnownUsers, getDbStatus, loadGroupsFromDisk, saveGroupsToDisk } from './db.js';
import { startDiscoveryResponder } from './discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');

// ─── FIX (v1.0.21) A3: CORS ужесточён ───
// Публичные сайты не должны дёргать API из браузера посетителя (drive-by
// запросы к LAN-серверу). Разрешены только «свои» клиенты: запросы без Origin
// (curl, Electron IPC, same-server инструменты), Origin "null" (Electron file://),
// localhost / 127.x / ::1 и приватные IPv4-диапазоны локальной сети.
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // без Origin: curl, Electron IPC, same-server
  if (origin === 'null') return true; // Electron file://
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1') return true;
    // только НАСТОЯЩИЕ IPv4-адреса (строга «цифры.цифры.цифры.цифры»),
    // иначе домены вида 127.0.0.1.evil.com обходили бы префиксные проверки
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    const o = host.split('.').map(Number);
    if (o.some(p => p > 255)) return false;
    if (o[0] === 127) return true; // loopback
    // приватные IPv4-диапазоны LAN
    if (o[0] === 10) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    return false;
  } catch {
    return false; // кривой Origin — не пускаем
  }
}

// Делегат для пакета cors: разрешённым отражаем их Origin (или '*' для запросов
// без Origin), запрещённым не выставляем заголовок вовсе → браузер заблокирует ответ
const corsOriginDelegate = (origin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
  cb(null, isAllowedOrigin(origin) ? (origin || '*') : false);
};

const app = express();
app.use(cors({ origin: corsOriginDelegate }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(clientDistPath));

// v1.0.19: подключение к PostgreSQL/Neon с ретраями (база может «проснуться» не сразу)
initDatabaseWithRetry().catch(err => console.error('[Neon DB Init Error]', err));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // FIX (v1.0.21) A3: те же правила Origin, что и у Express (раньше был '*')
    origin: corsOriginDelegate,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 25 * 1024 * 1024, // 25MB for voice messages & images
});

const PORT = process.env.PORT || 3001;

// In-memory data store
const usersBySocketId = new Map<string, User>();
// NEW (v1.0.27) MS: индекс «username (lowercase) → множество живых сокетов».
// Архитектура мульти-сессии: одно имя может быть открыто в нескольких окнах /
// на устройствах — ВСЕ его сокеты получают события (сообщения, звонки), а в
// присутствии имя показывается один раз (см. getOnlineUsersList).
const socketsByUsername = new Map<string, Set<string>>();
// Conversation key: [user1Id, user2Id].sort().join('::') -> array of ChatMessages
const messageHistory = new Map<string, ChatMessage[]>();
// NEW (v1.0.29) GC: группы — in-memory кэш + файл server/data/groups.json.
// История групповых сообщений живёт в ТОМ ЖЕ messageHistory с ключом
// 'group::' + groupId (тот же кольцевой буфер на 200) — правки/удаления/
// реакции работают и для групп с минимальными изменениями хендлеров.
const groupsById = new Map<string, GroupInfo>(); // id → группа
// NEW (v1.0.29) GC: загрузка групп при старте (файл мог быть создан прошлым
// запуском; отсутствующий/битый файл — просто пустой список, см. db.ts)
for (const g of loadGroupsFromDisk()) {
  groupsById.set(g.id, g);
}
if (groupsById.size > 0) console.log(`👥 [Groups] В кэше групп: ${groupsById.size}`);
// FIX звонков: таймеры гудков (авто-отмена неотвеченных звонков) и активные соединения
const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();
const connectedCalls = new Set<string>(); // ключ: [callerSocketId, targetSocketId].sort().join('::')

function getConversationKey(id1: string, id2: string): string {
  // Keys are built from STABLE usernames (not socket ids), so chat history
  // survives reconnects / page refreshes (fix: history lost between sessions)
  return [id1.toLowerCase(), id2.toLowerCase()].sort().join('::');
}

// NEW (v1.0.25) R1: серверный allowlist эмодзи-реакций (синхронизирован с
// REACTION_EMOJIS в клиенте). Всё вне списка — NACK chat:react_failed.
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🙏', '⭐'];

// ─── NEW (v1.0.27) AI: LLM-помощник (умные ответы + сводка переписки) ───

// Ленивый синглтон z-ai-web-dev-sdk (динамический импорт — отсутствие пакета
// не роняет сервер: ошибка выстрелит только при первом AI-запросе).
let zaiInstance: any = null;
let zaiInitPromise: Promise<any> | null = null;
async function getZai(): Promise<any> {
  if (!zaiInitPromise) {
    zaiInitPromise = (async () => {
      const mod = await import('z-ai-web-dev-sdk');
      const ZAI = (mod as any).default || mod;
      zaiInstance = await ZAI.create();
      return zaiInstance;
    })();
  }
  return zaiInitPromise;
}

// Защита от параллельных AI-запросов: ключ «вид:сокет:партнёр» → pending.
// Простейший безопасный вариант: повторный запрос той же пары, пока не завершился
// предыдущий, ПРОСТО ИГНОРИРУЕТСЯ (клиент получит результат первого запроса;
// очередь не копится, гонок нет).
const aiInflight = new Map<string, true>();

// NEW (v1.0.28) AI: поддерживаемые целевые языки перевода (коды → имена для промпта)
const AI_TRANSLATE_LANGS: Record<string, string> = {
  ru: 'русский', en: 'английский', de: 'немецкий', es: 'испанский', fr: 'французский',
  it: 'итальянский', pt: 'португальский', zh: 'китайский', ja: 'японский', ko: 'корейский',
  tr: 'турецкий', uk: 'украинский',
};

// Строка транскрипта для LLM: «Имя: текст»; голосовое → [голосовое, N сек],
// фото → [фото], удалённое → [сообщение удалено]. Строка ≤ 300 символов.
function messageToTranscriptLine(m: ChatMessage): string {
  let body: string;
  if (m.deleted) {
    body = '[сообщение удалено]';
  } else if (m.mediaType === 'voice') {
    body = `[голосовое, ${Math.round(m.duration ?? 0)} сек]`;
  } else if (m.mediaType === 'image') {
    body = '[фото]';
  } else {
    body = m.text || '';
  }
  return `${m.senderName}: ${body}`.slice(0, 300);
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

// NEW (v1.0.27) MS: снапшот присутствия ДЕДУПЛИЦИРОВАН по имени — пользователь
// с N окнами отображается ровно ОДИН раз. «Первичная» запись = User самой
// поздней регистрации (Map хранит порядок вставки — поздняя перезаписывает),
// sessions = число живых сокетов имени, inCallWith берём с любого сокета имени
// (звонок один на имя целиком, а не на сокет).
function getOnlineUsersList(): User[] {
  const byName = new Map<string, User>();
  for (const u of usersBySocketId.values()) {
    const key = u.username.toLowerCase();
    const prev = byName.get(key);
    byName.set(key, {
      ...u,
      sessions: (prev?.sessions || 0) + 1,
      inCallWith: u.inCallWith || prev?.inCallWith || null,
    });
  }
  return Array.from(byName.values());
}

function broadcastUsersList() {
  io.emit('users:update', getOnlineUsersList());
}

// ─── NEW (v1.0.27) MS: хелперы мульти-сессии ───

// Роутинг события ВСЕМ живым сессиям пользователя по имени. Мёртвые сокеты
// пропускаем и вычищаем из индекса на ходу (страховка от «призраков», если
// disconnect по какой-то причине не успел убрать запись).
function emitToUser(username: string, event: string, payload: any): void {
  const key = (username || '').trim().toLowerCase();
  const sids = socketsByUsername.get(key);
  if (!sids || sids.size === 0) return;
  for (const sid of Array.from(sids)) {
    if (!io.sockets.sockets.has(sid)) {
      sids.delete(sid); // мёртвый сокет — чистим набор на ходу
      continue;
    }
    io.to(sid).emit(event, payload);
  }
  if (sids.size === 0) socketsByUsername.delete(key);
}

// Канонический регистр имени — как зарегистрирован живой сессией; если имени
// нет онлайн, возвращаем как прислал вызывающий код.
function getCanonicalUsername(name: string): string {
  const clean = (name || '').trim();
  const key = clean.toLowerCase();
  if (!key) return clean;
  for (const u of usersBySocketId.values()) {
    if (u.username.toLowerCase() === key) return u.username;
  }
  return clean;
}

// Пометить/снять «в звонке» у ВСЕХ живых сессий имени — занятость пользователя
// едина на уровне ИМЕНИ (не сокета): presence-дедуп и проверки busy видят её сразу.
function setInCallWithAllSessions(username: string, partner: string | null): void {
  const sids = socketsByUsername.get(username.toLowerCase());
  if (!sids) return;
  for (const sid of sids) {
    const u = usersBySocketId.get(sid);
    if (u) u.inCallWith = partner;
  }
}

// Занято ли ИМЯ (хотя бы одна из его сессий в звонке)
function isUsernameInCall(username: string): boolean {
  const sids = socketsByUsername.get(username.toLowerCase());
  if (!sids) return false;
  for (const sid of sids) {
    const u = usersBySocketId.get(sid);
    if (u?.inCallWith) return true;
  }
  return false;
}

// Сокет-партнёр по УСТАНОВЛЕННОЙ паре звонков (connectedCalls), либо null.
// Нужен для «позднего» call:accept и строгого роутинга WebRTC-сигналинга/аудио
// строго между ДВУМЯ активными сокетами пары.
function findActiveCallPartner(socketId: string): string | null {
  for (const key of connectedCalls) {
    if (!key.includes(socketId)) continue;
    const [a, b] = key.split('::');
    if (a === socketId) return b;
    if (b === socketId) return a;
  }
  return null;
}

// ─── NEW (v1.0.29) GC: хелперы групповых чатов ───

// Ключ истории групповой беседы в messageHistory (переиспользуем общий буфер)
function getGroupKey(groupId: string): string {
  return 'group::' + groupId;
}

// Участник ли группы (сравнение имён без учёта регистра)
function isGroupMember(group: GroupInfo, username: string): boolean {
  const key = (username || '').trim().toLowerCase();
  if (!key) return false;
  return group.members.some(m => m.toLowerCase() === key);
}

// Все группы, где пользователь — участник (без учёта регистра)
function groupsOfUser(username: string): GroupInfo[] {
  const key = (username || '').trim().toLowerCase();
  if (!key) return [];
  const result: GroupInfo[] = [];
  for (const g of groupsById.values()) {
    if (g.members.some(m => m.toLowerCase() === key)) result.push(g);
  }
  return result;
}

// Событие ВСЕМ участникам группы (кроме exceptUsername, если задан) —
// поверх emitToUser: каждая живая сессия каждого участника получает событие.
function emitToGroupMembers(group: GroupInfo, event: string, payload: any, exceptUsername?: string): void {
  const exceptKey = exceptUsername ? exceptUsername.trim().toLowerCase() : null;
  for (const m of group.members) {
    if (exceptKey && m.toLowerCase() === exceptKey) continue;
    emitToUser(m, event, payload);
  }
}

// NEW (v1.0.29) GC: валидация списка участников: трим → слайс 24 → дедуп без
// учёта регистра → отбрасываем пустые. Незарегистрированные имена РАЗРЕШЕНЫ
// (как офлайн-ЛС): участник увидит группу при своей первой регистрации
// (user:register рассылает groups:list_result по имени).
function sanitizeMemberUsernames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of list) {
    const name = String(raw || '').trim().slice(0, 24);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

// NEW (v1.0.29) GC: загрузка истории по ключу беседы с логикой «ждать
// просыпающуюся базу» — общая для личных чатов (chat:history) и групп
// (group:history): быстрый путь — кольцевой буфер в памяти; иначе (если БД
// настроена, но ещё не подключена) коротко ждём подключение (до 10с) и тянем
// историю из БД, кэшируя её в память. Поведение ЛС — 1:1 с прежним кодом.
async function loadHistoryForKey(key: string): Promise<ChatMessage[]> {
  const dbSt = getDbStatus();
  if (dbSt.usingPostgres && !dbSt.connected) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (getDbStatus().connected) break;
    }
  }
  let history = messageHistory.get(key);
  if (!history || history.length === 0) {
    history = await dbGetHistory(key);
    messageHistory.set(key, history);
  }
  return history;
}

// ─── FIX (v1.0.21) A4/A5: проверка пары активного звонка перед релеем ───
// Обе стороны помечаются inCallWith ещё на стадии гудков (call:initiate),
// поэтому проверка валидна и ДО принятия звонка (trickle-ICE), и после.
function isCallPair(senderSocketId: string, targetUserId: string): boolean {
  const sender = usersBySocketId.get(senderSocketId);
  const target = usersBySocketId.get(targetUserId);
  return Boolean(
    sender &&
      target &&
      sender.inCallWith === target.username &&
      target.inCallWith === sender.username
  );
}

// рейт-лимит предупреждений — чтобы баганутый/злой клиент не заспамил лог
const callWarnAt = new Map<string, number>();
function warnCallBlocked(event: string, socketId: string, targetUserId: string) {
  const key = `${event}:${socketId}`;
  const now = Date.now();
  if (now - (callWarnAt.get(key) || 0) < 5000) return;
  callWarnAt.set(key, now);
  console.warn(`[Call Security] «${event}» отклонён: ${socketId} → ${targetUserId} не являются парой активного звонка`);
}

app.get('/health', (_req, res) => {
  // NEW (v1.0.27) MS: считаем УНИКАЛЬНЫХ пользователей (несколько окон одного
  // имени = один онлайн-юзер), а не количество сокетов
  res.json({ status: 'ok', onlineCount: getOnlineUsersList().length });
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
    // NEW (v1.0.27) MS: уникальные пользователи (дедуп по имени), не сокеты
    onlineCount: getOnlineUsersList().length,
  });
});

// v1.0.19: статус базы данных для UI (без кредов — только режим и хост Neon)
app.get('/api/db/status', (_req, res) => {
  res.json(getDbStatus());
});

// ────────────────────────────────────────────────────────────────
// v1.0.17: РЕАЛЬНАЯ РЕГИСТРАЦИЯ И ВХОД В АККАУНТ (REST).
// Раньше вход был «по нику» через сокет и при недоступном сервере
// кнопка молчала. Теперь: явная регистрация с паролем, вход,
// токен сессии (localStorage) и живая проверка занятости имени.
// ────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_\- ]{2,24}$/u;

function validateUsername(name: string): string | null {
  const clean = (name || '').trim();
  if (clean.length < 2) return 'Имя должно содержать минимум 2 символа';
  if (clean.length > 24) return 'Имя не должно быть длиннее 24 символов';
  if (!NAME_RE.test(clean)) return 'Имя может содержать только буквы, цифры, пробел, «_» и «-»';
  return null;
}

// ─── FIX (v1.0.21) A2: in-memory rate limiter для auth-эндпоинтов ───
// Защита от перебора паролей: простая корзина «N запросов / 60с» на IP,
// чистка протухших корзин прямо при обращении (без внешних зависимостей).
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(scope: string, req: express.Request, max: number, windowMs = 60000): boolean {
  const ip = req.socket?.remoteAddress || 'unknown';
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    // лёгкая чистка протухших корзин, чтобы карта не росла бесконечно
    if (rateBuckets.size > 1000) {
      for (const [k, v] of rateBuckets) {
        if (v.resetAt <= now) rateBuckets.delete(k);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

// ─── FIX (v1.0.22) S6: рейт-лимит для сокет-событий (ключ — socket.id, не IP:
// за NAT все клиенты локальной сети делят один IP) ───
const socketRateBuckets = new Map<string, { count: number; resetAt: number }>();

function isSocketRateLimited(scope: string, socketId: string, max: number, windowMs = 10000): boolean {
  const key = `${scope}:${socketId}`;
  const now = Date.now();
  const bucket = socketRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    socketRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    // лёгкая чистка протухших корзин, чтобы карта не росла бесконечно
    if (socketRateBuckets.size > 2000) {
      for (const [k, v] of socketRateBuckets) {
        if (v.resetAt <= now) socketRateBuckets.delete(k);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

function validatePassword(password: string): string | null {
  // FIX (v1.0.21) C5: минимальная длина пароля для НОВЫХ аккаунтов — 6 символов
  // (вход остаётся мягким: старые 4-символьные пароли продолжают работать)
  if (!password || password.length < 6) return 'Пароль должен содержать минимум 6 символов';
  if (password.length > 64) return 'Пароль не должен быть длиннее 64 символов';
  return null;
}

function newSessionToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

app.post('/api/auth/register', async (req, res) => {
  // FIX (v1.0.21) A2: не более 5 регистраций в минуту с одного IP
  if (isRateLimited('register', req, 5)) {
    return res.status(429).json({ error: 'Слишком много попыток регистрации. Подождите минуту.' });
  }
  try {
    const { username, password } = req.body || {};
    const nameError = validateUsername(username);
    if (nameError) return res.status(400).json({ error: nameError });
    const passError = validatePassword(password);
    if (passError) return res.status(400).json({ error: passError });

    const existing = await dbFindUserByName(String(username).trim());
    if (existing) {
      return res.status(409).json({ error: 'Имя «' + existing.username + '» уже занято. Попробуйте войти на вкладке «Вход».' });
    }

    const cleanName = String(username).trim();
    const token = newSessionToken();
    const saved = await dbSaveUser(cleanName, undefined, hashPassword(password), token);
    // FIX (v1.0.21) B3: гонка «двое регистрируют одно имя одновременно» — уникальный
    // индекс LOWER(username) в БД не дал вставить дубликат → честное «Имя занято»
    if (!saved) {
      return res.status(409).json({ error: 'Имя «' + cleanName + '» уже занято. Попробуйте войти на вкладке «Вход».' });
    }
    console.log(`[Auth] Зарегистрирован аккаунт: ${cleanName}`);
    res.json({ ok: true, token, username: cleanName, avatar: null });
  } catch (err: any) {
    console.error('[Auth] Ошибка регистрации:', err?.message || err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации. Попробуйте ещё раз.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  // FIX (v1.0.21) A2: анти-брутфорс — не более 10 попыток входа в минуту с одного IP
  if (isRateLimited('login', req, 10)) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Подождите минуту.' });
  }
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Введите имя и пароль' });
    }
    const account = await dbFindUserByName(String(username).trim());
    if (!account || !account.passwordHash) {
      return res.status(404).json({ error: 'Аккаунт не найден. Создайте его на вкладке «Регистрация».' });
    }
    if (!verifyPassword(password, account.passwordHash)) {
      return res.status(401).json({ error: 'Неверный пароль. Попробуйте ещё раз.' });
    }
    const token = newSessionToken();
    await dbSaveUser(account.username, account.avatar, undefined, token);
    console.log(`[Auth] Вход в аккаунт: ${account.username}`);
    res.json({ ok: true, token, username: account.username, avatar: account.avatar || null });
  } catch (err: any) {
    console.error('[Auth] Ошибка входа:', err?.message || err);
    res.status(500).json({ error: 'Ошибка сервера при входе. Попробуйте ещё раз.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  // FIX (v1.0.22) S5: лимит 60/мин — иначе перебор токенов бил по БД без ограничений
  if (isRateLimited('me', req, 60)) {
    return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const account = await dbGetUserByToken(token);
  if (!account) {
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
  res.json({ ok: true, username: account.username, avatar: account.avatar || null });
});

app.get('/api/auth/check', async (req, res) => {
  // FIX (v1.0.21) A2: лимит на «живую» проверку имени — не более 60 в минуту с одного IP
  if (isRateLimited('check', req, 60)) {
    return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
  }
  const username = String(req.query.username || '').trim();
  const nameError = validateUsername(username);
  if (nameError) {
    return res.json({ taken: false, valid: false, reason: nameError });
  }
  const existing = await dbFindUserByName(username);
  res.json({ taken: Boolean(existing), valid: true, takenBy: existing?.username });
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
      // FIX (v1.0.21) C4: SHA-256 payload (hex, lowercase) — лаунчер проверяет
      // целостность скачанного файла (контракт: поле payloadSha256)
      payloadSha256: release.payloadSha256 || null,
      timestamp: release.timestamp,
    });
  } catch (err: any) {
    // FIX (v1.0.22) S1: сырой err.message наружу не отдаём (утечка внутренностей)
    console.error('[Updates] Ошибка проверки обновлений:', err?.message || err);
    res.status(500).json({ error: 'Ошибка проверки обновлений' });
  }
});

app.get('/api/updates/download/:version', async (req, res) => {
  try {
    const version = req.params.version;
    // FIX (v1.0.22) S3: приоритет — payload из БД: именно он зарегистрирован в
    // SHA-контракте (/api/updates/check). Раньше локальный app.asar с диска
    // обслуживался В ПЕРВУЮ ОЧЕРЕДЬ и мог отличаться от опубликованного payload,
    // тихо обходя проверку целостности на клиентах.
    const base64 = await dbGetReleasePayload(version);
    if (base64) {
      const buffer = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="app-${version}.asar"`);
      // прозрачность: SHA-256 отданного байтового потока (для отладки контракта)
      res.setHeader('X-Payload-Sha256', crypto.createHash('sha256').update(buffer).digest('hex'));
      return res.send(buffer);
    }
    // Фолбэк: в БД payload нет (релиз зарегистрирован только ссылкой downloadUrl) —
    // отдаём локальный файл, если он есть на этом хосте
    const localAsarPath = path.resolve(__dirname, '../../release/win-unpacked/resources/app.asar');
    if (fs.existsSync(localAsarPath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="app-${version}.asar"`);
      return res.sendFile(localAsarPath);
    }
    return res.status(404).json({ error: 'Release payload not found' });
  } catch (err: any) {
    // FIX (v1.0.22) S1: сырой err.message наружу не отдаём
    console.error('[Updates] Ошибка скачивания релиза:', err?.message || err);
    res.status(500).json({ error: 'Ошибка скачивания релиза' });
  }
});

// ─── FIX (v1.0.21) A1: админ-токен для публикации обновлений ───
// Раньше POST/DELETE /api/updates/publish* были БЕЗ авторизации — кто угодно
// мог раздавать произвольный код всем клиентам (RCE). Теперь нужен
// VM_ADMIN_TOKEN в env + заголовок x-admin-token (сравнение через timingSafeEqual).
const ADMIN_TOKEN = process.env.VM_ADMIN_TOKEN;

// false = запрос отклонён (ответ уже отправлен), true = можно продолжать
function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: 'Публикация обновлений отключена: не задан VM_ADMIN_TOKEN на сервере' });
    return false;
  }
  const provided = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(ADMIN_TOKEN, 'utf8');
  // timingSafeEqual бросает при разной длине буферов — длины сверяем заранее
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(403).json({ error: 'Неверный админ-токен' });
    return false;
  }
  return true;
}

app.post('/api/updates/publish', async (req, res) => {
  // FIX (v1.0.21) A1: публикация только с корректным x-admin-token
  if (!adminGuard(req, res)) return;
  try {
    const { version, downloadUrl, releaseNotes, payloadBase64, payloadSha256 } = req.body;
    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }
    // FIX (v1.0.21) C4: SHA-256 payload. Приходит от publish-release.cjs;
    // если не прислали — считаем сами по payloadBase64 (hex, lowercase).
    let sha: string | undefined;
    if (typeof payloadSha256 === 'string' && payloadSha256.trim()) {
      sha = payloadSha256.trim().toLowerCase();
    } else if (typeof payloadBase64 === 'string' && payloadBase64) {
      try {
        sha = crypto.createHash('sha256').update(Buffer.from(payloadBase64, 'base64')).digest('hex');
      } catch {
        sha = undefined;
      }
    }
    const success = await dbPublishRelease(version, downloadUrl, releaseNotes, payloadBase64, sha);
    if (success) {
      res.json({ success: true, version });
    } else {
      res.status(500).json({ error: 'Failed to publish release' });
    }
  } catch (err: any) {
    // FIX (v1.0.21) A1: сырой err.message клиенту не отдаём (утечка внутренностей)
    console.error('[Updates] Ошибка публикации релиза:', err?.message || err);
    res.status(500).json({ error: 'Ошибка публикации релиза' });
  }
});

// v1.0.11: удалить релиз (очистка тестовых/битых публикаций, чтобы клиенты
// не видели фантомный бейдж «Обновление»)
app.delete('/api/updates/publish/:version', async (req, res) => {
  // FIX (v1.0.21) A1: удаление релиза только с корректным x-admin-token
  if (!adminGuard(req, res)) return;
  try {
    const version = req.params.version;
    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }
    const success = await dbDeleteRelease(version);
    res.json({ success, version });
  } catch (err: any) {
    // FIX (v1.0.21) A1: сырой err.message клиенту не отдаём
    console.error('[Updates] Ошибка удаления релиза:', err?.message || err);
    res.status(500).json({ error: 'Ошибка удаления релиза' });
  }
});

io.on('connection', (socket: Socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // 1. User Registration
  // v1.0.17: поддержан вход по токену аккаунта (после REST-регистрации/логина).
  // Без токена работает прежний путь (ник + опциональный пароль) — совместимость.
  socket.on('user:register', async ({ username, avatar, password, token }: { username: string; avatar?: string; password?: string; token?: string }) => {
    let cleanName = (username || '').trim().slice(0, 24);
    let userAvatar = avatar;

    if (token) {
      // ─── Вход по токену: имя берётся ИЗ АККАУНТА, пароль не нужен ───
      const account = await dbGetUserByToken(token);
      if (!account) {
        socket.emit('user:register_failed', {
          message: 'Сессия недействительна (сервер мог быть перезапущен). Войдите заново.',
        });
        return;
      }
      cleanName = account.username;
      if (!userAvatar && account.avatar) userAvatar = account.avatar;
    } else {
      // ─── Legacy: если имя занято в БД и защищено паролем — требуем пароль ───
      // FIX (v1.0.21) B3: поиск без учёта регистра (раньше чувствительный к регистру
      // dbGetUser позволял зарегистрировать «Alice» поверх существующего «alice»,
      // обходя защиту паролем и создавая дубликат аккаунта)
      const existingDbUser = await dbFindUserByName(cleanName);
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
      // FIX (v1.0.22) S4: НОВЫЙ пароль через legacy-сокет — та же политика, что в
      // REST-регистрации: минимум 6 символов (раньше через сокет создавался
      // аккаунт с паролем в 1 символ в обход REST-валидации)
      if (password && !existingDbUser?.passwordHash) {
        const passError = validatePassword(password);
        if (passError) {
          socket.emit('user:register_failed', { message: passError });
          return;
        }
      }
      // FIX (v1.0.22) S4: НОВОЕ имя через сокет — валидация как в REST (буквы/
      // цифры/пробел/_/-, 2–24). Существующие имена не трогаем — совместимость.
      if (!existingDbUser && cleanName) {
        const nameError = validateUsername(cleanName);
        if (nameError) {
          socket.emit('user:register_failed', { message: nameError });
          return;
        }
      }
      if (!userAvatar && existingDbUser?.avatar) {
        userAvatar = existingDbUser.avatar;
      }
      // FIX (v1.0.21) B3: приводим имя к каноническому регистру из БД (Alice → alice),
      // чтобы не плодить дубликаты и корректно обновлять last_seen/аватар
      if (existingDbUser) cleanName = existingDbUser.username;
    }

    if (!cleanName) cleanName = `User_${socket.id.slice(0, 4)}`;
    // NEW (v1.0.27) MS: защита от «призрачной» регистрации — если сокет умер,
    // пока мы ждали БД (await выше), не добавляем его ни в usersBySocketId,
    // ни в индекс имён (иначе имя навсегда зависнет «онлайн» с мёртвым сокетом)
    if (!io.sockets.sockets.has(socket.id)) {
      console.log(`[User Registered] ${cleanName}: сокет ${socket.id} уже отключён — сессия не регистрируется`);
      return;
    }
    // Сохраняем пользователя всегда — так last_seen обновляется при каждом входе,
    // и пользователь попадает в список «известных» (сайдбар с офлайн-собеседниками)
    await dbSaveUser(cleanName, userAvatar, password ? hashPassword(password) : undefined, token);

    // ─── NEW (v1.0.27) MS: МУЛЬТИ-СЕССИЯ — второе (третье…) окно того же имени
    // больше НЕ кикает первое: все сокеты имени живут одновременно и получают
    // события (сообщения/звонки/присутствие). user:replaced сервером не шлётся
    // вовсе (клиентский обработчик остаётся как безобидный легаси).
    // Защита индекса: этот же сокет уже был зарегистрирован (пере-регистрация
    // под другим именем) — снимаем его со старого имени, чтобы не протекло.
    const prevReg = usersBySocketId.get(socket.id);
    if (prevReg) {
      const prevSet = socketsByUsername.get(prevReg.username.toLowerCase());
      prevSet?.delete(socket.id);
      if (prevSet && prevSet.size === 0) socketsByUsername.delete(prevReg.username.toLowerCase());
    }
    const nameKey = cleanName.toLowerCase();
    let nameSessions = socketsByUsername.get(nameKey);
    if (!nameSessions) {
      nameSessions = new Set<string>();
      socketsByUsername.set(nameKey, nameSessions);
    }
    nameSessions.add(socket.id);
    console.log(`[Session Multi] ${cleanName}: session #${nameSessions.size} (socket ${socket.id})`);

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
      // NEW (v1.0.27) MS: в собственном профиле — актуальное число живых сессий имени
      user: { ...user, sessions: nameSessions.size },
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

    // NEW (v1.0.29) GC: сразу отдаём группы, где пользователь участник — в т.ч.
    // приглашения, сделанные в его имя ДО первой регистрации (незарегистрированные
    // участники разрешены так же, как офлайн-получатели в ЛС)
    socket.emit('groups:list_result', { groups: groupsOfUser(cleanName) });
  });

  // 1.1. Update User Avatar
  socket.on('user:update_avatar', async ({ avatar }: { avatar: string }) => {
    const user = usersBySocketId.get(socket.id);
    if (!user) return;
    user.avatar = avatar;
    // NEW (v1.0.27) MS: аватар применяем ко ВСЕМ сессиям имени — иначе снапшот
    // присутствия (берёт «самую позднюю» сессию) показывал бы старый аватар.
    // Решение по роутингу: подтверждение user:updated — только запрашивающему
    // сокету (минимальный диф, чужие окна узнают об аватаре из users:update);
    // даунгрейд кейса: чужое окно покажет свой старый аватар до перезагрузки.
    for (const sid of socketsByUsername.get(user.username.toLowerCase()) || []) {
      const u = usersBySocketId.get(sid);
      if (u) u.avatar = avatar;
    }
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

    // v1.0.20: если база настроена, но ещё «просыпается» (Neon free tier может
    // подниматься десятки секунд), коротко подождём подключение — иначе
    // пользователь увидит пустой чат, хотя история в базе уже есть.
    // NEW (v1.0.29) GC: логика вынесена в общий хелпер loadHistoryForKey
    // (используется и личными чатами, и группами) — поведение 1:1 с прежним кодом.
    const history = await loadHistoryForKey(key);
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
      groupId,
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
      // NEW (v1.0.29) GC: отправка в группу — при наличии groupId работает
      // ГРУППОВОЙ путь (recipientId/recipientUsername игнорируются)
      groupId?: string;
    }) => {
      const sender = usersBySocketId.get(socket.id);
      // NEW (v1.0.23) N1: NACK — раньше сообщение от ещё не зарегистрированного
      // сокета (авто-реконнект socket.io буферизует эмииты и досылает их ДО
      // повторной user:register) ронялось МОЛЧА. Теперь отправителю возвращается
      // chat:send_failed с причиной — он понимает, что сообщение не ушло.
      const preview = String(text || '').trim().slice(0, 80);
      if (!sender) {
        socket.emit('chat:send_failed', {
          reason: 'Сессия не зарегистрирована — переподключение ещё не завершено',
          preview,
        });
        return;
      }

      // ─── NEW (v1.0.29) GC: ГРУППОВОЙ ПУТЬ отправки сообщения ───
      // Валидации те же, что у ЛС (пустота/размер/длительность), но БЕЗ запрета
      // «писать самому себе» и без резолва получателя: получатель — сама группа.
      if (groupId) {
        const group = groupsById.get(String(groupId));
        if (!group || !isGroupMember(group, sender.username)) {
          socket.emit('chat:send_failed', { reason: 'Вы не участник этой группы', preview });
          return;
        }
        const groupTrimmedText = (text || '').trim();
        if (!groupTrimmedText && !mediaUrl) {
          socket.emit('chat:send_failed', { reason: 'Пустое сообщение', preview });
          return;
        }
        if (
          groupTrimmedText.length > 4000 ||
          (typeof duration === 'number' && (duration < 0 || duration > 600))
        ) {
          console.warn(`[Chat Security] Групповое сообщение от ${sender.username} отклонено: text=${groupTrimmedText.length} симв., duration=${duration}`);
          socket.emit('chat:send_failed', {
            reason: groupTrimmedText.length > 4000
              ? 'Текст слишком длинный (максимум 4000 символов)'
              : 'Недопустимая длительность голосового (максимум 10 минут)',
            preview,
          });
          return;
        }
        // валидация метаданных ответа — как в ЛС (сниппет ≤ 160 символов)
        let groupReplyMeta: ReplyMeta | undefined;
        if (replyTo && typeof replyTo.id === 'string' && replyTo.id.length <= 100) {
          const qt = (replyTo.text || '').trim().slice(0, 160);
          groupReplyMeta = {
            id: replyTo.id,
            senderName: (replyTo.senderName || '').slice(0, 24),
            text: qt || undefined,
            mediaType: replyTo.mediaType,
          };
        }
        // пересланные сообщения не сохраняют исходный replyTo (новая ветка)
        const groupForwardedFrom = (forwardedFrom || '').trim().slice(0, 24) || undefined;

        const message: ChatMessage = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          senderId: sender.id,
          senderName: sender.username,
          senderAvatar: sender.avatar,
          recipientId: group.id,
          recipientName: group.name,
          groupId: group.id,
          text: groupTrimmedText || undefined,
          mediaUrl: mediaUrl || undefined,
          mediaType: mediaType || 'text',
          duration: duration || undefined,
          // группы в v1.0.29 без пер-пользовательского статуса прочтения — сразу «прочитано»
          read: true,
          replyTo: groupForwardedFrom ? undefined : groupReplyMeta,
          forwardedFrom: groupForwardedFrom,
          timestamp: Date.now(),
        };

        // Та же карта messageHistory с ключом 'group::' + id (кап 200, как у ЛС)
        const gKey = getGroupKey(group.id);
        const gExisting = messageHistory.get(gKey) || [];
        gExisting.push(message);
        if (gExisting.length > 200) gExisting.shift();
        messageHistory.set(gKey, gExisting);

        dbSaveMessage(message, gKey).catch(err => console.error('[Neon DB Save Message Error]', err));

        // Доставка — КАЖДОЙ живой сессии ВСЕХ участников, включая отправителя
        // (эхо во все его окна — ровно как в ЛС)
        emitToGroupMembers(group, 'chat:receive', message);
        return;
      }
      // ─── конец группового пути (ниже — прежний путь ЛС без изменений) ───

      // Поиск получателя: по socket.id или по стабильному имени (в т.ч. офлайн)
      const recipientUser =
        (recipientId && usersBySocketId.get(recipientId)) ||
        Array.from(usersBySocketId.values()).find(
          u => u.username.toLowerCase() === (recipientUsername || '').toLowerCase()
        );
      const offlineName = (recipientUsername || '').trim().slice(0, 24);
      if (!recipientUser && !offlineName) {
        // NEW (v1.0.23) N1: NACK — получателя не опознать ни по сокету, ни по имени
        socket.emit('chat:send_failed', { reason: 'Получатель не найден', preview });
        return;
      }

      const recipientName = recipientUser ? recipientUser.username : offlineName;
      // Нельзя писать самому себе
      if (recipientName.toLowerCase() === sender.username.toLowerCase()) {
        // NEW (v1.0.23) N1: NACK вместо молчаливого игнора
        socket.emit('chat:send_failed', { reason: 'Нельзя отправлять сообщения самому себе', preview });
        return;
      }

      const trimmedText = (text || '').trim();
      if (!trimmedText && !mediaUrl) {
        // NEW (v1.0.23) N1: NACK — пустое сообщение отклонено
        socket.emit('chat:send_failed', { reason: 'Пустое сообщение', preview });
        return;
      }

      // FIX (v1.0.21) A6: серверная валидация размера/длительности — гигантские
      // тексты и «десятиминутные» голосовые не сохраняем и не релеим
      if (
        trimmedText.length > 4000 ||
        (typeof duration === 'number' && (duration < 0 || duration > 600))
      ) {
        console.warn(`[Chat Security] Сообщение от ${sender.username} отклонено: text=${trimmedText.length} симв., duration=${duration}`);
        // NEW (v1.0.23) N1: NACK — валидационный отказ теперь виден отправителю
        socket.emit('chat:send_failed', {
          reason: trimmedText.length > 4000
            ? 'Текст слишком длинный (максимум 4000 символов)'
            : 'Недопустимая длительность голосового (максимум 10 минут)',
          preview,
        });
        return; // без эха и без сохранения
      }

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
      // Echo back to sender (всегда — и для офлайн-отправки)
      // NEW (v1.0.27) MS: доставка и эхо — ВСЕМ живым сессиям ОБЕИХ сторон
      // (все окна получателя получают сообщение; все ОСТАЛЬНЫЕ окна отправителя
      // синхронизируются — отправляющее окно тоже получает эхо через этот же
      // роутинг, ровно один раз). Офлайн-получатель — no-op, история сохранена
      // выше; мёртвые сокеты emitToUser вычищает сам.
      emitToUser(recipientName, 'chat:receive', message);
      emitToUser(sender.username, 'chat:receive', message);
    }
  );

  // v1.0.11: удаление своего сообщения (мягкое — остаётся «Сообщение удалено»)
  // NEW (v1.0.29) GC: опциональный groupId — при наличии работает групповой путь
  socket.on('chat:delete', ({ partnerUsername, messageId, groupId }: { partnerUsername?: string; messageId: string; groupId?: string }) => {
    const user = usersBySocketId.get(socket.id);
    if (!user || !messageId) return;

    // ─── NEW (v1.0.29) GC: групповой путь удаления (та же мягкая семантика) ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, user.username)) return; // чужая группа — молча
      const gKey = getGroupKey(group.id);
      const gHistory = messageHistory.get(gKey);
      const gMsg = gHistory?.find(m => m.id === messageId);
      if (!gMsg || gMsg.senderName.toLowerCase() !== user.username.toLowerCase() || gMsg.deleted) {
        socket.emit('chat:delete_failed', {
          messageId,
          message: 'Можно удалять только свои сообщения',
        });
        return;
      }
      gMsg.deleted = true;
      gMsg.text = undefined;
      gMsg.mediaUrl = undefined;
      gMsg.duration = undefined;
      gMsg.replyTo = undefined;
      dbMarkMessageDeleted(gKey, messageId).catch(err => console.error('[Neon DB Delete Message Error]', err));
      console.log(`[Message Deleted] ${user.username} удалил ${messageId} (группа ${group.id})`);
      // всем участникам группы (включая удаляющего — эхо в его другие окна)
      emitToGroupMembers(group, 'chat:message_deleted', { messageId, groupId: group.id, partnerUsername: group.name });
      return;
    }

    if (!partnerUsername) return;

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
    // NEW (v1.0.27) MS: fan-out — ВСЕ сессии действующего пользователя (эхо в его
    // другие окна) + ВСЕ сессии собеседника; каждой стороне — её имя партнёра
    emitToUser(user.username, 'chat:message_deleted', { messageId, partnerUsername });
    emitToUser(partnerUsername, 'chat:message_deleted', { messageId, partnerUsername: user.username });
  });

  // NEW (v1.0.24) E1: редактирование своего отправленного сообщения. Править
  // можно только СВОЙ текст (в т.ч. подпись к фото), не удалённый, в течение
  // EDIT_WINDOW_MS после отправки. Как и chat:send, даём NACK (chat:edit_failed)
  // вместо молчаливого отказа — клиент возвращает текст в поле ввода.
  // NEW (v1.0.29) GC: опциональный groupId — при наличии работает групповой путь
  socket.on('chat:edit', ({ partnerUsername, messageId, text, groupId }: { partnerUsername?: string; messageId: string; text?: string; groupId?: string }) => {
    const user = usersBySocketId.get(socket.id);
    const newText = String(text || '').trim();
    if (!user || !messageId) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Некорректный запрос правки' });
      return;
    }

    // ─── NEW (v1.0.29) GC: групповой путь правки (правила 1:1 с ЛС) ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, user.username)) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Некорректный запрос правки' });
        return;
      }
      const gKey = getGroupKey(group.id);
      const gHistory = messageHistory.get(gKey);
      const gMsg = gHistory?.find(m => m.id === messageId);
      if (!gMsg || gMsg.senderName.toLowerCase() !== user.username.toLowerCase()) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Редактировать можно только свои сообщения' });
        return;
      }
      if (gMsg.deleted) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Сообщение удалено — редактировать нельзя' });
        return;
      }
      const G_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
      if (Date.now() - gMsg.timestamp > G_EDIT_WINDOW_MS) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Время редактирования истекло (48 часов)' });
        return;
      }
      if (!newText) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Текст правки не может быть пустым' });
        return;
      }
      if (newText.length > 4000) {
        socket.emit('chat:edit_failed', { messageId, reason: 'Текст слишком длинный (максимум 4000 символов)' });
        return;
      }
      gMsg.text = newText;
      gMsg.edited = true;
      gMsg.editedAt = Date.now();
      dbEditMessage(gKey, messageId, newText, gMsg.editedAt).catch(err => console.error('[Neon DB Edit Message Error]', err));
      console.log(`[Message Edited] ${user.username} отредактировал ${messageId} (группа ${group.id})`);
      // правка видна во всех окнах ВСЕХ участников группы
      emitToGroupMembers(group, 'chat:message_edited', { messageId, groupId: group.id, partnerUsername: group.name, text: newText, editedAt: gMsg.editedAt });
      return;
    }

    if (!partnerUsername) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Некорректный запрос правки' });
      return;
    }

    const key = getConversationKey(user.username, partnerUsername);
    const history = messageHistory.get(key);
    const msg = history?.find(m => m.id === messageId);

    // проверка владения сообщением
    if (!msg || msg.senderName.toLowerCase() !== user.username.toLowerCase()) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Редактировать можно только свои сообщения' });
      return;
    }
    if (msg.deleted) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Сообщение удалено — редактировать нельзя' });
      return;
    }
    // окно правки: 48 часов с момента отправки
    const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
    if (Date.now() - msg.timestamp > EDIT_WINDOW_MS) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Время редактирования истекло (48 часов)' });
      return;
    }
    // пустой текст и сообщения только с медиа без текста править нельзя
    if (!newText) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Текст правки не может быть пустым' });
      return;
    }
    if (newText.length > 4000) {
      socket.emit('chat:edit_failed', { messageId, reason: 'Текст слишком длинный (максимум 4000 символов)' });
      return;
    }

    // применяем правку в памяти + база (loss-proof очередь на случай «сна» Neon)
    msg.text = newText;
    msg.edited = true;
    msg.editedAt = Date.now();
    // если это была подпись к фото — тип остаётся image, текст просто обновится;
    // если текст исчезать не должен, mediaUrl не трогаем.

    dbEditMessage(key, messageId, newText, msg.editedAt).catch(err => console.error('[Neon DB Edit Message Error]', err));
    console.log(`[Message Edited] ${user.username} отредактировал ${messageId}`);

    // уведомляем отправителя (эхо) и все сокеты собеседника
    // NEW (v1.0.27) MS: fan-out — ВСЕ сессии действующего пользователя + ВСЕ
    // сессии собеседника (правка видна во всех окнах обеих сторон)
    emitToUser(user.username, 'chat:message_edited', { messageId, partnerUsername, text: newText, editedAt: msg.editedAt });
    emitToUser(partnerUsername, 'chat:message_edited', { messageId, partnerUsername: user.username, text: newText, editedAt: msg.editedAt });
  });

  // NEW (v1.0.25) R1: реакции-эмодзи на сообщения. Реагировать можно на ЛЮБОЕ
  // сообщение беседы (и своё, и собеседника). Семантика toggle/перенос: у одного
  // пользователя максимум одна реакция на сообщение — повторный тот же эмодзи
  // снимает её, другой эмодзи переносит. Сервер хранит актуальный слепок
  // msg.reactions в памяти и рассылает его ЦЕЛИКОМ обеим сторонам (эхо автору
  // реакции + все сокеты собеседника) — клиенту не нужно знать дельту.
  // NEW (v1.0.29) GC: опциональный groupId — при наличии работает групповой путь
  socket.on('chat:react', ({ partnerUsername, messageId, emoji, groupId }: { partnerUsername?: string; messageId: string; emoji?: string; groupId?: string }) => {
    const user = usersBySocketId.get(socket.id);
    const normEmoji = String(emoji || '').trim();
    // (для ЛС partnerUsername обязателен — как раньше; групповой путь идёт по groupId)
    if (!user || !messageId || !REACTION_EMOJIS.includes(normEmoji) || (!groupId && !partnerUsername)) {
      socket.emit('chat:react_failed', { messageId, reason: 'Некорректная реакция' });
      return;
    }
    // FIX-паттерн (v1.0.22) S6: рейт-лимит на реакции — 30 за 10 секунд на сокет
    if (isSocketRateLimited('react', socket.id, 30, 10000)) {
      socket.emit('chat:react_failed', { messageId, reason: 'Слишком много реакций — подождите немного' });
      return;
    }

    // ─── NEW (v1.0.29) GC: групповой путь реакции (toggle/перенос — 1:1 с ЛС) ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, user.username)) {
        socket.emit('chat:react_failed', { messageId, reason: 'Сообщение не найдено' });
        return;
      }
      const gKey = getGroupKey(group.id);
      const gHistory = messageHistory.get(gKey);
      const gMsg = gHistory?.find(m => m.id === messageId);
      if (!gMsg || gMsg.deleted) {
        socket.emit('chat:react_failed', { messageId, reason: 'Сообщение не найдено' });
        return;
      }
      const gMeLower = user.username.toLowerCase();
      const gNext: Record<string, string[]> = {};
      let gRemovedSame = false;
      for (const [e, users] of Object.entries(gMsg.reactions || {})) {
        const filtered = (users || []).filter(u => u.toLowerCase() !== gMeLower);
        if (filtered.length !== (users || []).length && e === normEmoji) gRemovedSame = true;
        if (filtered.length > 0) gNext[e] = filtered;
      }
      if (!gRemovedSame) {
        gNext[normEmoji] = [...(gNext[normEmoji] || []), user.username];
      }
      gMsg.reactions = gNext;
      dbSetReactions(gKey, messageId, gNext).catch(err => console.error('[Neon DB Reaction Error]', err));
      console.log(`💜 [Reaction] ${user.username} ${gRemovedSame ? 'снял(а)' : 'поставил(а)'} ${normEmoji} на ${messageId} (группа ${group.id})`);
      // слепок реакций — всем участникам группы (включая окно автора реакции)
      emitToGroupMembers(group, 'chat:reaction_updated', { messageId, groupId: group.id, partnerUsername: group.name, reactions: gNext });
      return;
    }

    const key = getConversationKey(user.username, partnerUsername!);
    const history = messageHistory.get(key);
    const msg = history?.find(m => m.id === messageId);
    if (!msg || msg.deleted) {
      socket.emit('chat:react_failed', { messageId, reason: 'Сообщение не найдено' });
      return;
    }

    // строим новый слепок: убираем свою прошлую реакцию (с любого эмодзи),
    // затем (если эмодзи не совпал со старым) ставим новую
    const meLower = user.username.toLowerCase();
    const next: Record<string, string[]> = {};
    let removedSame = false;
    for (const [e, users] of Object.entries(msg.reactions || {})) {
      const filtered = (users || []).filter(u => u.toLowerCase() !== meLower);
      if (filtered.length !== (users || []).length && e === normEmoji) removedSame = true;
      if (filtered.length > 0) next[e] = filtered;
    }
    if (!removedSame) {
      next[normEmoji] = [...(next[normEmoji] || []), user.username];
    }

    msg.reactions = next; // память (кольцевой буфер истории)
    dbSetReactions(key, messageId, next).catch(err => console.error('[Neon DB Reaction Error]', err));
    console.log(`💜 [Reaction] ${user.username} ${removedSame ? 'снял(а)' : 'поставил(а)'} ${normEmoji} на ${messageId}`);

    // эхо автору реакции + все сокеты собеседника (как у chat:message_edited)
    // NEW (v1.0.27) MS: fan-out — ВСЕ сессии действующего пользователя + ВСЕ
    // сессии собеседника (реакция видна во всех окнах обеих сторон)
    // (partnerUsername для ЛС-пути гарантирован guard'ом выше)
    emitToUser(user.username, 'chat:reaction_updated', { messageId, partnerUsername, reactions: next });
    emitToUser(partnerUsername!, 'chat:reaction_updated', { messageId, partnerUsername: user.username, reactions: next });
  });

  // 3.5 Typing indicator — relay only, без состояния на сервере
  // NEW (v1.0.29) GC: опциональный groupId — групповой индикатор «печатает…»
  // (chat:typing_group) уходит всем участникам, КРОМЕ печатающего
  socket.on('chat:typing', ({ recipientId, isTyping, groupId }: { recipientId?: string; isTyping: boolean; groupId?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;

    // ─── NEW (v1.0.29) GC: групповой путь индикатора печати ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, sender.username)) return;
      if (isTyping && isSocketRateLimited('typing', socket.id, 120, 10000)) return;
      emitToGroupMembers(
        group,
        'chat:typing_group',
        { groupId: group.id, fromName: sender.username, isTyping: Boolean(isTyping) },
        sender.username // самому себе индикатор не показываем
      );
      return;
    }

    // FIX (v1.0.22) S6: релеим только существующему сокету и с рейт-лимитом «старт»-
    // событий (120/10с) — раньше произвольный клиент мог спамить индикатор
    // «печатает…» любому recipientId. Стоп-события (isTyping=false) пропускаем
    // всегда — иначе «залипший» индикатор невозможно погасить.
    // NEW (v1.0.27) MS: клиент шлёт только recipientId (id «первичного» сокета из
    // снапшота присутствия) — резолвим имя и релеим ВСЕМ его живым сессиям
    // (протухший id → имени нет → no-op, как раньше).
    const targetName = usersBySocketId.get(recipientId || '')?.username;
    if (!recipientId || !targetName) return;
    if (isTyping && isSocketRateLimited('typing', socket.id, 120, 10000)) return;
    emitToUser(targetName, 'chat:typing', {
      fromName: sender.username,
      isTyping: Boolean(isTyping),
    });
  });

  // 3.6 Read receipts: получатель подтверждает прочтение
  // NEW (v1.0.29) GC: опциональный groupId — групповой путь.
  // NEW (v1.0.30) GR: пер-пользовательские статусы прочтения группы —
  // readState[каноническое имя] = время (ms), до которого участник дочитал
  // беседу. Поле уезжает клиентам внутри самого объекта группы (groups:list,
  // group:updated, create_result, history_loaded…), а живое обновление —
  // событием group:read_update ВСЕМ участникам (включая читателя — его
  // другие окна). Групповые сообщения по-прежнему создаются с read: true.
  socket.on('chat:read', ({ partnerUsername, groupId }: { partnerUsername?: string; groupId?: string }) => {
    const reader = usersBySocketId.get(socket.id);
    if (!reader) return;
    if (groupId) {
      const group = groupsById.get(String(groupId));
      // не участник / нет группы — молча игнорируем (как chat:send)
      if (!group || !isGroupMember(group, reader.username)) return;
      // каноническое имя участника (регистр из members)
      const canonical = group.members.find(m => m.toLowerCase() === reader.username.trim().toLowerCase());
      if (!canonical) return;

      const now = Date.now();
      const prev = group.readState?.[canonical];
      if (!group.readState) group.readState = {};
      // NEW (v1.0.30) GR: анти-спам при «дёрганом» фокусе окна — значение
      // обновляем ВСЕГДА, а рассылаем group:read_update только когда прочтение
      // РЕАЛЬНО меняет картину: статуса ещё не было ЛИБО между прошлым
      // статусом и этим подтверждением появились ЧУЖИЕ живые сообщения
      // (prev < timestamp <= now). Повторные read без новых сообщений
      // (рефокус окна) молчат — шторма рассылок нет, состояние у всех
      // актуально; его «догонит» следующий содержательный read или любой
      // group:updated с полным объектом группы.
      let crossing = false;
      const myKey = canonical.toLowerCase();
      const gHist = messageHistory.get(getGroupKey(group.id));
      if (gHist) {
        for (const m of gHist) {
          if (m.deleted) continue; // удалённые ничего не «переводят» в прочитанные
          if (m.senderName.toLowerCase() === myKey) continue; // свои не в счёт
          if ((typeof prev !== 'number' || prev < m.timestamp) && m.timestamp <= now) {
            crossing = true;
            break;
          }
        }
      }
      const shouldBroadcast = typeof prev !== 'number' || crossing;
      group.readState[canonical] = now;
      saveGroupsToDisk(Array.from(groupsById.values()));
      if (shouldBroadcast) {
        console.log(`[Group Read] ${canonical} дочитал «${group.name}» (${group.id})`);
        emitToGroupMembers(group, 'group:read_update', {
          groupId: group.id,
          username: canonical,
          readAt: now,
        });
      }
      return;
    }
    if (!partnerUsername) return;

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

    // FIX (v1.0.21) B5: «прочитано» сохраняем и в базе — раньше статус прочтения
    // жил только в памяти и слетал после перезагрузки страницы. Вызов
    // fire-and-forget: даже если база спит, память+ACK уже отработали.
    dbMarkConversationRead(key, partnerUsername).catch(() => { /* не критично */ });

    // уведомляем все сокеты собеседника — его ✓ станут ✓✓
    // NEW (v1.0.27) MS: квитанция о прочтении — ВСЕМ сессиям собеседника
    // (каждое его окно превратит ✓ в ✓✓); partnerName — канонический регистр
    emitToUser(partnerUsername, 'chat:read_ack', {
      readerName: reader.username,
      partnerName: getCanonicalUsername(partnerUsername),
    });
  });

  // ══════════════════════════════════════════════════════════════
  // ─── NEW (v1.0.29) GC: ГРУППОВЫЕ ЧАТЫ — обработчики ───
  // Состав групп персистится в server/data/groups.json (db.ts), история
  // сообщений — в общем messageHistory с ключом 'group::' + groupId
  // (+ Neon, если настроен). Все события группы доставляются каждой
  // живой сессии каждого участника (emitToGroupMembers поверх emitToUser).
  // ══════════════════════════════════════════════════════════════

  // GC-1. Создание группы: валидация названия/участников → группа → файл
  socket.on('group:create', ({ name, memberUsernames }: { name?: string; memberUsernames?: string[] }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;

    // название: трим, 1..40 символов
    const groupName = String(name || '').trim();
    if (groupName.length < 1 || groupName.length > 40) {
      socket.emit('group:create_result', { ok: false, error: 'Название группы: от 1 до 40 символов' });
      return;
    }

    // участники: трим/слайс 24/дедуп (в т.ч. с создателем); незарегистрированные разрешены
    const wanted = sanitizeMemberUsernames(memberUsernames).filter(
      m => m.toLowerCase() !== sender.username.toLowerCase() // создатель добавляется отдельно
    );
    // кап: всего участников (ВКЛЮЧАЯ создателя) ≤ 21
    if (1 + wanted.length > 21) {
      socket.emit('group:create_result', { ok: false, error: 'В группе не может быть больше 20 участников' });
      return;
    }
    // лимит групп на создателя
    let ownGroups = 0;
    for (const g of groupsById.values()) {
      if (g.createdBy.toLowerCase() === sender.username.toLowerCase()) ownGroups++;
    }
    if (ownGroups >= 50) {
      socket.emit('group:create_result', { ok: false, error: 'Слишком много групп (лимит 50)' });
      return;
    }

    // NEW (v1.0.30) GR: ВСЕ участники начинают «дочитавшими» — создатель и
    // приглашённые сразу при создании (та же семантика, что у group:invite:
    // беседы «до моего появления» для участника не существует)
    const initReadAt = Date.now();
    const initReadState: Record<string, number> = { [sender.username]: initReadAt };
    for (const m of wanted) initReadState[m] = initReadAt;

    const group: GroupInfo = {
      id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
      name: groupName,
      createdBy: sender.username,
      members: [sender.username, ...wanted],
      createdAt: Date.now(),
      readState: initReadState,
    };
    groupsById.set(group.id, group);
    saveGroupsToDisk(Array.from(groupsById.values()));
    console.log(`[Group] Created «${group.name}» by ${sender.username} (${group.id}, ${group.members.length} участников)`);

    // ack создателю, затем обновление ВСЕМ участникам (включая его — клиент
    // терпим к дублю и просто обновляет свой список из group:updated)
    socket.emit('group:create_result', { ok: true, group });
    emitToGroupMembers(group, 'group:updated', { group });
  });

  // GC-2. Приглашение участников: только участник группы; дедуп с текущим составом
  socket.on('group:invite', ({ groupId, memberUsernames }: { groupId?: string; memberUsernames?: string[] }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    const group = groupsById.get(String(groupId || ''));
    if (!group || !isGroupMember(group, sender.username)) {
      socket.emit('group:invite_result', { ok: false, error: 'Вы не участник этой группы' });
      return;
    }

    const requested = sanitizeMemberUsernames(memberUsernames);
    if (requested.length === 0) {
      socket.emit('group:invite_result', { ok: false, error: 'Не указаны участники для приглашения' });
      return;
    }
    // дедуп против уже существующих участников (и между собой)
    const existing = new Set(group.members.map(m => m.toLowerCase()));
    const fresh: string[] = [];
    for (const m of requested) {
      const key = m.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      fresh.push(m);
    }
    if (fresh.length === 0) {
      socket.emit('group:invite_result', { ok: false, error: 'Все перечисленные уже в группе' });
      return;
    }
    // кап: всего участников ≤ 21
    if (group.members.length + fresh.length > 21) {
      socket.emit('group:invite_result', { ok: false, error: 'В группе не может быть больше 20 участников' });
      return;
    }

    group.members.push(...fresh);
    // NEW (v1.0.30) GR: приглашённые начинают «дочитавшими» — документированная
    // семантика: пока их не было, беседа для них не существовала (не «висит»
    // чужая непрочитанность на новом участнике)
    if (!group.readState) group.readState = {};
    for (const m of fresh) group.readState[m] = Date.now();
    saveGroupsToDisk(Array.from(groupsById.values()));
    console.log(`[Group] Invite «${group.name}»: ${sender.username} добавил ${fresh.length} участн. (${group.id}, всего ${group.members.length})`);

    socket.emit('group:invite_result', { ok: true });
    // обновление ВСЕМ участникам (старым и новым — новые уже участники)
    emitToGroupMembers(group, 'group:updated', { group });
  });

  // GC-3. Выход из группы; ушёл последний — группа удаляется целиком
  socket.on('group:leave', ({ groupId }: { groupId?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    const group = groupsById.get(String(groupId || ''));
    if (!group || !isGroupMember(group, sender.username)) {
      socket.emit('group:leave_result', { ok: false, error: 'Вы не участник этой группы' });
      return;
    }

    group.members = group.members.filter(m => m.toLowerCase() !== sender.username.toLowerCase());
    // NEW (v1.0.30) GR: статус прочтения ушедшего больше не нужен (и не должен
    // попадать в файл/объекты группы — состав и readState согласованы)
    if (group.readState) {
      for (const key of Object.keys(group.readState)) {
        if (key.toLowerCase() === sender.username.toLowerCase()) delete group.readState[key];
      }
    }
    console.log(`[Group] Leave «${group.name}»: ${sender.username} (${group.id}, осталось ${group.members.length})`);

    if (group.members.length === 0) {
      // ушли все — группу удаляем; оповещать больше некого, кроме ушедшего
      groupsById.delete(group.id);
      saveGroupsToDisk(Array.from(groupsById.values()));
      socket.emit('group:leave_result', { ok: true });
      emitToUser(sender.username, 'group:deleted', { groupId: group.id });
      return;
    }

    saveGroupsToDisk(Array.from(groupsById.values()));
    socket.emit('group:leave_result', { ok: true });
    // оставшимся — обновлённый состав; ушедшему (его другим окнам) — удаление
    emitToGroupMembers(group, 'group:updated', { group });
    emitToUser(sender.username, 'group:deleted', { groupId: group.id });
  });

  // GC-4. Переименование: только создатель группы
  socket.on('group:rename', ({ groupId, name }: { groupId?: string; name?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    const group = groupsById.get(String(groupId || ''));
    if (!group || !isGroupMember(group, sender.username)) {
      socket.emit('group:rename_result', { ok: false, error: 'Вы не участник этой группы' });
      return;
    }
    if (group.createdBy.toLowerCase() !== sender.username.toLowerCase()) {
      socket.emit('group:rename_result', { ok: false, error: 'Переименовать группу может только её создатель' });
      return;
    }
    const newName = String(name || '').trim();
    if (newName.length < 1 || newName.length > 40) {
      socket.emit('group:rename_result', { ok: false, error: 'Название группы: от 1 до 40 символов' });
      return;
    }

    const prevName = group.name;
    group.name = newName;
    saveGroupsToDisk(Array.from(groupsById.values()));
    console.log(`[Group] Rename «${prevName}» → «${newName}» by ${sender.username} (${group.id})`);

    socket.emit('group:rename_result', { ok: true });
    emitToGroupMembers(group, 'group:updated', { group });
  });

  // GC-4k. NEW (v1.0.30) GR: ИСКЛЮЧЕНИЕ участника из группы — админ-действие,
  // доступное ТОЛЬКО создателю (как переименование). Исключённому (всем его
  // живым сессиям) уходит group:kicked, кикнувшему — group:kick_result,
  // оставшимся — group:updated с новым составом.
  socket.on('group:kick', ({ groupId, username }: { groupId?: string; username?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    const group = groupsById.get(String(groupId || ''));
    if (!group || !isGroupMember(group, sender.username)) {
      socket.emit('group:kick_result', { ok: false, error: 'Вы не участник этой группы' });
      return;
    }
    if (group.createdBy.toLowerCase() !== sender.username.toLowerCase()) {
      socket.emit('group:kick_result', { ok: false, error: 'Исключать участников может только создатель группы' });
      return;
    }
    // валидация имени: строка 1..24 после трима
    const targetName = String(username || '').trim().slice(0, 24);
    if (targetName.length < 1) {
      socket.emit('group:kick_result', { ok: false, error: 'Некорректное имя участника' });
      return;
    }
    if (targetName.toLowerCase() === sender.username.toLowerCase()) {
      socket.emit('group:kick_result', { ok: false, error: 'Себя удалить нельзя — выйдите из группы' });
      return;
    }
    // создателя исключить нельзя (ветка фактически недостижима: кикнуть может
    // только он сам, а «себя» мы уже отсекли — оставляем как страховку)
    if (targetName.toLowerCase() === group.createdBy.toLowerCase()) {
      socket.emit('group:kick_result', { ok: false, error: 'Создателя группы исключить нельзя' });
      return;
    }
    // каноническое имя жертвы (регистр из members)
    const kicked = group.members.find(m => m.toLowerCase() === targetName.toLowerCase());
    if (!kicked) {
      socket.emit('group:kick_result', { ok: false, error: 'Этого пользователя нет в группе' });
      return;
    }

    group.members = group.members.filter(m => m.toLowerCase() !== kicked.toLowerCase());
    // NEW (v1.0.30) GR: статус прочтения исключённого чистим (как при выходе)
    if (group.readState) {
      for (const key of Object.keys(group.readState)) {
        if (key.toLowerCase() === kicked.toLowerCase()) delete group.readState[key];
      }
    }
    console.log(`[Group] Kick «${group.name}»: ${sender.username} исключил ${kicked} (${group.id}, осталось ${group.members.length})`);

    // группа опустела (недостижимо: создатель остаётся) — та же обработка, что
    // при выходе последнего: группу удаляем, исключённому — group:deleted
    if (group.members.length === 0) {
      groupsById.delete(group.id);
      saveGroupsToDisk(Array.from(groupsById.values()));
      socket.emit('group:kick_result', { ok: true, username: kicked });
      emitToUser(kicked, 'group:kicked', { groupId: group.id, groupName: group.name, kickedBy: sender.username });
      emitToUser(kicked, 'group:deleted', { groupId: group.id });
      return;
    }

    saveGroupsToDisk(Array.from(groupsById.values()));
    socket.emit('group:kick_result', { ok: true, username: kicked });
    // исключённому (ВСЕ его сессии) — уведомление с именем группы и кикнувшим
    emitToUser(kicked, 'group:kicked', { groupId: group.id, groupName: group.name, kickedBy: sender.username });
    // оставшимся — обновлённый состав (кикнувший тоже получит — клиент
    // толерантен к upsert, ровно как в group:invite/leave)
    emitToGroupMembers(group, 'group:updated', { group });
  });

  // GC-5. Список групп пользователя (по запросу; также рассылается при регистрации)
  socket.on('groups:list', () => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    socket.emit('groups:list_result', { groups: groupsOfUser(sender.username) });
  });

  // GC-6. История групповой беседы: тот же db-wait, что у chat:history
  // (loadHistoryForKey); не участнику — молча пустой список
  socket.on('group:history', async ({ groupId }: { groupId?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    const gid = String(groupId || '');
    const group = groupsById.get(gid);
    if (!group || !isGroupMember(group, sender.username)) {
      socket.emit('group:history_loaded', { groupId: gid, messages: [] });
      return;
    }
    const history = await loadHistoryForKey(getGroupKey(gid));
    socket.emit('group:history_loaded', { groupId: gid, messages: history });
  });

  // ─── NEW (v1.0.27) AI: умные функции на LLM (z-ai-web-dev-sdk) ───
  // Результат всех обработчиков уходит ТОЛЬКО запрашивающему сокету.

  // 3.7a. Умные подсказки ответа: последние 8 сообщений беседы → короткие
  // варианты ответа от лица пользователя (NEW v1.0.28: число 1..3 от клиента, по умолчанию 3).
  socket.on('ai:suggest_replies', async ({ partnerUsername, count, groupId }: { partnerUsername?: string; count?: number; groupId?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;

    // ─── NEW (v1.0.29) GC: групповой путь подсказок (последние 8 сообщений
    // группы; «собеседник» в промпте — название группы) ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, sender.username)) {
        socket.emit('ai:suggest_replies_result', {
          partnerUsername: '',
          groupId: String(groupId),
          suggestions: [],
          error: 'Некорректный запрос подсказок',
        });
        return;
      }
      const gWantCount = Math.min(3, Math.max(1, Math.round(Number(count) || 3)));
      const gGuardKey = `suggest:${socket.id}:g:${group.id}`;
      if (aiInflight.has(gGuardKey)) return;
      aiInflight.set(gGuardKey, true);
      try {
        const history = messageHistory.get(getGroupKey(group.id)) || [];
        const lastMessages = history.slice(-8);
        if (lastMessages.length === 0) {
          socket.emit('ai:suggest_replies_result', {
            partnerUsername: group.name,
            groupId: group.id,
            suggestions: [],
            error: 'В переписке ещё нет сообщений для подсказок',
          });
          return;
        }
        const transcript = lastMessages.map(m => messageToTranscriptLine(m)).join('\n');
        const countWord = gWantCount === 1 ? 'один короткий вариант ответа' : gWantCount === 2 ? 'два коротких варианта ответа' : 'три коротких варианта ответа';
        const systemPrompt =
          'Ты — помощник в мессенджере. Пользователь переписывается с собеседником и хочет быстро ответить. ' +
          'Опираясь на последние сообщения диалога, предложи ровно ' + countWord + ' ОТ ЛИЦА ПОЛЬЗОВАТЕЛЯ. ' +
          'Требования: каждый вариант — одна фраза до 70 символов; естественный разговорный тон; язык — тот же, ' +
          'на котором идёт диалог; отвечай только ' + (gWantCount === 1 ? 'одной строкой' : gWantCount + ' строками') + ', без нумерации, кавычек, эмодзи и пояснений.';
        const userPrompt = `Диалог:\n${transcript}\n\nПользователь: ${sender.username}, собеседник: ${group.name}.\nТри варианта ответа для ${sender.username}:`;

        const zai = await getZai();
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            thinking: { type: 'disabled' },
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout 30s')), 30000)),
        ]);
        const raw: string = completion?.choices?.[0]?.message?.content || '';
        // парсинг: тот же конвейер, что у ЛС (чистка маркеров/кавычек/эмодзи, 1..120)
        const suggestions = String(raw || '')
          .split(/\r?\n/)
          .map(line =>
            line
              .trim()
              .replace(/^\d+[.)\]]\s*/, '')
              .replace(/^[-–—•*#>]+/, '')
              .trim()
              .replace(/^["'«»“”]+/, '')
              .replace(/["'«»“”]+$/, '')
              .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
              .trim()
          )
          .filter(line => line.length >= 1 && line.length <= 120)
          .slice(0, gWantCount);
        if (suggestions.length < 1) {
          socket.emit('ai:suggest_replies_result', {
            partnerUsername: group.name,
            groupId: group.id,
            suggestions: [],
            error: 'Не удалось подобрать варианты ответа',
          });
          return;
        }
        socket.emit('ai:suggest_replies_result', {
          partnerUsername: group.name,
          groupId: group.id,
          suggestions,
          error: undefined,
        });
      } catch (err) {
        console.error('[AI] suggest_replies (group) failed:', err);
        socket.emit('ai:suggest_replies_result', {
          partnerUsername: group.name,
          groupId: group.id,
          suggestions: [],
          error: 'AI-сервис недоступен, попробуйте позже',
        });
      } finally {
        aiInflight.delete(gGuardKey);
      }
      return;
    }

    // валидация: партнёр — строка 1..24, не своё имя
    const partner = String(partnerUsername || '').trim().slice(0, 24);
    if (!partner || partner.toLowerCase() === sender.username.toLowerCase()) {
      socket.emit('ai:suggest_replies_result', {
        partnerUsername: partner,
        suggestions: [],
        error: 'Некорректный запрос подсказок',
      });
      return;
    }
    // NEW (v1.0.28) AI: опциональное число подсказок от клиента — кламп 1..3 (по умолчанию 3, NaN-безопасно)
    const wantCount = Math.min(3, Math.max(1, Math.round(Number(count) || 3)));
    // in-flight guard: тот же сокет уже ждёт подсказки по этому партнёру — игнор
    const guardKey = `suggest:${socket.id}:${partner.toLowerCase()}`;
    if (aiInflight.has(guardKey)) return;
    aiInflight.set(guardKey, true);
    try {
      const history = messageHistory.get(getConversationKey(sender.username, partner)) || [];
      const lastMessages = history.slice(-8);
      // канонический регистр имени партнёра (как в истории/онлайне), иначе — как прислал клиент
      const display = getCanonicalUsername(partner);
      if (lastMessages.length === 0) {
        socket.emit('ai:suggest_replies_result', {
          partnerUsername: display,
          suggestions: [],
          error: 'В переписке ещё нет сообщений для подсказок',
        });
        return;
      }
      const transcript = lastMessages.map(m => messageToTranscriptLine(m)).join('\n');
      // NEW (v1.0.28) AI: число вариантов — от клиента (1..3); естественная форма числа для промпта
      const countWord = wantCount === 1 ? 'один короткий вариант ответа' : wantCount === 2 ? 'два коротких варианта ответа' : 'три коротких варианта ответа';
      const systemPrompt =
        'Ты — помощник в мессенджере. Пользователь переписывается с собеседником и хочет быстро ответить. ' +
        'Опираясь на последние сообщения диалога, предложи ровно ' + countWord + ' ОТ ЛИЦА ПОЛЬЗОВАТЕЛЯ. ' +
        'Требования: каждый вариант — одна фраза до 70 символов; естественный разговорный тон; язык — тот же, ' +
        'на котором идёт диалог; отвечай только ' + (wantCount === 1 ? 'одной строкой' : wantCount + ' строками') + ', без нумерации, кавычек, эмодзи и пояснений.';
      const userPrompt = `Диалог:\n${transcript}\n\nПользователь: ${sender.username}, собеседник: ${display}.\nТри варианта ответа для ${sender.username}:`;

      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({
          messages: [
            { role: 'assistant', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout 30s')), 30000)),
      ]);
      const raw: string = completion?.choices?.[0]?.message?.content || '';
      // парсинг: строки → чистка маркеров/нумерации/кавычек/эмодзи → 1..120 симв. → первые wantCount
      const suggestions = String(raw || '')
        .split(/\r?\n/)
        .map(line =>
          line
            .trim()
            .replace(/^\d+[.)\]]\s*/, '') // нумерация «1.» / «1)» / «1]»
            .replace(/^[-–—•*#>]+/, '') // маркеры списков / цитаты
            .trim()
            .replace(/^["'«»“”]+/, '') // кавычки в начале
            .replace(/["'«»“”]+$/, '') // кавычки в конце
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '') // эмодзи
            .trim()
        )
        .filter(line => line.length >= 1 && line.length <= 120)
        .slice(0, wantCount);
      if (suggestions.length < 1) {
        socket.emit('ai:suggest_replies_result', {
          partnerUsername: display,
          suggestions: [],
          error: 'Не удалось подобрать варианты ответа',
        });
        return;
      }
      socket.emit('ai:suggest_replies_result', {
        partnerUsername: display,
        suggestions,
        error: undefined,
      });
    } catch (err) {
      console.error('[AI] suggest_replies failed:', err);
      socket.emit('ai:suggest_replies_result', {
        partnerUsername: getCanonicalUsername(String(partnerUsername || '').trim()),
        suggestions: [],
        error: 'AI-сервис недоступен, попробуйте позже',
      });
    } finally {
      aiInflight.delete(guardKey);
    }
  });

  // 3.7b. Сводка переписки: последние 50 сообщений → короткая выжимка тем,
  // договорённостей и открытых вопросов.
  // NEW (v1.0.29) GC: опциональный groupId — сводка групповой беседы
  socket.on('ai:summarize', async ({ partnerUsername, groupId }: { partnerUsername?: string; groupId?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;

    // ─── NEW (v1.0.29) GC: групповой путь сводки (последние 50 сообщений группы) ───
    if (groupId) {
      const group = groupsById.get(String(groupId));
      if (!group || !isGroupMember(group, sender.username)) {
        socket.emit('ai:summary_result', {
          partnerUsername: '',
          groupId: String(groupId),
          summary: '',
          messageCount: 0,
          error: 'Некорректный запрос сводки',
        });
        return;
      }
      const gGuardKey = `summarize:${socket.id}:g:${group.id}`;
      if (aiInflight.has(gGuardKey)) return;
      aiInflight.set(gGuardKey, true);
      try {
        const history = messageHistory.get(getGroupKey(group.id)) || [];
        const lastMessages = history.slice(-50);
        if (lastMessages.length < 2) {
          socket.emit('ai:summary_result', {
            partnerUsername: group.name,
            groupId: group.id,
            summary: '',
            messageCount: 0,
            error: 'Переписки ещё недостаточно для сводки',
          });
          return;
        }
        const transcript = lastMessages.map(m => messageToTranscriptLine(m)).join('\n');
        const systemPrompt =
          'Ты — помощник в мессенджере. Составь краткую сводку переписки двух людей: главные темы, ' +
          'договорённости и открытые вопросы. Формат: 3–6 коротких строк, каждая с новой строки, ' +
          'без markdown-заголовков, без эмодзи. Язык — язык переписки.';
        const userPrompt = `Переписка ${sender.username} и ${group.name}:\n${transcript}\n\nСводка:`;

        const zai = await getZai();
        const completion = await Promise.race([
          zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            thinking: { type: 'disabled' },
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout 30s')), 30000)),
        ]);
        const raw: string = completion?.choices?.[0]?.message?.content || '';
        // санитизация: \r → '', трим; кап 4000 символов
        const summary = String(raw || '').replace(/\r/g, '').trim().slice(0, 4000);
        if (!summary) {
          socket.emit('ai:summary_result', {
            partnerUsername: group.name,
            groupId: group.id,
            summary: '',
            messageCount: 0,
            error: 'Не удалось составить сводку',
          });
          return;
        }
        socket.emit('ai:summary_result', {
          partnerUsername: group.name,
          groupId: group.id,
          summary,
          messageCount: lastMessages.length,
          error: undefined,
        });
      } catch (err) {
        console.error('[AI] summarize (group) failed:', err);
        socket.emit('ai:summary_result', {
          partnerUsername: group.name,
          groupId: group.id,
          summary: '',
          messageCount: 0,
          error: 'AI-сервис недоступен, попробуйте позже',
        });
      } finally {
        aiInflight.delete(gGuardKey);
      }
      return;
    }

    const partner = String(partnerUsername || '').trim().slice(0, 24);
    if (!partner || partner.toLowerCase() === sender.username.toLowerCase()) {
      socket.emit('ai:summary_result', {
        partnerUsername: partner,
        summary: '',
        messageCount: 0,
        error: 'Некорректный запрос сводки',
      });
      return;
    }
    const guardKey = `summarize:${socket.id}:${partner.toLowerCase()}`;
    if (aiInflight.has(guardKey)) return;
    aiInflight.set(guardKey, true);
    try {
      const history = messageHistory.get(getConversationKey(sender.username, partner)) || [];
      const lastMessages = history.slice(-50);
      const display = getCanonicalUsername(partner);
      if (lastMessages.length < 2) {
        socket.emit('ai:summary_result', {
          partnerUsername: display,
          summary: '',
          messageCount: 0,
          error: 'Переписки ещё недостаточно для сводки',
        });
        return;
      }
      const transcript = lastMessages.map(m => messageToTranscriptLine(m)).join('\n');
      const systemPrompt =
        'Ты — помощник в мессенджере. Составь краткую сводку переписки двух людей: главные темы, ' +
        'договорённости и открытые вопросы. Формат: 3–6 коротких строк, каждая с новой строки, ' +
        'без markdown-заголовков, без эмодзи. Язык — язык переписки.';
      const nameA = sender.username;
      const nameB = display;
      const userPrompt = `Переписка ${nameA} и ${nameB}:\n${transcript}\n\nСводка:`;

      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({
          messages: [
            { role: 'assistant', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout 30s')), 30000)),
      ]);
      const raw: string = completion?.choices?.[0]?.message?.content || '';
      // санитизация: \r → '', трим; кап 4000 символов
      const summary = String(raw || '').replace(/\r/g, '').trim().slice(0, 4000);
      if (!summary) {
        socket.emit('ai:summary_result', {
          partnerUsername: display,
          summary: '',
          messageCount: 0,
          error: 'Не удалось составить сводку',
        });
        return;
      }
      socket.emit('ai:summary_result', {
        partnerUsername: display,
        summary,
        messageCount: lastMessages.length,
        error: undefined,
      });
    } catch (err) {
      console.error('[AI] summarize failed:', err);
      socket.emit('ai:summary_result', {
        partnerUsername: getCanonicalUsername(String(partnerUsername || '').trim()),
        summary: '',
        messageCount: 0,
        error: 'AI-сервис недоступен, попробуйте позже',
      });
    } finally {
      aiInflight.delete(guardKey);
    }
  });

  // 3.7c. NEW (v1.0.28) AI: перевод отдельного сообщения (событие ai:translate_message).
  // Клиент присылает { messageId, text, targetLang }; результат — ТОЛЬКО запрашивающему сокету.
  socket.on('ai:translate_message', async ({ messageId, text, targetLang }: { messageId?: string; text?: string; targetLang?: string }) => {
    const sender = usersBySocketId.get(socket.id);
    if (!sender) return;
    // валидация: id сообщения — строка 1..64
    const mid = String(messageId || '').trim().slice(0, 64);
    if (!mid) {
      socket.emit('ai:translate_result', {
        messageId: mid,
        error: 'Некорректный запрос перевода',
      });
      return;
    }
    // валидация: текст для перевода — 1..2000 символов (без \r)
    const src = String(text || '').replace(/\r/g, '').trim().slice(0, 2000);
    if (!src) {
      socket.emit('ai:translate_result', {
        messageId: mid,
        error: 'Нечего переводить',
      });
      return;
    }
    // целевой язык: allowlist AI_TRANSLATE_LANGS, неизвестный/отсутствующий код → 'ru'
    const langCode = AI_TRANSLATE_LANGS[targetLang as string] ? String(targetLang) : 'ru';
    const langName = AI_TRANSLATE_LANGS[langCode];
    // in-flight guard: тот же сокет уже ждёт перевод этого сообщения — игнор
    const guardKey = `translate:${socket.id}:${mid}`;
    if (aiInflight.has(guardKey)) return;
    aiInflight.set(guardKey, true);
    try {
      // NEW (v1.0.29) GC: промпт теперь просит СТРОГИЙ JSON {"translation": "...",
      // "sourceLang": "..."} — так клиент получает и исходный язык сообщения.
      // Парсинг отказоустойчив: любой сбой → фолбэк «весь ответ = перевод»,
      // sourceLang = undefined (прежнее поведение v1.0.28 не ломается).
      const systemPrompt =
        'Ты — переводчик в мессенджере. Переведи текст пользователя на ' + langName + ' язык. ' +
        'Ответь СТРОГО JSON-объектом вида {"translation": "<готовый перевод>", "sourceLang": "<исходный язык одной строкой на русском, например: английский>"}. ' +
        'В translation — только готовый перевод: без кавычек, без пояснений, без транскрипции. ' +
        'Сохрани тон, эмодзи и форматирование абзацев. Если текст уже на целевом языке — верни его без изменений в translation.';
      const userPrompt = src;

      const zai = await getZai();
      const completion = await Promise.race([
        zai.chat.completions.create({
          messages: [
            { role: 'assistant', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AI timeout 30s')), 30000)),
      ]);
      // санитизация всего ответа: \r → '', трим; кап 2000 символов (фолбэк-значение)
      const sanitized = String(completion?.choices?.[0]?.message?.content || '').replace(/\r/g, '').trim().slice(0, 2000);
      // попытка вытащить JSON: от первой '{' до последней '}'
      let translated = '';
      let sourceLang: string | undefined;
      try {
        const first = sanitized.indexOf('{');
        const last = sanitized.lastIndexOf('}');
        if (first !== -1 && last > first) {
          const parsed = JSON.parse(sanitized.slice(first, last + 1));
          if (parsed && typeof parsed.translation === 'string' && parsed.translation.trim()) {
            translated = parsed.translation.replace(/\r/g, '').trim().slice(0, 2000);
            // исходный язык: только буквы/дефис/пробел (ru/en), ≤24 символов
            let sl = String(parsed.sourceLang ?? '').replace(/\r/g, '').trim().slice(0, 24);
            if (!/^[\p{L}\s-]+$/u.test(sl)) sl = '';
            sourceLang = sl || undefined;
          }
        }
      } catch { /* не JSON — фолбэк ниже */ }
      // любой сбой парсинга/валидации → весь санитизированный ответ и есть перевод
      if (!translated) translated = sanitized;
      if (!translated) {
        socket.emit('ai:translate_result', {
          messageId: mid,
          error: 'Не удалось перевести сообщение',
        });
        return;
      }
      socket.emit('ai:translate_result', {
        messageId: mid,
        translated,
        // NEW (v1.0.29) GC: исходный язык определения перевода (если модель его назвала)
        sourceLang,
        error: undefined,
      });
    } catch (err) {
      console.error('[AI] translate_message failed:', err);
      socket.emit('ai:translate_result', {
        messageId: mid,
        error: 'AI-сервис недоступен, попробуйте позже',
      });
    } finally {
      aiInflight.delete(guardKey);
    }
  });

  // 4. WebRTC Signaling: Initiate Call (Offer)
  socket.on('call:initiate', ({ targetUserId, offer }: { targetUserId: string; offer: any }) => {
    const caller = usersBySocketId.get(socket.id);
    const target = usersBySocketId.get(targetUserId);

    if (!caller) return;
    // NEW (v1.0.27) MS: занятость проверяется на уровне ИМЕНИ (любая из сессий
    // в звонке = имя занято): окно-двойник не начнёт параллельный звонок, а
    // «занятость» сразу видна в присутствии (дедуп-снапшот).
    if (isUsernameInCall(caller.username)) {
      socket.emit('call:failed', { message: 'Вы уже в звонке' });
      return;
    }
    if (!target) {
      socket.emit('call:failed', { message: 'Пользователь не найден или не в сети' });
      return;
    }

    if (isUsernameInCall(target.username)) {
      socket.emit('call:rejected', {
        callerId: socket.id,
        reason: 'Пользователь сейчас занят другим звонком',
      });
      return;
    }

    // FIX: помечаем занятыми ОБЕИХ на стадии гудков — раньше второй звонящий
    // мог дозвониться к тому, кому уже звонят.
    // NEW (v1.0.27) MS: «в звонке» помечаются ВСЕ сессии обоих имён (не только
    // два сокета) — звонок один на имя целиком.
    setInCallWithAllSessions(caller.username, target.username);
    setInCallWithAllSessions(target.username, caller.username);
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
      // NEW (v1.0.27) MS: таймаут гудков — снимаем «в звонке» со ВСЕХ сессий обоих имён
      if (c) setInCallWithAllSessions(c.username, null);
      if (t) setInCallWithAllSessions(t.username, null);
      broadcastUsersList();
      console.log(`[Call Missed] ${c?.username || socket.id} → ${t?.username || targetUserId}`);
      socket.emit('call:failed', { message: 'Абонент не отвечает' });
      // NEW (v1.0.27) MS: «Пропущенный» — во ВСЕ окна цели (звонили ведь всем)
      if (t) emitToUser(t.username, 'call:ended', { fromUserId: socket.id, reason: 'Пропущенный звонок' });
    }, 45000));

    console.log(`[Call Initiate] From ${caller.username} to ${target.username}`);
    // NEW (v1.0.27) MS: звоним ВСЕМ живым сессиям цели (кроме собственных сокетов
    // звонящего — защита от «позвонить себе»). callerId в payload = сокет
    // ЗВОНЯЩЕГО, чтобы ответ (call:accept) маршрутизировался к правильному сокету;
    // кто примет первым — тот и станет участником пары (см. call:accept).
    const callerSessions = socketsByUsername.get(caller.username.toLowerCase());
    for (const sid of Array.from(socketsByUsername.get(target.username.toLowerCase()) || [])) {
      if (!io.sockets.sockets.has(sid)) continue; // мёртвый — пропускаем
      if (callerSessions?.has(sid)) continue; // свой сокет — не звоним
      io.to(sid).emit('call:incoming', {
        callerId: caller.id,
        callerName: caller.username,
        callerAvatar: caller.avatar,
        offer,
      });
    }
  });

  // 5. WebRTC Signaling: Accept Call (Answer)
  socket.on('call:accept', ({ callerId, answer }: { callerId: string; answer: any }) => {
    const receiver = usersBySocketId.get(socket.id);
    const caller = usersBySocketId.get(callerId);

    // FIX (v1.0.21) A5: «принять» может только тот, кому реально звонят (и звонящий
    // должен быть в паре с отвечающим). Раньше произвольный сокет мог «принять»
    // чужой звонок и получить чужой SDP-answer.
    if (
      !receiver ||
      !caller ||
      receiver.inCallWith !== caller.username ||
      caller.inCallWith !== receiver.username
    ) {
      // NEW (v1.0.27) MS: «поздний» accept — звонок уже принят в ДРУГОМ окне того
      // же имени (пара уже установлена с другим сокетом принимающего). Активный
      // звонок НЕ трогаем; опоздавшему окну — понятный call:rejected (клиентского
      // обработчика call:cancelled не существует — используем понятный клиенту
      // call:rejected с причиной, он покажет тост и приберёт UI звонка).
      if (
        receiver &&
        caller &&
        caller.inCallWith === receiver.username &&
        findActiveCallPartner(callerId)
      ) {
        socket.emit('call:rejected', { reason: 'Звонок принят в другом окне' });
        return;
      }
      warnCallBlocked('call:accept', socket.id, callerId);
      return;
    }

    if (receiver && caller) {
      receiver.inCallWith = caller.username;
      caller.inCallWith = receiver.username;
      connectedCalls.add([callerId, socket.id].sort().join('::'));
      broadcastUsersList();
    }

    // NEW (v1.0.27) MS: первый accept выигрывает — гасим звонок в ОСТАЛЬНЫХ
    // окнах принимающего имени (call:ended молча уберёт у них UI входящего;
    // их inCallWith снимаем — участники пары только два сокета) и снимаем
    // «в звонке» с чужих для пары сессий.
    if (receiver) {
      for (const sid of Array.from(socketsByUsername.get(receiver.username.toLowerCase()) || [])) {
        if (sid === socket.id) continue;
        const u = usersBySocketId.get(sid);
        if (!u) continue;
        u.inCallWith = null;
        if (io.sockets.sockets.has(sid)) {
          io.to(sid).emit('call:ended', { fromUserId: callerId, reason: 'Звонок принят в другом окне' });
        }
      }
    }

    // Звонок принят — снимаем таймер гудков звонящего
    const timer = ringTimers.get(callerId);
    if (timer) { clearTimeout(timer); ringTimers.delete(callerId); }

    console.log(`[Call Accepted] by ${receiver?.username} from ${caller?.username}`);
    // targetUserId = сокет ПРИНЯВШЕГО — сигналинг/relay пойдут ровно в него
    socket.to(callerId).emit('call:accepted', {
      targetUserId: socket.id,
      answer,
    });
  });

  // 6. WebRTC Signaling: Reject Call
  socket.on('call:reject', ({ callerId, reason }: { callerId: string; reason?: string }) => {
    // FIX (v1.0.22) S2: отклонить звонок может только ЕГО адресат — раньше
    // произвольный сокет мог разорвать ЧУЖОЙ звонок (самолечением был лишь
    // 45-с таймер гудков). Обе стороны помечаются inCallWith уже на
    // call:initiate, поэтому проверка пары валидна и на стадии гудков.
    const receiver = usersBySocketId.get(socket.id);
    const caller = usersBySocketId.get(callerId);
    if (
      !receiver ||
      !caller ||
      receiver.inCallWith !== caller.username ||
      caller.inCallWith !== receiver.username
    ) {
      warnCallBlocked('call:reject', socket.id, callerId);
      return;
    }

    caller.inCallWith = null;
    receiver.inCallWith = null;
    // NEW (v1.0.27) MS: отклонение в ОДНОМ окне отменяет звонок ЦЕЛИКОМ:
    // «в звонке» снимаем со ВСЕХ сессий обоих имён. (Клиентский авто-отказ
    // «Занят» при этом на сервере недостижим: у занятого имени initiate не
    // прошёл бы вовсе — см. isUsernameInCall.)
    setInCallWithAllSessions(caller.username, null);
    setInCallWithAllSessions(receiver.username, null);
    broadcastUsersList();

    // Чистим состояние звонка
    const timer = ringTimers.get(callerId);
    if (timer) { clearTimeout(timer); ringTimers.delete(callerId); }
    connectedCalls.delete([callerId, socket.id].sort().join('::'));

    console.log(`[Call Rejected] callerId: ${callerId}, reason: ${reason}`);
    socket.to(callerId).emit('call:rejected', {
      reason: reason || 'Звонок отклонен пользователем',
    });
    // NEW (v1.0.27) MS: остальные окна отклонившего имени тоже перестают звонить
    for (const sid of Array.from(socketsByUsername.get(receiver.username.toLowerCase()) || [])) {
      if (sid === socket.id || !io.sockets.sockets.has(sid)) continue;
      io.to(sid).emit('call:ended', { fromUserId: callerId, reason: 'Звонок отклонен' });
    }
  });

  // 7. WebRTC Signaling: ICE Candidate Exchange
  socket.on('call:ice_candidate', ({ targetUserId, candidate }: { targetUserId: string; candidate: any }) => {
    // FIX (v1.0.21) A4: релей ICE-кандидатов только внутри пары активного звонка
    // (раньше принимали произвольный targetUserId — спуфинг сигналинга).
    // NEW (v1.0.27) MS: два режима роутинга:
    // 1) установленный звонок — СТРОГО активной паре сокетов: клиент звонящего
    //    шлёт targetUserId «первичного» сокета из снапшота присутствия, а принял
    //    звонок, возможно, ДРУГОЙ сокет — ПЕРЕНАПРАВЛЯЕМ на фактического
    //    участника пары (иначе кандидаты ушли бы «не в то окно»);
    // 2) стадия гудков (trickle-ICE до accept) — ВСЕМ сессиям имени цели:
    //    принимающий сокет дренирует очередь кандидатов, остальные окна
    //    безвредно их копят. inCallWith звонящего = имя цели — взаимность
    //    гарантирует setInCallWithAllSessions на call:initiate.
    const activePartner = findActiveCallPartner(socket.id);
    if (activePartner) {
      io.to(activePartner).emit('call:ice_candidate', {
        fromUserId: socket.id,
        candidate,
      });
      return;
    }
    const sender = usersBySocketId.get(socket.id);
    if (
      sender?.inCallWith &&
      sender.inCallWith.toLowerCase() !== sender.username.toLowerCase()
    ) {
      emitToUser(sender.inCallWith, 'call:ice_candidate', {
        fromUserId: socket.id,
        candidate,
      });
      return;
    }
    warnCallBlocked('call:ice_candidate', socket.id, targetUserId);
  });

  // 7.5 Audio Relay: forward raw audio data between call partners (fallback for when WebRTC P2P fails)
  socket.on('audio:data', ({ targetUserId, audio }: { targetUserId: string; audio: ArrayBuffer | Buffer | string }) => {
    // FIX (v1.0.21) A4: релей аудио только внутри пары активного звонка
    // (раньше принимали произвольный targetUserId — чужую аудио-стриму мог слушать кто угодно).
    // NEW (v1.0.27) MS: relay-аудио — СТРОГО установленной паре сокетов
    // (findActiveCallPartner): клиент звонящего шлёт targetUserId исходного
    // «первичного» сокета — перенаправляем на фактического собеседника пары,
    // если звонок приняли в другом окне. Клиент шлёт audio:data только после
    // принятия звонка (relay-фолбэк), поэтому стадии гудков тут не бывает.
    const partner = findActiveCallPartner(socket.id);
    if (!partner) {
      warnCallBlocked('audio:data', socket.id, targetUserId);
      return;
    }
    io.to(partner).emit('audio:data', {
      fromUserId: socket.id,
      audio,
    });
  });

  // 8. End active call
  socket.on('call:end', ({ targetUserId }: { targetUserId: string }) => {
    // FIX (v1.0.21) A4: завершить звонок может только участник пары (проверка
    // ДО очистки состояния — иначе произвольный сокет мог «разъединить» чужую пару)
    if (!isCallPair(socket.id, targetUserId)) {
      warnCallBlocked('call:end', socket.id, targetUserId);
      return;
    }

    const user = usersBySocketId.get(socket.id);
    const target = usersBySocketId.get(targetUserId);

    // NEW (v1.0.27) MS: «в звонке» снимаем со ВСЕХ сессий обоих имён (не только
    // с двух сокетов пары) — работает и как отмена исходящего на гудках
    if (user) setInCallWithAllSessions(user.username, null);
    if (target) setInCallWithAllSessions(target.username, null);

    // Чистим состояние звонка
    connectedCalls.delete([socket.id, targetUserId].sort().join('::'));
    const t1 = ringTimers.get(socket.id);
    if (t1) { clearTimeout(t1); ringTimers.delete(socket.id); }
    const t2 = ringTimers.get(targetUserId);
    if (t2) { clearTimeout(t2); ringTimers.delete(targetUserId); }

    broadcastUsersList();

    console.log(`[Call Ended] by ${user?.username} with ${target?.username}`);
    // NEW (v1.0.27) MS: «завершено» — ВСЕМ живым сессиям имени цели (активный
    // сокет пары + все ещё звонящие окна на стадии гудков); чужие для звонка
    // окна получат безвредный для себя call:ended (просто почистят стейт).
    if (target) {
      for (const sid of Array.from(socketsByUsername.get(target.username.toLowerCase()) || [])) {
        if (sid === socket.id || !io.sockets.sockets.has(sid)) continue;
        io.to(sid).emit('call:ended', { fromUserId: socket.id });
      }
    }
  });

  // 9. Disconnect cleanup
  socket.on('disconnect', () => {
    const user = usersBySocketId.get(socket.id);
    // Чистим таймер гудков и активные звонки с участием этого сокета
    const ownTimer = ringTimers.get(socket.id);
    if (ownTimer) { clearTimeout(ownTimer); ringTimers.delete(socket.id); }
    // NEW (v1.0.27) MS: сначала запоминаем, кем был сокет в звонке (установленная
    // пара / звонящий на гудках), потом чистим connectedCalls
    const establishedPartners: string[] = [];
    for (const key of Array.from(connectedCalls)) {
      if (key.includes(socket.id)) {
        connectedCalls.delete(key);
        const [a, b] = key.split('::');
        establishedPartners.push(a === socket.id ? b : a);
      }
    }
    const wasRingingCaller = Boolean(ownTimer) && Boolean(user?.inCallWith);

    // NEW (v1.0.27) MS: убираем сокет из индекса имён; remaining = остались ли
    // ещё живые сессии этого пользователя (частичный дисконнект ≠ офлайн)
    let remaining = 0;
    if (user) {
      const set = socketsByUsername.get(user.username.toLowerCase());
      set?.delete(socket.id);
      if (set && set.size === 0) {
        socketsByUsername.delete(user.username.toLowerCase());
      } else {
        remaining = set?.size || 0;
      }
    }
    const wasInCall = Boolean(user?.inCallWith);
    usersBySocketId.delete(socket.id);

    if (user) {
      console.log(`[User Disconnected] ${user.username} (${socket.id})${remaining > 0 ? ` — осталось сессий: ${remaining}` : ''}`);

      // NEW (v1.0.27) MS: звонковая очистка при отключении ОДНОГО сокета имени:
      // - УСТАНОВЛЕННАЯ пара: партнёру — call:ended, «в звонке» снимаем со всех
      //   сессий обоих имён. Если у отключившегося есть другие окна — юзер
      //   остаётся ОНЛАЙН (упрощение v1.0.27: медиа НЕ переносится на другое
      //   окно, звонок просто завершается для обоих — см. комментарий в spec).
      // - ЗВОНЯЩИЙ на гудках отключился: гасим звонок во всех окнах цели.
      // - ОДНО из звонящих ОКОН ЦЕЛИ отключилось: если остались другие окна —
      //   звонок ПРОДОЛЖАЕТСЯ (не трогаем); если окон не осталось — отменяем
      //   для звонившего (существующий офлайн-путь).
      if (establishedPartners.length > 0) {
        setInCallWithAllSessions(user.username, null);
        for (const pSid of establishedPartners) {
          const partner = usersBySocketId.get(pSid);
          if (!partner) continue;
          setInCallWithAllSessions(partner.username, null);
          if (io.sockets.sockets.has(pSid)) {
            io.to(pSid).emit('call:ended', { fromUserId: socket.id, reason: 'Собеседник отключился' });
          }
          const pt = ringTimers.get(pSid);
          if (pt) { clearTimeout(pt); ringTimers.delete(pSid); }
        }
        broadcastUsersList();
      } else if (wasRingingCaller) {
        // этот сокет был звонящим на гудках — всем окнам цели: «отключился»
        setInCallWithAllSessions(user.username, null);
        for (const [sId, u] of usersBySocketId.entries()) {
          if (u.inCallWith && u.inCallWith.toLowerCase() === user.username.toLowerCase()) {
            io.to(sId).emit('call:ended', { fromUserId: socket.id, reason: 'Собеседник отключился' });
          }
        }
        setInCallWithAllSessions(getCanonicalUsername(user.inCallWith || ''), null);
        broadcastUsersList();
      } else if (wasInCall && remaining === 0) {
        // цель ушла в оффлайн целиком ещё на гудках — существующая очистка:
        // снимаем «в звонке» и сообщаем ВСЕМ сокетам звонящего имени
        for (const [sId, u] of usersBySocketId.entries()) {
          if (u.inCallWith && u.inCallWith.toLowerCase() === user.username.toLowerCase()) {
            io.to(sId).emit('call:ended', { fromUserId: socket.id, reason: 'Собеседник отключился' });
          }
        }
        setInCallWithAllSessions(getCanonicalUsername(user.inCallWith || ''), null);
        broadcastUsersList();
      }

      if (remaining === 0) {
        // последняя сессия имени — существующий офлайн-путь: фиксируем
        // время последнего визита (для «был(а) в сети») и рассылаем присутствие
        dbSetLastSeen(user.username).catch(() => {});
        broadcastUsersList();
      } else {
        // NEW (v1.0.27) MS: юзер остался онлайн — только обновляем присутствие
        // (sessions уменьшился на 1)
        broadcastUsersList();
      }
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

// FIX (v1.0.21) C1: глобальные обработчики крашей — логируем и не падаем молча.
// Раньше любой необработанный rejection валил standalone-сервер без единой строки в логе.
process.on('unhandledRejection', (reason) => {
  console.error('❌ [Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]', err);
  // Встроенный режим (Electron, VM_EMBEDDED=1) — остаёмся живыми, иначе
  // падает всё приложение целиком. Автономный сервер — закрываемся честно.
  if (process.env.VM_EMBEDDED !== '1') process.exit(1);
});

server.listen(Number(PORT), '0.0.0.0', () => {
  const lanUrls = getLanAddresses();
  console.log(`🚀 Voice Messenger Server v1.0.30 запущен`);
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
