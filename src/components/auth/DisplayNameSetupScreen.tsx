import React, { useMemo, useState } from 'react';
import { AlertCircle, LogOut, RefreshCw, UserCheck, WifiOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
  validateDisplayNameInput,
} from '../../utils/displayName';

export const DisplayNameSetupScreen: React.FC = () => {
  const { activeSlot, session, slotMetas, switchSlot, signOutSlot } = useAuth();
  const { dataset, isSyncing, isUpdatingProfile, syncNow, updateMyDisplayName } = useSwimData();
  const isOnline = useOnlineStatus();

  const [draft, setDraft] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasOwnProfileInCache = useMemo(
    () => Boolean(session && dataset.profiles.some((p) => p.id === session.userId)),
    [dataset.profiles, session]
  );

  if (!session) return null;

  const roleLabel = session.role === 'coach' ? 'コーチ' : '選手';
  const otherSlot = activeSlot === 'coach' ? 'athlete' : 'coach';
  const otherMeta = slotMetas[otherSlot];
  const otherLabel = otherSlot === 'coach' ? 'コーチ枠へ切替' : '選手枠へ切替';

  const normalizedLength = [...normalizeDisplayName(draft)].length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const check = validateDisplayNameInput(draft);
    if (!check.valid) {
      setErrorMessage(check.error);
      return;
    }

    try {
      await updateMyDisplayName(check.normalized);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '表示名の登録に失敗しました。');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-50 flex items-center justify-center">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-400">
            swimlog-duo · {roleLabel}アカウント
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            プロフィール表示名の登録
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            アプリ内のヘッダー・ホーム・コメント・変更履歴に表示するあなたの名前を登録してください。
          </p>
        </div>

        {!isOnline && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <WifiOff className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              現在オフラインです。初回の表示名登録にはインターネット接続が必要です。接続回復後に登録を実行してください。
            </span>
          </div>
        )}

        {isOnline && isSyncing && (
          <div className="flex items-center gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
            <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
            <span>初回プロフィール情報を同期中です。完了まで少々お待ちください...</span>
          </div>
        )}

        {isOnline && !isSyncing && !hasOwnProfileInCache && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200 space-y-2">
            <p>端末内キャッシュにプロフィール情報がまだ読み込まれていません。</p>
            <button
              type="button"
              onClick={() => void syncNow()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-amber-700 px-3 text-xs font-semibold text-white hover:bg-amber-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>プロフィール情報を再取得</span>
            </button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-4"
        >
          <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
            <span className="inline-flex items-center gap-1.5 font-semibold text-sky-700 dark:text-sky-300">
              <UserCheck className="h-4 w-4" />
              <span>ログイン中の役割: {roleLabel}</span>
            </span>
            <span className="font-mono-num">
              {normalizedLength} / {DISPLAY_NAME_MAX_LENGTH}文字
            </span>
          </div>

          <div>
            <label
              htmlFor="onboarding-display-name"
              className="block text-sm font-semibold text-slate-800 dark:text-slate-100"
            >
              表示名
            </label>
            <input
              id="onboarding-display-name"
              type="text"
              autoFocus
              maxLength={60}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder={session.role === 'coach' ? '例: 佐藤 コーチ' : '例: 田中 太郎'}
              className="mt-1.5 w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 focus:border-sky-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50"
            />
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              1〜{DISPLAY_NAME_MAX_LENGTH}文字（前後の空白は自動除去、改行・タブ不可。後から設定画面で変更できます）
            </p>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-2xl border border-rose-300 bg-rose-50 px-3.5 py-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!isOnline || isSyncing || isUpdatingProfile || !hasOwnProfileInCache}
            className="flex w-full min-h-[48px] items-center justify-center rounded-2xl bg-sky-600 px-4 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50"
          >
            {isUpdatingProfile ? '登録中...' : '表示名を登録して始める'}
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={isUpdatingProfile}
            onClick={() => void switchSlot(otherSlot)}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            {otherMeta ? `${otherLabel} (${otherMeta.displayName || '表示名未設定'})` : otherLabel}
          </button>
          <button
            type="button"
            disabled={isUpdatingProfile}
            onClick={() => void signOutSlot(session.slot)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>この枠のみサインアウト</span>
          </button>
        </div>
      </div>
    </div>
  );
};
