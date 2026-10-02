import React, { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, Server, Globe, Wifi, Info, RotateCcw } from 'lucide-react';

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
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
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
