import React, { useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, ShieldCheck, UserCheck, WifiOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import { getSupabaseConfigError } from '../../lib/supabase';
import type { AccountSlot } from '../../types/domain';
import { PWAInstallButton } from '../pwa/PWAInstallButton';

export const LoginScreen: React.FC = () => {
  const {
    activeSlot,
    slotMetas,
    isLoading,
    isConfigured,
    authError,
    switchSlot,
    signIn,
    clearAuthError,
  } = useAuth();
  const { allOutboxCounts } = useSwimData();
  const isOnline = useOnlineStatus();

  const [selectedSlot, setSelectedSlot] = useState<AccountSlot>(activeSlot);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const configError = getSupabaseConfigError();

  const handleSelectSlot = (slot: AccountSlot) => {
    setSelectedSlot(slot);
    setEmail('');
    setPassword('');
    setLocalError(null);
    clearAuthError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearAuthError();
    if (!email.trim() || !password) {
      setLocalError('メールアドレスとパスワードを入力してください。');
      return;
    }
    setSubmitting(true);
    try {
      await signIn(selectedSlot, email, password);
      setPassword('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'ログインに失敗しました。');
    } finally {
      setSubmitting(false);
    }
  };

  const coachMeta = slotMetas.coach;
  const athleteMeta = slotMetas.athlete;

  return (
    <div className="min-h-screen bg-[#f4f7fb] px-4 py-8 text-[#0b1f3a] dark:bg-[#07111e] dark:text-slate-50 flex items-center justify-center">
      <div className="w-full max-w-md space-y-5">
        <div className="rounded-2xl bg-[#0b1f3a] px-6 py-6 text-center text-white shadow-sm">
          <div className="inline-flex items-center justify-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">swimlog-duo</h1>
            <span className="rounded-md border border-sky-400/35 bg-sky-400/15 px-2 py-0.5 text-[11px] font-semibold text-sky-200 whitespace-nowrap">
              β ベータ版
            </span>
          </div>
          <p className="mt-1.5 text-sm text-sky-100/90">
            コーチ・選手 2人専用 水泳トレーニング記録
          </p>
          <div className="flex justify-center pt-3">
            <PWAInstallButton />
          </div>
        </div>

        {!isConfigured && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <p className="font-semibold">接続設定の確認が必要です</p>
            <p className="mt-1 text-xs leading-relaxed">
              {configError ?? '接続先の環境設定を確認して再度起動してください。'}
            </p>
          </div>
        )}

        {!isOnline && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <WifiOff className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              現在オフラインです。初回ログインにはインターネット接続が必要です。保存済みのアカウントがある場合は下の枠から切り替えできます。
            </span>
          </div>
        )}

        {/* Saved 2-Account Slots */}
        <div className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-[0_1px_2px_rgba(11,31,58,0.04)] dark:border-[#1e3250] dark:bg-[#0e1b2e] space-y-3">
          <h2 className="text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
            アカウント枠の選択
          </h2>

          <div className="grid grid-cols-2 gap-2.5">
            {(['coach', 'athlete'] as AccountSlot[]).map((slot) => {
              const meta = slot === 'coach' ? coachMeta : athleteMeta;
              const isSelected = selectedSlot === slot;
              const pending = meta ? allOutboxCounts[meta.userId] ?? 0 : 0;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => handleSelectSlot(slot)}
                  className={`min-h-[64px] rounded-xl border p-3 text-left transition ${
                    isSelected
                      ? 'border-[#0077b6] bg-sky-50/80 dark:border-[#38bdf8] dark:bg-[#132b4f]'
                      : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-[#1e3250] dark:bg-[#0b1526] dark:hover:bg-[#13243c]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-[#0b1f3a] dark:text-slate-50">
                      {slot === 'coach' ? 'コーチ枠' : '選手枠'}
                    </span>
                    {meta && (
                      <UserCheck className="h-3.5 w-3.5 text-[#0077b6] dark:text-[#38bdf8]" />
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-600 dark:text-slate-300">
                    {meta ? meta.displayName || '表示名未設定' : '未ログイン'}
                  </div>
                  {pending > 0 && (
                    <div className="mt-0.5 font-mono-num text-[11px] text-amber-700 dark:text-amber-300">
                      未送信 {pending}件
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {slotMetas[selectedSlot] && (
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void switchSlot(selectedSlot)}
              className="w-full min-h-[44px] rounded-xl border border-[#0077b6] bg-sky-50 px-4 py-2 text-sm font-semibold text-[#0b1f3a] transition hover:bg-sky-100 dark:border-[#38bdf8] dark:bg-[#132b4f] dark:text-sky-100"
            >
              保持中の「{slotMetas[selectedSlot]?.displayName || (selectedSlot === 'coach' ? 'コーチ（表示名未設定）' : '選手（表示名未設定）')}」セッションで続行
            </button>
          )}
        </div>

        {/* Sign-in Form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-[0_1px_2px_rgba(11,31,58,0.04)] dark:border-[#1e3250] dark:bg-[#0e1b2e] space-y-4"
        >
          <div className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
            <KeyRound className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
            <span>
              {selectedSlot === 'coach' ? 'コーチアカウント' : '選手アカウント'}でログイン
            </span>
          </div>

          {(localError || authError) && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{localError || authError}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              メールアドレス（必須）
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-[#0b1f3a] focus:border-[#0077b6] focus:outline-none dark:border-[#2a4266] dark:bg-[#07111e] dark:text-slate-100"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              パスワード（必須）
            </label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white pl-3.5 pr-12 py-2 text-sm text-[#0b1f3a] focus:border-[#0077b6] focus:outline-none dark:border-[#2a4266] dark:bg-[#07111e] dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
                className="absolute right-0.5 top-1/2 -translate-y-1/2 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-500 hover:text-[#0b1f3a] dark:text-slate-400 dark:hover:text-slate-200"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || isLoading || !isConfigured || !isOnline}
            className="w-full min-h-[48px] rounded-xl bg-[#0077b6] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#006094] disabled:opacity-50"
          >
            {submitting ? '確認中...' : 'ログイン'}
          </button>

          <div className="flex items-start gap-2 pt-1 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
            <span>
              登録済みのコーチ・選手アカウントのみ利用できます。パスワードはこの端末に保存されません。
            </span>
          </div>
        </form>
      </div>
    </div>
  );
};
