import React, { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useSwimData } from '../../hooks/useSwimData';
import { INTENSITY_LEVELS, STROKE_TYPES } from '../../types/database';
import {
  calculateMenuMetrics,
  formatDistanceM,
  formatTimeMs,
} from '../../utils/swimCalculations';

export const AnalyticsPage: React.FC = () => {
  const { dataset, competitions } = useSwimData();
  const [strokeFilter, setStrokeFilter] = useState<string>('Fr');

  const versionById = useMemo(
    () => new Map(dataset.menu_versions.map((v) => [v.id, v])),
    [dataset.menu_versions]
  );

  const activeDays = useMemo(
    () => dataset.practice_days.filter((d) => !d.is_deleted),
    [dataset.practice_days]
  );
  const dayById = useMemo(() => new Map(activeDays.map((d) => [d.id, d])), [activeDays]);

  const activeEntries = useMemo(
    () => dataset.practice_entries.filter((e) => !e.is_deleted && dayById.has(e.day_id)),
    [dataset.practice_entries, dayById]
  );

  const aggregate = useMemo(() => {
    let totalDistance = 0;
    let totalDurationMs = 0;
    const intensityTotals = new Map<string, number>();

    for (const entry of activeEntries) {
      totalDurationMs += entry.total_time_ms ?? 0;
      const ver = versionById.get(entry.menu_version_id);
      if (!ver) continue;
      const m = calculateMenuMetrics(ver.content?.rows ?? []);
      totalDistance += m.totalDistanceM;
      for (const b of m.byIntensity) {
        intensityTotals.set(
          b.intensity,
          (intensityTotals.get(b.intensity) ?? 0) + b.distance_m
        );
      }
    }

    const intensityList = INTENSITY_LEVELS.map((lvl) => {
      const dist = intensityTotals.get(lvl) ?? 0;
      return {
        intensity: lvl,
        distance_m: dist,
        pct: totalDistance > 0 ? Math.round((dist / totalDistance) * 1000) / 10 : 0,
      };
    }).filter((x) => x.distance_m > 0);

    return { totalDistance, totalDurationMs, intensityList };
  }, [activeEntries, versionById]);

  const timeTrend = useMemo(() => {
    const entryById = new Map(activeEntries.map((e) => [e.id, e]));
    const points: Array<{
      date: string;
      time_ms: number;
      distance_m: number;
      label: string;
    }> = [];

    for (const sr of dataset.set_results) {
      if (sr.is_deleted || sr.time_ms == null) continue;
      const entry = entryById.get(sr.entry_id);
      if (!entry) continue;
      const day = dayById.get(entry.day_id);
      const ver = versionById.get(entry.menu_version_id);
      const row = ver?.content?.rows?.find((r) => r.id === sr.row_id);
      if (!day || !row) continue;
      if (row.stroke !== strokeFilter) continue;

      points.push({
        date: day.practice_date,
        time_ms: sr.time_ms,
        distance_m: row.distance_m,
        label: `${row.distance_m}m ${row.stroke}`,
      });
    }

    return points.sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
  }, [dataset.set_results, activeEntries, dayById, versionById, strokeFilter]);

  const maxTimeMs = useMemo(
    () => timeTrend.reduce((m, p) => Math.max(m, p.time_ms), 1),
    [timeTrend]
  );

  const today = new Date().toISOString().slice(0, 10);
  const upcomingComps = useMemo(
    () =>
      competitions
        .filter((c) => c.event_date >= today)
        .sort((a, b) => a.event_date.localeCompare(b.event_date)),
    [competitions, today]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-[#0077b6] dark:text-[#38bdf8]" />
        <h1 className="text-xl font-bold text-[#0b1f3a] dark:text-slate-50">
          練習データの分析
        </h1>
      </div>

      {/* Totals */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e]">
          <div className="text-xs text-slate-500 dark:text-slate-400">累計総距離</div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-[#0b1f3a] dark:text-slate-50">
            {formatDistanceM(aggregate.totalDistance)}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e]">
          <div className="text-xs text-slate-500 dark:text-slate-400">実施回数</div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-[#0b1f3a] dark:text-slate-50">
            {activeDays.length}日 / {activeEntries.length}回
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e]">
          <div className="text-xs text-slate-500 dark:text-slate-400">合計時間</div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-[#0b1f3a] dark:text-slate-50">
            {aggregate.totalDurationMs > 0
              ? formatTimeMs(aggregate.totalDurationMs)
              : '—'}
          </div>
        </div>
      </section>

      {/* Intensity Breakdown */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
          強度別の距離と割合
        </h2>
        {aggregate.intensityList.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            記録された練習がまだありません。
          </p>
        ) : (
          <div className="space-y-3">
            {aggregate.intensityList.map((row) => (
              <div key={row.intensity} className="space-y-1">
                <div className="flex items-center justify-between text-xs font-mono-num">
                  <span className="font-bold text-[#0b1f3a] dark:text-slate-100">
                    {row.intensity}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300">
                    {formatDistanceM(row.distance_m)} ({row.pct}%)
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-[#0077b6] dark:bg-[#38bdf8]"
                    style={{ width: `${Math.min(100, row.pct)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Time Trend */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
            過去のタイム推移
          </h2>
          <div className="flex items-center gap-2">
            <label
              htmlFor="analytics-stroke-filter"
              className="text-xs font-semibold text-slate-600 dark:text-slate-300"
            >
              種目
            </label>
            <select
              id="analytics-stroke-filter"
              value={strokeFilter}
              onChange={(e) => setStrokeFilter(e.target.value)}
              className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold dark:border-slate-700 dark:bg-[#07111e]"
            >
              {STROKE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {timeTrend.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {strokeFilter} のタイム記録がまだありません。
          </p>
        ) : (
          <div className="space-y-2.5">
            {timeTrend.map((pt, i) => {
              const widthPct = Math.max(15, Math.round((pt.time_ms / maxTimeMs) * 100));
              return (
                <div key={`${pt.date}-${i}`} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-mono-num">
                    <span className="text-slate-600 dark:text-slate-300">
                      {pt.date} · {pt.label}
                    </span>
                    <span className="font-bold text-[#0b1f3a] dark:text-slate-50">
                      {formatTimeMs(pt.time_ms)}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-[#0077b6] dark:bg-[#38bdf8]"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Competition Countdown */}
      {upcomingComps.length > 0 && (
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3">
          <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
            大会カウントダウン
          </h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {upcomingComps.map((c) => {
              const daysLeft = Math.ceil(
                (new Date(`${c.event_date}T00:00:00`).getTime() -
                  new Date(`${today}T00:00:00`).getTime()) /
                  (1000 * 60 * 60 * 24)
              );
              return (
                <div key={c.id} className="py-2.5 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-[#0b1f3a] dark:text-slate-100">
                      {c.name}
                    </div>
                    <div className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
                      {c.event_date} {c.note ? `· ${c.note}` : ''}
                    </div>
                  </div>
                  <div className="font-mono-num text-lg font-bold text-[#0077b6] dark:text-[#38bdf8]">
                    あと {daysLeft}日
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
