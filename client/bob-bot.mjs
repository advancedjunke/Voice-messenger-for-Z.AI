/** Bob-бот: держит пользователя Bob онлайн для UI-тестов (v1.0.22) */
import { io } from 'socket.io-client';
const SERVER = process.argv[2] || 'http://localhost:3001';
const socket = io(SERVER, { transports: ['websocket'] });
socket.on('connect', () => {
  console.log('[BobBot] connected:', socket.id, '(bot v1.0.22)');
  socket.emit('user:register', { username: 'Bob' });
});
socket.on('disconnect', () => console.log('[BobBot] disconnected'));
setInterval(() => {}, 1000); // keep alive
