import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bookmark, Copy, Plus, Search } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import type { MenuDerivedStatus } from '../../types/domain';
import {
  calculateMenuMetrics,
  deriveMenuStatus,
  formatDistanceM,
  formatMenuStatusLabel,
} from '../../utils/swimCalculations';

type FilterTab = 'all' | MenuDerivedStatus | 'templates';

export const MenuListPage: React.FC = () => {
  const { session } = useAuth();
  const { dataset, templateMeta, toggleTemplateFlag } = useSwimData();
  const navigate = useNavigate();
  const isCoach = session?.role === 'coach';

  const [filter, setFilter] = useState<FilterTab>(isCoach ? 'all' : 'shared');
  const [query, setQuery] = useState('');

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

  const templateIdSet = useMemo(
    () => new Set(templateMeta.filter((t) => t.is_template).map((t) => t.menu_id)),
    [templateMeta]
  );

  const filteredMenus = useMemo(() => {
    return dataset.menus.filter((menu) => {
      const status = deriveMenuStatus(menu, dataset.menu_status_history);
      if (!isCoach && status !== 'shared') return false;

      if (filter === 'templates') {
        if (!templateIdSet.has(menu.id)) return false;
      } else if (filter !== 'all' && status !== filter) {
        return false;
      }

      const ver = latestVersionByMenu.get(menu.id);
      const q = query.trim().toLowerCase();
      if (q) {
        const title = (ver?.title ?? '').toLowerCase();
        const rowsText = (ver?.content?.rows ?? [])
          .map((r) => `${r.stroke} ${r.intensity} ${r.instruction} ${r.free_text}`)
          .join(' ')
          .toLowerCase();
        return title.includes(q) || rowsText.includes(q);
      }
      return true;
    });
  }, [
    dataset.menus,
    dataset.menu_status_history,
    isCoach,
    filter,
    query,
    latestVersionByMenu,
    templateIdSet,
  ]);

  const coachTabs: Array<{ id: FilterTab; label: string }> = [
    { id: 'all', label: 'すべて' },
    { id: 'shared', label: '共有中' },
    { id: 'unshared', label: '未共有' },
    { id: 'unlisted', label: '非共有' },
    { id: 'archived', label: 'アーカイブ' },
    { id: 'templates', label: 'テンプレート' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">
            練習メニュー一覧
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isCoach
              ? '作成・バージョン管理・共有状態切替・テンプレート流用が行えます'
              : 'コーチから共有された練習メニューを確認し、記録を開始できます'}
          </p>
        </div>

        {isCoach && (
          <Link
            to="/menus/new"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>新規作成</span>
          </Link>
        )}
      </div>

      {/* Search + Filter Controls */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="メニュー名・種目・強度・指示で検索"
            className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm text-slate-900 focus:border-sky-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>

        {isCoach && (
          <div className="flex gap-1 overflow-x-auto rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800/80">
            {coachTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`min-h-[40px] rounded-lg px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-50'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Menu Cards */}
      {filteredMenus.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          該当するメニューがありません。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredMenus.map((menu) => {
            const ver = latestVersionByMenu.get(menu.id);
            const rows = ver?.content?.rows ?? [];
            const metrics = calculateMenuMetrics(rows);
            const status = deriveMenuStatus(menu, dataset.menu_status_history);
            const isTemplate = templateIdSet.has(menu.id);

            return (
              <div
                key={menu.id}
                className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={`/menus/${menu.id}`}
                      className="text-base font-bold text-slate-900 hover:text-sky-600 dark:text-slate-50 dark:hover:text-sky-400"
                    >
                      {ver?.title ?? '名称未設定メニュー'}
                    </Link>
                    <button
                      type="button"
                      onClick={() => void toggleTemplateFlag(menu.id, !isTemplate)}
                      aria-label={isTemplate ? 'テンプレート解除' : 'テンプレート登録'}
                      className="flex min-h-[44px] min-w-[44px] -mt-2 -mr-2 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Bookmark
                        className={`h-4 w-4 ${
                          isTemplate ? 'fill-sky-600 text-sky-600 dark:fill-sky-400 dark:text-sky-400' : ''
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                    <span>v{ver?.version_no ?? 1}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatMenuStatusLabel(status)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDistanceM(metrics.totalDistanceM)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{rows.length}行</span>
                  </div>

                  {metrics.byIntensity.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300 font-mono-num">
                      {metrics.byIntensity.map((item) => (
                        <span key={item.intensity}>
                          {item.intensity}: {formatDistanceM(item.distance_m)} ({item.percentage}%)
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <Link
                    to={`/menus/${menu.id}`}
                    className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    詳細・印刷
                  </Link>

                  <div className="flex items-center gap-2">
                    {isCoach && (
                      <button
                        type="button"
                        onClick={() => navigate(`/menus/new?copyFrom=${menu.id}`)}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        <span>複製作成</span>
                      </button>
                    )}
                    {!isCoach && ver && (
                      <Link
                        to={`/logs/new?versionId=${ver.id}`}
                        className="inline-flex min-h-[44px] items-center rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white hover:bg-sky-700"
                      >
                        このメニューで記録
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
