/**
 * v1.0.18: мост между экраном входа и цепочкой запуска в main-процессе.
 * Через contextBridge отдаём ровно две безопасные вещи:
 *  - isDesktop: true      → UI понимает, что это настольное приложение
 *  - rehost()             → перезапустить цепочку (localhost → UDP → встроенный хост)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceMessenger', {
  isDesktop: true,
  rehost: () => ipcRenderer.invoke('vm:rehost'),
});
