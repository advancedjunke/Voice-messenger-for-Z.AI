import pg from 'pg';
import dotenv from 'dotenv';
import { ChatMessage, User } from './types.js';

dotenv.config();

const { Pool } = pg;

let pool: pg.Pool | null = null;
let isDbConnected = false;

const connectionString = process.env.DATABASE_URL;

if (connectionString) {
  try {
    pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false,
      },
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 10000,
      max: 10,
    });

    pool.on('connect', (client) => {
      client.on('error', (err) => {
        console.warn('[Neon DB] Client socket error handled gracefully:', err.message);
      });
    });

    pool.on('error', (err) => {
      console.warn('[Neon DB] Unexpected error on idle client handled:', err.message);
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
      `);

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
        ALTER TABLE app_releases ALTER COLUMN download_url DROP NOT NULL;
      `);

      console.log('✅ [Neon DB] Таблицы users, messages и app_releases готовы к работе.');
      return true;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('⚠️ [Neon DB] Ошибка подключения к Neon базе:', err.message || err);
    isDbConnected = false;
    return false;
  }
}

export async function dbSaveUser(username: string, avatar?: string) {
  if (!pool || !isDbConnected) return;
  try {
    await withRetry(() => pool!.query(
      `INSERT INTO users (username, avatar, last_seen)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET
         avatar = COALESCE(EXCLUDED.avatar, users.avatar),
         last_seen = EXCLUDED.last_seen`,
      [username, avatar || null, Date.now()]
    ));
  } catch (err) {
    console.error('[Neon DB] Ошибка сохранения пользователя:', err);
  }
}

export async function dbGetUser(username: string): Promise<{ username: string; avatar?: string } | null> {
  if (!pool || !isDbConnected) return null;
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT username, avatar FROM users WHERE username = $1 LIMIT 1`,
      [username]
    ));
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка получения пользователя:', err);
    return null;
  }
}

export async function dbSaveMessage(msg: ChatMessage, conversationKey: string) {
  if (!pool || !isDbConnected) return;
  try {
    await withRetry(() => pool!.query(
      `INSERT INTO messages (id, conversation_key, sender_id, sender_name, sender_avatar, recipient_id, text, media_url, media_type, duration, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ]
    ));
  } catch (err) {
    console.error('[Neon DB] Ошибка сохранения сообщения:', err);
  }
}

export async function dbGetHistory(conversationKey: string, limit = 200): Promise<ChatMessage[]> {
  if (!pool || !isDbConnected) return [];
  try {
    const res = await withRetry(() => pool!.query(
      `SELECT id, sender_id as "senderId", sender_name as "senderName", sender_avatar as "senderAvatar", recipient_id as "recipientId",
              text, media_url as "mediaUrl", media_type as "mediaType", duration, timestamp
       FROM messages
       WHERE conversation_key = $1
       ORDER BY timestamp ASC
       LIMIT $2`,
      [conversationKey, limit]
    ));
    return res.rows;
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
  releaseNotes?: string;
  timestamp: number;
}

export async function dbGetLatestRelease(includePayload = false): Promise<AppRelease | null> {
  if (!pool || !isDbConnected) return null;
  try {
    const fields = includePayload
      ? `id, version, download_url as "downloadUrl", payload_base64 as "payloadBase64", release_notes as "releaseNotes", timestamp`
      : `id, version, download_url as "downloadUrl", (payload_base64 IS NOT NULL) as "hasPayload", release_notes as "releaseNotes", timestamp`;
    const res = await pool.query(
      `SELECT ${fields}
       FROM app_releases
       ORDER BY timestamp DESC
       LIMIT 1`
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка проверки обновлений:', err);
    return null;
  }
}

export async function dbGetReleasePayload(version: string): Promise<string | null> {
  if (!pool || !isDbConnected) return null;
  try {
    const res = await pool.query(
      `SELECT payload_base64 as "payloadBase64"
       FROM app_releases
       WHERE version = $1
       LIMIT 1`,
      [version]
    );
    return res.rows[0]?.payloadBase64 || null;
  } catch (err) {
    console.error('[Neon DB] Ошибка получения файла релиза:', err);
    return null;
  }
}

export async function dbPublishRelease(
  version: string,
  downloadUrl = '',
  releaseNotes = '',
  payloadBase64 = ''
): Promise<boolean> {
  if (!pool || !isDbConnected) return false;
  try {
    await pool.query(
      `INSERT INTO app_releases (version, download_url, release_notes, payload_base64, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (version) DO UPDATE SET
         download_url = EXCLUDED.download_url,
         release_notes = EXCLUDED.release_notes,
         payload_base64 = EXCLUDED.payload_base64,
         timestamp = EXCLUDED.timestamp`,
      [version, downloadUrl || null, releaseNotes, payloadBase64 || null, Date.now()]
    );
    return true;
  } catch (err) {
    console.error('[Neon DB] Ошибка публикации релиза:', err);
    return false;
  }
}
