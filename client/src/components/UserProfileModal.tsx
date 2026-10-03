/* NEW (v1.0.29) S: лёгкая полировка — мягче оверлей (bg-black/70, лучше
   читается светлый фон за стеклом), пульсирующая подпись «Обработка…»,
   фиолетовый акцент имени выбранного пресета. */
/* NEW (v1.0.28) S: визуальная полировка модалки профиля — радиальное свечение
   позади аватара, волосяная градиентная линия под шапкой, многослойная
   фиолетовая тень панели, фиолетовая тень кнопки-камеры, hover-тень кнопки
   загрузки, ghost-стиль «Отмена», CTA — градиент палитры (purple→fuchsia). */
// NEW (v1.0.23) TH2: двухтемная конвертация — базовое значение = светлый тон,
// dark: = прежний тёмный. Slate-утилиты конвертированы по аналогии с таблицей
// gray (slate-900 → slate-100, slate-800 → slate-100, тексты
// slate-300/400 → slate-700/600). Градиенты и purple-акценты не тронуты.
import React, { useState, useRef } from 'react';
import { Camera, Upload, Check, X, Sparkles } from 'lucide-react';
import { Avatar } from './Avatar.js';

interface UserProfileModalProps {
  isOpen: boolean;
  username: string;
  currentAvatar?: string;
  onClose: () => void;
  onSaveAvatar: (newAvatar: string) => void;
}

// Built-in presets with SVGs and the custom mask icon
const PRESET_AVATARS = [
  {
    id: 'mask',
    name: 'Green Demon',
    url: '/icon.png',
  },
  {
    id: 'cyber-dj',
    name: 'Cyber Wave',
    url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g1' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%238b5cf6'/><stop offset='100%' stop-color='%233b82f6'/></linearGradient></defs><rect width='100' height='100' rx='50' fill='%230f172a'/><circle cx='50' cy='50' r='45' fill='url(%23g1)' opacity='0.2'/><path d='M30 45 C30 35 40 28 50 28 C60 28 70 35 70 45' fill='none' stroke='%23a855f7' stroke-width='6' stroke-linecap='round'/><rect x='24' y='42' width='12' height='22' rx='6' fill='%23c084fc'/><rect x='64' y='42' width='12' height='22' rx='6' fill='%23c084fc'/><circle cx='50' cy='56' r='18' fill='%231e293b'/><circle cx='44' cy='54' r='3' fill='%2338bdf8'/><circle cx='56' cy='54' r='3' fill='%2338bdf8'/><path d='M44 64 Q50 68 56 64' stroke='%2338bdf8' stroke-width='2' fill='none' stroke-linecap='round'/></svg>",
  },
  {
    id: 'hacker-matrix',
    name: 'Glitch Hacker',
    url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g2' x1='0' y1='0' x2='0' y2='1'><stop offset='0%' stop-color='%2310b981'/><stop offset='100%' stop-color='%23047857'/></linearGradient></defs><rect width='100' height='100' rx='50' fill='%23052e16'/><circle cx='50' cy='50' r='46' fill='none' stroke='%2310b981' stroke-width='2' stroke-dasharray='5 3'/><path d='M30 35 L70 35 L62 70 L38 70 Z' fill='%230f172a' stroke='%2334d399' stroke-width='3'/><rect x='36' y='46' width='28' height='8' rx='2' fill='%2310b981'/><text x='50' y='65' fill='%2334d399' font-size='10' font-family='monospace' font-weight='bold' text-anchor='middle'>FSOC</text></svg>",
  },
  {
    id: 'cyber-cat',
    name: 'Neon Neko',
    url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g3' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%23ec4899'/><stop offset='100%' stop-color='%238b5cf6'/></linearGradient></defs><rect width='100' height='100' rx='50' fill='%23180c2e'/><path d='M26 45 L32 20 L48 36 Z' fill='url(%23g3)'/><path d='M74 45 L68 20 L52 36 Z' fill='url(%23g3)'/><circle cx='50' cy='55' r='26' fill='%232e1065'/><ellipse cx='40' cy='52' rx='5' ry='3' fill='%23f472b6'/><ellipse cx='60' cy='52' rx='5' ry='3' fill='%23f472b6'/><polygon points='50,60 47,64 53,64' fill='%23e879f9'/></svg>",
  },
  {
    id: 'phantom-skull',
    name: 'Cyber Skull',
    url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g4' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%23f59e0b'/><stop offset='100%' stop-color='%23ef4444'/></linearGradient></defs><rect width='100' height='100' rx='50' fill='%231c1917'/><circle cx='50' cy='46' r='24' fill='%23292524' stroke='url(%23g4)' stroke-width='3'/><rect x='40' y='65' width='20' height='12' rx='3' fill='%23292524' stroke='url(%23g4)' stroke-width='2'/><circle cx='41' cy='44' r='6' fill='%23fbbf24'/><circle cx='59' cy='44' r='6' fill='%23fbbf24'/><line x1='46' y1='65' x2='46' y2='77' stroke='%23f59e0b' stroke-width='2'/><line x1='54' y1='65' x2='54' y2='77' stroke='%23f59e0b' stroke-width='2'/></svg>",
  },
  {
    id: 'cyber-bot',
    name: 'Unit-01',
    url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g5' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%2306b6d4'/><stop offset='100%' stop-color='%233b82f6'/></linearGradient></defs><rect width='100' height='100' rx='50' fill='%23082f49'/><rect x='26' y='32' width='48' height='40' rx='8' fill='%230f172a' stroke='url(%23g5)' stroke-width='3'/><line x1='50' y1='32' x2='50' y2='20' stroke='%2306b6d4' stroke-width='3'/><circle cx='50' cy='18' r='4' fill='%2322d3ee'/><rect x='34' y='42' width='32' height='10' rx='3' fill='%230284c7'/><circle cx='42' cy='47' r='2' fill='%23ffffff'/><circle cx='58' cy='47' r='2' fill='%23ffffff'/><line x1='38' y1='62' x2='62' y2='62' stroke='%2338bdf8' stroke-width='3' stroke-linecap='round'/></svg>",
  },
];

export function UserProfileModal({
  isOpen,
  username,
  currentAvatar,
  onClose,
  onSaveAvatar,
}: UserProfileModalProps) {
  const [selectedAvatar, setSelectedAvatar] = useState<string>(currentAvatar || PRESET_AVATARS[0].url);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // Handle custom image file upload with client-side canvas crop/compression
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    const reader = new FileReader();
    reader.onload = event => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 160; // 160x160 for crisp yet lightweight avatar (~12 KB)
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setIsProcessing(false);
          return;
        }

        // Center-crop to square
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;

        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.88);
        setSelectedAvatar(compressedBase64);
        setIsProcessing(false);
      };
      img.onerror = () => setIsProcessing(false);
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    onSaveAvatar(selectedAvatar);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-chat-switch">
      {/* NEW (v1.0.27) S: карточка влетает мягким scale-in (переиспользован
          существующий кейфрейм .animate-scale-in из index.css — новых не
          добавлено) + фиолетовый оттенок тени; фон-оверлей уже имеет
          backdrop-blur-md + animate-chat-switch — не менялись */}
      {/* NEW (v1.0.28) S: многослойная фиолетовая тень панели (arbitrary) вместо
          плоской shadow-2xl — глубина в обеих темах */}
      <div className="relative w-full max-w-md bg-slate-100 dark:bg-slate-900 border border-purple-500/30 rounded-2xl shadow-[0_24px_70px_-20px_rgba(168,85,247,0.45)] overflow-hidden ring-1 ring-purple-500/20 animate-scale-in">
        {/* Glow Header */}
        <div className="relative p-6 text-center bg-gradient-to-b from-purple-100/60 dark:from-purple-950/40 to-transparent">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 text-slate-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Avatar Preview with Glowing Pulse */}
          <div className="relative inline-block mb-3">
            {/* NEW (v1.0.28) S: мягкое радиальное свечение позади аватара
                (декоративно, aria-hidden; лежит под кольцом по порядку DOM) */}
            <div className="absolute -inset-5 rounded-full bg-purple-500/20 blur-2xl" aria-hidden="true" />
            {/* NEW (v1.0.25) S1: полированное градиентное кольцо (purple→fuchsia→amber),
                тоньше (p-[2px]) — акцент-градиент одинаково работает в обеих темах */}
            <div className="relative p-[2px] rounded-full bg-gradient-to-tr from-purple-500 via-fuchsia-500 to-amber-500 animate-pulse-glow">
              <Avatar
                src={selectedAvatar}
                name={username}
                size="2xl"
                className="bg-slate-100 dark:bg-slate-950"
              />
            </div>
            {/* NEW (v1.0.28) S: кнопка-камера — фиолетовая тень вместо чёрной */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Загрузить фото с диска"
              className="absolute bottom-1 right-1 p-2 bg-purple-600 hover:bg-purple-500 text-white rounded-full shadow-lg shadow-purple-600/40 border-2 border-slate-200 dark:border-slate-900 cursor-pointer transition-transform hover:scale-110 active:scale-95"
            >
              <Camera className="w-4 h-4" />
            </button>
          </div>

          {/* NEW (v1.0.25) S1: имя — text-lg font-bold с акцентом-искоркой
              (Sparkles уже импортирован в файл) */}
          <h3 className="flex items-center justify-center gap-1.5 text-lg font-bold text-gray-900 dark:text-white tracking-wide">
            {username}
            <Sparkles className="w-4 h-4 text-purple-400" aria-hidden="true" />
          </h3>
          {/* NEW (v1.0.27) S: светлая пара подзаголовка (purple-700/80), dark: — прежний purple-300/80 */}
          <p className="text-xs text-purple-700/80 dark:text-purple-300/80 mt-0.5">Выберите аватарку или загрузите свое фото</p>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
          />
        </div>

        {/* NEW (v1.0.28) S: волосяная градиентная линия между шапкой и контентом */}
        <div className="h-px mx-6 bg-gradient-to-r from-transparent via-purple-500/30 to-transparent" aria-hidden="true" />

        {/* Content */}
        <div className="px-6 py-4 space-y-5">
          {/* Upload Button */}
          {/* NEW (v1.0.27) S: светлая пара кнопки загрузки фото (purple-700 + иконка
              purple-600) — ранее purple-200/400 почти не читались на светлом
              bg-slate-100/80; dark: — прежние значения */}
          {/* NEW (v1.0.28) S: кнопка загрузки — мягкая hover-тень (обе темы) */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-800 text-purple-700 dark:text-purple-200 border border-purple-500/25 rounded-xl font-medium text-sm transition-all hover:border-purple-500/50 hover:shadow-md hover:shadow-purple-500/10 cursor-pointer active:scale-[0.99]"
          >
            <Upload className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            {/* NEW (v1.0.29) S: «Обработка…» мягко пульсирует — живой индикатор занятости */}
            {isProcessing ? (
              <span className="animate-pulse">Обработка изображения...</span>
            ) : (
              'Загрузить фото с компьютера'
            )}
          </button>

          {/* Preset Gallery */}
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 mb-3 uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              Коллекция крутых аватарок
            </div>

            <div className="grid grid-cols-3 gap-3">
              {PRESET_AVATARS.map(preset => {
                const isSelected = selectedAvatar === preset.url;
                return (
                  // NEW (v1.0.25) S1: hover-полировка пресетов — масштаб + фиолетовая
                  // тень + active-прижатие; выбранный — плотное кольцо с ring-offset
                  // (цвет смещения = фон панели slate-100/slate-900, обе темы)
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setSelectedAvatar(preset.url)}
                    className={`group relative flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all duration-200 border hover:scale-105 active:scale-95 ${
                      isSelected
                        ? 'bg-purple-500/20 border-purple-400 ring-2 ring-purple-500 ring-offset-2 ring-offset-slate-100 dark:ring-offset-slate-900 shadow-lg shadow-purple-500/20'
                        : 'bg-slate-100/40 dark:bg-slate-800/40 border-slate-300/50 dark:border-slate-700/50 hover:bg-slate-200 dark:hover:bg-slate-800 hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-500/20'
                    }`}
                  >
                    <div className="relative">
                      <img
                        src={preset.url}
                        alt={preset.name}
                        className="w-14 h-14 rounded-full object-cover shadow-sm"
                      />
                      {isSelected && (
                        <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center border-2 border-slate-200 dark:border-slate-900 shadow">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      )}
                    </div>
                    {/* NEW (v1.0.29) S: имя выбранного пресета — фиолетовый акцент
                        (синхронно с кольцом выбора, обе темы) */}
                    <span
                      className={`text-[11px] font-medium truncate max-w-full transition-colors ${
                        isSelected
                          ? 'text-purple-700 dark:text-purple-300'
                          : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {preset.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="p-4 bg-slate-100/60 dark:bg-slate-950/60 border-t border-slate-200/80 dark:border-slate-800/80 flex items-center justify-end gap-3">
          {/* NEW (v1.0.28) S: «Отмена» — полноценная ghost-кнопка (скругление + hover-фон) */}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-800/70 transition-colors"
          >
            Отмена
          </button>
          {/* NEW (v1.0.28) S: CTA — градиент палитры (purple→fuchsia, была индента) */}
          <button
            type="button"
            onClick={handleSave}
            className="px-5 py-2 bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 text-white text-sm font-semibold rounded-xl shadow-lg shadow-purple-600/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            Сохранить аватарку
          </button>
        </div>
      </div>
    </div>
  );
}

export default UserProfileModal;
