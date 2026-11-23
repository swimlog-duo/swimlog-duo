import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  ClipboardList,
  Home,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  UserCheck,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import { useTheme } from '../../hooks/useTheme';
import { PWAInstallButton } from '../pwa/PWAInstallButton';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const { session, activeSlot, switchSlot } = useAuth();
  const { pendingCount, conflictItems, errorItems, isSyncing, syncNow } = useSwimData();
  const isOnline = useOnlineStatus();
  const { resolvedTheme, toggleTheme } = useTheme();
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
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      {/* Compact Sticky Top Bar */}
      <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 pt-safe">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap shrink-0 min-h-[44px] flex items-center"
            >
              swimlog-duo
            </button>
            <nav
              aria-label="デスクトップナビゲーション"
              className="hidden md:flex items-center gap-5 text-sm font-medium text-slate-600 dark:text-slate-300 ml-4"
            >
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `whitespace-nowrap shrink-0 py-2 transition-colors ${
                      isActive
                        ? 'text-sky-600 dark:text-sky-400 font-semibold border-b-2 border-sky-600 dark:border-sky-400'
                        : 'hover:text-slate-900 dark:hover:text-white'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {session && (
              <button
                type="button"
                onClick={() => void switchSlot(otherSlot)}
                title={`${session.displayName} (${roleLabel}) でログイン中 — タップで${otherLabel}`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
              >
                <UserCheck className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                <span className="max-w-[84px] truncate">{session.displayName}</span>
                <span className="text-slate-400" aria-hidden="true">
                  ·
                </span>
                <span className="text-sky-700 dark:text-sky-300">{roleLabel}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={isSyncing || !isOnline}
              aria-label="同期を実行"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {!isOnline ? (
                <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <RefreshCw
                  className={`h-4 w-4 ${isSyncing ? 'animate-spin text-sky-600 dark:text-sky-400' : ''}`}
                />
              )}
              {(pendingCount > 0 || conflictItems.length > 0 || errorItems.length > 0) && (
                <span className="font-mono-num text-xs">
                  {conflictItems.length > 0
                    ? `競合${conflictItems.length}`
                    : errorItems.length > 0
                    ? `エラー${errorItems.length}`
                    : `未${pendingCount}`}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label={resolvedTheme === 'dark' ? 'ライトモードへ切替' : 'ダークモードへ切替'}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 shrink-0"
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>

            <div className="hidden sm:block">
              <PWAInstallButton compact />
            </div>
          </div>
        </div>
      </header>

      {/* Main Scrollable Content */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 pb-24 md:pb-8">
        {children}
      </main>

      {/* Mobile Fixed Bottom Tab Bar */}
      <nav
        aria-label="モバイルナビゲーション"
        className="no-print md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95 pb-safe"
      >
        <div className="grid grid-cols-5 items-center h-14">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'text-sky-600 dark:text-sky-400 font-semibold'
                      : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                  }`
                }
              >
                <Icon className="h-5 w-5" />
                <span className="mt-0.5 whitespace-nowrap">{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
