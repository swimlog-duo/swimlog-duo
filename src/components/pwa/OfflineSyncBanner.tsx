import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, WifiOff } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import type { OutboxItem } from '../../types/domain';
import { ConflictResolverModal } from '../sync/ConflictResolverModal';

export const OfflineSyncBanner: React.FC = () => {
  const { session } = useAuth();
  const isOnline = useOnlineStatus();
  const {
    pendingCount,
    conflictItems,
    errorItems,
    isSyncing,
    lastSyncMessage,
    syncNow,
    retryErroredItem,
  } = useSwimData();
  const [activeConflict, setActiveConflict] = useState<OutboxItem | null>(null);

  const showBanner =
    !isOnline ||
    session?.offlineFallback ||
    pendingCount > 0 ||
    conflictItems.length > 0 ||
    errorItems.length > 0;

  if (!showBanner) return null;

  return (
    <>
      <div className="no-print mb-4 space-y-2">
        {!isOnline && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <div className="flex items-center gap-2">
              <WifiOff className="h-4 w-4 shrink-0" />
              <span>
                オフラインモード — 変更は端末内（IndexedDB）へ安全に保存され、再接続時に同期されます。
              </span>
            </div>
            {pendingCount > 0 && (
              <span className="font-mono-num text-xs font-semibold">
                未送信 {pendingCount}件
              </span>
            )}
          </div>
        )}

        {isOnline && pendingCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
            <div className="flex items-center gap-2">
              <RefreshCw className={`h-4 w-4 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>
                未送信データ <strong className="font-mono-num">{pendingCount}</strong> 件を同期待機中です。
              </span>
            </div>
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={isSyncing}
              className="min-h-[40px] rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {isSyncing ? '同期中...' : '今すぐ同期'}
            </button>
          </div>
        )}

        {conflictItems.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  同時編集の競合（REVISION_CONFLICT）が {conflictItems.length} 件あります
                </p>
                <p className="text-xs opacity-90">
                  相手の変更と端末の変更を両方保持しています。内容を確認して解決してください。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveConflict(conflictItems[0])}
              className="min-h-[44px] rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 whitespace-nowrap"
            >
              競合を確認・解決
            </button>
          </div>
        )}

        {errorItems.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            <div className="space-y-0.5">
              <p className="font-semibold">同期エラーが {errorItems.length} 件あります</p>
              <p className="text-xs">{errorItems[0].last_error}</p>
            </div>
            <button
              type="button"
              onClick={() => void retryErroredItem(errorItems[0])}
              className="min-h-[44px] rounded-xl border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-200"
            >
              再試行
            </button>
          </div>
        )}

        {lastSyncMessage && isOnline && pendingCount === 0 && conflictItems.length === 0 && errorItems.length === 0 && session?.offlineFallback && (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
            <CheckCircle2 className="h-4 w-4 text-sky-600" />
            <span>{lastSyncMessage}</span>
          </div>
        )}
      </div>

      {activeConflict && (
        <ConflictResolverModal
          item={activeConflict}
          onClose={() => setActiveConflict(null)}
        />
      )}
    </>
  );
};
