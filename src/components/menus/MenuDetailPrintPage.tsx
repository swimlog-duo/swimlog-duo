import React, { useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Archive, CheckCircle2, Edit3, Eye, EyeOff, Printer } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import { getRecordSyncState } from '../../lib/outboxOverlay';
import type { MenuStatusHistoryRow } from '../../types/database';
import { formatIsoToJstDate, formatIsoToJstDateTime } from '../../utils/dateJst';
import {
  calculateMenuMetrics,
  computeRowDistance,
  deriveMenuStatus,
  formatDistanceM,
  formatMenuStatusLabel,
} from '../../utils/swimCalculations';
import { SyncStatusBadge } from '../sync/SyncStatusBadge';

function formatStateSnapshot(isShared: boolean, isArchived: boolean): string {
  if (isArchived) return 'アーカイブ';
  return isShared ? '共有中' : '非共有';
}

function formatStatusTransition(h: MenuStatusHistoryRow): string {
  const before = formatStateSnapshot(h.old_is_shared, h.old_is_archived);
  const after = formatStateSnapshot(h.new_is_shared, h.new_is_archived);
  return `${before} → ${after}`;
}

export const MenuDetailPrintPage: React.FC = () => {
  const { menuId } = useParams<{ menuId: string }>();
  const location = useLocation();
  const { session } = useAuth();
  const { dataset, outbox, updateMenuStatus } = useSwimData();
  const isCoach = session?.role === 'coach';

  const saveNotice =
    (location.state as { saveNotice?: string } | null)?.saveNotice ?? null;

  const menu = useMemo(
    () => dataset.menus.find((m) => m.id === menuId) ?? null,
    [dataset.menus, menuId]
  );

  const versions = useMemo(
    () =>
      dataset.menu_versions
        .filter((v) => v.menu_id === menuId)
        .sort((a, b) => b.version_no - a.version_no),
    [dataset.menu_versions, menuId]
  );

  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const activeVersion = useMemo(() => {
    if (versions.length === 0) return null;
    return versions.find((v) => v.id === selectedVersionId) ?? versions[0];
  }, [versions, selectedVersionId]);

  const statusHistory = useMemo(
    () =>
      isCoach
        ? dataset.menu_status_history
            .filter((h) => h.menu_id === menuId)
            .sort((a, b) => b.changed_at.localeCompare(a.changed_at))
        : [],
    [isCoach, dataset.menu_status_history, menuId]
  );

  const syncInfo = useMemo(
    () =>
      menu
        ? getRecordSyncState(outbox, [menu.id, ...versions.map((v) => v.id)])
        : { state: 'synced' as const, items: [], errorMessage: null },
    [menu, outbox, versions]
  );

  if (!menu || !activeVersion) {
    return (
      <div className="rounded-2xl border border-slate-200/80 bg-white p-8 text-center text-sm text-slate-600 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] dark:text-slate-300">
        メニューが見つからないか、閲覧権限がありません。
      </div>
    );
  }

  const handleStatusChange = async (patch: { is_shared?: boolean; is_archived?: boolean }) => {
    if (statusBusy) return;
    setStatusError(null);
    setStatusBusy(true);
    try {
      await updateMenuStatus(menu.id, patch);
      setConfirmArchive(false);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'メニュー状態の更新に失敗しました。');
    } finally {
      setStatusBusy(false);
    }
  };

  const rows = activeVersion.content?.rows ?? [];
  const metrics = calculateMenuMetrics(rows);
  const status = deriveMenuStatus(menu, dataset.menu_status_history);

  return (
    <div className="space-y-5">
      {statusError && (
        <div className="no-print rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
          {statusError}
        </div>
      )}

      {(saveNotice || syncInfo.state !== 'synced') && (
        <div
          className={`no-print flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-xs font-semibold ${
            syncInfo.state === 'error'
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200'
              : syncInfo.state === 'pending' || syncInfo.state === 'syncing'
              ? 'border-sky-200 bg-sky-50 text-[#0b1f3a] dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              {syncInfo.state === 'error'
                ? 'この端末に保存済みですが、クラウドへの送信に失敗しました。上部の「再試行」からお試しください。'
                : syncInfo.state === 'pending' || syncInfo.state === 'syncing'
                ? `${saveNotice ?? '変更を保存しました。'}（この端末に保存済み・クラウドへ送信中）`
                : saveNotice ?? 'クラウドと同期済みです。'}
            </span>
          </div>
          <SyncStatusBadge state={syncInfo.state} compact />
        </div>
      )}

      {/* Control Toolbar (Hidden in Print) */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e]">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="menu-version-select"
            className="text-xs font-semibold text-slate-600 dark:text-slate-300"
          >
            表示する版
          </label>
          <select
            id="menu-version-select"
            value={activeVersion.id}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-mono-num dark:border-slate-700 dark:bg-[#07111e]"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_no} ({formatIsoToJstDate(v.created_at)})
              </option>
            ))}
          </select>
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            状態: {formatMenuStatusLabel(status)}
          </span>
          <SyncStatusBadge state={syncInfo.state} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <Printer className="h-4 w-4" />
            <span>印刷 / PDF</span>
          </button>

          {isCoach && !menu.is_archived && (
            <>
              <button
                type="button"
                disabled={statusBusy}
                onClick={() => void handleStatusChange({ is_shared: !menu.is_shared })}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                {menu.is_shared ? (
                  <>
                    <EyeOff className="h-4 w-4" />
                    <span>非共有にする</span>
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" />
                    <span>共有中にする</span>
                  </>
                )}
              </button>

              <Link
                to={`/menus/${menu.id}/revise`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
              >
                <Edit3 className="h-4 w-4" />
                <span>改訂（新版作成）</span>
              </Link>

              {!confirmArchive ? (
                <button
                  type="button"
                  disabled={statusBusy}
                  onClick={() => setConfirmArchive(true)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-rose-300 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300"
                >
                  <Archive className="h-4 w-4" />
                  <span>アーカイブ</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={statusBusy}
                    onClick={() =>
                      void handleStatusChange({ is_archived: true, is_shared: false })
                    }
                    className="min-h-[44px] rounded-xl bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                  >
                    アーカイブ確定
                  </button>
                  <button
                    type="button"
                    disabled={statusBusy}
                    onClick={() => setConfirmArchive(false)}
                    className="min-h-[44px] rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                  >
                    取消
                  </button>
                </div>
              )}
            </>
          )}

          {!isCoach && (
            <Link
              to={`/logs/new?versionId=${activeVersion.id}`}
              className="inline-flex min-h-[44px] items-center rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
            >
              このメニューで記録開始
            </Link>
          )}
        </div>
      </div>

      {/* Poolside / Print-ready Single-Screen Menu Sheet */}
      <article className="rounded-2xl border border-slate-200/80 bg-white p-5 sm:p-6 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-5">
        <header className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-[#0b1f3a] dark:text-slate-50">
              {activeVersion.title}
            </h1>
            <span className="font-mono-num text-xl font-bold text-[#0077b6] dark:text-[#38bdf8]">
              合計 {formatDistanceM(metrics.totalDistanceM)}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            <span>第{activeVersion.version_no}版</span>
            <span aria-hidden="true">·</span>
            <span>作成日 {formatIsoToJstDate(activeVersion.created_at)}</span>
            {metrics.byIntensity.map((b) => (
              <span key={b.intensity}>
                · {b.intensity}: {formatDistanceM(b.distance_m)} ({b.percentage}%)
              </span>
            ))}
          </div>
        </header>

        {/* Mobile Readable Card List (< 768px, hidden in print) */}
        <div className="md:hidden print:hidden space-y-2.5">
          {rows.map((row) => {
            if (row.is_group_header) {
              return (
                <div
                  key={row.id}
                  className="rounded-xl bg-[#0b1f3a]/8 px-3.5 py-2 text-xs font-bold text-[#0b1f3a] dark:bg-[#16345b]/60 dark:text-slate-100"
                >
                  {row.instruction || row.free_text || 'セクション'}
                </div>
              );
            }
            const rowDist = computeRowDistance(row);
            const memo = [row.instruction, row.free_text].filter(Boolean).join(' / ');
            return (
              <div
                key={row.id}
                className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-[#07111e]/60 space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
                    <span className="text-xs font-semibold text-[#0077b6] dark:text-[#38bdf8]">
                      {row.block_type}
                    </span>
                    <span className="font-mono-num">
                      {row.distance_m}m × {row.reps}t × {row.sets}s
                    </span>
                    <span>{row.stroke}</span>
                  </div>
                  <div className="font-mono-num text-xs font-bold text-[#0077b6] dark:text-[#38bdf8]">
                    {row.intensity} · {formatDistanceM(rowDist)}
                  </div>
                </div>
                {(row.circle || row.hr) && (
                  <div className="font-mono-num text-xs text-slate-600 dark:text-slate-300">
                    {row.circle ? `サークル ${row.circle}` : ''}
                    {row.circle && row.hr ? ' · ' : ''}
                    {row.hr ? `HR ${row.hr}` : ''}
                  </div>
                )}
                {memo && (
                  <p className="text-xs text-slate-600 dark:text-slate-300">{memo}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Desktop & Print Table */}
        <div className="hidden md:block print:block overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="py-2 pr-3">区分</th>
                <th className="py-2 pr-3">メニュー内容</th>
                <th className="py-2 pr-3">種目</th>
                <th className="py-2 pr-3">強度</th>
                <th className="py-2 pr-3">サークル / HR</th>
                <th className="py-2 pr-3 text-right">距離</th>
                <th className="py-2 pl-3">指示・メモ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((row) => {
                if (row.is_group_header) {
                  return (
                    <tr
                      key={row.id}
                      className="bg-slate-100/80 dark:bg-slate-800/60 print-break-avoid"
                    >
                      <td
                        colSpan={7}
                        className="py-2 px-2 text-xs font-bold text-[#0b1f3a] dark:text-slate-100"
                      >
                        {row.instruction || row.free_text || 'セクション'}
                      </td>
                    </tr>
                  );
                }
                const rowDist = computeRowDistance(row);
                return (
                  <tr key={row.id} className="print-break-avoid">
                    <td className="py-2.5 pr-3 text-xs font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {row.block_type}
                    </td>
                    <td className="py-2.5 pr-3 font-mono-num font-semibold text-[#0b1f3a] dark:text-slate-100 whitespace-nowrap">
                      {row.distance_m}m × {row.reps}t × {row.sets}s
                    </td>
                    <td className="py-2.5 pr-3 text-xs font-semibold whitespace-nowrap">
                      {row.stroke}
                    </td>
                    <td className="py-2.5 pr-3 font-mono-num text-xs font-bold text-[#0077b6] dark:text-[#38bdf8] whitespace-nowrap">
                      {row.intensity}
                    </td>
                    <td className="py-2.5 pr-3 font-mono-num text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {row.circle || '—'} {row.hr ? `/ HR ${row.hr}` : ''}
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono-num font-semibold whitespace-nowrap">
                      {formatDistanceM(rowDist)}
                    </td>
                    <td className="py-2.5 pl-3 text-xs text-slate-600 dark:text-slate-300">
                      {[row.instruction, row.free_text].filter(Boolean).join(' / ') || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>

      {/* Coach-only Status History */}
      {isCoach && statusHistory.length > 0 && (
        <section className="no-print rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-2">
          <h2 className="text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
            共有状態の変更履歴（コーチのみ）
          </h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {statusHistory.map((h) => (
              <div key={h.id} className="py-2 flex items-center justify-between gap-2">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  {formatStatusTransition(h)}
                </span>
                <span className="font-mono-num text-slate-500 dark:text-slate-400">
                  {formatIsoToJstDateTime(h.changed_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
