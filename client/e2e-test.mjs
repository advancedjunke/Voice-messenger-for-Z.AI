/**
 * E2E тест Voice Messenger v1.0.12
 * Проверяет: регистрацию, чат, историю через реконнект, пароли,
 * дубли имён, сигналинг звонков, занятость, офлайн-сообщения, ответы,
 * удаление сообщений, last seen, пересылку и API обновлений.
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

// ─── 8.5 Индикатор «печатает…» (v1.0.10) ───
console.log('8.5 Индикатор «печатает…»');
const typingOnP = waitFor(bob2, 'chat:typing', 4000, t => t.fromName === 'Alice' && t.isTyping === true);
alice2.emit('chat:typing', { recipientId: bob2.id, isTyping: true });
const typingOn = await typingOnP;
ok('Bob видит «Alice печатает…»', typingOn.isTyping === true);

const typingOffP = waitFor(bob2, 'chat:typing', 4000, t => t.fromName === 'Alice' && t.isTyping === false);
alice2.emit('chat:typing', { recipientId: bob2.id, isTyping: false });
const typingOff = await typingOffP;
ok('Bob видит остановку «печатает…»', typingOff.isTyping === false);

// ─── 8.6 Read receipts (v1.0.10) ───
console.log('8.6 Квитанции о прочтении');
// Bob подтверждает прочтение сообщений Alice → Alice получает chat:read_ack
const readAckP = waitFor(alice2, 'chat:read_ack', 4000, a => a.readerName === 'Bob');
bob2.emit('chat:read', { partnerUsername: 'Alice' });
const readAck = await readAckP;
ok('Alice получила chat:read_ack от Bob', readAck.readerName === 'Bob');
// обратное направление
const readAck2P = waitFor(bob2, 'chat:read_ack', 4000, a => a.readerName === 'Alice');
alice2.emit('chat:read', { partnerUsername: 'Bob' });
const readAck2 = await readAck2P;
ok('Bob получил chat:read_ack от Alice', readAck2.readerName === 'Alice');

// ─── 8.7 Офлайн-сообщения (v1.0.11) ───
console.log('8.7 Офлайн-сообщения (отправка по имени)');
bob2.disconnect();
await wait(300);
const offEchoP = waitFor(alice2, 'chat:receive', 4000, m => m.text === 'офлайн-привет' && m.senderName === 'Alice');
alice2.emit('chat:send', { recipientUsername: 'Bob', text: 'офлайн-привет', mediaType: 'text' });
const offEcho = await offEchoP;
ok('Эхо офлайн-отправки получено (сервер не отклонил)', Boolean(offEcho.id));
ok('Сообщение адресовано Bob по имени (recipientName)', offEcho.recipientName === 'Bob');

const bob3 = await connectAndRegister('Bob');
ok('Bob снова в сети', !bob3.failed);
const hist3P = waitFor(bob3, 'chat:history_loaded', 4000, h => h.recipientId === 'Alice');
bob3.emit('chat:history', { recipientUsername: 'Alice' });
const hist3 = await hist3P;
ok(`Bob видит сообщение, отправленное офлайн (${hist3.messages.length} сообщ.)`, hist3.messages.some(m => m.text === 'офлайн-привет'));

// ─── 8.8 Ответы на сообщения (v1.0.11) ───
console.log('8.8 Ответы на сообщения (reply)');
const replyRecvP = waitFor(bob3, 'chat:receive', 4000, m => m.text === 'Отвечаю!');
alice2.emit('chat:send', {
  recipientUsername: 'Bob',
  text: 'Отвечаю!',
  mediaType: 'text',
  replyTo: { id: offEcho.id, senderName: 'Alice', text: 'офлайн-привет', mediaType: 'text' },
});
const replyMsg = await replyRecvP;
ok('Bob получил сообщение с replyTo (сниппет сохранён)', replyMsg.replyTo?.text === 'офлайн-привет' && replyMsg.replyTo?.senderName === 'Alice');

// ─── 8.9 Удаление сообщений (v1.0.11) ───
console.log('8.9 Удаление сообщений');
// Bob пытается удалить ЧУЖОЕ сообщение → отказ
const delFailP = waitFor(bob3, 'chat:delete_failed', 4000);
bob3.emit('chat:delete', { partnerUsername: 'Alice', messageId: replyMsg.id });
const delFail = await delFailP;
ok('Чужое сообщение удалить нельзя (chat:delete_failed)', Boolean(delFail.message));

// Alice удаляет СВОЁ сообщение → обе стороны уведомлены
const delAckP = waitFor(alice2, 'chat:message_deleted', 4000, d => d.messageId === replyMsg.id);
const delRecvP = waitFor(bob3, 'chat:message_deleted', 4000, d => d.messageId === replyMsg.id);
alice2.emit('chat:delete', { partnerUsername: 'Bob', messageId: replyMsg.id });
await Promise.all([delAckP, delRecvP]);
ok('Обе стороны уведомлены о удалении', true);

const hist4P = waitFor(bob3, 'chat:history_loaded', 4000, h => h.recipientId === 'Alice');
bob3.emit('chat:history', { recipientUsername: 'Alice' });
const hist4 = await hist4P;
const deletedMsg = hist4.messages.find(m => m.id === replyMsg.id);
ok('В истории сообщение помечено deleted, контент стёрт', Boolean(deletedMsg?.deleted) && !deletedMsg?.text);

// ─── 8.10 Известные пользователи / last seen (v1.0.11) ───
console.log('8.10 Известные пользователи (last seen)');
const knownP = waitFor(alice2, 'users:known_list', 4000);
alice2.emit('users:known');
const known = await knownP;
const knownBob = (known.users || []).find(u => u.username.toLowerCase() === 'bob');
ok(`users:known_list содержит пользователей (${(known.users || []).length})`, (known.users || []).length >= 1);
ok('В списке есть Bob с lastSeen', Boolean(knownBob) && knownBob.lastSeen > 0);

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

// v1.0.11: удаление релиза (очистка за собой, чтобы клиенты не видели фантомный бейдж)
const delRel = await fetch(`${SERVER}/api/updates/publish/9.9.9-test`, { method: 'DELETE' }).then(r => r.json());
ok('DELETE /api/updates/publish/:version — ok', delRel.success === true, JSON.stringify(delRel));
const checkAfter = await fetch(`${SERVER}/api/updates/check`).then(r => r.json());
ok('После удаления релиза check → available:false', checkAfter.available === false, JSON.stringify(checkAfter));

// ─── 11. Пересылка сообщений (v1.0.12) ───
console.log('11. Пересылка сообщений (forward)');
const carolFwd = await connectAndRegister('Carol', 'secret123');
ok('Carol снова в сети (для forward)', !carolFwd.failed);

const carolFwdP = waitFor(carolFwd, 'chat:receive', 4000, m => m.text === 'Пересылаемое сообщение от Bob');
const fwdEchoP = waitFor(alice2, 'chat:receive', 4000, m => m.text === 'Пересылаемое сообщение от Bob');
alice2.emit('chat:send', {
  recipientUsername: 'Carol',
  text: 'Пересылаемое сообщение от Bob',
  mediaType: 'text',
  forwardedFrom: 'Bob',
});
const [carolFwdMsg, fwdEcho] = await Promise.all([carolFwdP, fwdEchoP]);
ok('Carol получила пересланное сообщение', Boolean(carolFwdMsg));
ok('Пересланное сообщение помечено forwardedFrom=Bob', carolFwdMsg.forwardedFrom === 'Bob', `получено: ${JSON.stringify(carolFwdMsg.forwardedFrom)}`);
ok('Эхо пересылки у отправителя тоже с forwardedFrom', fwdEcho.forwardedFrom === 'Bob');
carolFwd.disconnect();

// ─── 12. Бродкаст списка известных при регистрации (v1.0.12) ───
console.log('12. known_list обновляется у других клиентов при регистрации');
const freshListP = waitFor(alice2, 'users:known_list', 5000, d => (d.users || []).some(u => u.username === 'FwdUser'));
const fwdUser = await connectAndRegister('FwdUser');
ok('FwdUser зарегистрирован', !fwdUser.failed);
try {
  const freshList = await freshListP;
  ok('Alice получила обновлённый known_list с FwdUser без переподключения', (freshList.users || []).some(u => u.username === 'FwdUser'));
} catch {
  ok('Alice получила обновлённый known_list с FwdUser без переподключения', false, 'таймаут users:known_list');
}
fwdUser.disconnect();

// ─── Итог ───
console.log('\n' + '═'.repeat(50));
console.log(`📊 Результат: ${passed} ✅ / ${failed} ❌`);
console.log('═'.repeat(50) + '\n');
process.exit(failed > 0 ? 1 : 0);
