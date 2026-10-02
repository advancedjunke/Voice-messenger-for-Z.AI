const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { discoverLanServer, waitForLocalHealth } = require('./lan-discovery.cjs');

// 1. Single Instance Lock (prevents multiple windows from opening)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

const CLOUD_URL = 'https://f2f9c29f9c574a2c-217-199-233-97.serveousercontent.com';
const LOCAL_URL = 'http://localhost:3001';

// ────────────────────────────────────────────────────────────────
// v1.0.14: ЛОГИЧЕСКАЯ ЦЕПОЧКА ЗАПУСКА ПРИЛОЖЕНИЯ
//
//  Шаг 1. На этом ПК уже запущен сервер (батник / другое окно)?  → подключаемся
//  Шаг 2. UDP-broadcast: есть ли сервер у кого-то в локальной сети? → подключаемся
//  Шаг 3. Никого нет → ЭТОТ пользователь становится хостом:
//         приложение запускает встроенный сервер на своём ПК,
//         и все, кто откроет приложение после него, найдут его
//         через Шаг 2 (UDP-поиск) автоматически.
//  Шаг 4. Всё остальное не удалось → облачный сервер (последний рубеж).
// ────────────────────────────────────────────────────────────────

/**
 * Мини-загрузчик .env: если рядом с приложением лежит voice-messenger.env
 * (или server/.env в исходниках), отдаём DATABASE_URL встроенному серверу —
 * тогда история чатов на хосте сохраняется и между перезапусками.
 */
function loadOptionalEnvFile() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(app.getPath('exe')), 'voice-messenger.env'));
  }
  candidates.push(path.join(__dirname, '../server/.env'));

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      console.log(`[Embedded] Загружен файл переменных: ${file}`);
      return;
    } catch { /* не критично */ }
  }
}

/** Путь к скомпилированному серверу внутри приложения (или в исходниках). */
function getServerEntryPath() {
  // asar: false → в пакете сервер лежит рядом как обычные файлы
  const candidates = [
    path.join(__dirname, '../server/dist/index.js'),            // исходники / unpacked
    path.join(process.resourcesPath || '', 'app/server/dist/index.js'), // установленное приложение
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* resourcesPath может отсутствовать */ }
  }
  return null;
}

/**
 * Шаг 3 цепочки: запускаем встроенный сервер ВНУТРИ процесса Electron
 * (Electron содержит Node.js — отдельная установка не нужна).
 * Сервер слушает 0.0.0.0:3001 + отвечает на UDP-поиск на :3002.
 */
async function startEmbeddedServer() {
  const serverEntry = getServerEntryPath();
  if (!serverEntry) {
    console.warn('[Embedded] server/dist/index.js не найден — встроенный хостинг недоступен');
    return false;
  }

  loadOptionalEnvFile();

  // v1.0.17: папка данных встроенного сервера — аккаунты (логины/пароли/токены)
  // переживают перезапуск приложения. В Program Files писать нельзя, поэтому
  // используем стандартную папку данных Electron (%APPDATA%/VoiceMessenger).
  try {
    const dataDir = path.join(app.getPath('userData'), 'server-data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.VM_DATA_DIR = dataDir;
  } catch { /* не критично — сервер сохранит в свою папку data */ }

  process.env.VM_EMBEDDED = '1'; // сервер не должен process.exit() при ошибке порта

  try {
    console.log('[Embedded] 🏠 Сервер в сети не найден — этот ПК становится ХОСТОМ...');
    // Динамический import() ESM-сервера из CJS-main (Electron 35, Node 22)
    await import(url.pathToFileURL(serverEntry).href);
  } catch (err) {
    console.error('[Embedded] Не удалось запустить встроенный сервер:', err?.message || err);
    return false;
  }

  const healthy = await waitForLocalHealth(10000);
  if (healthy) {
    console.log('[Embedded] ✅ Встроенный сервер работает на http://localhost:3001 (0.0.0.0)');
    console.log('[Embedded] → Все, кто запустит приложение в этой сети, подключатся к вам автоматически');
  }
  return healthy;
}

/** Возвращает URL сервера, к которому подключается UI. */
async function resolveServerTarget() {
  // Шаг 1: сервер уже работает на этом ПК?
  const { checkHttpHealth } = require('./lan-discovery.cjs');
  if (await checkHttpHealth(`${LOCAL_URL}/health`, 500)) {
    console.log('[Chain] Шаг 1 ✅ Найден уже запущенный сервер на этом ПК →', LOCAL_URL);
    return LOCAL_URL;
  }

  // Шаг 2: ищем сервер в локальной сети (UDP-broadcast, порт 3002)
  console.log('[Chain] Шаг 2 🔎 Ищу сервер хоста в локальной сети...');
  const found = await discoverLanServer(1800).catch(() => null);
  if (found) {
    console.log('[Chain] Шаг 2 ✅ Сервер найден в сети →', found);
    return found;
  }

  // Шаг 3: становимся хостом сами
  if (await startEmbeddedServer()) {
    console.log('[Chain] Шаг 3 ✅ Подключаюсь к собственному встроенному серверу →', LOCAL_URL);
    return LOCAL_URL;
  }

  // Шаг 4: облачный резерв
  console.log('[Chain] Шаг 4 ⚠️ Встроенный сервер недоступен → облачный резерв', CLOUD_URL);
  return CLOUD_URL;
}

function createWindow(serverTarget) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 850,
    minHeight: 600,
    title: 'Voice Messenger',
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#0b0f19',
    show: false, // Prevents window flickering while page is loading
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Automatically grant microphone permissions for WebRTC calls
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true);
    }
    callback(true);
  });

  // Smooth appearance once content is parsed — no flickering!
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Load the local UI directly from disk with resolved server query
  const localHtmlPath = path.join(__dirname, '../client/dist/index.html');
  if (fs.existsSync(localHtmlPath)) {
    console.log('✅ Resolved server target:', serverTarget);
    mainWindow.loadFile(localHtmlPath, { query: { server: serverTarget } });
  } else {
    // Development fallback
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const serverTarget = await resolveServerTarget();
  createWindow(serverTarget);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(serverTarget);
    }
  });
});

// When another instance is launched, focus the existing window instead of creating a new one
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
