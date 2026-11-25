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
                オフラインモード — 変更はこの端末に保存され、通信回復後に自動同期されます。
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
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-[#0b1f3a] dark:border-[#244675] dark:bg-[#132b4f] dark:text-sky-100">
            <div className="flex items-center gap-2">
              <RefreshCw
                className={`h-4 w-4 shrink-0 text-[#0077b6] dark:text-[#38bdf8] ${
                  isSyncing ? 'animate-spin' : ''
                }`}
              />
              <span>
                未送信のデータが <strong className="font-mono-num">{pendingCount}</strong> 件あります。
              </span>
            </div>
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={isSyncing}
              className="min-h-[44px] rounded-xl bg-[#0077b6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#006094] disabled:opacity-50"
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
                  同じ記録への変更が重なりました（{conflictItems.length}件）
                </p>
                <p className="text-xs opacity-90">
                  双方の内容を保持しています。どちらを残すか確認してください。
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
              <p className="font-semibold">同期に失敗したデータがあります（{errorItems.length}件）</p>
              <p className="text-xs">{errorItems[0].last_error}</p>
            </div>
            <button
              type="button"
              onClick={() => void retryErroredItem(errorItems[0])}
              className="min-h-[44px] rounded-xl border border-amber-400 bg-white px-4 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-[#0e1b2e] dark:text-amber-200"
            >
              再試行
            </button>
          </div>
        )}

        {lastSyncMessage &&
          isOnline &&
          pendingCount === 0 &&
          conflictItems.length === 0 &&
          errorItems.length === 0 &&
          session?.offlineFallback && (
            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700 dark:border-[#1e3250] dark:bg-[#0e1b2e] dark:text-slate-300">
              <CheckCircle2 className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
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
