import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Save } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import { deleteDraft, loadDraft, saveDraft } from '../../lib/offlineDb';
import type { SplitRecord } from '../../types/database';
import {
  calculateMenuMetrics,
  computeRowDistance,
  formatDistanceM,
  parseTimeInputToMs,
} from '../../utils/swimCalculations';

interface RowLogInput {
  row_id: string;
  time_text: string;
  splits_text: string;
  rating: string;
  impression: string;
}

interface PracticeLogDraft {
  selectedDayId?: string;
  practiceDate: string;
  dayNote: string;
  selectedVersionId: string;
  totalTimeText: string;
  entryRating: string;
  entryImpression: string;
  rowInputs: Record<string, RowLogInput>;
}

export const PracticeLogEditorPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const presetVersionId = searchParams.get('versionId') ?? '';
  const presetDayId = searchParams.get('dayId') ?? '';
  const navigate = useNavigate();

  const { session } = useAuth();
  const { dataset, savePracticeLogBatch } = useSwimData();

  const userId = session?.userId ?? '';
  const isAthlete = session?.role === 'athlete';

  const sharedVersions = useMemo(() => {
    const sharedMenuIds = new Set(
      dataset.menus.filter((m) => m.is_shared && !m.is_archived).map((m) => m.id)
    );
    const latestByMenu = new Map<string, (typeof dataset.menu_versions)[number]>();
    for (const v of dataset.menu_versions) {
      if (!sharedMenuIds.has(v.menu_id)) continue;
      const prev = latestByMenu.get(v.menu_id);
      if (!prev || v.version_no > prev.version_no) {
        latestByMenu.set(v.menu_id, v);
      }
    }
    return Array.from(latestByMenu.values());
  }, [dataset.menus, dataset.menu_versions]);

  const activeDays = useMemo(
    () =>
      dataset.practice_days
        .filter((d) => !d.is_deleted)
        .sort((a, b) => b.practice_date.localeCompare(a.practice_date)),
    [dataset.practice_days]
  );

  const [selectedDayId, setSelectedDayId] = useState<string>(presetDayId || 'NEW');
  const [practiceDate, setPracticeDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [dayNote, setDayNote] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState<string>(() => {
    if (presetVersionId) return presetVersionId;
    return sharedVersions[0]?.id ?? '';
  });
  const [totalTimeText, setTotalTimeText] = useState('');
  const [entryRating, setEntryRating] = useState('');
  const [entryImpression, setEntryImpression] = useState('');
  const [rowInputs, setRowInputs] = useState<Record<string, RowLogInput>>({});
  const [draftRestored, setDraftRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submittedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const loadedDraftScopeRef = useRef<string | null>(null);
  const prevScopeRef = useRef<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const draftKey = `practice_log_new_${presetDayId || 'day'}`;

  const latestDraftRef = useRef<{
    userId: string;
    draftKey: string;
    payload: PracticeLogDraft;
  } | null>(null);

  useEffect(() => {
    if (!selectedVersionId && sharedVersions.length > 0) {
      setSelectedVersionId(sharedVersions[0].id);
    }
  }, [selectedVersionId, sharedVersions]);

  const activeVersion = useMemo(
    () =>
      dataset.menu_versions.find((v) => v.id === selectedVersionId) ??
      sharedVersions[0] ??
      null,
    [dataset.menu_versions, selectedVersionId, sharedVersions]
  );

  // Keep latestDraftRef synchronized for immediate flush on pagehide/unmount
  useEffect(() => {
    if (!userId || !isAthlete) {
      latestDraftRef.current = null;
      return;
    }
    latestDraftRef.current = {
      userId,
      draftKey,
      payload: {
        selectedDayId,
        practiceDate,
        dayNote,
        selectedVersionId,
        totalTimeText,
        entryRating,
        entryImpression,
        rowInputs,
      },
    };
  }, [
    userId,
    isAthlete,
    draftKey,
    selectedDayId,
    practiceDate,
    dayNote,
    selectedVersionId,
    totalTimeText,
    entryRating,
    entryImpression,
    rowInputs,
  ]);

  // StrictMode-safe & account-switch-safe draft hydration
  useEffect(() => {
    if (!userId || !isAthlete) {
      loadedDraftScopeRef.current = null;
      prevScopeRef.current = null;
      return;
    }

    const scope = `${userId}:${draftKey}:${presetDayId}:${presetVersionId}`;
    if (prevScopeRef.current !== null && prevScopeRef.current !== scope) {
      setSelectedDayId(presetDayId || 'NEW');
      setPracticeDate(new Date().toISOString().slice(0, 10));
      setDayNote('');
      setSelectedVersionId(presetVersionId || sharedVersions[0]?.id || '');
      setTotalTimeText('');
      setEntryRating('');
      setEntryImpression('');
      setRowInputs({});
      setDraftRestored(false);
      isDirtyRef.current = false;
      submittedRef.current = false;
    }
    prevScopeRef.current = scope;

    if (loadedDraftScopeRef.current === scope) {
      return;
    }
    loadedDraftScopeRef.current = scope;
    isDirtyRef.current = false;
    submittedRef.current = false;

    let cancelled = false;
    let finished = false;

    void loadDraft<PracticeLogDraft>(userId, draftKey)
      .then((d) => {
        finished = true;
        if (cancelled || isDirtyRef.current || !d) return;
        let restoredAny = false;
        if (!presetDayId && d.selectedDayId) {
          setSelectedDayId(d.selectedDayId);
          restoredAny = true;
        }
        if (!presetDayId && d.practiceDate) {
          setPracticeDate(d.practiceDate);
          restoredAny = true;
        }
        if (d.dayNote) {
          setDayNote(d.dayNote);
          restoredAny = true;
        }
        if (!presetVersionId && d.selectedVersionId) {
          setSelectedVersionId(d.selectedVersionId);
          restoredAny = true;
        }
        if (d.totalTimeText) {
          setTotalTimeText(d.totalTimeText);
          restoredAny = true;
        }
        if (d.entryRating) {
          setEntryRating(d.entryRating);
          restoredAny = true;
        }
        if (d.entryImpression) {
          setEntryImpression(d.entryImpression);
          restoredAny = true;
        }
        if (d.rowInputs && Object.keys(d.rowInputs).length > 0) {
          setRowInputs(d.rowInputs);
          restoredAny = true;
        }
        if (restoredAny) {
          setDraftRestored(true);
        }
      })
      .catch(() => {
        finished = true;
      });

    return () => {
      cancelled = true;
      if (!finished && loadedDraftScopeRef.current === scope) {
        loadedDraftScopeRef.current = null;
      }
    };
  }, [userId, isAthlete, draftKey, presetDayId, presetVersionId, sharedVersions]);

  // Debounced auto-save when dirty
  useEffect(() => {
    if (!userId || !isAthlete || !isDirtyRef.current || submittedRef.current) return;
    const payload: PracticeLogDraft = {
      selectedDayId,
      practiceDate,
      dayNote,
      selectedVersionId,
      totalTimeText,
      entryRating,
      entryImpression,
      rowInputs,
    };
    const timer = window.setTimeout(() => {
      if (isDirtyRef.current && !submittedRef.current) {
        void saveDraft(userId, draftKey, payload).catch(() => {});
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    userId,
    isAthlete,
    draftKey,
    selectedDayId,
    practiceDate,
    dayNote,
    selectedVersionId,
    totalTimeText,
    entryRating,
    entryImpression,
    rowInputs,
  ]);

  // Flush dirty draft immediately on pagehide / visibilitychange / unmount
  useEffect(() => {
    const flushNow = () => {
      if (!isDirtyRef.current || submittedRef.current) return;
      const latest = latestDraftRef.current;
      if (!latest) return;
      void saveDraft(latest.userId, latest.draftKey, latest.payload).catch(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushNow();
      }
    };

    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      flushNow();
    };
  }, []);

  const executableRows = useMemo(
    () => (activeVersion?.content?.rows ?? []).filter((r) => !r.is_group_header),
    [activeVersion]
  );
  const metrics = useMemo(
    () => calculateMenuMetrics(activeVersion?.content?.rows ?? []),
    [activeVersion]
  );

  if (!isAthlete) {
    return (
      <div className="rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
        練習記録の入力は選手アカウントのみ操作できます。コーチは記録の確認・編集・コメントが可能です。
      </div>
    );
  }

  const updateRowInput = (rowId: string, patch: Partial<RowLogInput>) => {
    isDirtyRef.current = true;
    setRowInputs((prev) => {
      const current = prev[rowId] ?? {
        row_id: rowId,
        time_text: '',
        splits_text: '',
        rating: '',
        impression: '',
      };
      return { ...prev, [rowId]: { ...current, ...patch } };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setErrorMsg(null);
    if (!activeVersion) {
      setErrorMsg('共有中のメニューを選択してください。');
      return;
    }

    let parsedTotalTimeMs: number | null = null;
    if (totalTimeText.trim()) {
      parsedTotalTimeMs = parseTimeInputToMs(totalTimeText);
      if (parsedTotalTimeMs === null) {
        setErrorMsg('合計時間の形式が正しくありません（例: 45:00 または 1:12.50）。');
        return;
      }
    }

    const preparedSets: Array<{
      row_id: string;
      time_ms: number | null;
      splits: SplitRecord[];
      rating: number | null;
      impression: string;
    }> = [];

    for (const row of executableRows) {
      const input = rowInputs[row.id];
      if (
        !input ||
        (!input.time_text.trim() &&
          !input.splits_text.trim() &&
          !input.rating &&
          !input.impression.trim())
      ) {
        continue;
      }

      let rowTimeMs: number | null = null;
      if (input.time_text.trim()) {
        rowTimeMs = parseTimeInputToMs(input.time_text);
        if (rowTimeMs === null) {
          setErrorMsg(
            `「${row.distance_m}m ${row.stroke}」の代表タイム形式が正しくありません（例: 31.45 または 1:05.20）。`
          );
          return;
        }
      }

      const splitTokens = input.splits_text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const splits: SplitRecord[] = [];
      for (let idx = 0; idx < splitTokens.length; idx += 1) {
        const ms = parseTimeInputToMs(splitTokens[idx]);
        if (ms === null) {
          setErrorMsg(
            `「${row.distance_m}m ${row.stroke}」のラップ（${splitTokens[idx]}）形式が正しくありません。`
          );
          return;
        }
        splits.push({ rep: idx + 1, time_ms: ms });
      }

      preparedSets.push({
        row_id: row.id,
        time_ms: rowTimeMs,
        splits,
        rating: input.rating ? Number(input.rating) : null,
        impression: input.impression.trim(),
      });
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      let existingDayId: string | null = null;
      if (selectedDayId !== 'NEW') {
        existingDayId = selectedDayId;
      } else {
        const existingSameDate = activeDays.find((d) => d.practice_date === practiceDate);
        if (existingSameDate) {
          existingDayId = existingSameDate.id;
        }
      }

      const existingEntriesForDay = existingDayId
        ? dataset.practice_entries.filter((en) => en.day_id === existingDayId && !en.is_deleted)
        : [];
      const nextSortOrder =
        existingEntriesForDay.reduce((m, en) => Math.max(m, en.sort_order), 0) + 1;

      const dayId = await savePracticeLogBatch({
        existingDayId,
        practice_date: practiceDate,
        day_note: dayNote,
        menu_version_id: activeVersion.id,
        sort_order: nextSortOrder,
        total_time_ms: parsedTotalTimeMs,
        rating: entryRating ? Number(entryRating) : null,
        impression: entryImpression,
        set_results: preparedSets,
      });

      submittedRef.current = true;
      isDirtyRef.current = false;
      if (userId) {
        await deleteDraft(userId, draftKey);
      }
      navigate(`/logs/day/${dayId}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '記録の保存に失敗しました。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-[#0b1f3a] dark:text-slate-50">
          練習日の登録
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          入力内容は自動で端末に下書き保存され、オフラインでも記録できます。
        </p>
      </div>

      {draftRestored && (
        <div className="rounded-2xl border border-[#0077b6]/25 bg-[#0077b6]/5 px-4 py-2.5 text-xs font-medium text-[#0b1f3a] dark:border-[#38bdf8]/30 dark:bg-[#0e1b2e] dark:text-sky-200">
          入力途中の下書きを復元しました。
        </div>
      )}

      {errorMsg && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
          {errorMsg}
        </div>
      )}

      {/* Day & Menu Version Selection */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="log-day-select"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              記録先の練習日
            </label>
            <select
              id="log-day-select"
              value={selectedDayId}
              onChange={(e) => {
                isDirtyRef.current = true;
                setSelectedDayId(e.target.value);
              }}
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            >
              <option value="NEW">新しい練習日を登録（同日があれば統合）</option>
              {activeDays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.practice_date} に追加メニューとして記録
                </option>
              ))}
            </select>
          </div>

          {selectedDayId === 'NEW' && (
            <div>
              <label
                htmlFor="log-practice-date"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                練習日（必須）
              </label>
              <input
                id="log-practice-date"
                type="date"
                required
                value={practiceDate}
                onChange={(e) => {
                  isDirtyRef.current = true;
                  setPracticeDate(e.target.value);
                }}
                className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
              />
            </div>
          )}
        </div>

        {selectedDayId === 'NEW' && (
          <div>
            <label
              htmlFor="log-day-note"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              その日のメモ・体調
            </label>
            <input
              id="log-day-note"
              type="text"
              value={dayNote}
              onChange={(e) => {
                isDirtyRef.current = true;
                setDayNote(e.target.value);
              }}
              placeholder="例: 朝練 25mプール 体調良好"
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
          </div>
        )}

        <div>
          <label
            htmlFor="log-menu-version-select"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            使った練習メニュー（必須）
          </label>
          <select
            id="log-menu-version-select"
            value={activeVersion?.id ?? ''}
            onChange={(e) => {
              isDirtyRef.current = true;
              setSelectedVersionId(e.target.value);
            }}
            required
            className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
          >
            {sharedVersions.length === 0 ? (
              <option value="">共有中のメニューがありません</option>
            ) : (
              sharedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} (v{v.version_no})
                </option>
              ))
            )}
          </select>
          {activeVersion && (
            <p className="mt-1 font-mono-num text-xs text-slate-500 dark:text-slate-400">
              総距離 {formatDistanceM(metrics.totalDistanceM)} · {executableRows.length}項目
            </p>
          )}
        </div>
      </section>

      {/* Set-by-Set Logging */}
      {activeVersion && (
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
            セットごとのタイム・感想
          </h2>

          {(activeVersion.content?.rows ?? []).map((row) => {
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
            const val = rowInputs[row.id] ?? {
              row_id: row.id,
              time_text: '',
              splits_text: '',
              rating: '',
              impression: '',
            };
            const dist = computeRowDistance(row);
            const rowBase = `log-row-${row.id}`;
            return (
              <div
                key={row.id}
                className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm font-bold text-[#0b1f3a] dark:text-slate-50">
                    <span className="text-[#0077b6] dark:text-[#38bdf8] mr-2">
                      [{row.block_type}]
                    </span>
                    <span className="font-mono-num">
                      {row.distance_m}m × {row.reps}t × {row.sets}s
                    </span>{' '}
                    <span>{row.stroke}</span>{' '}
                    <span className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
                      ({row.intensity} · {formatDistanceM(dist)})
                    </span>
                  </div>
                  <div className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
                    {row.circle ? `サークル ${row.circle}` : ''}
                    {row.hr ? ` · HR ${row.hr}` : ''}
                  </div>
                </div>
                {(row.instruction || row.free_text) && (
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    指示: {[row.instruction, row.free_text].filter(Boolean).join(' / ')}
                  </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label
                      htmlFor={`${rowBase}-time`}
                      className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                    >
                      代表タイム（例 31.45 / 1:05.20）
                    </label>
                    <input
                      id={`${rowBase}-time`}
                      type="text"
                      value={val.time_text}
                      onChange={(e) =>
                        updateRowInput(row.id, { time_text: e.target.value })
                      }
                      placeholder="31.45"
                      className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${rowBase}-splits`}
                      className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                    >
                      各本ラップ（カンマ区切り）
                    </label>
                    <input
                      id={`${rowBase}-splits`}
                      type="text"
                      value={val.splits_text}
                      onChange={(e) =>
                        updateRowInput(row.id, { splits_text: e.target.value })
                      }
                      placeholder="31.2, 31.5, 31.8"
                      className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`${rowBase}-rating`}
                      className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                    >
                      セット評価 (1〜5)
                    </label>
                    <select
                      id={`${rowBase}-rating`}
                      value={val.rating}
                      onChange={(e) => updateRowInput(row.id, { rating: e.target.value })}
                      className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
                    >
                      <option value="">未選択</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor={`${rowBase}-impression`}
                    className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                  >
                    セットのメモ
                  </label>
                  <input
                    id={`${rowBase}-impression`}
                    type="text"
                    value={val.impression}
                    onChange={(e) =>
                      updateRowInput(row.id, { impression: e.target.value })
                    }
                    placeholder="このセットの感覚・メモ"
                    className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
                  />
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* Overall Entry Summary */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <h2 className="text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
          メニュー全体の振り返り
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="log-total-time"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              合計時間（例 45:00 または 1:12.50）
            </label>
            <input
              id="log-total-time"
              type="text"
              value={totalTimeText}
              onChange={(e) => {
                isDirtyRef.current = true;
                setTotalTimeText(e.target.value);
              }}
              placeholder="45:00"
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
          </div>

          <div>
            <label
              htmlFor="log-entry-rating"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              全体評価 (1〜5)
            </label>
            <select
              id="log-entry-rating"
              value={entryRating}
              onChange={(e) => {
                isDirtyRef.current = true;
                setEntryRating(e.target.value);
              }}
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            >
              <option value="">未選択</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="log-entry-impression"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            感想・メモ
          </label>
          <textarea
            id="log-entry-impression"
            rows={3}
            value={entryImpression}
            onChange={(e) => {
              isDirtyRef.current = true;
              setEntryImpression(e.target.value);
            }}
            placeholder="泳ぎの感触、課題、良かった点など"
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-[#07111e]"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !activeVersion}
          className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#0077b6] px-6 text-sm font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
        >
          <Save className="h-4 w-4" />
          <span>{submitting ? '保存中...' : '練習記録を保存する'}</span>
        </button>
      </section>
    </form>
  );
};
