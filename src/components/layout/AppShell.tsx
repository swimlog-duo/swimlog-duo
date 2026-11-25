import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  ClipboardList,
  Home,
  RefreshCw,
  Settings,
  UserCheck,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import { PWAInstallButton } from '../pwa/PWAInstallButton';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { session, activeSlot, switchSlot } = useAuth();
  const { pendingCount, conflictItems, errorItems, isSyncing, syncNow } = useSwimData();
  const isOnline = useOnlineStatus();
  const navigate = useNavigate();

  const roleLabel = session?.role === 'coach' ? 'コーチ' : '選手';
  const otherSlot = activeSlot === 'coach' ? 'athlete' : 'coach';
  const otherLabel = otherSlot === 'coach' ? 'コーチへ切替' : '選手へ切替';

  const navItems = [
    { to: '/', label: 'ホーム', icon: Home, end: true },
    { to: '/menus', label: 'メニュー', icon: ClipboardList, end: false },
    { to: '/logs', label: '練習記録', icon: Activity, end: false },
    { to: '/analytics', label: '分析', icon: BarChart3, end: false },
    { to: '/settings', label: '設定', icon: Settings, end: false },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#f4f7fb] text-[#0b1f3a] dark:bg-[#07111e] dark:text-slate-50">
      {/* Elite Navy Sporty Top Header */}
      <header className="no-print sticky top-0 z-30 border-b border-[#183358] bg-[#0b1f3a] text-white pt-safe shadow-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-6 min-w-0">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap shrink-0 text-left group"
            >
              <span className="text-base sm:text-lg font-black tracking-tight text-white group-hover:text-[#38bdf8] transition-colors">
                swimlog-duo
              </span>
              <span className="rounded-md border border-[#38bdf8]/40 bg-[#38bdf8]/15 px-2 py-0.5 text-[10px] font-bold tracking-wide leading-none text-[#38bdf8] whitespace-nowrap uppercase">
                β
              </span>
            </button>

            <nav
              aria-label="デスクトップナビゲーション"
              className="hidden md:flex items-center gap-1 text-sm font-semibold text-slate-300"
            >
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `inline-flex min-h-[44px] items-center px-3.5 rounded-xl whitespace-nowrap shrink-0 transition-all ${
                      isActive
                        ? 'bg-[#16345b] text-[#38bdf8] shadow-sm font-bold'
                        : 'hover:bg-white/5 hover:text-white'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {session && (
              <button
                type="button"
                onClick={() => void switchSlot(otherSlot)}
                title={`${session.displayName || '表示名未設定'} (${roleLabel}) でログイン中 — タップで${otherLabel}`}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#244675] bg-[#132b4f] px-3 text-xs font-bold text-white transition hover:bg-[#1a3966] whitespace-nowrap shrink-0 shadow-sm"
              >
                <UserCheck className="h-4 w-4 text-[#38bdf8] shrink-0" />
                <span className="max-w-[80px] sm:max-w-[140px] truncate">
                  {session.displayName || '表示名未設定'}
                </span>
                <span className="text-slate-400 font-normal" aria-hidden="true">
                  ·
                </span>
                <span className="text-[#38bdf8]">{roleLabel}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={isSyncing || !isOnline}
              aria-label="同期を実行"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#244675] bg-[#132b4f] px-3 text-xs font-bold text-white transition hover:bg-[#1a3966] disabled:opacity-50 whitespace-nowrap shrink-0 shadow-sm"
            >
              {!isOnline ? (
                <WifiOff className="h-4 w-4 text-amber-300" />
              ) : (
                <RefreshCw
                  className={`h-4 w-4 ${isSyncing ? 'animate-spin text-[#38bdf8]' : 'text-slate-200'}`}
                />
              )}
              {(pendingCount > 0 || conflictItems.length > 0 || errorItems.length > 0) && (
                <span className="font-mono-num text-xs text-[#38bdf8] font-bold">
                  {conflictItems.length > 0
                    ? `競合${conflictItems.length}`
                    : errorItems.length > 0
                    ? `エラー${errorItems.length}`
                    : `未${pendingCount}`}
                </span>
              )}
            </button>

            <div className="hidden sm:block">
              <PWAInstallButton compact />
            </div>
          </div>
        </div>
      </header>

      {/* Main Scrollable Content */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 py-6 pb-28 md:pb-10">
        {children}
      </main>

      {/* Mobile Fixed Bottom Tab Bar */}
      <nav
        aria-label="モバイルナビゲーション"
        className="no-print md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200/90 bg-white/95 backdrop-blur-md dark:border-[#1e3250] dark:bg-[#0b1f3a]/95 pb-safe shadow-lg"
      >
        <div className="grid grid-cols-5 items-center h-16">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex flex-col items-center justify-center min-h-[48px] text-[11px] font-bold transition-all ${
                    isActive
                      ? 'text-[#0077b6] dark:text-[#38bdf8] scale-105'
                      : 'text-slate-500 hover:text-[#0b1f3a] dark:text-slate-400 dark:hover:text-white'
                  }`
                }
              >
                <Icon className="h-5 w-5" />
                <span className="mt-1 whitespace-nowrap tracking-tight">{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
