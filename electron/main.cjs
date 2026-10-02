const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const util = require('util');
const { spawn } = require('child_process');
const { discoverLanServer, checkHttpHealth, waitForLocalHealth } = require('./lan-discovery.cjs');

// 1. Single Instance Lock (prevents multiple windows from opening)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

const LOCAL_URL = 'http://127.0.0.1:3001';

// ────────────────────────────────────────────────────────────────
// v1.0.14: ЛОГИЧЕСКАЯ ЦЕПОЧКА ЗАПУСКА ПРИЛОЖЕНИЯ
//
//  Шаг 1. На этом ПК уже запущен сервер (батник / другое окно)?  → подключаемся
//  Шаг 2. UDP-broadcast: есть ли сервер у кого-то в локальной сети? → подключаемся
//  Шаг 3. Никого нет → ЭТОТ пользователь становится хостом:
//         приложение запускает встроенный сервер на своём ПК,
//         и все, кто откроет приложение после него, найдут его
//         через Шаг 2 (UDP-поиск) автоматически.
//
//  v1.0.18: мёртвый облачный фолбэк УДАЛЁН — он молча подсовывал
//  клиенту недоступный адрес, из-за чего висело «Нет связи с сервером».
//  Теперь если встроенный сервер не поднялся, остаёмся на localhost,
//  а экран входа даёт кнопку «Перезапустить сервер» (IPC vm:rehost).
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// v1.0.18: ЛОГИ В ФАЙЛ — %APPDATA%/VoiceMessenger/main.log
// Раньше ошибки встроенного сервера уходили «в никуда» (консоли нет),
// и невозможно было понять, почему «Нет связи с сервером».
// ────────────────────────────────────────────────────────────────
let logStream = null;
function getLogPath() {
  try { return path.join(app.getPath('userData'), 'main.log'); } catch { return null; }
}
function initFileLogging() {
  const p = getLogPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    logStream = fs.createWriteStream(p, { flags: 'a' });
    logStream.write(`\n────── Запуск приложения v1.0.20 · ${new Date().toISOString()} ───────\n`);
    const wrap = (orig) => (...args) => {
      try { orig(...args); logStream.write(`[${new Date().toISOString()}] ${util.format(...args)}\n`); } catch { /* не критично */ }
    };
    console.log = wrap(console.log.bind(console));
    console.warn = wrap(console.warn.bind(console));
    console.error = wrap(console.error.bind(console));
  } catch { /* логирование не критично */ }
}

/**
 * Мини-загрузчик .env: если рядом с приложением лежит voice-messenger.env
 * (или server/.env в исходниках), отдаём DATABASE_URL встроенному серверу —
 * тогда история чатов на хосте сохраняется и между перезапусками.
 *
 * v1.0.20: третьим кандидатом идёт voice-messenger.env, ВШИТЫЙ В СБОРКУ
 * (GitHub Actions записывает его из секрета NEON_DATABASE_URL). Порядок
 * приоритета: файл рядом с exe → файл из настроек приложения → вшитый
 * в сборку → server/.env из исходников. Файл без полезных переменных
 * (например, только комментарий) пропускается — смотрим следующий кандидат.
 */
function loadOptionalEnvFile() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(path.dirname(app.getPath('exe')), 'voice-messenger.env'));
  }
  // v1.0.19: env-файл в папке данных (записывается из настроек приложения —
  // в Program Files писать нельзя, а в %APPDATA% можно)
  try {
    candidates.push(path.join(app.getPath('userData'), 'voice-messenger.env'));
  } catch { /* userData недоступен */ }
  // v1.0.20: строка подключения, вшитая в сборку (секрет NEON_DATABASE_URL)
  candidates.push(path.join(__dirname, '../voice-messenger.env'));
  candidates.push(path.join(__dirname, '../server/.env'));

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      let applied = 0;
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
          applied++;
        }
      }
      if (applied > 0) {
        console.log(`[Embedded] Загружен файл переменных: ${file}`);
        return;
      }
      // файл без полезных переменных — проверяем следующий кандидат
    } catch { /* не критично */ }
  }
}

/**
 * Путь к скомпилированному серверу внутри приложения (или в исходниках).
 * v1.0.18: сначала index.bundle.mjs — сервер, собранный esbuild ВМЕСТЕ со
 * всеми зависимостями. Раньше мы клали в пакет server/node_modules, но
 * electron-builder молча выбрасывал вложенные node_modules → встроенный
 * сервер падал с ERR_MODULE_NOT_FOUND → «Нет связи с сервером».
 */
function getServerEntryPath() {
  // asar: false → в пакете сервер лежит рядом как обычные файлы
  const candidates = [
    path.join(__dirname, '../server/dist/index.bundle.mjs'),                  // исходники / unpacked
    path.join(__dirname, '../server/dist/index.js'),                          // исходники без бандла
    path.join(process.resourcesPath || '', 'app/server/dist/index.bundle.mjs'), // установленное приложение
    path.join(process.resourcesPath || '', 'app/server/dist/index.js'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* resourcesPath может отсутствовать */ }
  }
  return null;
}

// ─── Резервный запуск сервера ОТДЕЛЬНЫМ процессом ───
let serverChild = null;
function stopServerChild() {
  if (serverChild) {
    try { serverChild.kill(); } catch { /* уже мёртв */ }
    serverChild = null;
  }
}

/**
 * Шаг 3 цепочки: запускаем встроенный сервер.
 * Попытка 1 — in-process import() (быстро; Electron содержит Node.js).
 * Попытка 2 — отдельный процесс через ELECTRON_RUN_AS_NODE (изоляция:
 * работает даже если у Electron-сборки капризный ESM-лоадер).
 * Сервер слушает 0.0.0.0:3001 + отвечает на UDP-поиск на :3002.
 */
async function startEmbeddedServer() {
  const serverEntry = getServerEntryPath();
  if (!serverEntry) {
    console.warn('[Embedded] server/dist/index.bundle.mjs не найден — встроенный хостинг недоступен');
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

  // ─── Попытка 1: in-process ───
  try {
    console.log('[Embedded] 🏠 Сервер в сети не найден — этот ПК становится ХОСТОМ (in-process)...');
    await import(url.pathToFileURL(serverEntry).href);
    if (await waitForLocalHealth(12000)) {
      console.log('[Embedded] ✅ Встроенный сервер работает на', LOCAL_URL, '(0.0.0.0)');
      console.log('[Embedded] → Все, кто запустит приложение в этой сети, подключатся к вам автоматически');
      return true;
    }
    console.warn('[Embedded] In-process сервер не ответил на /health — пробую отдельным процессом');
    stopServerChild();
  } catch (err) {
    console.error('[Embedded] In-process запуск не удался:', err?.message || err);
  }

  // ─── Попытка 2: отдельный Node-процесс (ELECTRON_RUN_AS_NODE) ───
  try {
    console.log('[Embedded] 🏠 Запускаю сервер отдельным процессом (ELECTRON_RUN_AS_NODE)...');
    const serverLog = path.join(app.getPath('userData'), 'server.log');
    const out = fs.openSync(serverLog, 'a');
    serverChild = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    serverChild.on('exit', (code) => {
      console.warn(`[Embedded] Процесс сервера завершился (код ${code})`);
      serverChild = null;
    });
    if (await waitForLocalHealth(12000)) {
      console.log('[Embedded] ✅ Сервер-процесс работает на', LOCAL_URL, '(лог: ' + serverLog + ')');
      return true;
    }
    console.error('[Embedded] Сервер-процесс тоже не ответил на /health. Смотрите server.log:', serverLog);
  } catch (err) {
    console.error('[Embedded] Запуск отдельным процессом не удался:', err?.message || err);
  }

  return false;
}

/** Возвращает URL сервера, к которому подключается UI. */
async function resolveServerTarget() {
  // Шаг 1: сервер уже работает на этом ПК? (127.0.0.1 — чтобы не зависеть
  // от того, во что Windows разрешил имя «localhost»: IPv4 или IPv6)
  if (await checkHttpHealth(`${LOCAL_URL}/health`, 600)) {
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

  // Шаг 4: ничего не вышло — остаёмся на localhost. Экран входа покажет
  // ошибку и кнопку «Перезапустить сервер», подробности — в main.log.
  console.error('[Chain] Шаг 4 ❌ Встроенный сервер запустить не удалось — подробности в main.log');
  return LOCAL_URL;
}

function localHtmlPath() {
  return path.join(__dirname, '../client/dist/index.html');
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
      preload: path.join(__dirname, 'preload.cjs'),
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
  if (fs.existsSync(localHtmlPath())) {
    console.log('✅ Resolved server target:', serverTarget);
    mainWindow.loadFile(localHtmlPath(), { query: { server: serverTarget } });
  } else {
    // Development fallback
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ────────────────────────────────────────────────────────────────
// v1.0.18: IPC «Перезапустить сервер» — раньше кнопка «Проверить снова»
// просто перезагружала страницу с ТЕМ ЖЕ мёртвым адресом (query не менялся),
// поэтому пользователь никак не мог вытащить приложение из тупика.
// ────────────────────────────────────────────────────────────────
ipcMain.handle('vm:rehost', async () => {
  console.log('[Rehost] 🔁 Пользователь запросил перезапуск сервера');
  stopServerChild();
  const target = await resolveServerTarget();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.loadFile(localHtmlPath(), { query: { server: target } });
    } catch (err) {
      console.warn('[Rehost] Не удалось перезагрузить окно:', err?.message || err);
    }
  }
  return { ok: true, url: target, logPath: getLogPath() };
});

// ────────────────────────────────────────────────────────────────
// v1.0.19: IPC «База данных (Neon)» — пользователь вставляет строку
// подключения в настройках, мы сохраняем её в %APPDATA%/VoiceMessenger/
// voice-messenger.env и перезапускаем приложение (встроенный сервер
// подхватит DATABASE_URL при старте).
// ────────────────────────────────────────────────────────────────
const userDataEnvFile = () => path.join(app.getPath('userData'), 'voice-messenger.env');

ipcMain.handle('vm:get-db-config', () => {
  let configured = false;
  try { configured = fs.existsSync(userDataEnvFile()); } catch { /* нет доступа */ }
  return { configured, envFile: userDataEnvFile() };
});

ipcMain.handle('vm:save-db-config', (_e, rawUrl) => {
  const value = String(rawUrl || '').trim();
  try {
    if (!value) {
      // Пустая строка = отключить базу (вернуться в файловый режим)
      fs.rmSync(userDataEnvFile(), { force: true });
    } else {
      if (!/^postgres(ql)?:\/\//i.test(value)) {
        return { ok: false, error: 'Строка подключения должна начинаться с postgresql:// …' };
      }
      let parsed;
      try { parsed = new URL(value); } catch { return { ok: false, error: 'Некорректная строка подключения' }; }
      if (!parsed.hostname) return { ok: false, error: 'В строке нет хоста базы данных' };
      fs.mkdirSync(path.dirname(userDataEnvFile()), { recursive: true });
      fs.writeFileSync(userDataEnvFile(), `DATABASE_URL=${value}\n`, 'utf8');
      console.log(`[DB] Сохранена строка подключения Neon → ${parsed.host}`);
    }
  } catch (err) {
    return { ok: false, error: 'Не удалось сохранить файл настроек: ' + (err?.message || err) };
  }
  // Чистый перезапуск: убираем дочерний сервер-процесс и стартуем заново
  stopServerChild();
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

app.whenReady().then(async () => {
  initFileLogging();
  console.log(`🚀 Voice Messenger v1.0.20 (Electron ${process.versions.electron}, Node ${process.versions.node})`);
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

app.on('before-quit', () => {
  stopServerChild();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
