/* NEW (v1.0.29) S: микро-полировка — плашка ошибки влетает мягким fadeIn
   (существующий .animate-fade-in, без новых кейфреймов), глазок пароля с
   active-прижатием, левое фоновое свечение — violet (палитра, была indigo). */
/* NEW (v1.0.28) S: визуальная полировка экрана входа — многослойная фиолетовая
   тень карточки, плитка-логотип purple→fuchsia, единый фиолетовый фокус полей,
   active-прижатие вкладок/CTA, третий декоративный blur-акцент фона,
   стеклянная пилюля P2P-футера. Индентовые градиенты заменены на палитру
   приложения (purple→fuchsia) — новая индента НЕ добавлялась. */
// NEW (v1.0.23) TH2: двухтемная конвертация — базовое значение = светлый тон,
// dark: = прежний тёмный. Градиентные кнопки/акценты (indigo/purple/emerald/red)
// и фоновые blur-пятна не тронуты.
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
    // FIX (v1.0.21): при регистрации минимум 6 символов (вход остался мягким —
    // старые аккаунты с 4-символьными паролями должны продолжать работать)
    if (mode === 'register' && password.trim().length < 6) {
      setLocalError('Пароль: минимум 6 символов');
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
        // FIX (v1.0.21): 429 (rate limit) — показываем сообщение сервера из JSON,
        // а не только сетевые ошибки; без текста от сервера — понятный фолбэк
        const fallback =
          res.status === 429
            ? 'Слишком много попыток — подождите немного и попробуйте снова.'
            : `Ошибка сервера (${res.status}). Попробуйте ещё раз.`;
        setLocalError(data.error || fallback);
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
          <p className="text-[11px] mt-1.5 flex items-center gap-1 text-gray-600 dark:text-gray-400">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-100 dark:bg-gray-950 overflow-y-auto p-4">
      {/* Фоновое свечение */}
      {/* NEW (v1.0.29) S: левое свечение — violet (палитра приложения, была indigo) */}
      <div className="pointer-events-none fixed -top-32 -left-32 w-96 h-96 bg-violet-600/20 rounded-full blur-3xl" />
      <div className="pointer-events-none fixed -bottom-32 -right-32 w-96 h-96 bg-purple-600/20 rounded-full blur-3xl" />
      {/* NEW (v1.0.28) S: третий декоративный акцент — фуксия по центру за карточкой */}
      <div className="pointer-events-none fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[32rem] h-[32rem] bg-fuchsia-500/10 rounded-full blur-3xl" aria-hidden="true" />

      {/* NEW (v1.0.28) S: многослойная фиолетовая тень карточки (arbitrary) вместо
          плоской shadow-2xl — глубина в обеих темах; волосяная линия сверху осталась */}
      <div className="w-full max-w-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-8 shadow-[0_20px_60px_-15px_rgba(168,85,247,0.3)] relative my-auto">
        {/* NEW (v1.0.27) S: тонкая градиентная «волосяная» линия по верхнему краю
            карточки (inset-x-6 — не задевает скругления rounded-3xl) + мягкий
            фиолетовый оттенок тени (shadow-purple-500/10) — обе темы */}
        <div className="absolute top-0 inset-x-6 h-px bg-gradient-to-r from-transparent via-purple-500/50 to-transparent" aria-hidden="true" />
        <div className="flex flex-col items-center text-center">
          {/* NEW (v1.0.28) S: плитка-логотип — градиент палитры приложения
              (purple→fuchsia) + мягкое фиолетовое свечение (arbitrary shadow) */}
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-purple-500 to-fuchsia-500 flex items-center justify-center shadow-[0_8px_30px_rgba(168,85,247,0.35)] mb-4">
            <PhoneCall className="w-8 h-8 text-white" />
          </div>

          <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight mb-1">Voice Messenger</h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm mb-5">
            Личные сообщения и аудиозвонки в высоком качестве
          </p>

          {/* ─── Статус сервера (v1.0.17: раньше при недоступном сервере кнопка молчала) ─── */}
          {socketConnected ? (
            <div className="w-full flex items-center justify-center gap-2 px-4 py-2 mb-4 bg-emerald-100/80 dark:bg-emerald-950/40 border border-emerald-500/25 rounded-xl text-xs text-emerald-700 dark:text-emerald-300">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Сервер на связи
            </div>
          ) : (
            <div className="w-full px-4 py-3 mb-4 bg-red-100/80 dark:bg-red-950/40 border border-red-500/30 rounded-xl text-xs text-red-700 dark:text-red-300">
              <div className="flex items-center justify-center gap-2 mb-1 font-semibold">
                <WifiOff className="w-3.5 h-3.5" />
                Нет связи с сервером
              </div>
              {/* NEW (v1.0.27) S: светлая пара текста (red-600/80), dark: — прежний red-400/80 */}
              <p className="text-red-600/80 dark:text-red-400/80 leading-relaxed">
                {(window as any).voiceMessenger?.rehost
                  ? 'Приложение попробует запустить сервер прямо на этом ПК. Нажмите «Перезапустить сервер» — если не поможет, проверьте интернет.'
                  : 'Вход невозможен, пока сервер недоступен. Проверьте интернет и перезапустите приложение.'}
              </p>
              {/* NEW (v1.0.27) S: светлая пара текста кнопки (red-700), dark: — прежний red-200 */}
              <button
                onClick={() => {
                  if ((window as any).voiceMessenger?.rehost) {
                    desktopRehost();
                  } else {
                    window.location.reload();
                  }
                }}
                disabled={rehosting}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-60 border border-red-500/30 rounded-lg text-red-700 dark:text-red-200 transition-colors"
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
          {/* NEW (v1.0.28) S: активная вкладка — градиент палитры (purple→fuchsia) +
              active-прижатие; неактивная — мягкий hover-фон вместо только цвета текста */}
          <div className="w-full grid grid-cols-2 gap-1 p-1 bg-gray-100/70 dark:bg-gray-950/70 border border-gray-200 dark:border-gray-800 rounded-xl mb-5">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all active:scale-[0.98] ${
                mode === 'login'
                  ? 'bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white shadow-lg shadow-purple-600/25'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-white/5'
              }`}
            >
              <LogIn className="w-4 h-4" /> Вход
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all active:scale-[0.98] ${
                mode === 'register'
                  ? 'bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white shadow-lg shadow-purple-600/25'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-200/70 dark:hover:bg-white/5'
              }`}
            >
              <UserPlus className="w-4 h-4" /> Регистрация
            </button>
          </div>

          {/* NEW (v1.0.28) S: поля формы — единый фиолетовый фокус (кольцо + свечение
              + подсветка бордера; был indigo-ring) и hover-бордер у всех трёх инпутов */}
          <form onSubmit={submit} className="w-full space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-2 text-left">
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
                  className="w-full pl-11 pr-4 py-3.5 bg-gray-100/70 dark:bg-gray-950/70 border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/60 focus:border-purple-500/40 focus:shadow-[0_0_0_4px_rgba(168,85,247,0.10)] transition-all text-base"
                />
              </div>
              {nameStatusBlock()}
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-2 text-left">
                Пароль
              </label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={mode === 'login' ? 'Пароль от аккаунта' : 'Придумайте пароль (мин. 6 символов)'}
                  maxLength={64}
                  className="w-full pl-11 pr-11 py-3.5 bg-gray-100/70 dark:bg-gray-950/70 border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/60 focus:border-purple-500/40 focus:shadow-[0_0_0_4px_rgba(168,85,247,0.10)] transition-all text-base"
                />
                {/* NEW (v1.0.28) S: глазок пароля — скруглённая зона с hover-фоном */}
                {/* NEW (v1.0.29) S: + active-прижатие (как у остальных кнопок формы) */}
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/70 dark:hover:bg-white/10 transition-all active:scale-90"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-2 text-left">
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
                    className="w-full pl-11 pr-4 py-3.5 bg-gray-100/70 dark:bg-gray-950/70 border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/60 focus:border-purple-500/40 focus:shadow-[0_0_0_4px_rgba(168,85,247,0.10)] transition-all text-base"
                  />
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5 text-left">
                  Аккаунт сохранится на сервере хоста — вы сможете входить под ним с любого устройства.
                </p>
              </div>
            )}

            {shownError && (
              // NEW (v1.0.27) S: светлая пара плашки ошибки (red-50/80 + red-700 +
              // border-red-200) — единственная оставшаяся «тёмная» плашка на светлой
              // карточке (успех/офлайн починены в v1.0.23); dark: — прежние значения
              // NEW (v1.0.29) S: появление — мягкий fadeIn (существующий класс)
              <div className="flex items-start gap-2 px-4 py-3 bg-red-50/80 dark:bg-red-950/50 border border-red-200 dark:border-red-500/30 rounded-xl text-sm text-red-700 dark:text-red-300 text-left animate-fade-in">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{shownError}</span>
              </div>
            )}

            {/* NEW (v1.0.28) S: главная кнопка — градиент палитры (purple→fuchsia),
                active-прижатие, приглушение насыщенности в disabled */}
            <button
              type="submit"
              disabled={submitting || !name.trim() || !password.trim()}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 disabled:opacity-50 disabled:saturate-50 disabled:cursor-not-allowed text-white font-medium rounded-xl shadow-lg shadow-purple-600/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
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

          {/* NEW (v1.0.28) S: P2P-заметка — стеклянная пилюля с рамкой (обе темы) */}
          <div className="inline-flex items-center gap-2 mt-6 px-3.5 py-1.5 rounded-full bg-gray-100/80 dark:bg-gray-950/80 border border-gray-200/80 dark:border-gray-800 text-xs text-gray-500">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>P2P WebRTC аудиопоток шифруется напрямую между участниками</span>
          </div>
        </div>
      </div>
    </div>
  );
};
