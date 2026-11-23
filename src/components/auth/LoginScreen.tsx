import React, { useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, ShieldCheck, UserCheck, WifiOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import { getSupabaseConfigError, getSupabaseHostLabel } from '../../lib/supabase';
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
  const [email, setEmail] = useState(() => slotMetas[activeSlot]?.email ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const configError = getSupabaseConfigError();
  const hostLabel = getSupabaseHostLabel();

  const handleSelectSlot = (slot: AccountSlot) => {
    setSelectedSlot(slot);
    setEmail(slotMetas[slot]?.email ?? '');
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
    <div className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-50 flex items-center justify-center">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            swimlog-duo
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            コーチ・選手 2人専用 水泳トレーニング管理
          </p>
          <div className="flex justify-center pt-1">
            <PWAInstallButton />
          </div>
        </div>

        {!isConfigured && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <p className="font-semibold">Supabase 環境変数の確認が必要です</p>
            <p className="mt-1 text-xs leading-relaxed">
              {configError ??
                'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY（Publishable Key のみ）を設定してビルド・起動してください。'}
            </p>
          </div>
        )}

        {isConfigured && hostLabel && (
          <div className="text-center font-mono-num text-[11px] text-slate-500 dark:text-slate-400">
            接続先: {hostLabel}
          </div>
        )}

        {!isOnline && (
          <div className="flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <WifiOff className="h-4 w-4 shrink-0" />
            <span>
              現在オフラインです。初回ログインにはインターネット接続が必要です。保存済みアカウントがある場合は下の枠から切り替えできます。
            </span>
          </div>
        )}

        {/* Saved 2-Account Slots */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            アカウント枠の選択（2アカウント独立保持）
          </h2>

          <div className="grid grid-cols-2 gap-2">
            {(['coach', 'athlete'] as AccountSlot[]).map((slot) => {
              const meta = slot === 'coach' ? coachMeta : athleteMeta;
              const isSelected = selectedSlot === slot;
              const pending = meta ? allOutboxCounts[meta.userId] ?? 0 : 0;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => handleSelectSlot(slot)}
                  className={`min-h-[60px] rounded-xl border p-3 text-left transition ${
                    isSelected
                      ? 'border-sky-600 bg-sky-50 dark:border-sky-400 dark:bg-sky-950/40'
                      : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/50 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-slate-900 dark:text-slate-50">
                      {slot === 'coach' ? 'コーチ枠' : '選手枠'}
                    </span>
                    {meta && (
                      <UserCheck className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-600 dark:text-slate-300">
                    {meta ? meta.displayName : '未ログイン'}
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
              className="w-full min-h-[44px] rounded-xl border border-sky-600 bg-sky-50 px-4 py-2 text-sm font-semibold text-sky-800 transition hover:bg-sky-100 dark:border-sky-500 dark:bg-sky-950/40 dark:text-sky-200"
            >
              保持中の「{slotMetas[selectedSlot]?.displayName}」セッションで続行
            </button>
          )}
        </div>

        {/* Sign-in Form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-4"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <KeyRound className="h-4 w-4 text-sky-600 dark:text-sky-400" />
            <span>
              {selectedSlot === 'coach' ? 'コーチアカウント' : '選手アカウント'}でサインイン
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
              メールアドレス
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              パスワード
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
                className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white pl-3.5 pr-11 py-2 text-sm text-slate-900 focus:border-sky-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || isLoading || !isConfigured || !isOnline}
            className="w-full min-h-[48px] rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
          >
            {submitting ? '認証・ロール確認中...' : 'ログイン'}
          </button>

          <div className="flex items-start gap-2 pt-1 text-xs text-slate-500 dark:text-slate-400">
            <ShieldCheck className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
            <span>
              一般新規登録は無効です。Supabase管理画面で作成済みのアカウントのみ利用でき、パスワードは端末に保存されません。
            </span>
          </div>
        </form>
      </div>
    </div>
  );
};
