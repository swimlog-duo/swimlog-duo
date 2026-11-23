import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react';
import { useSwimData } from '../../hooks/useSwimData';
import type { OutboxItem } from '../../types/domain';
import { formatTimeMs, parseTimeInputToMs } from '../../utils/swimCalculations';

interface ConflictResolverModalProps {
  item: OutboxItem;
  onClose: () => void;
}

export const ConflictResolverModal: React.FC<ConflictResolverModalProps> = ({
  item,
  onClose,
}) => {
  const { outbox, acceptServerOnConflict, submitMergedConflict, refreshConflictRecord } =
    useSwimData();
  const currentItem = outbox.find((x) => x.queue_id === item.queue_id) ?? item;
  const detail = currentItem.conflict_detail;
  const serverRecord = detail?.server_record ?? null;
  const serverRevision =
    detail?.server_revision ??
    (serverRecord && typeof serverRecord.revision === 'number' ? serverRecord.revision : null);

  const tableName = detail?.table ?? currentItem.table_name;

  // Editable merged fields depending on table
  const [mergedNote, setMergedNote] = useState<string>(() =>
    String(currentItem.payload.note ?? serverRecord?.note ?? '')
  );
  const [mergedImpression, setMergedImpression] = useState<string>(() =>
    String(currentItem.payload.impression ?? serverRecord?.impression ?? '')
  );
  const [mergedRating, setMergedRating] = useState<string>(() => {
    const val = currentItem.payload.rating ?? serverRecord?.rating;
    return val != null ? String(val) : '';
  });
  const [mergedTimeText, setMergedTimeText] = useState<string>(() => {
    const ms =
      typeof currentItem.payload.time_ms === 'number'
        ? currentItem.payload.time_ms
        : typeof currentItem.payload.total_time_ms === 'number'
        ? currentItem.payload.total_time_ms
        : typeof serverRecord?.time_ms === 'number'
        ? serverRecord.time_ms
        : typeof serverRecord?.total_time_ms === 'number'
        ? serverRecord.total_time_ms
        : null;
    return ms != null ? formatTimeMs(ms) : '';
  });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refetchError, setRefetchError] = useState<string | null>(null);

  const serverSummaryRows = useMemo(() => {
    const rows: Array<{ label: string; serverVal: string; localVal: string }> = [];
    const srv = serverRecord ?? {};
    if (tableName === 'practice_days') {
      rows.push({
        label: 'メモ',
        serverVal: serverRecord ? String(srv.note ?? '—') : '（未取得）',
        localVal: String(currentItem.payload.note ?? '—'),
      });
    } else if (tableName === 'practice_entries') {
      rows.push({
        label: '合計時間',
        serverVal: serverRecord
          ? formatTimeMs(srv.total_time_ms as number | null)
          : '（未取得）',
        localVal: formatTimeMs(currentItem.payload.total_time_ms as number | null),
      });
      rows.push({
        label: '評価',
        serverVal: serverRecord
          ? srv.rating != null
            ? `${srv.rating}/5`
            : '—'
          : '（未取得）',
        localVal: currentItem.payload.rating != null ? `${currentItem.payload.rating}/5` : '—',
      });
      rows.push({
        label: '感想',
        serverVal: serverRecord ? String(srv.impression ?? '—') : '（未取得）',
        localVal: String(currentItem.payload.impression ?? '—'),
      });
    } else if (tableName === 'set_results') {
      rows.push({
        label: 'タイム',
        serverVal: serverRecord ? formatTimeMs(srv.time_ms as number | null) : '（未取得）',
        localVal: formatTimeMs(currentItem.payload.time_ms as number | null),
      });
      rows.push({
        label: '評価',
        serverVal: serverRecord
          ? srv.rating != null
            ? `${srv.rating}/5`
            : '—'
          : '（未取得）',
        localVal: currentItem.payload.rating != null ? `${currentItem.payload.rating}/5` : '—',
      });
      rows.push({
        label: 'メモ・感想',
        serverVal: serverRecord ? String(srv.impression ?? '—') : '（未取得）',
        localVal: String(currentItem.payload.impression ?? '—'),
      });
    }
    return rows;
  }, [tableName, serverRecord, currentItem.payload]);

  const handleRefreshServer = async () => {
    setRefetchError(null);
    setRefreshing(true);
    try {
      const updated = await refreshConflictRecord(currentItem);
      const srv = updated.conflict_detail?.server_record;
      if (srv) {
        if (!mergedNote && typeof srv.note === 'string') setMergedNote(srv.note);
        if (!mergedImpression && typeof srv.impression === 'string') {
          setMergedImpression(srv.impression);
        }
        if (!mergedRating && srv.rating != null) setMergedRating(String(srv.rating));
      }
    } catch (err) {
      setRefetchError(
        err instanceof Error ? err.message : 'サーバー最新データの取得に失敗しました。'
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleUseServer = async () => {
    setBusy(true);
    try {
      await acceptServerOnConflict(currentItem);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMerged = async () => {
    if (serverRevision == null) return;
    setBusy(true);
    try {
      const mergedPayload: Record<string, unknown> = { ...currentItem.payload };
      if (tableName === 'practice_days') {
        mergedPayload.note = mergedNote;
      } else if (tableName === 'practice_entries') {
        mergedPayload.impression = mergedImpression;
        mergedPayload.rating = mergedRating ? Number(mergedRating) : null;
        mergedPayload.total_time_ms = mergedTimeText
          ? parseTimeInputToMs(mergedTimeText)
          : null;
      } else if (tableName === 'set_results') {
        mergedPayload.impression = mergedImpression;
        mergedPayload.rating = mergedRating ? Number(mergedRating) : null;
        mergedPayload.time_ms = mergedTimeText ? parseTimeInputToMs(mergedTimeText) : null;
      }

      await submitMergedConflict(currentItem, mergedPayload, serverRevision);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-6 w-6 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
            <div>
              <h2
                id="conflict-modal-title"
                className="text-lg font-bold text-slate-900 dark:text-slate-50"
              >
                同時編集の競合解決（PT409）
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 font-mono-num">
                対象: {tableName} · 送信時 rev.{currentItem.expected_revision ?? '?'} / サーバー最新 rev.
                {serverRevision ?? '?'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {(serverRevision == null || !serverRecord) && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200 space-y-2">
            <p className="font-semibold">
              サーバー側の最新データが未取得のため、最新 revision を確認できていません（端末の変更は安全に保持されています）。
            </p>
            <button
              type="button"
              disabled={refreshing || busy}
              onClick={() => void handleRefreshServer()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>{refreshing ? '再取得中...' : 'サーバー最新データを再取得'}</span>
            </button>
          </div>
        )}

        {serverRevision != null && serverRecord && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={refreshing || busy}
              onClick={() => void handleRefreshServer()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>{refreshing ? '再取得中...' : 'サーバー最新値を再取得'}</span>
            </button>
          </div>
        )}

        {refetchError && (
          <div className="rounded-2xl border border-rose-300 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
            {refetchError}
          </div>
        )}

        {/* Comparison Table */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
          <div className="grid grid-cols-3 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <span>項目</span>
            <span>サーバー最新値</span>
            <span>この端末の変更</span>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {serverSummaryRows.map((row) => (
              <div key={row.label} className="grid grid-cols-3 gap-2 px-3 py-2.5 text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  {row.label}
                </span>
                <span className="text-slate-900 dark:text-slate-100 break-words">
                  {row.serverVal}
                </span>
                <span className="text-sky-700 dark:text-sky-300 font-medium break-words">
                  {row.localVal}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Merge Editor */}
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/60">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            統合して保存する内容を編集
          </h3>

          {tableName === 'practice_days' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                練習日メモ
              </label>
              <textarea
                rows={3}
                value={mergedNote}
                onChange={(e) => setMergedNote(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          )}

          {(tableName === 'practice_entries' || tableName === 'set_results') && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {tableName === 'practice_entries' ? '合計時間' : 'タイム'}（例 1:23.45）
                  </label>
                  <input
                    type="text"
                    value={mergedTimeText}
                    onChange={(e) => setMergedTimeText(e.target.value)}
                    className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    評価 (1〜5)
                  </label>
                  <select
                    value={mergedRating}
                    onChange={(e) => setMergedRating(e.target.value)}
                    className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    <option value="">未評価</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  感想・メモ
                </label>
                <textarea
                  rows={2}
                  value={mergedImpression}
                  onChange={(e) => setMergedImpression(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleUseServer()}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            サーバー最新値を採用（端末変更を取下げ）
          </button>
          <button
            type="button"
            disabled={busy || serverRevision == null}
            onClick={() => void handleSaveMerged()}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            <span>rev.{serverRevision ?? '?'} を基準に統合保存</span>
          </button>
        </div>
      </div>
    </div>
  );
};
