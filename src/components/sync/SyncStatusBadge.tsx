import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react';
import type { RecordSyncState } from '../../lib/outboxOverlay';

interface SyncStatusBadgeProps {
  state: RecordSyncState;
  compact?: boolean;
  className?: string;
}

export const SyncStatusBadge: React.FC<SyncStatusBadgeProps> = ({
  state,
  compact = false,
  className = '',
}) => {
  switch (state) {
    case 'synced':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:border-emerald-800/80 dark:bg-emerald-950/50 dark:text-emerald-200 ${className}`}
        >
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          <span>同期済み</span>
        </span>
      );
    case 'syncing':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-[#0077b6] dark:border-sky-800 dark:bg-sky-950/60 dark:text-[#38bdf8] ${className}`}
        >
          <RefreshCw className="h-3 w-3 shrink-0 animate-spin" />
          <span>送信中...</span>
        </span>
      );
    case 'pending':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200 ${className}`}
        >
          <Clock className="h-3 w-3 shrink-0" />
          <span>{compact ? '同期待ち' : '同期待ち（端末保存済み）'}</span>
        </span>
      );
    case 'error':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200 ${className}`}
        >
          <XCircle className="h-3 w-3 shrink-0" />
          <span>{compact ? '送信失敗' : '送信失敗（端末保存済み）'}</span>
        </span>
      );
    case 'conflict':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-lg border border-rose-400 bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-900 dark:border-rose-700 dark:bg-rose-950/80 dark:text-rose-200 ${className}`}
        >
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>{compact ? '競合あり' : '競合あり（要確認）'}</span>
        </span>
      );
  }
};
