import React, { useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Edit2, History, MessageSquare, Plus, Save, Trash2, X } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useSwimData } from '../../hooks/useSwimData';
import { getRecordSyncState } from '../../lib/outboxOverlay';
import type {
  PracticeDayRow,
  PracticeEntryRow,
  SetResultRow,
  SplitRecord,
} from '../../types/database';
import { formatIsoToJstDateTime, formatYmdWithWeekdayJst } from '../../utils/dateJst';
import {
  calculateMenuMetrics,
  formatDistanceM,
  formatTimeMs,
  parseTimeInputToMs,
} from '../../utils/swimCalculations';
import { normalizeDisplayName } from '../../utils/displayName';
import { SyncStatusBadge } from '../sync/SyncStatusBadge';

function formatHistoryTableLabel(tableName: string): string {
  switch (tableName) {
    case 'practice_days':
      return '練習日のメモ';
    case 'practice_entries':
      return 'メニュー全体の記録';
    case 'set_results':
      return 'セットごとの記録';
    default:
      return '練習記録';
  }
}

function formatOldDataSummary(
  tableName: string,
  oldData: Record<string, unknown> | null | undefined
): string {
  if (!oldData || typeof oldData !== 'object') return '変更前の内容あり';
  const parts: string[] = [];

  if (tableName === 'practice_days') {
    if (typeof oldData.practice_date === 'string' && oldData.practice_date) {
      parts.push(`日付: ${oldData.practice_date}`);
    }
    if ('note' in oldData) {
      const noteText = typeof oldData.note === 'string' ? oldData.note.trim() : '';
      parts.push(`メモ: ${noteText || '（なし）'}`);
    }
  } else if (tableName === 'practice_entries') {
    if (typeof oldData.total_time_ms === 'number') {
      parts.push(`合計時間: ${formatTimeMs(oldData.total_time_ms)}`);
    }
    if (typeof oldData.rating === 'number') {
      parts.push(`評価: ${oldData.rating}/5`);
    }
    if ('impression' in oldData) {
      const imp = typeof oldData.impression === 'string' ? oldData.impression.trim() : '';
      parts.push(`感想: ${imp || '（なし）'}`);
    }
  } else if (tableName === 'set_results') {
    if (typeof oldData.time_ms === 'number') {
      parts.push(`タイム: ${formatTimeMs(oldData.time_ms)}`);
    }
    if (Array.isArray(oldData.splits) && oldData.splits.length > 0) {
      const formattedSplits = oldData.splits
        .map((sp) => {
          if (sp && typeof sp === 'object' && 'time_ms' in sp) {
            const ms = (sp as { time_ms?: unknown }).time_ms;
            return typeof ms === 'number' ? formatTimeMs(ms) : '';
          }
          return '';
        })
        .filter(Boolean);
      if (formattedSplits.length > 0) {
        parts.push(`ラップ: ${formattedSplits.join(' / ')}`);
      }
    }
    if (typeof oldData.rating === 'number') {
      parts.push(`評価: ${oldData.rating}/5`);
    }
    if (typeof oldData.impression === 'string' && oldData.impression.trim()) {
      parts.push(`メモ: ${oldData.impression.trim()}`);
    }
  }

  return parts.length > 0 ? parts.join(' · ') : '変更前の記録';
}

function formatCurrentDataSummary(
  tableName: string,
  day: PracticeDayRow,
  entriesById: Map<string, PracticeEntryRow>,
  setsById: Map<string, SetResultRow>,
  recordId: string
): string {
  if (tableName === 'practice_days' && recordId === day.id) {
    if (day.is_deleted) return '削除済み（非表示）';
    return `日付: ${day.practice_date} · メモ: ${day.note?.trim() || '（なし）'}`;
  }
  if (tableName === 'practice_entries') {
    const entry = entriesById.get(recordId);
    if (!entry) return '記録なし';
    if (entry.is_deleted) return '削除済み（非表示）';
    const parts: string[] = [];
    if (entry.total_time_ms != null) parts.push(`合計時間: ${formatTimeMs(entry.total_time_ms)}`);
    if (entry.rating != null) parts.push(`評価: ${entry.rating}/5`);
    parts.push(`感想: ${entry.impression?.trim() || '（なし）'}`);
    return parts.join(' · ');
  }
  if (tableName === 'set_results') {
    const sr = setsById.get(recordId);
    if (!sr) return '記録なし';
    if (sr.is_deleted) return '削除済み（非表示）';
    const parts: string[] = [];
    if (sr.time_ms != null) parts.push(`タイム: ${formatTimeMs(sr.time_ms)}`);
    if (Array.isArray(sr.splits) && sr.splits.length > 0) {
      parts.push(`ラップ: ${sr.splits.map((sp) => formatTimeMs(sp.time_ms)).join(' / ')}`);
    }
    if (sr.rating != null) parts.push(`評価: ${sr.rating}/5`);
    if (sr.impression?.trim()) parts.push(`メモ: ${sr.impression.trim()}`);
    return parts.length > 0 ? parts.join(' · ') : '記録あり';
  }
  return '最新の状態';
}

export const PracticeLogDetailPage: React.FC = () => {
  const { dayId } = useParams<{ dayId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();
  const {
    dataset,
    outbox,
    createSetResult,
    updatePracticeDay,
    updatePracticeEntry,
    updateSetResult,
    addCoachComment,
  } = useSwimData();

  const saveNotice =
    (location.state as { saveNotice?: string } | null)?.saveNotice ?? null;

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
      const clean = normalizeDisplayName(p.display_name ?? '') || '表示名未設定';
      const roleLabel = p.role === 'coach' ? 'コーチ' : '選手';
      const formatted =
        clean.includes(`(${roleLabel})`) || clean.includes(`（${roleLabel}）`)
          ? clean
          : `${clean}（${roleLabel}）`;
      map.set(p.id, formatted);
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
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'day' | 'entry' | 'set';
    id: string;
    revision: number;
    label: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  if (!day) {
    return (
      <div className="rounded-2xl border border-slate-200/80 bg-white p-8 text-center text-sm text-slate-600 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] dark:text-slate-300">
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

  const handleConfirmDelete = async () => {
    if (!deleteTarget || savingRef.current) return;
    setModalError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      if (deleteTarget.type === 'day') {
        await updatePracticeDay(deleteTarget.id, deleteTarget.revision, { is_deleted: true });
        setDeleteTarget(null);
        navigate('/logs', { replace: true });
        return;
      }
      if (deleteTarget.type === 'entry') {
        await updatePracticeEntry(deleteTarget.id, deleteTarget.revision, { is_deleted: true });
      } else {
        await updateSetResult(deleteTarget.id, deleteTarget.revision, { is_deleted: true });
      }
      setDeleteTarget(null);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '削除に失敗しました。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const entriesById = new Map(dataset.practice_entries.map((e) => [e.id, e]));
  const setsById = new Map(dataset.set_results.map((s) => [s.id, s]));

  const relatedIds = new Set<string>([
    day.id,
    ...entries.map((e) => e.id),
    ...dataset.set_results
      .filter((s) => entries.some((e) => e.id === s.entry_id))
      .map((s) => s.id),
  ]);

  const daySyncInfo = getRecordSyncState(outbox, Array.from(relatedIds));

  const relatedHistory = dataset.record_history
    .filter((h) => relatedIds.has(h.record_id))
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at));

  return (
    <div className="space-y-6">
      {saveNotice && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
        >
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{saveNotice}</span>
          </span>
          <SyncStatusBadge state={daySyncInfo.state} />
        </div>
      )}

      {actionError && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
          {actionError}
        </div>
      )}

      {/* Day Header */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono-num text-2xl font-bold text-[#0b1f3a] dark:text-slate-50">
                {formatYmdWithWeekdayJst(day.practice_date)}
              </h1>
              <SyncStatusBadge state={daySyncInfo.state} compact />
            </div>
            <p className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
              最終更新 {formatIsoToJstDateTime(day.updated_at)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAthlete && (
              <Link
                to={`/logs/new?dayId=${day.id}`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#0077b6] px-3.5 text-xs font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc] whitespace-nowrap"
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
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Edit2 className="h-3.5 w-3.5" />
              <span>日次メモ編集</span>
            </button>
            {isAthlete && (
              <button
                type="button"
                onClick={() => {
                  setModalError(null);
                  setDeleteTarget({
                    type: 'day',
                    id: day.id,
                    revision: day.revision,
                    label: `${day.practice_date} の練習日記録`,
                  });
                }}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-rose-300 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40 whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>この日を削除</span>
              </button>
            )}
          </div>
        </div>

        {editingDayNote ? (
          <div className="space-y-2">
            <label htmlFor="day-note-edit" className="sr-only">
              その日のメモ
            </label>
            <textarea
              id="day-note-edit"
              rows={2}
              value={dayNoteDraft}
              onChange={(e) => setDayNoteDraft(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingDayNote(false)}
                className="min-h-[44px] rounded-xl border border-slate-300 px-3.5 text-xs font-semibold dark:border-slate-700"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSaveDayNote()}
                className="min-h-[44px] rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
              >
                メモを保存
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {day.note || 'その日のメモはありません'}
          </p>
        )}
      </section>

      {/* Entries */}
      {entries.map((entry) => {
        const ver = dataset.menu_versions.find((v) => v.id === entry.menu_version_id);
        const rows = ver?.content?.rows ?? [];
        const executableRows = rows.filter((r) => !r.is_group_header);
        const metrics = calculateMenuMetrics(rows);
        const setResults = dataset.set_results.filter(
          (s) => s.entry_id === entry.id && !s.is_deleted
        );
        const setByRowId = new Map(setResults.map((s) => [s.row_id, s]));
        const recordedSetCount = executableRows.filter((r) => setByRowId.has(r.id)).length;
        const entrySyncInfo = getRecordSyncState(outbox, [
          entry.id,
          ...setResults.map((s) => s.id),
        ]);
        const comments = dataset.coach_comments.filter((c) => c.entry_id === entry.id);

        return (
          <section
            key={entry.id}
            className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3 dark:border-slate-800">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-[#0b1f3a] dark:text-slate-50">
                    {ver?.title ?? '実施メニュー'}{' '}
                    <span className="font-mono-num text-sm text-slate-500">
                      (v{ver?.version_no ?? '?'})
                    </span>
                  </h2>
                  {entrySyncInfo.state !== 'synced' && (
                    <SyncStatusBadge state={entrySyncInfo.state} compact />
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono-num">
                  <span>{formatDistanceM(metrics.totalDistanceM)}</span>
                  {entry.total_time_ms != null && (
                    <span>· 合計 {formatTimeMs(entry.total_time_ms)}</span>
                  )}
                  {entry.rating != null && <span>· 評価 {entry.rating}/5</span>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => openEntryEdit(entry)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <Edit2 className="h-3.5 w-3.5" />
                  <span>全体記録を編集</span>
                </button>
                {isAthlete && (
                  <button
                    type="button"
                    onClick={() => {
                      setModalError(null);
                      setDeleteTarget({
                        type: 'entry',
                        id: entry.id,
                        revision: entry.revision,
                        label: `${ver?.title ?? '実施メニュー'} の記録`,
                      });
                    }}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-rose-300 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40 whitespace-nowrap"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>記録を削除</span>
                  </button>
                )}
              </div>
            </div>

            {/* Coach Planned vs Athlete Actual Comparison Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 text-xs dark:border-slate-800 dark:bg-[#07111e]/70">
              <div>
                <div className="font-semibold text-slate-500 dark:text-slate-400">
                  コーチの予定距離
                </div>
                <div className="mt-0.5 font-mono-num text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
                  {formatDistanceM(metrics.totalDistanceM)} ({executableRows.length}セット)
                </div>
              </div>
              <div>
                <div className="font-semibold text-slate-500 dark:text-slate-400">
                  選手の実施記録
                </div>
                <div className="mt-0.5 font-mono-num text-sm font-bold text-[#0077b6] dark:text-[#38bdf8]">
                  記録済み {recordedSetCount}/{executableRows.length}セット
                </div>
              </div>
              <div>
                <div className="font-semibold text-slate-500 dark:text-slate-400">
                  全体タイム / 評価
                </div>
                <div className="mt-0.5 font-mono-num text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
                  {entry.total_time_ms != null ? formatTimeMs(entry.total_time_ms) : '未入力'}
                  {entry.rating != null ? ` · ${entry.rating}/5` : ''}
                </div>
              </div>
            </div>

            {entry.impression && (
              <div className="rounded-xl bg-slate-50 p-3.5 text-sm text-slate-800 dark:bg-[#07111e]/70 dark:text-slate-200">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mr-2">
                  選手の感想:
                </span>
                {entry.impression}
              </div>
            )}

            {/* Set Results Matched to Version Rows */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {executableRows.map((row) => {
                const sr = setByRowId.get(row.id);
                return (
                  <div
                    key={row.id}
                    className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[#0b1f3a] dark:text-slate-100">
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          予定
                        </span>
                        <span className="font-mono-num">
                          {row.distance_m}m×{row.reps}×{row.sets}
                        </span>
                        <span>
                          {row.stroke} ({row.intensity})
                        </span>
                        {row.circle && (
                          <span className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
                            · {row.circle}
                          </span>
                        )}
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                            sr
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                          }`}
                        >
                          {sr ? '実施済' : '未入力'}
                        </span>
                      </div>
                      {sr ? (
                        <div className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                          <div className="font-mono-num font-bold text-[#0077b6] dark:text-[#38bdf8]">
                            タイム: {formatTimeMs(sr.time_ms)}
                            {sr.rating != null ? ` · 評価 ${sr.rating}/5` : ''}
                          </div>
                          {sr.splits?.length > 0 && (
                            <div className="font-mono-num text-slate-500 dark:text-slate-400">
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
                      <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
                        <button
                          type="button"
                          onClick={() => openSetEdit(sr)}
                          className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-200 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          <span>編集</span>
                        </button>
                        {isAthlete && (
                          <button
                            type="button"
                            onClick={() => {
                              setModalError(null);
                              setDeleteTarget({
                                type: 'set',
                                id: sr.id,
                                revision: sr.revision,
                                label: `${row.distance_m}m×${row.reps}×${row.sets} ${row.stroke} の記録`,
                              });
                            }}
                            className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-rose-300 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40 whitespace-nowrap"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>削除</span>
                          </button>
                        )}
                      </div>
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
                          className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-[#0077b6]/30 bg-[#0077b6]/10 px-3.5 text-xs font-semibold text-[#0b1f3a] hover:bg-[#0077b6]/15 dark:border-[#38bdf8]/40 dark:bg-[#38bdf8]/15 dark:text-sky-200 self-start sm:self-center whitespace-nowrap"
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

            {/* Coach Comments */}
            <div className="border-t border-slate-100 pt-4 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
                  <MessageSquare className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8] shrink-0" />
                  <span>コーチからのコメント</span>
                </h3>
                {isCoach && commentEntryId !== entry.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setCommentEntryId(entry.id);
                      setCommentSetResultId('');
                      setCommentBody('');
                    }}
                    className="min-h-[44px] rounded-xl bg-[#0077b6] px-3.5 text-xs font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] whitespace-nowrap shrink-0"
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
                        className="rounded-xl border border-slate-200/80 bg-slate-50 p-3.5 text-sm dark:border-slate-800 dark:bg-[#07111e]/70"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>
                            {profileNameMap.get(c.created_by) ?? 'コーチ'}
                            {targetRow
                              ? ` · ${targetRow.distance_m}m×${targetRow.reps} ${targetRow.stroke}`
                              : ''}
                          </span>
                          <span className="font-mono-num">
                            {formatIsoToJstDateTime(c.created_at)}
                          </span>
                        </div>
                        <p className="mt-1 text-[#0b1f3a] dark:text-slate-100 whitespace-pre-wrap">
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
                    <div>
                      <label htmlFor={`comment-target-${entry.id}`} className="sr-only">
                        コメント対象セット
                      </label>
                      <select
                        id={`comment-target-${entry.id}`}
                        value={commentSetResultId}
                        onChange={(e) => setCommentSetResultId(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-xs dark:border-slate-700 dark:bg-[#07111e]"
                      >
                        <option value="">メニュー全体へのコメント</option>
                        {setResults.map((sr) => {
                          const row = rows.find((r) => r.id === sr.row_id);
                          return (
                            <option key={sr.id} value={sr.id}>
                              セット対象:{' '}
                              {row
                                ? `${row.distance_m}m×${row.reps} ${row.stroke}`
                                : 'セット記録'}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}
                  <label htmlFor={`comment-body-${entry.id}`} className="sr-only">
                    コメント本文
                  </label>
                  <textarea
                    id={`comment-body-${entry.id}`}
                    rows={3}
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="選手へのフィードバックコメント（投稿後の変更・削除はできません）"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-[#07111e]"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setCommentEntryId('');
                        setCommentSetResultId('');
                      }}
                      className="min-h-[44px] rounded-xl border border-slate-300 px-3.5 text-xs font-semibold dark:border-slate-700"
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      disabled={saving || !commentBody.trim()}
                      onClick={() => void handleSubmitComment(entry.id)}
                      className="min-h-[44px] rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
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
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-[#0b1f3a] dark:text-slate-100">
          <History className="h-4 w-4 text-[#0077b6] dark:text-[#38bdf8]" />
          <span>変更履歴</span>
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
                  <span className="font-semibold text-[#0b1f3a] dark:text-slate-200">
                    {formatHistoryTableLabel(h.table_name)} ·{' '}
                    {h.changed_by ? profileNameMap.get(h.changed_by) ?? '担当者' : '担当者'}
                  </span>
                  <span className="font-mono-num text-slate-500 dark:text-slate-400">
                    {formatIsoToJstDateTime(h.changed_at)}
                  </span>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:bg-[#07111e] dark:text-slate-300 space-y-1">
                  <div>変更前: {formatOldDataSummary(h.table_name, h.old_data)}</div>
                  <div className="font-medium text-[#0b1f3a] dark:text-slate-100">
                    現在:{' '}
                    {formatCurrentDataSummary(
                      h.table_name,
                      day,
                      entriesById,
                      setsById,
                      h.record_id
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Edit Entry Modal */}
      {editingEntry && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-entry-modal-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#0e1b2e] space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="edit-entry-modal-title" className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
                実施記録の編集
              </h3>
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => setEditingEntry(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
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
                <label htmlFor="edit-entry-time" className="block text-xs font-semibold">
                  合計時間
                </label>
                <input
                  id="edit-entry-time"
                  type="text"
                  value={entryTimeDraft}
                  onChange={(e) => setEntryTimeDraft(e.target.value)}
                  placeholder="45:00"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
                />
              </div>
              <div>
                <label htmlFor="edit-entry-rating" className="block text-xs font-semibold">
                  評価 (1〜5)
                </label>
                <select
                  id="edit-entry-rating"
                  value={entryRatingDraft}
                  onChange={(e) => setEntryRatingDraft(e.target.value)}
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
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
                <label htmlFor="edit-entry-impression" className="block text-xs font-semibold">
                  感想・メモ
                </label>
                <textarea
                  id="edit-entry-impression"
                  rows={3}
                  value={entryImpDraft}
                  onChange={(e) => setEntryImpDraft(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-[#07111e]"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSaveEntryEdit()}
              className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#0077b6] text-sm font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? '保存中...' : '変更を保存'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Edit or Create Set Result Modal */}
      {(editingSet || creatingSetTarget) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-set-modal-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#0e1b2e] space-y-4">
            <div className="flex items-center justify-between">
              <h3 id="edit-set-modal-title" className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
                {editingSet
                  ? 'セット結果の編集'
                  : `セット結果の追加 (${creatingSetTarget?.label})`}
              </h3>
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => {
                  setEditingSet(null);
                  setCreatingSetTarget(null);
                }}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
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
                <label htmlFor="edit-set-time" className="block text-xs font-semibold">
                  タイム（例 31.45）
                </label>
                <input
                  id="edit-set-time"
                  type="text"
                  value={setTimeDraft}
                  onChange={(e) => setSetTimeDraft(e.target.value)}
                  placeholder="31.45"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
                />
              </div>
              <div>
                <label htmlFor="edit-set-splits" className="block text-xs font-semibold">
                  各本ラップ（カンマ区切り）
                </label>
                <input
                  id="edit-set-splits"
                  type="text"
                  value={setSplitsDraft}
                  onChange={(e) => setSetSplitsDraft(e.target.value)}
                  placeholder="31.2, 31.5, 31.8"
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
                />
              </div>
              <div>
                <label htmlFor="edit-set-rating" className="block text-xs font-semibold">
                  評価 (1〜5)
                </label>
                <select
                  id="edit-set-rating"
                  value={setRatingDraft}
                  onChange={(e) => setSetRatingDraft(e.target.value)}
                  className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
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
                <label htmlFor="edit-set-impression" className="block text-xs font-semibold">
                  メモ・感想
                </label>
                <textarea
                  id="edit-set-impression"
                  rows={2}
                  value={setImpDraft}
                  onChange={(e) => setSetImpDraft(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-[#07111e]"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSaveSetModal()}
              className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#0077b6] text-sm font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
            >
              <Save className="h-4 w-4" />
              <span>
                {saving
                  ? '保存中...'
                  : editingSet
                  ? '変更を保存'
                  : 'セット結果を追加'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Athlete Soft-Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-log-modal-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-rose-300 bg-white p-6 shadow-xl dark:border-rose-800 dark:bg-[#0e1b2e] space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3
                id="delete-log-modal-title"
                className="text-base font-bold text-rose-800 dark:text-rose-200"
              >
                記録の削除確認
              </h3>
              <button
                type="button"
                aria-label="閉じる"
                disabled={saving}
                onClick={() => setDeleteTarget(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
              「<span className="font-bold">{deleteTarget.label}</span>」を削除しますか？
              <br />
              この操作は取り消せません。一覧画面からは非表示になり、変更履歴には記録が残ります。
            </p>
            {modalError && (
              <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                {modalError}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setDeleteTarget(null)}
                className="min-h-[44px] rounded-xl border border-slate-300 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleConfirmDelete()}
                className="min-h-[44px] rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {saving ? '削除中...' : '削除を実行する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
