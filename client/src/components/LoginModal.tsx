import React, { useState } from 'react';
import { PhoneCall, ShieldCheck, Sparkles } from 'lucide-react';

interface LoginModalProps {
  onLogin: (username: string) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onLogin }) => {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onLogin(name.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
        {/* Glow decoration */}
        <div className="absolute -top-24 -left-24 w-48 h-48 bg-indigo-600/30 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-purple-600/30 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-indigo-500/25 mb-4">
            <PhoneCall className="w-8 h-8 text-white" />
          </div>

          <h2 className="text-2xl font-bold text-white tracking-tight mb-1">
            Voice Messenger
          </h2>
          <p className="text-gray-400 text-sm mb-6">
            Личные сообщения и прямые аудиозвонки в высоком качестве
          </p>

          <form onSubmit={handleSubmit} className="w-full space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 text-left">
                Ваш никнейм
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Например: Alex, CyberNinja..."
                autoFocus
                maxLength={24}
                className="w-full px-4 py-3.5 bg-gray-950/70 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
              />
            </div>

            <button
              type="submit"
              disabled={!name.trim()}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-xl shadow-lg shadow-indigo-600/25 transition-all flex items-center justify-center gap-2"
            >
              <span>Войти в сеть</span>
              <Sparkles className="w-4 h-4" />
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
