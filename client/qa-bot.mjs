/** QA-бот: Bob онлайн, шлёт «печатает…» и сообщение найденному пользователю QA (v1.0.22) */
import { io } from 'socket.io-client';
const socket = io('http://localhost:3001', { transports: ['websocket'] });
let qaId = null;
socket.on('connect', () => {
  console.log('[QABot] connected:', socket.id, '(bot v1.0.22)');
  socket.emit('user:register', { username: 'Bob' });
});
socket.on('users:update', (users) => {
  const qa = (users || []).find(u => u.username === 'QA');
  if (qa && qa.id !== qaId) {
    qaId = qa.id;
    console.log('[QABot] QA found:', qaId);
    // волны «печатает…» каждые 5с
    setInterval(() => {
      if (!qaId) return;
      socket.emit('chat:typing', { recipientId: qaId, isTyping: true });
      setTimeout(() => socket.emit('chat:typing', { recipientId: qaId, isTyping: false }), 2500);
    }, 5000);
    // сообщение через 6с
    setTimeout(() => {
      if (qaId) socket.emit('chat:send', { recipientId: qaId, text: 'Привет от Bob-бота! 👋 Как дела?' });
    }, 6000);
  }
});
setInterval(() => {}, 1000);
