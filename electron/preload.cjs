/**
 * v1.0.18: мост между UI и цепочкой запуска в main-процессе.
 * v1.0.19: + управление базой данных (Neon PostgreSQL).
 * Через contextBridge отдаём только безопасные, явные методы:
 *  - isDesktop: true      → UI понимает, что это настольное приложение
 *  - rehost()             → перезапустить цепочку (localhost → UDP → встроенный хост)
 *  - getDbConfig()        → настроена ли база данных (env-файл)
 *  - saveDbConfig(url)    → сохранить строку Neon и перезапустить приложение ('' = отключить)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceMessenger', {
  isDesktop: true,
  rehost: () => ipcRenderer.invoke('vm:rehost'),
  getDbConfig: () => ipcRenderer.invoke('vm:get-db-config'),
  saveDbConfig: (url) => ipcRenderer.invoke('vm:save-db-config', url),
});
