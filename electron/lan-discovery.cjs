/**
 * v1.0.14: Клиентская часть UDP-обнаружения хост-сервера в локальной сети.
 *
 * Цепочка запуска приложения:
 *   1. localhost:3001 уже работает?          → подключаемся к нему
 *   2. UDP-broadcast «VM_DISCOVER_V1» → :3002 → чужой хост отвечает ссылкой
 *   3. Никого не нашли?                       → сами становимся хостом
 *      (main.cjs запускает встроенный сервер, другие найдут его этим же поиском)
 *
 * Модуль отдельный (CJS) — его можно тестировать без запуска Electron.
 */

const dgram = require('dgram');
const http = require('http');

const DISCOVERY_PORT = Number(process.env.VM_DISCOVERY_PORT) || 3002;
const DISCOVERY_MAGIC = 'VM_DISCOVER_V1';
const REPLY_PREFIX = 'VM_HERE_V1|';
const URL_RE = /^http:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;

/** Все широковещательные адреса наших IPv4-интерфейсов + глобальный 255.255.255.255 */
function getBroadcastAddresses() {
  const list = ['255.255.255.255'];
  const nets = os_networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      const octets = net.address.split('.');
      octets[3] = '255';
      const b = octets.join('.');
      if (!list.includes(b)) list.push(b);
    }
  }
  return list;
}

// Обёртка для удобства стаб-тестирования
function os_networkInterfaces() {
  return require('os').networkInterfaces();
}

/**
 * Ищет сервер в локальной сети UDP-broadcast'ом.
 * @param {number} timeoutMs сколько ждать ответа (по умолчанию 1600 мс)
 * @returns {Promise<string|null>} «http://IP:3001» или null, если никто не ответил
 */
function discoverLanServer(timeoutMs = 1600) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* уже закрыт */ }
      resolve(url);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on('error', () => finish(null));

    sock.on('message', (msg) => {
      const text = msg.toString('utf8');
      if (!text.startsWith(REPLY_PREFIX)) return;
      const url = text.slice(REPLY_PREFIX.length).trim();
      if (URL_RE.test(url)) {
        console.log(`[Discovery] 🔎 Найден сервер в сети: ${url}`);
        finish(url);
      }
    });

    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* не критично */ }
      const payload = Buffer.from(DISCOVERY_MAGIC);
      for (const broadcastAddr of getBroadcastAddresses()) {
        try { sock.send(payload, DISCOVERY_PORT, broadcastAddr); } catch { /* интерфейс может не слать broadcast */ }
      }
    });
  });
}

/** Проверяет, что HTTP-эндпоинт жив (например /health). */
function checkHttpHealth(url, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        finish(res.statusCode === 200);
      });
      req.on('timeout', () => { req.destroy(); finish(false); });
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Ждёт появления /health на localhost:3001 (встроенный сервер стартует асинхронно). */
async function waitForLocalHealth(timeoutMs = 10000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHttpHealth('http://localhost:3001/health', 700)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = { discoverLanServer, checkHttpHealth, waitForLocalHealth, DISCOVERY_PORT };
