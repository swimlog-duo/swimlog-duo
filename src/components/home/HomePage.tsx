import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Calendar,
  ChevronRight,
  ClipboardList,
  MessageSquare,
  Plus,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import {
  calculateMenuMetrics,
  deriveMenuStatus,
  formatDistanceM,
  formatMenuStatusLabel,
  formatTimeMs,
} from '../../utils/swimCalculations';

export const HomePage: React.FC = () => {
  const { session } = useAuth();
  const { dataset, competitions } = useSwimData();
  const isCoach = session?.role === 'coach';

  const latestVersionByMenu = useMemo(() => {
    const map = new Map<string, (typeof dataset.menu_versions)[number]>();
    for (const v of dataset.menu_versions) {
      const prev = map.get(v.menu_id);
      if (!prev || v.version_no > prev.version_no) {
        map.set(v.menu_id, v);
      }
    }
    return map;
  }, [dataset.menu_versions]);

  const versionById = useMemo(() => {
    const map = new Map<string, (typeof dataset.menu_versions)[number]>();
    for (const v of dataset.menu_versions) {
      map.set(v.id, v);
    }
    return map;
  }, [dataset.menu_versions]);

  const activeDays = useMemo(
    () =>
      dataset.practice_days
        .filter((d) => !d.is_deleted)
        .sort((a, b) => b.practice_date.localeCompare(a.practice_date)),
    [dataset.practice_days]
  );

  const activeEntries = useMemo(
    () => dataset.practice_entries.filter((e) => !e.is_deleted),
    [dataset.practice_entries]
  );

  const weeklyStats = useMemo(() => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const recentDayIds = new Set(
      activeDays.filter((d) => d.practice_date >= weekAgo).map((d) => d.id)
    );
    let weekDistance = 0;
    let weekSessions = 0;

    for (const entry of activeEntries) {
      if (!recentDayIds.has(entry.day_id)) continue;
      weekSessions += 1;
      const ver = versionById.get(entry.menu_version_id);
      if (ver) {
        weekDistance += calculateMenuMetrics(ver.content?.rows ?? []).totalDistanceM;
      }
    }
    return { weekDistance, weekSessions, recentDayCount: recentDayIds.size };
  }, [activeDays, activeEntries, versionById]);

  const sharedMenus = useMemo(
    () => dataset.menus.filter((m) => m.is_shared && !m.is_archived),
    [dataset.menus]
  );

  const nextCompetition = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = competitions
      .filter((c) => c.event_date >= today)
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
    if (upcoming.length === 0) return null;
    const target = upcoming[0];
    const diffDays = Math.ceil(
      (new Date(`${target.event_date}T00:00:00`).getTime() -
        new Date(`${today}T00:00:00`).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    return { ...target, diffDays };
  }, [competitions]);

  const recentComments = useMemo(
    () =>
      [...dataset.coach_comments]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 3),
    [dataset.coach_comments]
  );

  return (
    <div className="space-y-6">
      {/* Header Hero Action Strip */}
      <section className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <p className="text-xs font-semibold text-sky-700 dark:text-sky-400">
            {isCoach ? 'コーチダッシュボード' : '選手ダッシュボード'} · {session?.displayName || '表示名未設定'}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            {isCoach ? '練習メニュー管理と選手フィードバック' : '今日の練習と記録入力'}
          </h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {isCoach ? (
            <Link
              to="/menus/new"
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>新しいメニューを作成</span>
            </Link>
          ) : (
            <Link
              to="/logs/new"
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>練習を記録する</span>
            </Link>
          )}
        </div>
      </section>

      {/* Top Metrics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            直近7日の総距離
          </div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-slate-900 dark:text-slate-50">
            {formatDistanceM(weeklyStats.weekDistance)}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            直近7日の練習回数
          </div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-slate-900 dark:text-slate-50">
            {weeklyStats.recentDayCount}日 / {weeklyStats.weekSessions}本
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            共有中メニュー
          </div>
          <div className="mt-1 font-mono-num text-2xl font-bold text-slate-900 dark:text-slate-50">
            {sharedMenus.length}件
          </div>
        </div>

        <Link
          to="/settings"
          className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-sky-400 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            次の大会まで（ローカル）
          </div>
          {nextCompetition ? (
            <div className="mt-1">
              <div className="font-mono-num text-2xl font-bold text-sky-600 dark:text-sky-400">
                あと{nextCompetition.diffDays}日
              </div>
              <div className="truncate text-xs text-slate-600 dark:text-slate-300">
                {nextCompetition.name} · {nextCompetition.event_date}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">
              設定から大会を登録
            </div>
          )}
        </Link>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Shared / Recent Menus */}
        <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-sky-600 dark:text-sky-400" />
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
                {isCoach ? '最近のメニュー' : '共有中の練習メニュー'}
              </h2>
            </div>
            <Link
              to="/menus"
              className="text-xs font-semibold text-sky-700 hover:underline dark:text-sky-400 min-h-[44px] flex items-center"
            >
              すべて見る
            </Link>
          </div>

          {(isCoach ? dataset.menus.filter((m) => !m.is_archived) : sharedMenus).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              {isCoach
                ? 'まだメニューがありません。「新しいメニューを作成」から登録できます。'
                : '現在共有中の練習メニューはありません。'}
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {(isCoach ? dataset.menus.filter((m) => !m.is_archived) : sharedMenus)
                .slice(0, 5)
                .map((menu) => {
                  const ver = latestVersionByMenu.get(menu.id);
                  const metrics = calculateMenuMetrics(ver?.content?.rows ?? []);
                  const statusLabel = formatMenuStatusLabel(
                    deriveMenuStatus(menu, dataset.menu_status_history)
                  );
                  return (
                    <Link
                      key={menu.id}
                      to={`/menus/${menu.id}`}
                      className="flex min-h-[60px] items-center justify-between gap-3 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl px-2 -mx-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {ver?.title ?? '名称未設定メニュー'}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                          <span>v{ver?.version_no ?? 1}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatDistanceM(metrics.totalDistanceM)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{statusLabel}</span>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                    </Link>
                  );
                })}
            </div>
          )}
        </section>

        {/* Recent Practice Days */}
        <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-sky-600 dark:text-sky-400" />
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
                最近の練習記録
              </h2>
            </div>
            <Link
              to="/logs"
              className="text-xs font-semibold text-sky-700 hover:underline dark:text-sky-400 min-h-[44px] flex items-center"
            >
              すべて見る
            </Link>
          </div>

          {activeDays.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              まだ練習記録がありません。
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {activeDays.slice(0, 5).map((day) => {
                const entries = activeEntries.filter((e) => e.day_id === day.id);
                const dayDist = entries.reduce((sum, e) => {
                  const ver = versionById.get(e.menu_version_id);
                  return (
                    sum +
                    (ver ? calculateMenuMetrics(ver.content?.rows ?? []).totalDistanceM : 0)
                  );
                }, 0);
                const totalMs = entries.reduce((sum, e) => sum + (e.total_time_ms ?? 0), 0);

                return (
                  <Link
                    key={day.id}
                    to={`/logs/day/${day.id}`}
                    className="flex min-h-[60px] items-center justify-between gap-3 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl px-2 -mx-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100 font-mono-num">
                        <Calendar className="h-4 w-4 text-slate-400 shrink-0" />
                        <span>{day.practice_date}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                        <span>{entries.length}メニュー</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatDistanceM(dayDist)}</span>
                        {totalMs > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatTimeMs(totalMs)}</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>rev.{day.revision}</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Latest Coach Comments */}
      {recentComments.length > 0 && (
        <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-sky-600 dark:text-sky-400" />
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
              最新のコーチコメント
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {recentComments.map((c) => {
              const entry = activeEntries.find((e) => e.id === c.entry_id);
              const ver = entry ? versionById.get(entry.menu_version_id) : undefined;
              return (
                <div key={c.id} className="py-2.5 text-sm">
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                    {ver?.title ?? '練習記録'} · {c.created_at.slice(0, 10)}
                  </div>
                  <p className="mt-1 text-slate-800 dark:text-slate-200">{c.body}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
