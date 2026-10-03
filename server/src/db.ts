import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ChatMessage, KnownUser, User, GroupInfo } from './types.js';

dotenv.config();

const { Pool } = pg;

let pool: pg.Pool | null = null;
let isDbConnected = false;

const connectionString = process.env.DATABASE_URL;

// v1.0.19: статус БД для UI (/api/db/status) — без кредов, только режим и хост
let dbStatus: { usingPostgres: boolean; connected: boolean; host: string | null } = {
  usingPostgres: false,
  connected: false,
  host: null,
};

export function getDbStatus() {
  return { ...dbStatus };
}

function parseDbHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

// ─── In-memory fallback: работает и без БД ───
const localUsers = new Map<string, { username: string; avatar?: string; passwordHash?: string; authToken?: string; lastSeen: number }>();
// Fallback для релизов: автообновления работают даже без БД
const localReleases = new Map<string, AppRelease>();

// ────────────────────────────────────────────────────────────────
// v1.0.17: ФАЙЛОВОЕ ХРАНИЛИЩЕ АККАУНТОВ (режим без БД).
// Раньше аккаунты жили только в памяти — перезапуск сервера стирал
// регистрации. Теперь они сохраняются в accounts.json и переживают
// перезапуск приложения/сервера. В Electron путь задаётся через
// VM_DATA_DIR (userData), в батнике — server/data рядом с сервером.
// ────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirnameDb = path.dirname(__filename);
const DATA_DIR = process.env.VM_DATA_DIR || path.resolve(__dirnameDb, '../data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function loadLocalUsers() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (Array.isArray(raw?.users)) {
      for (const u of raw.users) {
        if (!u?.username) continue;
        localUsers.set(String(u.username).toLowerCase(), {
          username: String(u.username),
          avatar: u.avatar || undefined,
          passwordHash: u.passwordHash || undefined,
          authToken: u.authToken || undefined,
          lastSeen: Number(u.lastSeen) || 0,
        });
      }
      console.log(`📂 [Accounts] Загружено локальных аккаунтов: ${localUsers.size} (${ACCOUNTS_FILE})`);
    }
  } catch (err: any) {
    console.warn('[Accounts] Не удалось прочитать accounts.json:', err?.message || err);
  }
}
loadLocalUsers();

let accountsSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistLocalUsers() {
  if (accountsSaveTimer) clearTimeout(accountsSaveTimer);
  accountsSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = { savedAt: Date.now(), users: Array.from(localUsers.values()) };
      const tmp = ACCOUNTS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, ACCOUNTS_FILE);
    } catch (err: any) {
      console.warn('[Accounts] Не удалось сохранить accounts.json:', err?.message || err);
    }
  }, 400);
}

// ────────────────────────────────────────────────────────────────
// NEW (v1.0.29) GC: ФАЙЛОВОЕ ХРАНИЛИЩЕ ГРУПП (groups.json).
// Зеркалит паттерн accounts.json: группы переживают рестарт сервера.
// Сам кэш (Map id → группа) живёт в index.ts (groupsById) — db.ts только
// читает/пишет файл. Запись дебаунсится (~250мс), атомарно через .tmp+rename.
// ────────────────────────────────────────────────────────────────
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

// Загрузка групп с диска. Отсутствующий/битый файл — не ошибка: [] и работа дальше.
export function loadGroupsFromDisk(): GroupInfo[] {
  try {
    if (!fs.existsSync(GROUPS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    if (!Array.isArray(raw?.groups)) return [];
    // мягкая валидация каждой записи: id/имя/участники обязательны
    const groups: GroupInfo[] = [];
    for (const g of raw.groups) {
      if (!g || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string' || !Array.isArray(g.members)) continue;
      const members = g.members.map((m: unknown) => String(m || '').trim().slice(0, 24)).filter((m: string) => m.length > 0);
      // NEW (v1.0.30) GR: статусы прочтения переживают рестарт. Нормализация
      // при загрузке: остаются только записи о ТЕКУЩИХ участниках (без учёта
      // регистра) с числовым временем > 0; старые файлы без readState — ок
      // (поле остаётся undefined, логика в index.ts терпит его отсутствие).
      let readState: Record<string, number> | undefined;
      if (g.readState && typeof g.readState === 'object') {
        const memberKeys = new Set(members.map((m: string) => m.toLowerCase()));
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(g.readState)) {
          const name = String(k || '').trim();
          if (!name || !memberKeys.has(name.toLowerCase())) continue;
          const t = Number(v);
          if (Number.isFinite(t) && t > 0) clean[name] = Math.floor(t);
        }
        if (Object.keys(clean).length > 0) readState = clean;
      }
      groups.push({
        id: g.id,
        name: g.name,
        createdBy: String(g.createdBy || g.members[0] || ''),
        members,
        createdAt: Number(g.createdAt) || Date.now(),
        ...(readState ? { readState } : {}),
      });
    }
    console.log(`👥 [Groups] Загружено групп: ${groups.length} (${GROUPS_FILE})`);
    return groups;
  } catch (err: any) {
    console.warn('[Groups] Не удалось прочитать groups.json:', err?.message || err);
    return [];
  }
}

let groupsSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Сохранение ВСЕХ групп на диск (дебаунс ~250мс — бережём диск при серии мутаций).
// Вызывается из index.ts после каждого изменения состава/названия группы.
export function saveGroupsToDisk(groups: GroupInfo[]) {
  if (groupsSaveTimer) clearTimeout(groupsSaveTimer);
  groupsSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = { savedAt: Date.now(), groups };
      const tmp = GROUPS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, GROUPS_FILE);
    } catch (err: any) {
      console.warn('[Groups] Не удалось сохранить groups.json:', err?.message || err);
    }
  }, 250);
}

if (connectionString) {
  dbStatus.usingPostgres = true;
  dbStatus.host = parseDbHost(connectionString);
  try {
    // v1.0.19: SSL только когда он реально нужен (Neon / sslmode в URL).
    // Раньше SSL навязывался всем — из-за этого сервер не мог подключиться
    // к обычному PostgreSQL без TLS (падало всё в файловый режим).
    const needsSsl = /sslmode=(require|verify|prefer)|neon\.tech/i.test(connectionString);
    pool = new Pool({
      connectionString,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000, // v1.0.20: Neon free tier может просыпаться до ~10 секунд
      max: 10,
    });

    pool.on('connect', (client) => {
      client.on('error', (err) => {
        console.warn('[Neon DB] Client socket error handled gracefully:', err.message);
        // FIX (v1.0.21) C3: соединение потеряно — сбрасываем флаг, чтобы
        // /api/db/status не врал, и фоновый вотчер (15с) поднял базу заново
        isDbConnected = false;
        dbStatus.connected = false;
      });
    });

    pool.on('error', (err) => {
      console.warn('[Neon DB] Unexpected error on idle client handled:', err.message);
      // FIX (v1.0.21) C3: см. выше — не даём статусу «connected» замереть после потери соединения
      isDbConnected = false;
      dbStatus.connected = false;
    });
  } catch (err) {
    console.error('[Neon DB] Failed to create connection pool', err);
  }
}

// Retry wrapper for resilience against ECONNRESET / connection terminated errors
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || '';
      const isTransient =
        msg.includes('Connection terminated') ||
        msg.includes('ECONNRESET') ||
        msg.includes('connection lost') ||
        msg.includes('timeout');
      if (isTransient && attempt < maxRetries) {
        const delay = attempt * 500;
        console.warn(`[Neon DB] Transient error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${msg}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: exhausted retries');
}

// ────────────────────────────────────────────────────────────────
// v1.0.20: ОЧЕРЕДЬ СООБЩЕНИЙ на время «пробуждения» базы.
// Раньше сообщение, отправленное до подключения Neon (free tier
// может просыпаться десятки секунд), ТЕРЯЛОСЬ МОЛЧА. Теперь оно
// встаёт в очередь и автоматически доезжает до базы, как только
// подключение установлено.
// ────────────────────────────────────────────────────────────────
const PENDING_MESSAGES_MAX = 1000;
const pendingMessages: Array<{ msg: ChatMessage; conversationKey: string }> = [];

function queuePendingMessage(item: { msg: ChatMessage; conversationKey: string }) {
  if (pendingMessages.length >= PENDING_MESSAGES_MAX) pendingMessages.shift();
  pendingMessages.push(item);
  console.log(`📬 [Neon DB] Сообщение поставлено в очередь (всего: ${pendingMessages.length})`);
}

// FIX (v1.0.21) B4: очередь удалений на время «сна» базы. Раньше пометка
// «удалено» молча ТЕРЯЛАСЬ, если база была недоступна (в отличие от сообщений) —
// после пробуждения «удалённое» сообщение снова всплывало в истории.
const PENDING_DELETES_MAX = 1000;
const pendingDeletes: Array<{ messageId: string; conversationKey: string }> = [];

function queuePendingDelete(item: { messageId: string; conversationKey: string }) {
  if (pendingDeletes.length >= PENDING_DELETES_MAX) pendingDeletes.shift();
  pendingDeletes.push(item);
  console.log(`🗑️ [Neon DB] Удаление поставлено в очередь (всего: ${pendingDeletes.length})`);
}

// NEW (v1.0.24) E1: очередь правок сообщений на время «сна» базы — тот же
// loss-proof паттерн, что и у удалений (B4): правка не теряется, а доезжает
// до базы после пробуждения.
const PENDING_EDITS_MAX = 1000;
const pendingEdits: Array<{ messageId: string; conversationKey: string; text: string; editedAt: number }> = [];

function queuePendingEdit(item: { messageId: string; conversationKey: string; text: string; editedAt: number }) {
  if (pendingEdits.length >= PENDING_EDITS_MAX) pendingEdits.shift();
  pendingEdits.push(item);
  console.log(`✏️ [Neon DB] Правка поставлена в очередь (всего: ${pendingEdits.length})`);
}

async function insertMessageRow(msg: ChatMessage, conversationKey: string) {
  await withRetry(() => pool!.query(
    `INSERT INTO messages (id, conversation_key, sender_id, sender_name, sender_avatar, recipient_id, text, media_url, media_type, duration, timestamp,
                           reply_to_id, reply_to_sender, reply_to_text, reply_to_media_type, deleted, forwarded_from, read, edited, edited_at, reactions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO NOTHING`,
    [
      msg.id,
      conversationKey,
      msg.senderId,
      msg.senderName,
      msg.senderAvatar || null,
      msg.recipientId,
      msg.text || null,
      msg.mediaUrl || null,
      msg.mediaType || 'text',
      msg.duration || null,
      msg.timestamp,
      msg.replyTo?.id || null,
      msg.replyTo?.senderName || null,
      msg.replyTo?.text || null,
      msg.replyTo?.mediaType || null,
      Boolean(msg.deleted),
      msg.forwardedFrom || null,
      // FIX (v1.0.21) B5: новое сообщение по определению непрочитано (false);
      // если сообщение стояло в очереди и успело стать прочитанным — сохранится true
      Boolean(msg.read),
      // NEW (v1.0.24) E1: факт и время правки текста
      Boolean(msg.edited),
      msg.editedAt || null,
      // NEW (v1.0.25) R1: реакции на момент вставки (JSON-строка; обычно null)
      msg.reactions && Object.keys(msg.reactions).length > 0 ? JSON.stringify(msg.reactions) : null,
    ]
  ));
}

// FIX (v1.0.21) B4: мягкое удаление вынесено в отдельную функцию — используется
// и напрямую, и при досылке очереди удалений
async function applyDeleteRow(item: { messageId: string; conversationKey: string }) {
  await withRetry(() => pool!.query(
    `UPDATE messages
     SET deleted = TRUE, text = NULL, media_url = NULL, duration = NULL
     WHERE id = $1 AND conversation_key = $2`,
    [item.messageId, item.conversationKey]
  ));
}

// NEW (v1.0.24) E1: применение правки текста — используется и напрямую,
// и при досылке очереди правок после «пробуждения» базы
async function applyEditRow(item: { messageId: string; conversationKey: string; text: string; editedAt: number }) {
  await withRetry(() => pool!.query(
    `UPDATE messages
     SET text = $3, edited = TRUE, edited_at = $4
     WHERE id = $1 AND conversation_key = $2 AND deleted = FALSE`,
    [item.messageId, item.conversationKey, item.text, item.editedAt]
  ));
}

// NEW (v1.0.25) R1: применение нового слепка реакций сообщения — используется
// и напрямую, и при досылке очереди реакций. Пишем СЛЕПОК ЦЕЛИКОМ (не дельту):
// сервер хранит актуальный msg.reactions в памяти, база просто догоняет.
// deleted = FALSE — реакция не должна «воскрешать» удалённые сообщения
// (как у правок E1).
async function applyReactionRow(item: { messageId: string; conversationKey: string; reactions: Record<string, string[]> }) {
  await withRetry(() => pool!.query(
    `UPDATE messages
     SET reactions = $3
     WHERE id = $1 AND conversation_key = $2 AND deleted = FALSE`,
    [item.messageId, item.conversationKey, JSON.stringify(item.reactions)]
  ));
}

export async function flushPendingMessages() {
  if (!pool || !isDbConnected || pendingMessages.length === 0) return;
  const batch = pendingMessages.splice(0, pendingMessages.length);
  let saved = 0;
  // FIX (v1.0.21) B1 (критичное): раньше при первой же ошибке в очередь
  // возвращалось ТОЛЬКО одно сообщение, а остаток батча МОЛЧА ТЕРЯЛСЯ.
  // Теперь в очередь возвращается весь несохранённый хвост — с сохранением порядка.
  for (let i = 0; i < batch.length; i++) {
    try {
      await insertMessageRow(batch[i].msg, batch[i].conversationKey);
      saved++;
    } catch (err: any) {
      console.warn('[Neon DB] Очередь: сообщение не сохранилось, возвращаю остаток батча в очередь:', err?.message || err);
      pendingMessages.unshift(...batch.slice(i));
      break; // база снова недоступна — продолжим на следующей попытке
    }
  }
  if (saved > 0) console.log(`📬 [Neon DB] Из очереди сохранено сообщений: ${saved} (осталось: ${pendingMessages.length})`);
}

// FIX (v1.0.21) B4: досылка накопившихся удалений — тот же loss-proof паттерн, что и в B1
export async function flushPendingDeletes() {
  if (!pool || !isDbConnected || pendingDeletes.length === 0) return;
  const batch = pendingDeletes.splice(0, pendingDeletes.length);
  let applied = 0;
  for (let i = 0; i < batch.length; i++) {
    try {
      await applyDeleteRow(batch[i]);
      applied++;
    } catch (err: any) {
      console.warn('[Neon DB] Очередь удалений: не удалось применить, возвращаю остаток в очередь:', err?.message || err);
      pendingDeletes.unshift(...batch.slice(i));
      break;
    }
  }
  if (applied > 0) console.log(`🗑️ [Neon DB] Из очереди применено удалений: ${applied} (осталось: ${pendingDeletes.length})`);
}

// NEW (v1.0.24) E1: досылка накопившихся правок — тот же loss-proof паттерн
export async function flushPendingEdits() {
  if (!pool || !isDbConnected || pendingEdits.length === 0) return;
  const batch = pendingEdits.splice(0, pendingEdits.length);
  let applied = 0;
  for (let i = 0; i < batch.length; i++) {
    try {
      await applyEditRow(batch[i]);
      applied++;
    } catch (err: any) {
      console.warn('[Neon DB] Очередь правок: не удалось применить, возвращаю остаток в очередь:', err?.message || err);
      pendingEdits.unshift(...batch.slice(i));
      break;
    }
  }
  if (applied > 0) console.log(`✏️ [Neon DB] Из очереди применено правок: ${applied} (осталось: ${pendingEdits.length})`);
}

// NEW (v1.0.25) R1: очередь слепков реакций на время «сна» базы — loss-proof
// паттерн, как у правок (E1). Слепки копятся, если база спит; после пробуждения
// доезжают ВСЕ по порядку (последний слепок побеждает — итоговое состояние верно).
const PENDING_REACTIONS_MAX = 1000;
const pendingReactions: Array<{ messageId: string; conversationKey: string; reactions: Record<string, string[]> }> = [];

function queuePendingReaction(item: { messageId: string; conversationKey: string; reactions: Record<string, string[]> }) {
  if (pendingReactions.length >= PENDING_REACTIONS_MAX) pendingReactions.shift();
  pendingReactions.push(item);
  console.log(`💜 [Neon DB] Реакция поставлена в очередь (всего: ${pendingReactions.length})`);
}

export async function flushPendingReactions() {
  if (!pool || !isDbConnected || pendingReactions.length === 0) return;
  const batch = pendingReactions.splice(0, pendingReactions.length);
  let applied = 0;
  for (let i = 0; i < batch.length; i++) {
    try {
      await applyReactionRow(batch[i]);
      applied++;
    } catch (err: any) {
      console.warn('[Neon DB] Очередь реакций: не удалось применить, возвращаю остаток в очередь:', err?.message || err);
      pendingReactions.unshift(...batch.slice(i));
      break;
    }
  }
  if (applied > 0) console.log(`💜 [Neon DB] Из очереди применено реакций: ${applied} (осталось: ${pendingReactions.length})`);
}

// Фоновая досылка: раз в 30 секунд пробуем доставить недоставленное
setInterval(() => {
  if (isDbConnected && (pendingMessages.length > 0 || pendingDeletes.length > 0 || pendingEdits.length > 0 || pendingReactions.length > 0)) {
    flushPendingMessages().catch(() => { /* не критично */ });
    flushPendingDeletes().catch(() => { /* не критично */ });
    flushPendingEdits().catch(() => { /* не критично */ });
    // NEW (v1.0.25) R1: реакции досылаем ПОСЛЕДНИМИ (после сообщений/удалений/
    // правок) — чтобы слепок реакций не мог опередить само сообщение
    flushPendingReactions().catch(() => { /* не критично */ });
  }
}, 30000).unref?.();

export async function initDatabase() {
  if (!pool) {
    console.log('ℹ️ [Neon DB] DATABASE_URL не указан. Сервер работает во встроенном режиме хранения в памяти.');
    return false;
  }

  try {
    const client = await pool.connect();
    try {
      console.log('🐘 [Neon DB] Успешное подключение к PostgreSQL базе данных Neon.tech!');
      isDbConnected = true;

      // Create users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          username VARCHAR(100) PRIMARY KEY,
          avatar TEXT,
          last_seen BIGINT NOT NULL
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        -- v1.0.17: токен сессии для входа в аккаунт
        ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token TEXT;
      `);

      // FIX (v1.0.21) B3: уникальность имён БЕЗ учёта регистра на уровне БД
      // (Alice и alice — один аккаунт). Отдельный try: если в базе уже есть
      // дубли с разным регистром, индекс не создастся — но инициализация
      // из-за этого падать не должна.
      try {
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users (LOWER(username))`);
      } catch (idxErr: any) {
        console.warn('[Neon DB] Уникальный индекс LOWER(username) не создан (возможно, есть дубли имён с разным регистром):', idxErr?.message || idxErr);
      }

      // Create messages table
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(100) PRIMARY KEY,
          conversation_key VARCHAR(250) NOT NULL,
          sender_id VARCHAR(100) NOT NULL,
          sender_name VARCHAR(100) NOT NULL,
          sender_avatar TEXT,
          recipient_id VARCHAR(100) NOT NULL,
          text TEXT,
          media_url TEXT,
          media_type VARCHAR(50),
          duration INT,
          timestamp BIGINT NOT NULL
        );
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_avatar TEXT;
        -- v1.0.11: ответы на сообщения, удаление, время последнего визита
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id VARCHAR(100);
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender VARCHAR(100);
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_text TEXT;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_media_type VARCHAR(50);
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;
        -- v1.0.12: пересылка сообщений (имя первоначального отправителя)
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from VARCHAR(100);
        -- FIX (v1.0.21) B5: прочтение сообщений (персистентные «✓✓»)
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE;
        -- NEW (v1.0.24) E1: редактирование отправленных сообщений (факт + время)
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT FALSE;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at BIGINT;
        -- NEW (v1.0.25) R1: реакции-эмодзи на сообщения (JSON: эмодзи → [username])
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions TEXT;
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_key);
      `);

      // Create app_releases table for auto-updating on any computer!
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_releases (
          id SERIAL PRIMARY KEY,
          version VARCHAR(50) NOT NULL UNIQUE,
          payload_base64 TEXT,
          download_url TEXT,
          release_notes TEXT,
          timestamp BIGINT NOT NULL
        );
        ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS payload_base64 TEXT;
        -- FIX (v1.0.21) C4: SHA-256 payload — лаунчер проверяет целостность скачивания
        ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS payload_sha256 TEXT;
        ALTER TABLE app_releases ALTER COLUMN download_url DROP NOT NULL;
      `);

      console.log('✅ [Neon DB] Таблицы users, messages и app_releases готовы к работе.');
      dbStatus.connected = true;

      // v1.0.19: если аккаунты успели создаться в файловом режиме (Neon был
      // недоступен на старте), переносим их в базу — ничего не теряем.
      // FIX (v1.0.21) B3: try вынесен внутрь цикла — один конфликтный аккаунт
      // (например, дубликат с другим регистром) не должен прерывать перенос остальных.
      try {
        for (const u of localUsers.values()) {
          if (!u.passwordHash) continue;
          try {
            await client.query(
              `INSERT INTO users (username, avatar, password_hash, auth_token, last_seen)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (username) DO NOTHING`,
              [u.username, u.avatar || null, u.passwordHash || null, u.authToken || null, u.lastSeen || Date.now()]
            );
          } catch { /* дубликат/конфликт — пропускаем этого пользователя */ }
        }
      } catch (mErr: any) {
        console.warn('[Neon DB] Не удалось перенести локальные аккаунты:', mErr.message);
      }

      // v1.0.20: досылаем сообщения, накопившиеся, пока база просыпалась
      await flushPendingMessages();
      // FIX (v1.0.21) B4: досылаем и накопившиеся удаления (после сообщений —
      // чтобы «удалённое» не вставилось обратно уже помеченным)
      await flushPendingDeletes();
      // NEW (v1.0.24) E1: досылаем накопившиеся правки (после удалений — чтобы
      // правка не перезатёрла текст сообщения, уже удалённого во «сне» базы)
      await flushPendingEdits();

      return true;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('⚠️ [Neon DB] Ошибка подключения к Neon базе:', err.message || err);
    isDbConnected = false;
    dbStatus.connected = false;
    return false;
  }
}

// v1.0.19: Neon free tier "усыпляет" базу — первое подключение может не
// пройти. Раньше попытка была одна: сервер навсегда падал в файловый режим.
// Теперь: до 5 попыток с нарастающей паузой, затем фоновая проверка раз в
// минуту; как только база ожила — она подхватывается, а аккаунты, созданные
// в файловом режиме, переносятся в неё автоматически.
export async function initDatabaseWithRetry(): Promise<boolean> {
  if (!pool) {
    console.log('ℹ️ [Neon DB] DATABASE_URL не указан. Сервер работает во встроенном режиме хранения в памяти.');
    return false;
  }
  const delays = [0, 4000, 10000, 20000, 40000];
  let connected = false;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.log(`[Neon DB] Повторная попытка подключения через ${delays[i] / 1000}с…`);
      await new Promise(r => setTimeout(r, delays[i]));
    }
    if (await initDatabase()) {
      connected = true;
      break;
    }
  }
  if (!connected) console.warn('[Neon DB] База недоступна — работаем в файловом режиме, подключение проверяем раз в 15 секунд.');
  // FIX (v1.0.21) C3: вотчер теперь ПОСТОЯННЫЙ. Раньше он останавливался после
  // первого успешного подключения — и если база «усыплялась» посреди сессии
  // (pool error → флаг сброшен), сервер навсегда оставался в файловом режиме.
  const timer = setInterval(() => {
    if (isDbConnected) return; // подключено — просто следим дальше
    initDatabase().then(ok => {
      if (ok) console.log('✅ [Neon DB] Соединение с базой восстановлено.');
    });
  }, 15000);
  timer.unref?.();
  return connected;
}

// FIX (v1.0.21) B3: возвращает false ТОЛЬКО при unique violation (имя уже
// занято — гонка регистрации). Прочие ошибки проглатываются как раньше,
// чтобы не менять поведение существующих вызовов.
export async function dbSaveUser(username: string, avatar?: string, passwordHash?: string, authToken?: string): Promise<boolean> {
  if (!pool || !isDbConnected) {
    // Fallback: локальное файловое хранилище (режим без БД)
    const prev = localUsers.get(username.toLowerCase());
    localUsers.set(username.toLowerCase(), {
      username,
      avatar: avatar || prev?.avatar,
      passwordHash: passwordHash || prev?.passwordHash,
      authToken: authToken || prev?.authToken,
      lastSeen: Date.now(),
    });
    persistLocalUsers();
    return true;
  }
  try {
    await withRetry(() => pool!.query(
      `INSERT INTO users (username, avatar, password_hash, auth_token, last_seen)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE SET
         avatar = COALESCE(EXCLUDED.avatar, users.avatar),
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash),
         auth_token = COALESCE(EXCLUDED.auth_token, users.auth_token),
         last_seen = EXCLUDED.last_seen`,
      [username, avatar || null, passwordHash || null, authToken || null, Date.now()]
    ));
    return true;
  } catch (err: any) {
    // 23505 = unique_violation: сработал индекс LOWER(username) — имя занято
    if (err?.code === '23505') {
      console.warn(`[Neon DB] Имя «${username}» уже занято (unique violation).`);
      return false;
    }
    console.error('[Neon DB] Ошибка сохранения пользователя:', err);
    return true;
  }
}

export async function dbGetUser(username: string): Promise<{ username: string; avatar?: string; passwordHash?: string } | null> {
  if (!pool || !isDbConnected) {
    return localUsers.get(username.toLowerCase()) || null;
  }
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT username, avatar, password_hash as "passwordHash" FROM users WHERE username = $1 LIMIT 1`,
      [username]
    ));
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка получения пользователя:', err);
    return null;
  }
}

// v1.0.17: поиск аккаунта без учёта регистра (Alice и alice — один аккаунт)
export async function dbFindUserByName(name: string): Promise<{ username: string; avatar?: string; passwordHash?: string } | null> {
  if (!name) return null;
  if (!pool || !isDbConnected) {
    return localUsers.get(name.toLowerCase()) || null;
  }
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT username, avatar, password_hash as "passwordHash" FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [name]
    ));
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка поиска пользователя:', err);
    return null;
  }
}

// v1.0.17: найти аккаунт по токену сессии
export async function dbGetUserByToken(token: string): Promise<{ username: string; avatar?: string } | null> {
  if (!token) return null;
  if (!pool || !isDbConnected) {
    for (const u of localUsers.values()) {
      if (u.authToken === token) return { username: u.username, avatar: u.avatar };
    }
    return null;
  }
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT username, avatar FROM users WHERE auth_token = $1 LIMIT 1`,
      [token]
    ));
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка поиска по токену:', err);
    return null;
  }
}

export async function dbSaveMessage(msg: ChatMessage, conversationKey: string) {
  if (!pool) return; // БД не настроена — история только в памяти хоста
  if (!isDbConnected) {
    // v1.0.20: база настроена, но ещё не проснулась — НЕ ТЕРЯЕМ сообщение
    queuePendingMessage({ msg, conversationKey });
    return;
  }
  try {
    await insertMessageRow(msg, conversationKey);
  } catch (err: any) {
    console.error('[Neon DB] Ошибка сохранения сообщения:', err?.message || err);
    queuePendingMessage({ msg, conversationKey }); // v1.0.20: не теряем
  }
}

// v1.0.11: пометить сообщение удалённым (контент стираем, сам факт остаётся)
export async function dbMarkMessageDeleted(conversationKey: string, messageId: string) {
  if (!pool) return; // БД не настроена — некуда писать
  if (!isDbConnected) {
    // FIX (v1.0.21) B4: база спит — удаление в очередь, как сообщения. Раньше просто return.
    queuePendingDelete({ conversationKey, messageId });
    return;
  }
  try {
    await applyDeleteRow({ conversationKey, messageId });
  } catch (err) {
    console.error('[Neon DB] Ошибка удаления сообщения:', err);
    // FIX (v1.0.21) B4: не теряем — вернём в очередь и досылаем позже
    queuePendingDelete({ conversationKey, messageId });
  }
}

// NEW (v1.0.24) E1: отредактировать текст своего сообщения (факт правки
// фиксируем в колонках edited/edited_at). Loss-proof паттерн очереди — как у
// удалений: база спит → правка в очередь и доедет после пробуждения.
export async function dbEditMessage(conversationKey: string, messageId: string, text: string, editedAt: number) {
  if (!pool) return; // БД не настроена — некуда писать
  const item = { conversationKey, messageId, text, editedAt };
  if (!isDbConnected) {
    queuePendingEdit(item);
    return;
  }
  try {
    await applyEditRow(item);
  } catch (err) {
    console.error('[Neon DB] Ошибка правки сообщения:', err);
    queuePendingEdit(item); // не теряем — досылаем позже
  }
}

// NEW (v1.0.25) R1: сохранить слепок реакций сообщения (loss-proof очередь,
// если база спит). Без БД — no-op: актуальные реакции живут в памяти сервера
// (messageHistory) и никуда не пропадают до рестарта.
export async function dbSetReactions(conversationKey: string, messageId: string, reactions: Record<string, string[]>) {
  if (!pool) return; // БД не настроена — некуда писать
  const item = { conversationKey, messageId, reactions };
  if (!isDbConnected) {
    queuePendingReaction(item);
    return;
  }
  try {
    await applyReactionRow(item);
  } catch (err) {
    console.error('[Neon DB] Ошибка сохранения реакций:', err);
    queuePendingReaction(item); // не теряем — досылаем позже
  }
}

// FIX (v1.0.21) B5: отметить всю беседу с собеседником прочитанной (persist «✓✓»).
// Вызывается fire-and-forget из обработчика chat:read в index.ts.
export async function dbMarkConversationRead(conversationKey: string, partnerName: string) {
  if (!pool || !isDbConnected) return;
  try {
    await withRetry(() => pool!.query(
      `UPDATE messages SET read = TRUE
       WHERE conversation_key = $1 AND LOWER(sender_name) = LOWER($2) AND deleted = FALSE`,
      [conversationKey, partnerName]
    ));
  } catch (err) {
    console.error('[Neon DB] Ошибка отметки «прочитано»:', err);
  }
}

// v1.0.11: обновить только время последнего визита (не трогая аватар/пароль)
export async function dbSetLastSeen(username: string) {
  if (!pool || !isDbConnected) {
    const prev = localUsers.get(username.toLowerCase());
    if (prev) prev.lastSeen = Date.now();
    persistLocalUsers();
    return;
  }
  try {
    await withRetry(() => pool!.query(
      `UPDATE users SET last_seen = $2 WHERE username = $1`,
      [username, Date.now()]
    ));
  } catch (err) {
    console.error('[Neon DB] Ошибка обновления last_seen:', err);
  }
}

// v1.0.11: известные пользователи (включая офлайн) для сайдбара
export async function dbGetKnownUsers(limit = 30): Promise<KnownUser[]> {
  if (!pool || !isDbConnected) {
    return Array.from(localUsers.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(u => ({ username: u.username, avatar: u.avatar, lastSeen: u.lastSeen }));
  }
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT username, avatar, last_seen as "lastSeen"
       FROM users
       ORDER BY last_seen DESC
       LIMIT $1`,
      [limit]
    ));
    return res.rows;
  } catch (err) {
    console.error('[Neon DB] Ошибка получения известных пользователей:', err);
    return [];
  }
}

export async function dbGetHistory(conversationKey: string, limit = 200): Promise<ChatMessage[]> {
  if (!pool || !isDbConnected) return [];
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT id, sender_id as "senderId", sender_name as "senderName", sender_avatar as "senderAvatar", recipient_id as "recipientId",
              text, media_url as "mediaUrl", media_type as "mediaType", duration, timestamp,
              reply_to_id as "replyToId", reply_to_sender as "replyToSender", reply_to_text as "replyToText",
              reply_to_media_type as "replyToMediaType", deleted, forwarded_from as "forwardedFrom", read,
              edited, edited_at as "editedAt", reactions
       FROM messages
       WHERE conversation_key = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [conversationKey, limit]
    ));
    // FIX (v1.0.21) B2: раньше «ASC LIMIT 200» отдавал СТАРЕЙШИЕ 200 сообщений
    // (у длинных бесед история «застревала» в древности). Теперь берём НОВЕЙШИЕ
    // 200 (DESC) и разворачиваем обратно в хронологию — как у кольцевого буфера в памяти.
    // FIX (v1.0.21) B5: колонка read подхватывается и маппится в ChatMessage.read.
    res.rows.reverse();
    // v1.0.11: восстанавливаем вложенную структуру replyTo из плоских колонок
    return res.rows.map((row: any) => {
      const { replyToId, replyToSender, replyToText, replyToMediaType, reactions, ...rest } = row;
      if (replyToId) {
        rest.replyTo = {
          id: replyToId,
          senderName: replyToSender || '',
          text: replyToText || undefined,
          mediaType: replyToMediaType || undefined,
        };
      }
      // NEW (v1.0.25) R1: распаковываем JSON-слепок реакций (эмодзи → [username]).
      // Битый JSON (не должен случаться) — просто игнорируем.
      if (reactions) {
        try {
          const parsed = JSON.parse(reactions);
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            rest.reactions = parsed;
          }
        } catch { /* ignore */ }
      }
      return rest as ChatMessage;
    });
  } catch (err) {
    console.error('[Neon DB] Ошибка загрузки истории сообщений:', err);
    return [];
  }
}

export interface AppRelease {
  id: number;
  version: string;
  downloadUrl?: string;
  payloadBase64?: string;
  // FIX (v1.0.21) C4: SHA-256 payload (hex, lowercase) — проверка целостности на стороне лаунчера
  payloadSha256?: string;
  releaseNotes?: string;
  timestamp: number;
}

export async function dbGetLatestRelease(includePayload = false): Promise<AppRelease | null> {
  if (!pool || !isDbConnected) {
    // Fallback: локальное хранилище релизов
    const all = Array.from(localReleases.values()).sort((a, b) => b.timestamp - a.timestamp);
    const latest = all[0];
    if (!latest) return null;
    return includePayload ? latest : { ...latest, payloadBase64: undefined } as AppRelease;
  }
  try {
    // FIX (v1.0.21) C2: обёрнуто в withRetry, как остальные запросы (Neon может просыпаться)
    const fields = includePayload
      ? `id, version, download_url as "downloadUrl", payload_base64 as "payloadBase64", payload_sha256 as "payloadSha256", release_notes as "releaseNotes", timestamp`
      : `id, version, download_url as "downloadUrl", (payload_base64 IS NOT NULL) as "hasPayload", payload_sha256 as "payloadSha256", release_notes as "releaseNotes", timestamp`;
    const res = await withRetry(() => pool!.query(
      `SELECT ${fields}
       FROM app_releases
       ORDER BY timestamp DESC
       LIMIT 1`
    ));
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка проверки обновлений:', err);
    return null;
  }
}

export async function dbGetReleasePayload(version: string): Promise<string | null> {
  if (!pool || !isDbConnected) {
    return localReleases.get(version)?.payloadBase64 || null;
  }
  try {
    // FIX (v1.0.21) C2: с ретраем, как остальные запросы
    const res = await withRetry(() => pool!.query(
      `SELECT payload_base64 as "payloadBase64"
       FROM app_releases
       WHERE version = $1
       LIMIT 1`,
      [version]
    ));
    return res.rows[0]?.payloadBase64 || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка получения файла релиза:', err);
    return null;
  }
}

// v1.0.11: удалить релиз (очистка тестовых/битых публикаций)
export async function dbDeleteRelease(version: string): Promise<boolean> {
  if (!pool || !isDbConnected) {
    return localReleases.delete(version);
  }
  try {
    // FIX (v1.0.21) C2: с ретраем, как остальные запросы
    await withRetry(() => pool!.query(`DELETE FROM app_releases WHERE version = $1`, [version]));
    return true;
  } catch (err) {
    console.error('[Neon DB] Ошибка удаления релиза:', err);
    return false;
  }
}

export async function dbPublishRelease(
  version: string,
  downloadUrl = '',
  releaseNotes = '',
  payloadBase64 = '',
  // FIX (v1.0.21) C4: SHA-256 payload (hex, lowercase) — контракт с publish-release.cjs и лаунчером
  payloadSha256 = ''
): Promise<boolean> {
  if (!pool || !isDbConnected) {
    // Fallback: локальное хранилище релизов
    localReleases.set(version, {
      id: localReleases.size + 1,
      version,
      downloadUrl: downloadUrl || undefined,
      payloadBase64: payloadBase64 || undefined,
      payloadSha256: payloadSha256 || undefined,
      releaseNotes,
      timestamp: Date.now(),
    });
    return true;
  }
  try {
    // FIX (v1.0.21) C2: с ретраем, как остальные запросы
    await withRetry(() => pool!.query(
      `INSERT INTO app_releases (version, download_url, release_notes, payload_base64, payload_sha256, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (version) DO UPDATE SET
         download_url = EXCLUDED.download_url,
         release_notes = EXCLUDED.release_notes,
         payload_base64 = EXCLUDED.payload_base64,
         payload_sha256 = EXCLUDED.payload_sha256,
         timestamp = EXCLUDED.timestamp`,
      [version, downloadUrl || null, releaseNotes, payloadBase64 || null, payloadSha256 || null, Date.now()]
    ));
    return true;
  } catch (err) {
    console.error('[Neon DB] Ошибка публикации релиза:', err);
    return false;
  }
}
