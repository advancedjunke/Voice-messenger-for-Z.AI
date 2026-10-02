import React, { useState, useEffect, useRef } from 'react';
import {
  PhoneCall, Lock, User as UserIcon, AlertCircle, LogIn, UserPlus,
  CheckCircle2, XCircle, Loader2, RefreshCw, ShieldCheck, Eye, EyeOff, WifiOff,
} from 'lucide-react';

type Mode = 'login' | 'register';
type NameStatus = 'idle' | 'checking' | 'free' | 'taken' | 'invalid';

interface AuthScreenProps {
  serverUrl: string;
  socketConnected: boolean;
  initialName?: string;
  error?: string | null;
  onAuthed: (payload: { token: string; username: string; avatar?: string | null }) => void;
}

/**
 * v1.0.17: Экран входа / регистрации.
 * - Явные вкладки «Вход» и «Регистрация» (раньше была одна непонятная форма).
 * - Живая проверка занятости имени (GET /api/auth/check).
 * - Понятная ошибка, если сервер недоступен (раньше кнопка молчала!).
 * - Токен сессии сохраняется в localStorage — приложение помнит вход.
 */
export const AuthScreen: React.FC<AuthScreenProps> = ({
  serverUrl,
  socketConnected,
  initialName = '',
  error,
  onAuthed,
}) => {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState(initialName);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [nameStatus, setNameStatus] = useState<NameStatus>('idle');
  const [rehosting, setRehosting] = useState(false);
  const checkAbortRef = useRef<AbortController | null>(null);

  // Сброс локальных ошибок при вводе
  useEffect(() => {
    setLocalError(null);
  }, [name, password, password2, mode]);

  // v1.0.17: живая проверка занятости имени при регистрации (с debounce 450мс)
  useEffect(() => {
    if (mode !== 'register') {
      setNameStatus('idle');
      return;
    }
    const clean = name.trim();
    if (!clean) {
      setNameStatus('idle');
      return;
    }
    setNameStatus('checking');
    const timer = setTimeout(async () => {
      try {
        checkAbortRef.current?.abort();
        const ctrl = new AbortController();
        checkAbortRef.current = ctrl;
        const res = await fetch(`${serverUrl}/api/auth/check?username=${encodeURIComponent(clean)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (data.valid === false) setNameStatus('invalid');
        else setNameStatus(data.taken ? 'taken' : 'free');
      } catch {
        // сеть недоступна — просто не показываем статус имени
        setNameStatus('idle');
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [name, mode, serverUrl]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const cleanName = name.trim();
    if (!cleanName) {
      setLocalError('Введите имя');
      return;
    }
    if (!password.trim()) {
      setLocalError('Введите пароль');
      return;
    }
    if (mode === 'register' && password !== password2) {
      setLocalError('Пароли не совпадают');
      return;
    }

    setSubmitting(true);
    setLocalError(null);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanName, password: password.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setLocalError(data.error || `Ошибка сервера (${res.status}). Попробуйте ещё раз.`);
        return;
      }
      onAuthed({ token: data.token, username: data.username, avatar: data.avatar });
    } catch {
      setLocalError(
        'Не удалось связаться с сервером. Убедитесь, что приложение запущено у хоста, и проверьте интернет.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const shownError = localError || error;

  // v1.0.18: в настольном приложении «Проверить снова» реально перезапускает
  // сервер (localhost → UDP-поиск → встроенный хост) через IPC, а не просто
  // перезагружает страницу с тем же мёртвым адресом.
  const desktopRehost = async () => {
    const vm = (window as any).voiceMessenger;
    if (!vm?.rehost || rehosting) return;
    setRehosting(true);
    try {
      await vm.rehost(); // после успеха main-процесс сам перезагрузит окно
    } catch { /* окно уже перезагружается или IPC недоступен */ }
    // Если через 25 секунд окно так и не перезагрузилось — возвращаем кнопку
    setTimeout(() => setRehosting(false), 25000);
  };

  const nameStatusBlock = () => {
    if (mode !== 'register' || !name.trim()) return null;
    switch (nameStatus) {
      case 'checking':
        return (
          <p className="text-[11px] mt-1.5 flex items-center gap-1 text-gray-400">
            <Loader2 className="w-3 h-3 animate-spin" /> Проверяю имя…
          </p>
        );
      case 'free':
        return (
          <p className="text-[11px] mt-1.5 flex items-center gap-1 text-emerald-400">
            <CheckCircle2 className="w-3 h-3" /> Имя свободно — можно регистрировать
          </p>
        );
      case 'taken':
        return (
          <p className="text-[11px] mt-1.5 flex items-center gap-1 text-amber-400">
            <XCircle className="w-3 h-3" /> Имя занято — переключитесь на вкладку «Вход»
          </p>
        );
      case 'invalid':
        return (
          <p className="text-[11px] mt-1.5 flex items-center gap-1 text-amber-400">
            <XCircle className="w-3 h-3" /> Имя: 2–24 символа, буквы, цифры, пробел, «_», «-»
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950 overflow-y-auto p-4">
      {/* Фоновое свечение */}
      <div className="pointer-events-none fixed -top-32 -left-32 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
      <div className="pointer-events-none fixed -bottom-32 -right-32 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl" />

      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-3xl p-8 shadow-2xl relative my-auto">
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 mb-4">
            <PhoneCall className="w-8 h-8 text-white" />
          </div>

          <h2 className="text-2xl font-bold text-white tracking-tight mb-1">Voice Messenger</h2>
          <p className="text-gray-400 text-sm mb-5">
            Личные сообщения и аудиозвонки в высоком качестве
          </p>

          {/* ─── Статус сервера (v1.0.17: раньше при недоступном сервере кнопка молчала) ─── */}
          {socketConnected ? (
            <div className="w-full flex items-center justify-center gap-2 px-4 py-2 mb-4 bg-emerald-950/40 border border-emerald-500/25 rounded-xl text-xs text-emerald-300">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Сервер на связи
            </div>
          ) : (
            <div className="w-full px-4 py-3 mb-4 bg-red-950/40 border border-red-500/30 rounded-xl text-xs text-red-300">
              <div className="flex items-center justify-center gap-2 mb-1 font-semibold">
                <WifiOff className="w-3.5 h-3.5" />
                Нет связи с сервером
              </div>
              <p className="text-red-400/80 leading-relaxed">
                {(window as any).voiceMessenger?.rehost
                  ? 'Приложение попробует запустить сервер прямо на этом ПК. Нажмите «Перезапустить сервер» — если не поможет, проверьте интернет.'
                  : 'Вход невозможен, пока сервер недоступен. Проверьте интернет и перезапустите приложение.'}
              </p>
              <button
                onClick={() => {
                  if ((window as any).voiceMessenger?.rehost) {
                    desktopRehost();
                  } else {
                    window.location.reload();
                  }
                }}
                disabled={rehosting}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-60 border border-red-500/30 rounded-lg text-red-200 transition-colors"
              >
                {rehosting ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" /> Перезапускаю сервер…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3 h-3" />
                    {(window as any).voiceMessenger?.rehost ? 'Перезапустить сервер' : 'Проверить снова'}
                  </>
                )}
              </button>
            </div>
          )}

          {/* ─── Переключатель Вход / Регистрация ─── */}
          <div className="w-full grid grid-cols-2 gap-1 p-1 bg-gray-950/70 border border-gray-800 rounded-xl mb-5">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <LogIn className="w-4 h-4" /> Вход
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                mode === 'register'
                  ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg shadow-indigo-600/20'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <UserPlus className="w-4 h-4" /> Регистрация
            </button>
          </div>

          <form onSubmit={submit} className="w-full space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 text-left">
                Имя пользователя
              </label>
              <div className="relative">
                <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Например: Alex, CyberNinja…"
                  autoFocus
                  maxLength={24}
                  className="w-full pl-11 pr-4 py-3.5 bg-gray-950/70 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
                />
              </div>
              {nameStatusBlock()}
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 text-left">
                Пароль
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={mode === 'login' ? 'Пароль от аккаунта' : 'Придумайте пароль (мин. 4 символа)'}
                  maxLength={64}
                  className="w-full pl-11 pr-11 py-3.5 bg-gray-950/70 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 text-left">
                  Повторите пароль
                </label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password2}
                    onChange={e => setPassword2(e.target.value)}
                    placeholder="Ещё раз пароль"
                    maxLength={64}
                    className="w-full pl-11 pr-4 py-3.5 bg-gray-950/70 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
                  />
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5 text-left">
                  Аккаунт сохранится на сервере хоста — вы сможете входить под ним с любого устройства.
                </p>
              </div>
            )}

            {shownError && (
              <div className="flex items-start gap-2 px-4 py-3 bg-red-950/50 border border-red-500/30 rounded-xl text-sm text-red-300 text-left">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{shownError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !name.trim() || !password.trim()}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-xl shadow-lg shadow-indigo-600/25 transition-all flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{mode === 'login' ? 'Входим…' : 'Создаём аккаунт…'}</span>
                </>
              ) : (
                <>
                  <span>{mode === 'login' ? 'Войти в аккаунт' : 'Создать аккаунт'}</span>
                  {mode === 'login' ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                </>
              )}
            </button>
          </form>

          <div className="flex items-center gap-2 mt-6 text-xs text-gray-500">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>P2P WebRTC аудиопоток шифруется напрямую между участниками</span>
          </div>
        </div>
      </div>
    </div>
  );
};
