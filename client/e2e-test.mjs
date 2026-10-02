/**
 * E2E тест Voice Messenger v1.0.9
 * Проверяет: регистрацию, чат, историю через реконнект, пароли,
 * дубли имён, сигналинг звонков, занятость и API обновлений.
 * Запуск: bun e2e-test.mjs [serverUrl]
 */
import { io } from 'socket.io-client';

const SERVER = process.argv[2] || 'http://localhost:3001';
let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Ждёт событие на сокете с таймаутом */
function waitFor(socket, event, timeoutMs = 4000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting "${event}"`));
    }, timeoutMs);
    const handler = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    };
    socket.on(event, handler);
  });
}

/** Подключение + регистрация */
function connectAndRegister(username, password) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error(`register timeout: ${username}`)), 5000);
    socket.on('connect', () => {
      socket.emit('user:register', { username, password });
    });
    socket.on('user:registered', ({ user }) => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.on('user:register_failed', ({ message }) => {
      clearTimeout(t);
      resolve({ failed: true, message, socket });
    });
  });
}

console.log(`\n🧪 E2E тесты против ${SERVER}\n`);

// ─── 1. Регистрация ───
console.log('1. Регистрация пользователей');
const alice = await connectAndRegister('Alice');
ok('Alice зарегистрирована', !alice.failed && alice.id);
const bob = await connectAndRegister('Bob');
ok('Bob зарегистрирован', !bob.failed && bob.id);

// ─── 2. Отправка сообщения ───
console.log('2. Личные сообщения');
const bobReceiveP = waitFor(bob, 'chat:receive', 4000, m => m.senderName === 'Alice' && m.text === 'Привет, Bob!');
const aliceEchoP = waitFor(alice, 'chat:receive', 4000, m => m.senderName === 'Alice' && m.text === 'Привет, Bob!');
alice.emit('chat:send', { recipientId: bob.id, text: 'Привет, Bob!', mediaType: 'text' });
const [bobMsg, aliceMsg] = await Promise.all([bobReceiveP, aliceEchoP]);
ok('Bob получил сообщение', bobMsg.text === 'Привет, Bob!');
ok('Alice получила эхо своего сообщения', aliceMsg.text === 'Привет, Bob!');
ok('В сообщении есть recipientName (Bob)', bobMsg.recipientName === 'Bob');

// ─── 3. История выживает реконнект (ГЛАВНЫЙ ФИКС) ───
console.log('3. История чата через переподключение');
alice.disconnect();
await wait(300);
const alice2 = await connectAndRegister('Alice');
ok('Alice переподключилась с НОВЫМ socket.id', alice2.id !== alice.id);
const histP = waitFor(alice2, 'chat:history_loaded', 4000, h => h.recipientId === 'Bob');
alice2.emit('chat:history', { recipientId: bob.id, recipientUsername: 'Bob' });
const hist = await histP;
ok(`История сохранилась после реконнекта (${hist.messages.length} сообщ.)`, hist.messages.length >= 1 && hist.messages.some(m => m.text === 'Привет, Bob!'));

// ─── 4. История доступна, когда собеседник офлайн ───
console.log('4. История при офлайн-собеседнике');
bob.disconnect();
await wait(300);
const hist2P = waitFor(alice2, 'chat:history_loaded', 4000, h => h.recipientId === 'Bob');
alice2.emit('chat:history', { recipientId: 'offline', recipientUsername: 'Bob' });
const hist2 = await hist2P;
ok('История получена пока Bob офлайн', hist2.messages.length >= 1);

// ─── 5. Пароли ───
console.log('5. Защита имени паролем');
const carol = await connectAndRegister('Carol', 'secret123');
ok('Carol зарегистрирована с паролем', !carol.failed);
carol.disconnect();
await wait(300);

const carolNoPass = await connectAndRegister('Carol');
ok('Вход без пароля отклонён', carolNoPass.failed === true, `получено: ${carolNoPass.failed ? carolNoPass.message : JSON.stringify({ failed: carolNoPass.failed })}`);
const carolWrong = await connectAndRegister('Carol', 'wrongpass');
ok('Вход с неверным паролем отклонён', carolWrong.failed === true, `получено: ${carolWrong.failed ? carolWrong.message : 'успех?!'}`);
const carolOk = await connectAndRegister('Carol', 'secret123');
ok('Вход с верным паролем работает', !carolOk.failed);

// ─── 6. Дубликат имени (второе окно) ───
console.log('6. Дубликат имени');
const dave = await connectAndRegister('Dave');
const replacedP = waitFor(dave, 'user:replaced', 4000);
const dave2res = await connectAndRegister('Dave');
ok('Второй Dave вошёл', !dave2res.failed);
let replaced = false;
try { await replacedP; replaced = true; } catch {}
ok('Первый Dave получил user:replaced и отключён', replaced && !dave.connected);

// ─── 7. Сигналинг звонка ───
console.log('7. WebRTC сигналинг (аудио-звонки)');
const fakeOffer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };
const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\n' };

// чистим Carol (не нужна) и возвращаем Bob онлайн (он отключался в шаге 4)
carolOk.disconnect();
const bob2 = await connectAndRegister('Bob');
ok('Bob снова в сети', !bob2.failed);

const incomingP = waitFor(bob2, 'call:incoming', 4000, c => c.callerName === 'Alice');
const acceptAckP = waitFor(alice2, 'call:accepted', 4000);
alice2.emit('call:initiate', { targetUserId: bob2.id, offer: fakeOffer });
const incoming = await incomingP;
ok('Bob получил входящий звонок от Alice', Boolean(incoming.callerId));

bob2.emit('call:accept', { callerId: incoming.callerId, answer: fakeAnswer });
const accepted = await acceptAckP;
ok('Alice получила подтверждение (answer)', accepted.answer?.type === 'answer');

// ICE-кандидаты
const iceP = waitFor(bob2, 'call:ice_candidate', 4000, c => c.candidate?.candidate === 'fake-ice-alice');
alice2.emit('call:ice_candidate', { targetUserId: bob2.id, candidate: { candidate: 'fake-ice-alice' } });
const iceMsg = await iceP;
ok('ICE-кандидат доставлен Alice→Bob', Boolean(iceMsg.candidate));

const iceP2 = waitFor(alice2, 'call:ice_candidate', 4000, c => c.candidate?.candidate === 'fake-ice-bob');
bob2.emit('call:ice_candidate', { targetUserId: alice2.id, candidate: { candidate: 'fake-ice-bob' } });
await iceP2;
ok('ICE-кандидат доставлен Bob→Alice', true);

// Relay audio: бинарный чанк
const relayP = waitFor(bob2, 'audio:data', 4000);
alice2.emit('audio:data', { targetUserId: bob2.id, audio: new Uint8Array([1, 2, 3]).buffer });
const relayMsg = await relayP;
ok('Relay-аудио доставлено (бинарный чанк)', relayMsg.audio instanceof ArrayBuffer || relayMsg.audio?.byteLength > 0 || Boolean(relayMsg.audio));

// Завершение звонка
const endP = waitFor(bob2, 'call:ended', 4000);
alice2.emit('call:end', { targetUserId: bob2.id });
await endP;
ok('Bob получил call:ended', true);

// ─── 8. Занятость (защита от параллельных звонков) ───
console.log('8. Занятость пользователя');
const carolOk2 = await connectAndRegister('Carol', 'secret123');
const incomingBusyP = waitFor(bob2, 'call:incoming', 4000, c => c.callerName === 'Alice');
alice2.emit('call:initiate', { targetUserId: bob2.id, offer: fakeOffer });
await incomingBusyP;
const rejectedP = waitFor(carolOk2, 'call:rejected', 4000, r => (r.reason || '').includes('занят'));
carolOk2.emit('call:initiate', { targetUserId: bob2.id, offer: fakeOffer });
const rej = await rejectedP;
ok('Carol получила «пользователь занят»', Boolean(rej.reason));
// сброс
const endP2 = waitFor(bob2, 'call:ended', 4000);
alice2.emit('call:end', { targetUserId: bob2.id });
await endP2;
ok('Звонок завершён корректно', true);

// ─── 9. Оффлайн-цель: call:initiate на несуществующего ───
console.log('9. Вызов несуществующего пользователя');
const failP = waitFor(alice2, 'call:failed', 4000);
alice2.emit('call:initiate', { targetUserId: 'nonexistent-id', offer: fakeOffer });
const failMsg = await failP;
ok('Получен call:failed «не найден»', Boolean(failMsg.message));

// ─── 10. HTTP API обновлений ───
console.log('10. API автообновлений');
const health = await fetch(`${SERVER}/health`).then(r => r.json());
ok('/health отвечает', health.status === 'ok' && typeof health.onlineCount === 'number');

const pub = await fetch(`${SERVER}/api/updates/publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: '9.9.9-test', payloadBase64: Buffer.from('fake-asar-payload-for-testing').toString('base64'), releaseNotes: 'test' }),
}).then(r => r.json());
ok('POST /api/updates/publish — ok', pub.success === true, JSON.stringify(pub));

const check = await fetch(`${SERVER}/api/updates/check`).then(r => r.json());
ok('GET /api/updates/check видит релиз 9.9.9-test', check.available && check.latestVersion === '9.9.9-test', JSON.stringify(check));

const dl = await fetch(`${SERVER}/api/updates/download/9.9.9-test`);
const dlBuf = await dl.text();
ok('GET /api/updates/download отдаёт payload', dlBuf === 'fake-asar-payload-for-testing', `получено: ${dlBuf.slice(0, 40)}`);

// ─── Итог ───
console.log('\n' + '═'.repeat(50));
console.log(`📊 Результат: ${passed} ✅ / ${failed} ❌`);
console.log('═'.repeat(50) + '\n');
process.exit(failed > 0 ? 1 : 0);
