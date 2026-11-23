import React, { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Archive, Edit3, Eye, EyeOff, Printer } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import {
  calculateMenuMetrics,
  computeRowDistance,
  deriveMenuStatus,
  formatDistanceM,
  formatMenuStatusLabel,
} from '../../utils/swimCalculations';

export const MenuDetailPrintPage: React.FC = () => {
  const { menuId } = useParams<{ menuId: string }>();
  const { session } = useAuth();
  const { dataset, updateMenuStatus } = useSwimData();
  const isCoach = session?.role === 'coach';

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

  if (!menu || !activeVersion) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
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

      {/* Control Toolbar (Hidden in Print) */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            バージョン:
          </label>
          <select
            value={activeVersion.id}
            onChange={(e) => setSelectedVersionId(e.target.value)}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-mono-num dark:border-slate-700 dark:bg-slate-950"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version_no} ({v.created_at.slice(0, 10)})
              </option>
            ))}
          </select>
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            状態: {formatMenuStatusLabel(status)}
          </span>
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
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white hover:bg-sky-700"
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
              className="inline-flex min-h-[44px] items-center rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white hover:bg-sky-700"
            >
              このメニューで記録開始
            </Link>
          )}
        </div>
      </div>

      {/* Poolside / Print-ready Single-Screen Menu Sheet */}
      <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-5">
        <header className="border-b border-slate-200 pb-4 dark:border-slate-800">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
              {activeVersion.title}
            </h1>
            <span className="font-mono-num text-xl font-bold text-sky-600 dark:text-sky-400">
              Total {formatDistanceM(metrics.totalDistanceM)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
            <span>Version {activeVersion.version_no}</span>
            <span aria-hidden="true">·</span>
            <span>作成日 {activeVersion.created_at.slice(0, 10)}</span>
            {metrics.byIntensity.map((b) => (
              <span key={b.intensity}>
                · {b.intensity}: {formatDistanceM(b.distance_m)} ({b.percentage}%)
              </span>
            ))}
          </div>
        </header>

        <div className="overflow-x-auto">
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
                        className="py-2 px-2 text-xs font-bold text-slate-800 dark:text-slate-100"
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
                    <td className="py-2.5 pr-3 font-mono-num font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {row.distance_m}m × {row.reps}t × {row.sets}s
                    </td>
                    <td className="py-2.5 pr-3 text-xs font-semibold whitespace-nowrap">
                      {row.stroke}
                    </td>
                    <td className="py-2.5 pr-3 font-mono-num text-xs font-bold text-sky-700 dark:text-sky-300 whitespace-nowrap">
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
        <section className="no-print rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-2">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            共有状態変更履歴（コーチのみ閲覧可）
          </h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {statusHistory.map((h) => (
              <div key={h.id} className="py-2 flex items-center justify-between gap-2">
                <span className="text-slate-700 dark:text-slate-300">
                  共有: {String(h.old_is_shared)} → {String(h.new_is_shared)} · アーカイブ:{' '}
                  {String(h.old_is_archived)} → {String(h.new_is_archived)}
                </span>
                <span className="font-mono-num text-slate-500 dark:text-slate-400">
                  {h.changed_at.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
