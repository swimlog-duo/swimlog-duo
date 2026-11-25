import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import {
  calculateMenuMetrics,
  formatDistanceM,
  formatTimeMs,
} from '../../utils/swimCalculations';

export const PracticeLogListPage: React.FC = () => {
  const { session } = useAuth();
  const { dataset } = useSwimData();
  const isAthlete = session?.role === 'athlete';

  const versionById = useMemo(() => {
    const map = new Map<string, (typeof dataset.menu_versions)[number]>();
    for (const v of dataset.menu_versions) {
      map.set(v.id, v);
    }
    return map;
  }, [dataset.menu_versions]);

  const days = useMemo(
    () =>
      dataset.practice_days
        .filter((d) => !d.is_deleted)
        .sort((a, b) => b.practice_date.localeCompare(a.practice_date)),
    [dataset.practice_days]
  );

  const entriesByDay = useMemo(() => {
    const map = new Map<string, typeof dataset.practice_entries>();
    for (const entry of dataset.practice_entries) {
      if (entry.is_deleted) continue;
      const list = map.get(entry.day_id) ?? [];
      list.push(entry);
      map.set(entry.day_id, list);
    }
    for (const [key, list] of map.entries()) {
      map.set(
        key,
        [...list].sort((a, b) => a.sort_order - b.sort_order)
      );
    }
    return map;
  }, [dataset.practice_entries]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#0b1f3a] dark:text-slate-50">
            練習記録一覧
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isAthlete
              ? '練習日ごとの実施メニューとタイムを確認・記録できます'
              : '選手の練習記録の確認とアドバイスができます'}
          </p>
        </div>

        {isAthlete && (
          <Link
            to="/logs/new"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#0077b6] px-4 py-2 text-sm font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc] whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>練習を記録する</span>
          </Link>
        )}
      </div>

      {days.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-8 text-center text-sm text-slate-500 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] dark:text-slate-400">
          {isAthlete
            ? 'まだ練習記録がありません。「練習を記録する」から最初の記録を作成してください。'
            : '選手から登録された練習記録はまだありません。'}
        </div>
      ) : (
        <div className="space-y-3">
          {days.map((day) => {
            const entries = entriesByDay.get(day.id) ?? [];
            const totalDistance = entries.reduce((sum, e) => {
              const ver = versionById.get(e.menu_version_id);
              return (
                sum +
                (ver ? calculateMenuMetrics(ver.content?.rows ?? []).totalDistanceM : 0)
              );
            }, 0);

            return (
              <Link
                key={day.id}
                to={`/logs/day/${day.id}`}
                className="block rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm transition hover:border-[#0077b6] dark:border-slate-800/80 dark:bg-[#0e1b2e] dark:hover:border-[#38bdf8]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-mono-num text-base font-bold text-[#0b1f3a] dark:text-slate-50">
                    <Calendar className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
                    <span>{day.practice_date}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono-num text-sm font-bold text-[#0077b6] dark:text-[#38bdf8]">
                    <span>{formatDistanceM(totalDistance)}</span>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </div>
                </div>

                {day.note && (
                  <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300 line-clamp-2">
                    {day.note}
                  </p>
                )}

                {entries.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-2.5 dark:border-slate-800">
                    {entries.map((entry) => {
                      const ver = versionById.get(entry.menu_version_id);
                      const detailParts: string[] = [];
                      if (entry.total_time_ms != null) {
                        detailParts.push(formatTimeMs(entry.total_time_ms));
                      }
                      if (entry.rating != null) {
                        detailParts.push(`評価 ${entry.rating}/5`);
                      }
                      return (
                        <div
                          key={entry.id}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-300"
                        >
                          <span className="font-semibold">
                            {ver?.title ?? 'メニュー'} (v{ver?.version_no ?? '?'})
                          </span>
                          {detailParts.length > 0 && (
                            <span className="font-mono-num text-slate-500 dark:text-slate-400">
                              {detailParts.join(' · ')}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};
