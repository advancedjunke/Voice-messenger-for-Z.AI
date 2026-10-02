import React, { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, Server, Globe, Wifi, Info, RotateCcw, Database, Loader2, Eye, EyeOff, PlugZap, Unplug } from 'lucide-react';

interface DbStatus {
  usingPostgres: boolean;
  connected: boolean;
  host: string | null;
}

interface ServerSettingsModalProps {
  isOpen: boolean;
  /** Текущий активный адрес сервера (resolved в App) */
  currentServerUrl: string;
  socketConnected: boolean;
  onClose: () => void;
}

/**
 * v1.0.13: Модалка «Настройки сервера» — замена голому prompt().
 * 1. Показывает активный адрес сервера и статус подключения.
 * 2. Тянет с сервера /api/server-info и показывает LAN-ссылки, которые можно
 *    отправить другу (друг открывает их в браузере — сервер раздаёт клиент сам).
 * 3. Позволяет ввести другой адрес (например http://192.168.1.5:3001) и сбросить.
 */
export const ServerSettingsModal: React.FC<ServerSettingsModalProps> = ({
  isOpen,
  currentServerUrl,
  socketConnected,
  onClose,
}) => {
  const [newUrl, setNewUrl] = useState('');
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [hostname, setHostname] = useState<string>('');
  const [infoLoading, setInfoLoading] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // v1.0.19: раздел «База данных (Neon PostgreSQL)»
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [dbUrl, setDbUrl] = useState('');
  const [showDbUrl, setShowDbUrl] = useState(false);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbNote, setDbNote] = useState<string | null>(null);

  // При открытии — заполняем поле текущим значением и тянем LAN-адреса
  useEffect(() => {
    if (!isOpen) return;
    setNewUrl(localStorage.getItem('vm_server_url') || currentServerUrl || '');
    setError(null);
    setCopiedUrl(null);
    setLanUrls([]);
    setHostname('');

    if (!currentServerUrl) return;
    setInfoLoading(true);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 4000);
    fetch(`${currentServerUrl}/api/server-info`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(data => {
        setLanUrls(Array.isArray(data?.lanUrls) ? data.lanUrls : []);
        setHostname(data?.hostname || '');
      })
      .catch(() => {
        // сервер недоступен по этому адресу — просто показываем пустой список
      })
      .finally(() => {
        window.clearTimeout(timer);
        setInfoLoading(false);
      });

    // v1.0.19: статус базы данных
    setDbStatus(null);
    setDbError(null);
    setDbNote(null);
    setDbBusy(false);
    const dbCtrl = new AbortController();
    const dbTimer = window.setTimeout(() => dbCtrl.abort(), 4000);
    fetch(`${currentServerUrl}/api/db/status`, { signal: dbCtrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(data => setDbStatus({ usingPostgres: !!data?.usingPostgres, connected: !!data?.connected, host: data?.host || null }))
      .catch(() => setDbStatus(null))
      .finally(() => window.clearTimeout(dbTimer));

    // Файл настроек существует? (только настольное приложение)
    const vm = (window as any).voiceMessenger;
    if (vm?.getDbConfig) {
      vm.getDbConfig().then((cfg: any) => setDbNote(cfg?.envFile || null)).catch(() => {});
    }

    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
      dbCtrl.abort();
      window.clearTimeout(dbTimer);
    };
  }, [isOpen, currentServerUrl]);

  /** Нормализация адреса: добавляем http:// если нет схемы, убираем хвостовой слэш */
  const normalizeUrl = (raw: string): string => {
    let u = raw.trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
    return u;
  };

  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback для file:// (Electron) без clipboard-разрешения
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* не критично */ }
      document.body.removeChild(ta);
    }
    setCopiedUrl(url);
    window.setTimeout(() => setCopiedUrl(prev => (prev === url ? null : prev)), 1800);
  }, []);

  const handleSave = () => {
    const u = normalizeUrl(newUrl);
    if (!u) {
      // Пусто = сброс на авто-определение
      localStorage.removeItem('vm_server_url');
      window.location.reload();
      return;
    }
    try {
      // Валидация: это должен быть корректный URL с хостом
      const parsed = new URL(u);
      if (!parsed.hostname) throw new Error('no hostname');
    } catch {
      setError('Некорректный адрес. Пример: http://192.168.1.5:3001');
      return;
    }
    localStorage.setItem('vm_server_url', u);
    window.location.reload();
  };

  const handleReset = () => {
    localStorage.removeItem('vm_server_url');
    window.location.reload();
  };

  // v1.0.19: сохранить строку Neon и перезапустить приложение
  const handleSaveDb = async () => {
    const vm = (window as any).voiceMessenger;
    if (!vm?.saveDbConfig) {
      setDbError('Доступно только в настольном приложении. Для сервера из батника создайте файл server/.env со строкой DATABASE_URL=…');
      return;
    }
    if (dbBusy) return;
    setDbError(null);
    setDbBusy(true);
    try {
      const res = await vm.saveDbConfig(dbUrl.trim());
      if (res && res.ok === false) {
        setDbError(res.error || 'Не удалось сохранить');
        setDbBusy(false);
      }
      // при успехе приложение само перезапустится (app.relaunch)
    } catch {
      // окно уже перезапускается
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Настройки сервера"
    >
      <div
        className="w-full max-w-md bg-gray-900 border border-gray-700/80 rounded-2xl shadow-2xl overflow-hidden animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center">
              <Server className="w-4.5 h-4.5 text-purple-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm">Настройки сервера</h3>
              <p className="text-[11px] text-gray-500">Подключение к хосту мессенджера</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
          {/* Текущий сервер */}
          <div className="flex items-center justify-between p-3 rounded-xl bg-gray-800/50 border border-gray-700/60">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-0.5">
                Активный сервер
              </p>
              <p className="text-xs text-gray-200 font-mono truncate" title={currentServerUrl}>
                {currentServerUrl || 'не определён'}
              </p>
            </div>
            <span
              className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold border ${
                socketConnected
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-red-500/10 text-red-400 border-red-500/20'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${socketConnected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {socketConnected ? 'Онлайн' : 'Нет связи'}
            </span>
          </div>

          {/* LAN-ссылки для друзей */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              <h4 className="text-xs font-semibold text-gray-300">
                Пригласить друга (та же Wi-Fi / LAN сеть)
              </h4>
            </div>

            {infoLoading ? (
              <div className="p-3 rounded-xl bg-gray-800/40 border border-gray-700/50 text-[11px] text-gray-500">
                Получаем адреса с сервера…
              </div>
            ) : lanUrls.length > 0 ? (
              <div className="space-y-2">
                {lanUrls.map(url => (
                  <div
                    key={url}
                    className="flex items-center gap-2 p-2.5 rounded-xl bg-gray-800/60 border border-gray-700/60"
                  >
                    <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <code className="flex-1 text-[11px] text-emerald-300 font-mono truncate" title={url}>
                      {url}
                    </code>
                    <button
                      onClick={() => handleCopy(url)}
                      title="Скопировать ссылку"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors shrink-0"
                    >
                      {copiedUrl === url ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ))}
                <p className="text-[11px] text-gray-500 leading-relaxed flex gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0 text-gray-600" />
                  <span>
                    Отправьте другу ссылку{hostname ? ` (ПК «${hostname}»)` : ''} — он откроет её в
                    браузере и сразу попадёт в этот сервер. Если не открывается — разрешите порт в
                    брандмауэре Windows (см. README, раздел «Хостинг в локальной сети»).
                  </span>
                </p>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-[11px] text-amber-200/80 leading-relaxed">
                Не удалось получить LAN-адреса с активного сервера. Если вы хостите сервер у себя —
                найдите IP своего ПК (команда <code className="font-mono">ipconfig</code> в Windows)
                и дайте другу адрес вида <code className="font-mono">http://192.168.x.x:3001</code>.
              </div>
            )}
          </div>

          {/* ─── v1.0.19: База данных (Neon PostgreSQL) ─── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-sky-400" />
                <h4 className="text-xs font-semibold text-gray-300">База данных (Neon PostgreSQL)</h4>
              </div>
              {dbStatus && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                    dbStatus.usingPostgres && dbStatus.connected
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : dbStatus.usingPostgres
                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      : 'bg-gray-700/40 text-gray-400 border-gray-600/40'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      dbStatus.usingPostgres && dbStatus.connected
                        ? 'bg-emerald-400 animate-pulse'
                        : dbStatus.usingPostgres
                        ? 'bg-amber-400'
                        : 'bg-gray-500'
                    }`}
                  />
                  {dbStatus.usingPostgres && dbStatus.connected
                    ? 'Neon подключён'
                    : dbStatus.usingPostgres
                    ? 'Ошибка подключения'
                    : 'Файловый режим'}
                </span>
              )}
            </div>

            {dbStatus && (
              <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
                {dbStatus.usingPostgres && dbStatus.connected
                  ? `История переписки и аккаунты хранятся централизованно (${dbStatus.host}). Подключите эту же базу у друзей-хостов — увидите общую историю.`
                  : dbStatus.usingPostgres
                  ? `Строка подключения задана (${dbStatus.host}), но сервер не смог подключиться. Проверьте строку и доступность базы.`
                  : 'История сообщений живёт только в памяти хоста и очищается при его перезапуске. Подключите бесплатную базу Neon — и история будет сохраняться навсегда.'}
              </p>
            )}

            <div className="relative">
              <Database className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input
                type={showDbUrl ? 'text' : 'password'}
                value={dbUrl}
                onChange={e => {
                  setDbUrl(e.target.value);
                  setDbError(null);
                }}
                placeholder="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"
                className="w-full pl-10 pr-10 py-2.5 bg-gray-800/80 border border-gray-700 rounded-xl text-xs text-white font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowDbUrl(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
                tabIndex={-1}
                aria-label={showDbUrl ? 'Скрыть строку подключения' : 'Показать строку подключения'}
              >
                {showDbUrl ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>

            {dbError && (
              <p className="mt-1.5 text-[11px] text-red-400 leading-relaxed">{dbError}</p>
            )}

            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleSaveDb}
                disabled={dbBusy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-sky-600 text-white hover:bg-sky-500 active:scale-95 disabled:opacity-60 transition-all shadow-lg shadow-sky-600/20"
              >
                {dbBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                {dbBusy ? 'Сохраняю…' : 'Подключить и перезапустить'}
              </button>
              {dbStatus?.usingPostgres && (window as any).voiceMessenger?.saveDbConfig && (
                <button
                  onClick={() => { setDbUrl(''); handleSaveDb(); }}
                  disabled={dbBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Отключить базу
                </button>
              )}
            </div>

            {dbNote && (
              <p className="mt-1.5 text-[10px] text-gray-600 font-mono truncate" title={dbNote}>
                Настройки: {dbNote}
              </p>
            )}

            <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 text-gray-600" />
              <span>
                Бесплатно на <a href="https://neon.tech" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">neon.tech</a>:
                создайте проект → скопируйте Connection string → вставьте сюда. База нужна только хосту.
              </span>
            </p>
          </div>

          {/* Смена адреса */}
          <div>
            <label htmlFor="server-url-input" className="block text-xs font-semibold text-gray-300 mb-2">
              Адрес другого сервера
            </label>
            <input
              id="server-url-input"
              type="text"
              value={newUrl}
              onChange={e => {
                setNewUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="http://192.168.1.5:3001"
              className="w-full px-3.5 py-2.5 bg-gray-800/80 border border-gray-700 rounded-xl text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-all"
            />
            {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
            <p className="mt-1.5 text-[11px] text-gray-500">
              Пустое поле + «Сохранить» = авто-определение (как раньше).
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-gray-800 bg-gray-900/80">
          <button
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            title="Убрать сохранённый адрес и определить сервер автоматически"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Сбросить
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-purple-600 text-white hover:bg-purple-500 active:scale-95 transition-all shadow-lg shadow-purple-600/20"
            >
              Сохранить и перезагрузить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
