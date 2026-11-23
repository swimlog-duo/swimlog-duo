import React, { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Edit2, History, MessageSquare, Plus, Save, X } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import type { PracticeEntryRow, SetResultRow, SplitRecord } from '../../types/database';
import {
  calculateMenuMetrics,
  formatDistanceM,
  formatTimeMs,
  parseTimeInputToMs,
} from '../../utils/swimCalculations';

export const PracticeLogDetailPage: React.FC = () => {
  const { dayId } = useParams<{ dayId: string }>();
  const { session } = useAuth();
  const {
    dataset,
    createSetResult,
    updatePracticeDay,
    updatePracticeEntry,
    updateSetResult,
    addCoachComment,
  } = useSwimData();

  const isCoach = session?.role === 'coach';
  const isAthlete = session?.role === 'athlete';

  const day = useMemo(
    () => dataset.practice_days.find((d) => d.id === dayId && !d.is_deleted) ?? null,
    [dataset.practice_days, dayId]
  );

  const entries = useMemo(
    () =>
      dataset.practice_entries
        .filter((e) => e.day_id === dayId && !e.is_deleted)
        .sort((a, b) => a.sort_order - b.sort_order),
    [dataset.practice_entries, dayId]
  );

  const profileNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of dataset.profiles) {
      map.set(p.id, `${p.display_name} (${p.role === 'coach' ? 'コーチ' : '選手'})`);
    }
    return map;
  }, [dataset.profiles]);

  const [editingDayNote, setEditingDayNote] = useState(false);
  const [dayNoteDraft, setDayNoteDraft] = useState('');

  const [editingEntry, setEditingEntry] = useState<PracticeEntryRow | null>(null);
  const [entryTimeDraft, setEntryTimeDraft] = useState('');
  const [entryRatingDraft, setEntryRatingDraft] = useState('');
  const [entryImpDraft, setEntryImpDraft] = useState('');

  const [editingSet, setEditingSet] = useState<SetResultRow | null>(null);
  const [creatingSetTarget, setCreatingSetTarget] = useState<{
    entryId: string;
    rowId: string;
    label: string;
  } | null>(null);
  const [setTimeDraft, setSetTimeDraft] = useState('');
  const [setSplitsDraft, setSetSplitsDraft] = useState('');
  const [setRatingDraft, setSetRatingDraft] = useState('');
  const [setImpDraft, setSetImpDraft] = useState('');

  const [commentEntryId, setCommentEntryId] = useState<string>('');
  const [commentSetResultId, setCommentSetResultId] = useState<string>('');
  const [commentBody, setCommentBody] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  if (!day) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
        練習日の記録が見つかりません。
      </div>
    );
  }

  const handleSaveDayNote = async () => {
    if (savingRef.current) return;
    setActionError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      await updatePracticeDay(day.id, day.revision, { note: dayNoteDraft });
      setEditingDayNote(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新に失敗しました。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const openEntryEdit = (entry: PracticeEntryRow) => {
    setModalError(null);
    setEditingEntry(entry);
    setEntryTimeDraft(entry.total_time_ms != null ? formatTimeMs(entry.total_time_ms) : '');
    setEntryRatingDraft(entry.rating != null ? String(entry.rating) : '');
    setEntryImpDraft(entry.impression ?? '');
  };

  const handleSaveEntryEdit = async () => {
    if (!editingEntry || savingRef.current) return;
    setModalError(null);
    let parsedTimeMs: number | null = null;
    if (entryTimeDraft.trim()) {
      parsedTimeMs = parseTimeInputToMs(entryTimeDraft);
      if (parsedTimeMs === null) {
        setModalError('合計時間の形式が正しくありません（例: 45:00 または 1:12.50）。');
        return;
      }
    }

    savingRef.current = true;
    setSaving(true);
    try {
      await updatePracticeEntry(editingEntry.id, editingEntry.revision, {
        total_time_ms: parsedTimeMs,
        rating: entryRatingDraft ? Number(entryRatingDraft) : null,
        impression: entryImpDraft,
      });
      setEditingEntry(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '更新に失敗しました。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const openSetEdit = (sr: SetResultRow) => {
    setModalError(null);
    setCreatingSetTarget(null);
    setEditingSet(sr);
    setSetTimeDraft(sr.time_ms != null ? formatTimeMs(sr.time_ms) : '');
    setSetSplitsDraft(
      Array.isArray(sr.splits) && sr.splits.length > 0
        ? sr.splits
            .map((sp) => (sp.time_ms != null ? formatTimeMs(sp.time_ms) : ''))
            .filter(Boolean)
            .join(', ')
        : ''
    );
    setSetRatingDraft(sr.rating != null ? String(sr.rating) : '');
    setSetImpDraft(sr.impression ?? '');
  };

  const openSetCreate = (entryId: string, rowId: string, label: string) => {
    setModalError(null);
    setEditingSet(null);
    setCreatingSetTarget({ entryId, rowId, label });
    setSetTimeDraft('');
    setSetSplitsDraft('');
    setSetRatingDraft('');
    setSetImpDraft('');
  };

  const handleSaveSetModal = async () => {
    if ((!editingSet && !creatingSetTarget) || savingRef.current) return;
    setModalError(null);

    let parsedTimeMs: number | null = null;
    if (setTimeDraft.trim()) {
      parsedTimeMs = parseTimeInputToMs(setTimeDraft);
      if (parsedTimeMs === null) {
        setModalError('タイムの形式が正しくありません（例: 31.45 または 1:05.20）。');
        return;
      }
    }

    const splitTokens = setSplitsDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const splits: SplitRecord[] = [];
    for (let idx = 0; idx < splitTokens.length; idx += 1) {
      const ms = parseTimeInputToMs(splitTokens[idx]);
      if (ms === null) {
        setModalError(`ラップ（${splitTokens[idx]}）の形式が正しくありません。`);
        return;
      }
      splits.push({ rep: idx + 1, time_ms: ms });
    }

    savingRef.current = true;
    setSaving(true);
    try {
      if (editingSet) {
        await updateSetResult(editingSet.id, editingSet.revision, {
          time_ms: parsedTimeMs,
          splits,
          rating: setRatingDraft ? Number(setRatingDraft) : null,
          impression: setImpDraft,
        });
        setEditingSet(null);
      } else if (creatingSetTarget) {
        await createSetResult({
          entry_id: creatingSetTarget.entryId,
          row_id: creatingSetTarget.rowId,
          time_ms: parsedTimeMs,
          splits,
          rating: setRatingDraft ? Number(setRatingDraft) : null,
          impression: setImpDraft.trim(),
        });
        setCreatingSetTarget(null);
      }
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '保存に失敗しました。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSubmitComment = async (entryId: string) => {
    if (!commentBody.trim() || savingRef.current) return;
    setActionError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      await addCoachComment({
        entryId,
        setResultId: commentSetResultId || null,
        body: commentBody,
      });
      setCommentBody('');
      setCommentSetResultId('');
      setCommentEntryId('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'コメント投稿に失敗しました。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const relatedIds = new Set<string>([
    day.id,
    ...entries.map((e) => e.id),
    ...dataset.set_results
      .filter((s) => entries.some((e) => e.id === s.entry_id))
      .map((s) => s.id),
  ]);

  const relatedHistory = dataset.record_history
    .filter((h) => relatedIds.has(h.record_id))
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at));

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
          {actionError}
        </div>
      )}

      {/* Day Header */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-mono-num text-2xl font-bold text-slate-900 dark:text-slate-50">
              {day.practice_date}
            </h1>
            <p className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
              rev.{day.revision} · 最終更新 {day.updated_at.slice(0, 16).replace('T', ' ')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAthlete && (
              <Link
                to={`/logs/new?dayId=${day.id}`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-sky-600 px-3.5 text-xs font-semibold text-white hover:bg-sky-700"
              >
                <Plus className="h-4 w-4" />
                <span>この日にメニュー追加</span>
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                setDayNoteDraft(day.note ?? '');
                setEditingDayNote(true);
              }}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
            >
              <Edit2 className="h-3.5 w-3.5" />
              <span>日次メモ編集</span>
            </button>
          </div>
        </div>

        {editingDayNote ? (
          <div className="space-y-2">
            <textarea
              rows={2}
              value={dayNoteDraft}
              onChange={(e) => setDayNoteDraft(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingDayNote(false)}
                className="min-h-[40px] rounded-xl border border-slate-300 px-3 text-xs font-semibold"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleSaveDayNote()}
                className="min-h-[40px] rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white"
              >
                保存 (expected_revision: {day.revision})
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {day.note || '日次メモなし'}
          </p>
        )}
      </section>

      {/* Entries */}
      {entries.map((entry) => {
        const ver = dataset.menu_versions.find((v) => v.id === entry.menu_version_id);
        const rows = ver?.content?.rows ?? [];
        const metrics = calculateMenuMetrics(rows);
        const setResults = dataset.set_results.filter(
          (s) => s.entry_id === entry.id && !s.is_deleted
        );
        const setByRowId = new Map(setResults.map((s) => [s.row_id, s]));
        const comments = dataset.coach_comments.filter((c) => c.entry_id === entry.id);

        return (
          <section
            key={entry.id}
            className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-800">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">
                  {ver?.title ?? '実施メニュー'}{' '}
                  <span className="font-mono-num text-sm text-slate-500">
                    (v{ver?.version_no ?? '?'})
                  </span>
                </h2>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                  <span>{formatDistanceM(metrics.totalDistanceM)}</span>
                  {entry.total_time_ms != null && (
                    <span>· 合計 {formatTimeMs(entry.total_time_ms)}</span>
                  )}
                  {entry.rating != null && <span>· 評価 {entry.rating}/5</span>}
                  <span>· rev.{entry.revision}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => openEntryEdit(entry)}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
              >
                <Edit2 className="h-3.5 w-3.5" />
                <span>全体記録を編集</span>
              </button>
            </div>

            {entry.impression && (
              <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-800 dark:bg-slate-950/60 dark:text-slate-200">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mr-2">
                  選手感想:
                </span>
                {entry.impression}
              </div>
            )}

            {/* Set Results Matched to Version Rows */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows
                .filter((r) => !r.is_group_header)
                .map((row) => {
                  const sr = setByRowId.get(row.id);
                  return (
                    <div
                      key={row.id}
                      className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                    >
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          <span className="font-mono-num">
                            {row.distance_m}m×{row.reps}×{row.sets}
                          </span>{' '}
                          {row.stroke} ({row.intensity})
                        </div>
                        {sr ? (
                          <div className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                            <div className="font-mono-num font-bold text-sky-700 dark:text-sky-300">
                              タイム: {formatTimeMs(sr.time_ms)}
                              {sr.rating != null ? ` · 評価 ${sr.rating}/5` : ''} · rev.
                              {sr.revision}
                            </div>
                            {sr.splits?.length > 0 && (
                              <div className="font-mono-num text-slate-500">
                                ラップ:{' '}
                                {sr.splits
                                  .map((sp) => `#${sp.rep} ${formatTimeMs(sp.time_ms)}`)
                                  .join(' / ')}
                              </div>
                            )}
                            {sr.impression && <div>メモ: {sr.impression}</div>}
                          </div>
                        ) : (
                          <div className="mt-0.5 text-xs text-slate-400">未記録</div>
                        )}
                      </div>

                      {sr ? (
                        <button
                          type="button"
                          onClick={() => openSetEdit(sr)}
                          className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 self-start sm:self-center"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          <span>編集</span>
                        </button>
                      ) : (
                        isAthlete && (
                          <button
                            type="button"
                            onClick={() =>
                              openSetCreate(
                                entry.id,
                                row.id,
                                `${row.distance_m}m×${row.reps}×${row.sets} ${row.stroke}`
                              )
                            }
                            className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-sky-300 bg-sky-50 px-3 text-xs font-semibold text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 self-start sm:self-center"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            <span>記録追加</span>
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
            </div>

            {/* Coach Comments (Read both, Write Coach Only) */}
            <div className="border-t border-slate-100 pt-4 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                  <MessageSquare className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                  <span>コーチコメント（書き換え不可・追記専用）</span>
                </h3>
                {isCoach && commentEntryId !== entry.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setCommentEntryId(entry.id);
                      setCommentSetResultId('');
                      setCommentBody('');
                    }}
                    className="min-h-[40px] rounded-xl bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700"
                  >
                    コメントを書く
                  </button>
                )}
              </div>

              {comments.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  コメントはまだありません。
                </p>
              ) : (
                <div className="space-y-2">
                  {comments.map((c) => {
                    const targetSet = c.set_result_id
                      ? setResults.find((s) => s.id === c.set_result_id)
                      : undefined;
                    const targetRow = targetSet
                      ? rows.find((r) => r.id === targetSet.row_id)
                      : undefined;
                    return (
                      <div
                        key={c.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-950/60"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>
                            {profileNameMap.get(c.created_by) ?? 'コーチ'}
                            {targetRow
                              ? ` · ${targetRow.distance_m}m×${targetRow.reps} ${targetRow.stroke}`
                              : ''}
                          </span>
                          <span className="font-mono-num">
                            {c.created_at.slice(0, 16).replace('T', ' ')}
                          </span>
                        </div>
                        <p className="mt-1 text-slate-900 dark:text-slate-100 whitespace-pre-wrap">
                          {c.body}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}

              {isCoach && commentEntryId === entry.id && (
                <div className="space-y-2">
                  {setResults.length > 0 && (
                    <select
                      value={commentSetResultId}
                      onChange={(e) => setCommentSetResultId(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="">メニュー全体へのコメント</option>
                      {setResults.map((sr) => {
                        const row = rows.find((r) => r.id === sr.row_id);
                        return (
                          <option key={sr.id} value={sr.id}>
                            セット対象:{' '}
                            {row
                              ? `${row.distance_m}m×${row.reps} ${row.stroke}`
                              : sr.row_id}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  <textarea
                    rows={3}
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="選手へのフィードバックコメント（投稿後の編集・削除はできません）"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setCommentEntryId('');
                        setCommentSetResultId('');
                      }}
                      className="min-h-[40px] rounded-xl border border-slate-300 px-3 text-xs font-semibold"
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      disabled={saving || !commentBody.trim()}
                      onClick={() => void handleSubmitComment(entry.id)}
                      className="min-h-[40px] rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {saving ? '送信中...' : 'コメントを投稿'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}

      {/* Record History Timeline */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100">
          <History className="h-4 w-4 text-sky-600 dark:text-sky-400" />
          <span>変更履歴（record_history）</span>
        </h2>
        {relatedHistory.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            まだ変更履歴はありません。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {relatedHistory.map((h) => (
              <div key={h.id} className="py-2.5 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 font-mono-num">
                    {h.table_name} · rev.{h.revision} ·{' '}
                    {h.changed_by ? profileNameMap.get(h.changed_by) ?? h.changed_by : '不明'}
                  </span>
                  <span className="font-mono-num text-slate-500 dark:text-slate-400">
                    {h.changed_at.slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-100 p-2 font-mono-num text-[11px] text-slate-700 dark:bg-slate-950 dark:text-slate-300">
                  変更前: {JSON.stringify(h.old_data)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Edit Entry Modal */}
      {editingEntry && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">
                実施記録の編集 (rev.{editingEntry.revision})
              </h3>
              <button
                type="button"
                onClick={() => setEditingEntry(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {modalError && (
              <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                {modalError}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold">合計時間</label>
                <input
                  type="text"
                  value={entryTimeDraft}
                  onChange={(e) => setEntryTimeDraft(e.target.value)}
                  placeholder="45:00"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold">評価 (1〜5)</label>
                <select
                  value={entryRatingDraft}
                  onChange={(e) => setEntryRatingDraft(e.target.value)}
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">未設定</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold">感想・メモ</label>
                <textarea
                  rows={3}
                  value={entryImpDraft}
                  onChange={(e) => setEntryImpDraft(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSaveEntryEdit()}
              className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-sky-600 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? '保存中...' : '更新を保存（revision 検査付き）'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Edit or Create Set Result Modal */}
      {(editingSet || creatingSetTarget) && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">
                {editingSet
                  ? `セット結果の編集 (rev.${editingSet.revision})`
                  : `セット結果の追加 (${creatingSetTarget?.label})`}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setEditingSet(null);
                  setCreatingSetTarget(null);
                }}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {modalError && (
              <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                {modalError}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold">タイム（例 31.45）</label>
                <input
                  type="text"
                  value={setTimeDraft}
                  onChange={(e) => setSetTimeDraft(e.target.value)}
                  placeholder="31.45"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold">各本ラップ（カンマ区切り）</label>
                <input
                  type="text"
                  value={setSplitsDraft}
                  onChange={(e) => setSetSplitsDraft(e.target.value)}
                  placeholder="31.2, 31.5, 31.8"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold">評価 (1〜5)</label>
                <select
                  value={setRatingDraft}
                  onChange={(e) => setSetRatingDraft(e.target.value)}
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">未設定</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold">メモ・感想</label>
                <textarea
                  rows={2}
                  value={setImpDraft}
                  onChange={(e) => setSetImpDraft(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSaveSetModal()}
              className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-sky-600 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>
                {saving
                  ? '保存中...'
                  : editingSet
                  ? '更新を保存（revision 検査付き）'
                  : 'セット結果を追加'}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
