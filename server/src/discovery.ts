import dgram from 'dgram';
import os from 'os';

/**
 * v1.0.14: UDP-обнаружение хоста в локальной сети.
 *
 * Логика цепочки запуска (по требованию): когда кто-то открывает приложение,
 * оно широковещательным UDP-пакетом спрашивает «есть ли уже сервер в сети?».
 * Этот модуль — ответчик: слушает UDP :3002, на магический запрос
 * «VM_DISCOVER_V1» отвечает «VM_HERE_V1|http://<мой-LAN-IP>:<порт>».
 * Клиент берёт ссылку и подключается — вводить IP вручную не нужно.
 */

export const DISCOVERY_PORT = Number(process.env.VM_DISCOVERY_PORT) || 3002;
export const DISCOVERY_MAGIC = 'VM_DISCOVER_V1';
export const DISCOVERY_REPLY_PREFIX = 'VM_HERE_V1|';

function getLocalIpv4Addresses(): string[] {
  const result: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.internal || net.family !== 'IPv4') continue;
      result.push(net.address);
    }
  }
  return result;
}

/**
 * Выбираем наш IP из той же /24-подсети, что у спрашивающего, — тогда
 * ссылка будет гарантированно доступна ему (у хоста может быть несколько
 * сетевых интерфейсов: Wi-Fi, Ethernet, виртуальные адаптеры).
 */
function pickBestLocalIp(senderIp: string): string {
  const ips = getLocalIpv4Addresses();
  const s = senderIp.split('.');
  if (s.length === 4) {
    for (const ip of ips) {
      const p = ip.split('.');
      // Совпадение первых трёх октетов = одна /24-подсеть (типичный домашний Wi-Fi)
      if (p[0] === s[0] && p[1] === s[1] && p[2] === s[2]) return ip;
    }
  }
  return ips[0] || '127.0.0.1';
}

let responderStarted = false;

export function startDiscoveryResponder(httpPort: number): void {
  if (responderStarted) return;
  responderStarted = true;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err: NodeJS.ErrnoException) => {
    // EADDRINUSE — на этом ПК уже работает другой экземпляр с ответчиком:
    // обнаружение всё равно будет работать через него, не критично.
    console.warn(`[Discovery] UDP-ответчик: ${err.message} (порт ${DISCOVERY_PORT})`);
    try { sock.close(); } catch { /* уже закрыт */ }
  });

  sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_MAGIC) return;

    const reply = `${DISCOVERY_REPLY_PREFIX}http://${pickBestLocalIp(rinfo.address)}:${httpPort}`;
    sock.send(Buffer.from(reply), rinfo.port, rinfo.address, () => {
      console.log(`[Discovery] Ответили ${rinfo.address}:${rinfo.port} → ${reply}`);
    });
  });

  sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    try { sock.setBroadcast(true); } catch { /* не критично */ }
    console.log(`[Discovery] ✅ UDP-ответчик запущен на порту ${DISCOVERY_PORT} — приложение друзей найдёт этот сервер автоматически`);
  });
}
