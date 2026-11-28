import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import { deleteDraft, loadDraft, saveDraft } from '../../lib/offlineDb';
import {
  BLOCK_TYPES,
  INTENSITY_LEVELS,
  STROKE_TYPES,
  type MenuItemRow,
} from '../../types/database';
import {
  calculateMenuMetrics,
  computeRowDistance,
  createRowId,
  formatDistanceM,
  MAX_MENU_ROWS,
  validateMenuVersionInput,
} from '../../utils/swimCalculations';

const DISTANCE_PRESETS = [25, 50, 75, 100, 150, 200, 300, 400, 500, 800, 1000, 1500];
const REPS_PRESETS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];
const SETS_PRESETS = [1, 2, 3, 4, 5, 6, 8, 10];

interface PresetOrNumericFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  presets: number[];
  onChange: (next: number) => void;
}

const PresetOrNumericField: React.FC<PresetOrNumericFieldProps> = ({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  presets,
  onChange,
}) => {
  const [draft, setDraft] = useState<string>(String(value));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setDraft(String(value));
    }
  }, [value, isFocused]);

  const isPreset = presets.includes(value);

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
      >
        {label}
      </label>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        <select
          aria-label={`${label}の候補を選択`}
          value={isPreset ? String(value) : 'custom'}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              const el = document.getElementById(id) as HTMLInputElement | null;
              el?.focus();
              el?.select();
              return;
            }
            const nextVal = Number(e.target.value);
            setDraft(String(nextVal));
            onChange(nextVal);
          }}
          className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2 text-base sm:text-xs font-mono-num dark:border-slate-700 dark:bg-[#07111e]"
        >
          {presets.map((p) => (
            <option key={p} value={String(p)}>
              {p}
              {unit}
            </option>
          ))}
          <option value="custom">直接入力</option>
        </select>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={draft}
          onFocus={() => setIsFocused(true)}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            if (raw.trim() === '') return;
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed >= min) {
              onChange(Math.min(max, Math.floor(parsed)));
            }
          }}
          onBlur={() => {
            setIsFocused(false);
            const parsed = Number(draft);
            const clamped =
              Number.isFinite(parsed) && draft.trim() !== ''
                ? Math.max(min, Math.min(max, Math.floor(parsed)))
                : value;
            setDraft(String(clamped));
            if (clamped !== value) {
              onChange(clamped);
            }
          }}
          className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2.5 font-mono-num text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
        />
      </div>
    </div>
  );
};

function makeEmptyRow(): MenuItemRow {
  return {
    id: createRowId(),
    block_type: 'SWIM',
    stroke: 'Fr',
    intensity: 'A1',
    distance_m: 100,
    reps: 4,
    sets: 1,
    circle: '1:40',
    hr: null,
    instruction: '',
    free_text: '',
    is_group_header: false,
    parent_row_id: null,
  };
}

export const MenuEditorPage: React.FC = () => {
  const { menuId } = useParams<{ menuId: string }>();
  const [searchParams] = useSearchParams();
  const copyFromId = searchParams.get('copyFrom');
  const navigate = useNavigate();

  const { session } = useAuth();
  const { dataset, createMenu, reviseMenu } = useSwimData();
  const isCoach = session?.role === 'coach';
  const userId = session?.userId ?? '';
  const isRevisionMode = Boolean(menuId);

  const sourceMenuId = menuId ?? copyFromId;
  const sourceLatestVersion = useMemo(() => {
    if (!sourceMenuId) return null;
    const versions = dataset.menu_versions
      .filter((v) => v.menu_id === sourceMenuId)
      .sort((a, b) => b.version_no - a.version_no);
    return versions[0] ?? null;
  }, [sourceMenuId, dataset.menu_versions]);

  const draftKey = `menu_editor_${menuId ?? copyFromId ?? 'new'}`;

  const [title, setTitle] = useState<string>(() => {
    if (sourceLatestVersion) {
      return isRevisionMode
        ? sourceLatestVersion.title
        : `${sourceLatestVersion.title}（コピー）`;
    }
    return '';
  });

  const [rows, setRows] = useState<MenuItemRow[]>(() => {
    if (sourceLatestVersion?.content?.rows?.length) {
      return sourceLatestVersion.content.rows.map((r) => ({
        ...r,
        id: isRevisionMode ? r.id : createRowId(),
      }));
    }
    return [makeEmptyRow()];
  });

  const [shareAfter, setShareAfter] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submittedRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const isDirtyRef = useRef(false);
  const hydratedVersionIdRef = useRef<string | null>(sourceLatestVersion?.id ?? null);
  const loadedDraftScopeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sourceLatestVersion) return;
    if (isDirtyRef.current) return;
    if (hydratedVersionIdRef.current === sourceLatestVersion.id) return;

    hydratedVersionIdRef.current = sourceLatestVersion.id;
    setTitle(
      isRevisionMode
        ? sourceLatestVersion.title
        : `${sourceLatestVersion.title}（コピー）`
    );
    if (sourceLatestVersion.content?.rows?.length) {
      setRows(
        sourceLatestVersion.content.rows.map((r) => ({
          ...r,
          id: isRevisionMode ? r.id : createRowId(),
        }))
      );
    }
  }, [sourceLatestVersion, isRevisionMode]);

  useEffect(() => {
    if (!userId || !isCoach || sourceMenuId) {
      loadedDraftScopeRef.current = null;
      return;
    }
    const scope = `${userId}:${draftKey}`;
    if (loadedDraftScopeRef.current === scope) return;

    loadedDraftScopeRef.current = scope;
    isDirtyRef.current = false;
    submittedRef.current = false;
    let cancelled = false;
    let finished = false;

    void loadDraft<{ title: string; rows: MenuItemRow[] }>(userId, draftKey)
      .then((draft) => {
        finished = true;
        if (cancelled || isDirtyRef.current) return;
        if (draft && (draft.title || draft.rows?.length)) {
          setTitle(draft.title ?? '');
          if (Array.isArray(draft.rows) && draft.rows.length > 0) {
            setRows(draft.rows);
          }
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
  }, [userId, isCoach, sourceMenuId, draftKey]);

  useEffect(() => {
    if (!userId || !isCoach || !isDirtyRef.current || submittedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveDraft(userId, draftKey, { title, rows }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [userId, isCoach, draftKey, title, rows]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((isDirtyRef.current || submittingRef.current) && !submittedRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const metrics = useMemo(() => calculateMenuMetrics(rows), [rows]);
  const validation = useMemo(() => validateMenuVersionInput(title, rows), [title, rows]);

  if (!isCoach) {
    return (
      <div className="rounded-2xl border border-rose-300 bg-rose-50 p-6 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
        メニューの作成・改訂はコーチアカウントのみ操作できます。
      </div>
    );
  }

  const updateRow = (idx: number, patch: Partial<MenuItemRow>) => {
    isDirtyRef.current = true;
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    if (rows.length >= MAX_MENU_ROWS) return;
    isDirtyRef.current = true;
    setRows((prev) => [...prev, makeEmptyRow()]);
  };

  const removeRow = (idx: number) => {
    if (rows.length <= 1) return;
    isDirtyRef.current = true;
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveRow = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= rows.length) return;
    isDirtyRef.current = true;
    setRows((prev) => {
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    setSubmitError(null);
    if (!validation.valid) {
      setSubmitError(validation.errors.join(' '));
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (isRevisionMode && menuId) {
        await reviseMenu({
          menuId,
          title,
          rows,
          shareAfter,
        });
        submittedRef.current = true;
        isDirtyRef.current = false;
        if (userId) await deleteDraft(userId, draftKey);
        navigate(`/menus/${menuId}`, {
          state: { saveNotice: '新しいバージョンを保存しました。' },
        });
      } else {
        const newId = await createMenu({
          title,
          rows,
          shareNow: shareAfter,
        });
        submittedRef.current = true;
        isDirtyRef.current = false;
        if (userId) await deleteDraft(userId, draftKey);
        navigate(`/menus/${newId}`, {
          state: { saveNotice: '練習メニューを保存しました。' },
        });
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '保存に失敗しました。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#0b1f3a] dark:text-slate-50">
            {isRevisionMode ? 'メニュー改訂（新バージョン作成）' : '新しい練習メニューを作成'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isRevisionMode
              ? 'これまでの版を残したまま、新しいバージョンを作成します。'
              : '練習ブロックを追加すると、総距離と強度割合が自動で計算されます。'}
          </p>
        </div>
      </div>

      {draftRestored && (
        <div className="rounded-2xl border border-[#0077b6]/25 bg-[#0077b6]/5 px-4 py-2.5 text-xs font-medium text-[#0b1f3a] dark:border-[#38bdf8]/30 dark:bg-[#0e1b2e] dark:text-sky-200">
          入力途中の下書きを復元しました。
        </div>
      )}

      {submitError && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
          {submitError}
        </div>
      )}

      {/* Title & Live Metrics Summary */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div>
          <label
            htmlFor="menu-title"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            メニュー名（必須・1〜200文字）
          </label>
          <input
            id="menu-title"
            type="text"
            maxLength={200}
            required
            value={title}
            onChange={(e) => {
              isDirtyRef.current = true;
              setTitle(e.target.value);
            }}
            placeholder="例: 2026-11-23 朝練 スピード持久"
            className="mt-1.5 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-base sm:text-sm text-[#0b1f3a] focus:border-[#0077b6] focus:outline-none dark:border-slate-700 dark:bg-[#07111e] dark:text-slate-100"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="space-y-1">
            <div className="text-xs text-slate-500 dark:text-slate-400">総距離</div>
            <div className="font-mono-num text-2xl font-bold text-[#0077b6] dark:text-[#38bdf8]">
              {formatDistanceM(metrics.totalDistanceM)}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 text-xs font-mono-num text-slate-700 dark:text-slate-300">
            {metrics.byIntensity.map((b) => (
              <div key={b.intensity}>
                <span className="font-bold">{b.intensity}</span>: {formatDistanceM(b.distance_m)} (
                {b.percentage}%)
              </div>
            ))}
          </div>

          <div className="text-xs font-mono-num text-slate-500 dark:text-slate-400">
            {rows.length}/{MAX_MENU_ROWS}行
          </div>
        </div>
      </section>

      {/* Menu Rows Builder */}
      <section className="space-y-3">
        {rows.map((row, index) => {
          const rowDist = computeRowDistance(row);
          const idBase = `menu-row-${row.id}`;
          return (
            <div
              key={row.id}
              className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono-num text-xs font-bold text-slate-500 dark:text-slate-400">
                    #{index + 1}
                  </span>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 min-h-[44px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(row.is_group_header)}
                      onChange={(e) =>
                        updateRow(index, { is_group_header: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-[#0077b6]"
                    />
                    <span>見出し行（距離加算しない）</span>
                  </label>
                </div>

                <div className="flex items-center gap-1">
                  <span className="font-mono-num text-xs font-bold text-[#0b1f3a] dark:text-slate-200 mr-2">
                    {row.is_group_header ? '見出し' : formatDistanceM(rowDist)}
                  </span>
                  <button
                    type="button"
                    onClick={() => moveRow(index, -1)}
                    disabled={index === 0}
                    aria-label="上へ移動"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveRow(index, 1)}
                    disabled={index === rows.length - 1}
                    aria-label="下へ移動"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={rows.length <= 1}
                    aria-label="行を削除"
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-rose-500 hover:bg-rose-50 disabled:opacity-30 dark:hover:bg-rose-950/40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {!row.is_group_header && (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label
                        htmlFor={`${idBase}-block`}
                        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                      >
                        練習タイプ
                      </label>
                      <select
                        id={`${idBase}-block`}
                        value={row.block_type}
                        onChange={(e) => updateRow(index, { block_type: e.target.value })}
                        className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                      >
                        {BLOCK_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor={`${idBase}-stroke`}
                        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                      >
                        種目
                      </label>
                      <select
                        id={`${idBase}-stroke`}
                        value={row.stroke}
                        onChange={(e) => updateRow(index, { stroke: e.target.value })}
                        className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                      >
                        {STROKE_TYPES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor={`${idBase}-intensity`}
                        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                      >
                        強度
                      </label>
                      <select
                        id={`${idBase}-intensity`}
                        value={row.intensity}
                        onChange={(e) => updateRow(index, { intensity: e.target.value })}
                        className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2 text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                      >
                        {INTENSITY_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <PresetOrNumericField
                      id={`${idBase}-distance`}
                      label="距離 (m)"
                      value={row.distance_m}
                      min={0}
                      max={10000}
                      step={25}
                      unit="m"
                      presets={DISTANCE_PRESETS}
                      onChange={(nextVal) => updateRow(index, { distance_m: nextVal })}
                    />

                    <PresetOrNumericField
                      id={`${idBase}-reps`}
                      label="回数 (t)"
                      value={row.reps}
                      min={1}
                      max={200}
                      unit="t"
                      presets={REPS_PRESETS}
                      onChange={(nextVal) => updateRow(index, { reps: nextVal })}
                    />

                    <PresetOrNumericField
                      id={`${idBase}-sets`}
                      label="セット数 (s)"
                      value={row.sets}
                      min={1}
                      max={50}
                      unit="s"
                      presets={SETS_PRESETS}
                      onChange={(nextVal) => updateRow(index, { sets: nextVal })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label
                        htmlFor={`${idBase}-circle`}
                        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                      >
                        サークル
                      </label>
                      <input
                        id={`${idBase}-circle`}
                        type="text"
                        value={row.circle}
                        onChange={(e) => updateRow(index, { circle: e.target.value })}
                        placeholder="1:30"
                        className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2.5 font-mono-num text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`${idBase}-hr`}
                        className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                      >
                        目標心拍 (HR)
                      </label>
                      <input
                        id={`${idBase}-hr`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={row.hr ?? ''}
                        onChange={(e) =>
                          updateRow(index, {
                            hr: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        placeholder="160"
                        className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-2.5 font-mono-num text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label
                    htmlFor={`${idBase}-instruction`}
                    className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                  >
                    {row.is_group_header ? 'ブロック見出し' : '詳細指示'}
                  </label>
                  <input
                    id={`${idBase}-instruction`}
                    type="text"
                    value={row.instruction}
                    onChange={(e) => updateRow(index, { instruction: e.target.value })}
                    placeholder={
                      row.is_group_header ? '例: Main Set' : '例: 後半ビルドアップ'
                    }
                    className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${idBase}-free-text`}
                    className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400"
                  >
                    メモ
                  </label>
                  <input
                    id={`${idBase}-free-text`}
                    type="text"
                    value={row.free_text}
                    onChange={(e) => updateRow(index, { free_text: e.target.value })}
                    placeholder="補足メモ（任意）"
                    className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-base sm:text-sm dark:border-slate-700 dark:bg-[#07111e]"
                  />
                </div>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={addRow}
          disabled={rows.length >= MAX_MENU_ROWS}
          className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white text-sm font-semibold text-[#0b1f3a] hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-[#0e1b2e] dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" />
          <span>メニュー行を追加</span>
        </button>
      </section>

      {/* Bottom Save Bar */}
      <section className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e]">
        <label className="inline-flex items-center gap-2.5 text-sm font-medium text-[#0b1f3a] dark:text-slate-200 min-h-[44px] cursor-pointer">
          <input
            type="checkbox"
            checked={shareAfter}
            onChange={(e) => setShareAfter(e.target.checked)}
            className="h-5 w-5 rounded border-slate-300 text-[#0077b6]"
          />
          <span>保存後に選手へ共有する</span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="min-h-[48px] rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={submitting || !validation.valid}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#0077b6] px-6 text-sm font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
          >
            <Save className="h-4 w-4" />
            <span>{submitting ? '保存中...' : isRevisionMode ? '新バージョンを保存' : 'メニューを保存'}</span>
          </button>
        </div>
      </section>
    </form>
  );
};
