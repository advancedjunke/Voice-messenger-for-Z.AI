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
// FIX (v1.0.21): ужесточили проверку URL из ответа — октеты строго 0-255, порт 1-65535,
// без ведущих нулей. Раньше \d{1,3} пропускал мусор вроде 999.999.999.999:99999.
// По-прежнему принимаем только plain http + IPv4 — это сознательное ограничение для LAN.
const URL_RE = /^http:\/\/(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}:(6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3})$/;

/** «192.168.1.5» → [192,168,1,5]; null, если это не валидный IPv4 */
function parseIPv4Octets(str) {
  if (typeof str !== 'string') return null;
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Все широковещательные адреса наших IPv4-интерфейсов + глобальный 255.255.255.255 */
function getBroadcastAddresses() {
  const list = ['255.255.255.255'];
  const nets = os_networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      // FIX (v1.0.21): broadcast считается по НАСТОЯЩЕЙ маске подсети:
      //   broadcast = (ip AND netmask) OR (NOT netmask)
      // Раньше последний октет просто заменялся на .255 — это верно только для /24,
      // а в сетях /16 или /23 запрос уходил не на тот адрес.
      const ip = parseIPv4Octets(net.address);
      const mask = parseIPv4Octets(net.netmask);
      let b;
      if (ip && mask) {
        const bc = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255));
        b = bc.join('.');
      } else {
        // Фолбэк, если netmask недоступна: старый метод (корректен только для /24)
        const octets = String(net.address).split('.');
        octets[3] = '255';
        b = octets.join('.');
      }
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

/** Ждёт появления /health на 127.0.0.1:3001 (встроенный сервер стартует асинхронно). */
async function waitForLocalHealth(timeoutMs = 10000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // FIX (v1.0.21): 127.0.0.1 вместо 'localhost' — в тон всей цепочке main.cjs:
    // на Windows 'localhost' может резолвиться в IPv6 (::1), а встроенный
    // сервер слушает IPv4 — проверка здоровья могла ложно «падать».
    if (await checkHttpHealth('http://127.0.0.1:3001/health', 700)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = { discoverLanServer, checkHttpHealth, waitForLocalHealth, DISCOVERY_PORT };
