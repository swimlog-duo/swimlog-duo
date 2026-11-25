import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Calendar,
  ChevronRight,
  ClipboardList,
  MessageSquare,
  Plus,
  Trophy,
  Zap,
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
      {/* Elite Sports Hero Banner */}
      <section className="relative overflow-hidden rounded-3xl border border-[#16345b] bg-gradient-to-br from-[#0b1f3a] via-[#102d54] to-[#07111e] p-6 sm:p-8 text-white shadow-xl dark:border-slate-800">
        <div className="absolute -right-12 -top-12 h-64 w-64 rounded-full bg-[#0077b6]/20 blur-3xl pointer-events-none" />
        <div className="absolute -left-12 -bottom-12 h-64 w-64 rounded-full bg-[#38bdf8]/10 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div className="min-w-0 space-y-1.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-[#38bdf8] backdrop-blur-md">
              <Zap className="h-3.5 w-3.5 fill-[#38bdf8]" />
              <span>{isCoach ? 'コーチダッシュボード' : '選手ダッシュボード'} · {session?.displayName || '表示名未設定'}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              {isCoach ? '練習メニュー管理と選手指導' : '今日のトレーニングと記録'}
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 max-w-xl">
              {isCoach
                ? '作成したメニューの配信状況確認や、選手ごとのタイム・感想へのフィードバックを行えます。'
                : 'コーチからの共有メニューを確認し、日々のトレーニング成果やラップタイムを記録しましょう。'}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 shrink-0">
            {isCoach ? (
              <Link
                to="/menus/new"
                className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-2xl bg-[#0077b6] px-6 py-3 text-sm font-bold text-white shadow-lg shadow-[#0077b6]/30 transition hover:bg-[#0284c7] active:scale-[0.98] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc] whitespace-nowrap"
              >
                <Plus className="h-5 w-5" />
                <span>新しいメニューを作成</span>
              </Link>
            ) : (
              <Link
                to="/logs/new"
                className="inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-2xl bg-[#0077b6] px-6 py-3 text-sm font-bold text-white shadow-lg shadow-[#0077b6]/30 transition hover:bg-[#0284c7] active:scale-[0.98] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc] whitespace-nowrap"
              >
                <Plus className="h-5 w-5" />
                <span>練習を記録する</span>
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* Strava-style Elite Metrics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:border-[#0077b6]/50 hover:shadow-md dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-1">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>直近7日の総距離</span>
            <Activity className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          </div>
          <div className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#0b1f3a] dark:text-slate-50">
            {formatDistanceM(weeklyStats.weekDistance)}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            過去7日間のトレーニング総量
          </p>
        </div>

        <div className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:border-[#0077b6]/50 hover:shadow-md dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-1">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>直近7日の練習</span>
            <Calendar className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          </div>
          <div className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#0b1f3a] dark:text-slate-50">
            {weeklyStats.recentDayCount}日 / {weeklyStats.weekSessions}回
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            安定した継続頻度
          </p>
        </div>

        <div className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:border-[#0077b6]/50 hover:shadow-md dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-1">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>共有中メニュー</span>
            <ClipboardList className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          </div>
          <div className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#0b1f3a] dark:text-slate-50">
            {sharedMenus.length}件
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            配信中の練習メニュー
          </p>
        </div>

        <Link
          to="/settings"
          className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm transition hover:border-[#0077b6] hover:shadow-md dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-1"
        >
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400">
            <span>次の大会まで</span>
            <Trophy className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          </div>
          {nextCompetition ? (
            <>
              <div className="font-mono-num text-2xl sm:text-3xl font-extrabold text-[#0077b6] dark:text-[#38bdf8]">
                あと{nextCompetition.diffDays}日
              </div>
              <p className="truncate text-[11px] text-slate-600 dark:text-slate-300">
                {nextCompetition.name}
              </p>
            </>
          ) : (
            <>
              <div className="text-xl font-bold text-slate-700 dark:text-slate-200">
                未登録
              </div>
              <p className="text-[11px] text-[#0077b6] dark:text-[#38bdf8] font-semibold">
                設定から大会を登録
              </p>
            </>
          )}
        </Link>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Shared / Recent Menus */}
        <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-950/60 text-[#0077b6] dark:text-[#38bdf8]">
                <ClipboardList className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-bold text-[#0b1f3a] dark:text-slate-50">
                {isCoach ? '最近の練習メニュー' : '共有中の練習メニュー'}
              </h2>
            </div>
            <Link
              to="/menus"
              className="inline-flex min-h-[44px] items-center px-2 text-xs font-semibold text-[#0077b6] hover:underline dark:text-[#38bdf8]"
            >
              すべて見る
            </Link>
          </div>

          {(isCoach ? dataset.menus.filter((m) => !m.is_archived) : sharedMenus).length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              {isCoach
                ? 'まだメニューがありません。「新しいメニューを作成」から登録できます。'
                : '現在共有中の練習メニューはありません。'}
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
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
                      className="flex min-h-[64px] items-center justify-between gap-3 py-3.5 transition hover:bg-slate-50/80 dark:hover:bg-slate-800/30 rounded-xl px-3 -mx-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
                          {ver?.title ?? '名称未設定メニュー'}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                          <span className="font-semibold text-[#0077b6] dark:text-[#38bdf8]">
                            v{ver?.version_no ?? 1}
                          </span>
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
        <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-950/60 text-[#0077b6] dark:text-[#38bdf8]">
                <Activity className="h-5 w-5" />
              </div>
              <h2 className="text-lg font-bold text-[#0b1f3a] dark:text-slate-50">
                最近の練習記録
              </h2>
            </div>
            <Link
              to="/logs"
              className="inline-flex min-h-[44px] items-center px-2 text-xs font-semibold text-[#0077b6] hover:underline dark:text-[#38bdf8]"
            >
              すべて見る
            </Link>
          </div>

          {activeDays.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              まだ練習記録がありません。「練習を記録する」から記録を追加しましょう。
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
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
                    className="flex min-h-[64px] items-center justify-between gap-3 py-3.5 transition hover:bg-slate-50/80 dark:hover:bg-slate-800/30 rounded-xl px-3 -mx-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a] dark:text-slate-100 font-mono-num">
                        <Calendar className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8] shrink-0" />
                        <span>{day.practice_date}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                        <span>{entries.length}メニュー</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-[#0077b6] dark:text-[#38bdf8]">
                          {formatDistanceM(dayDist)}
                        </span>
                        {totalMs > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatTimeMs(totalMs)}</span>
                          </>
                        )}
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
        <section className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 dark:bg-sky-950/60 text-[#0077b6] dark:text-[#38bdf8]">
              <MessageSquare className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-[#0b1f3a] dark:text-slate-50">
              最新のコーチコメント
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {recentComments.map((c) => {
              const entry = activeEntries.find((e) => e.id === c.entry_id);
              const ver = entry ? versionById.get(entry.menu_version_id) : undefined;
              return (
                <div key={c.id} className="py-3 text-sm space-y-1">
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                    {ver?.title ?? '練習記録'} · {c.created_at.slice(0, 10)}
                  </div>
                  <p className="text-slate-800 dark:text-slate-200 font-medium">
                    {c.body}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
