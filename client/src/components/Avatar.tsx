import { useState } from 'react';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  online?: boolean;
  status?: 'online' | 'offline' | 'busy';
  className?: string;
  onClick?: () => void;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-xl',
  '2xl': 'w-24 h-24 text-3xl',
};

const dotSizes = {
  xs: 'w-1.5 h-1.5 border-[1px] bottom-0 right-0',
  sm: 'w-2 h-2 border-[1.5px] bottom-0 right-0',
  md: 'w-2.5 h-2.5 border-2 bottom-0.5 right-0.5',
  lg: 'w-3 h-3 border-2 bottom-0.5 right-0.5',
  xl: 'w-4 h-4 border-2 bottom-1 right-1',
  '2xl': 'w-5 h-5 border-2 bottom-1.5 right-1.5',
};

const gradients = [
  'from-purple-600 to-indigo-600',
  'from-emerald-600 to-teal-600',
  'from-blue-600 to-cyan-600',
  'from-rose-600 to-pink-600',
  'from-amber-600 to-orange-600',
  'from-fuchsia-600 to-purple-600',
];

function getGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return gradients[Math.abs(hash) % gradients.length];
}

export function Avatar({
  src,
  name,
  size = 'md',
  online,
  status,
  className = '',
  onClick,
}: AvatarProps) {
  const [imageError, setImageError] = useState(false);
  const initials = (name || '?')
    .trim()
    .split(/\s+/)
    .map(part => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const hasImage = src && !imageError;
  const gradient = getGradient(name || '');

  return (
    <div
      onClick={onClick}
      className={`relative inline-flex items-center justify-center shrink-0 rounded-full select-none ${
        sizeClasses[size]
      } ${onClick ? 'cursor-pointer hover:opacity-90 active:scale-95 transition-all' : ''} ${className}`}
    >
      {hasImage ? (
        <img
          src={src}
          alt={name}
          onError={() => setImageError(true)}
          className="w-full h-full rounded-full object-cover shadow-sm ring-1 ring-white/10"
        />
      ) : (
        <div
          className={`w-full h-full rounded-full bg-gradient-to-tr ${gradient} flex items-center justify-center font-bold text-white shadow-sm ring-1 ring-white/15`}
        >
          {initials}
        </div>
      )}

      {(status !== undefined || online !== undefined) && (
        <span
          className={`absolute rounded-full border-slate-900 ${dotSizes[size]} ${
            status === 'busy'
              ? 'bg-amber-400 ring-1 ring-amber-500/50'
              : (status === 'online' || (status === undefined && online))
              ? 'bg-emerald-400 ring-1 ring-emerald-500/50'
              : 'bg-slate-500'
          }`}
          title={
            status === 'busy'
              ? 'В звонке'
              : (status === 'online' || (status === undefined && online))
              ? 'В сети'
              : 'Не в сети'
          }
        />
      )}
    </div>
  );
}

export default Avatar;
