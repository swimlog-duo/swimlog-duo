import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import type { BackupImportPreview } from '../../lib/offlineDb';
import { getOutboxDependentItems } from '../../lib/outboxOverlay';
import type { AccountSlot, OutboxItem, SwimlogBackupBundle } from '../../types/domain';
import { formatIsoToJstDateTime, getTodayJst } from '../../utils/dateJst';
import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
  validateDisplayNameInput,
} from '../../utils/displayName';
import { createUuid } from '../../utils/swimCalculations';
import { PWAInstallButton } from '../pwa/PWAInstallButton';
import { ConflictResolverModal } from '../sync/ConflictResolverModal';

function formatOutboxTableLabel(tableName: OutboxItem['table_name']): string {
  switch (tableName) {
    case 'practice_days':
      return '練習日のメモ';
    case 'practice_entries':
      return 'メニュー全体の記録';
    case 'set_results':
      return 'セットごとの記録';
    case 'menus':
      return '練習メニュー';
    case 'menu_versions':
      return 'メニュー内容';
    case 'coach_comments':
      return 'コーチコメント';
    default:
      return '練習データ';
  }
}

function formatOutboxOpLabel(op: OutboxItem['operation']): string {
  switch (op) {
    case 'insert':
      return '新規登録';
    case 'update':
      return '更新';
    case 'revise_menu_version':
      return '改訂版作成';
    default:
      return '変更';
  }
}

function formatOutboxStatusLabel(status: OutboxItem['status']): string {
  switch (status) {
    case 'pending':
      return '送信待ち（端末保存済み）';
    case 'syncing':
      return '送信中';
    case 'conflict':
      return '競合（要確認）';
    case 'error':
      return '送信エラー（端末保存済み）';
    default:
      return '保留中';
  }
}

function formatAccountCardName(displayName: string | null | undefined, slot: AccountSlot): string {
  const clean = normalizeDisplayName(displayName ?? '');
  if (!clean) return '表示名が未設定です';
  const roleLabel = slot === 'coach' ? 'コーチ' : '選手';
  if (clean.includes(`(${roleLabel})`) || clean.includes(`（${roleLabel}）`)) {
    return clean;
  }
  return `${clean}（${roleLabel}）`;
}

export const SettingsPage: React.FC = () => {
  const { activeSlot, session, slotMetas, switchSlot, signOutSlot } = useAuth();
  const isOnline = useOnlineStatus();
  const {
    outbox,
    allOutboxCounts,
    competitions,
    isSyncing,
    isUpdatingProfile,
    lastSyncMessage,
    errorItems,
    syncNow,
    updateMyDisplayName,
    retryErroredItem,
    retryAllErroredItems,
    discardOutboxWithDependents,
    saveCompetitionsList,
    exportJsonBackup,
    previewJsonBackup,
    importJsonBackup,
  } = useSwimData();

  const [displayNameDraft, setDisplayNameDraft] = useState(session?.displayName ?? '');
  const [profileSaveMessage, setProfileSaveMessage] = useState<string | null>(null);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);

  const [compName, setCompName] = useState('');
  const [compDate, setCompDate] = useState('');
  const [compNote, setCompNote] = useState('');
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    bundle: SwimlogBackupBundle;
    preview: BackupImportPreview;
  } | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);

  const [selectedConflict, setSelectedConflict] = useState<OutboxItem | null>(null);
  const [pendingDiscardItem, setPendingDiscardItem] = useState<{
    root: OutboxItem;
    dependents: OutboxItem[];
  } | null>(null);
  const [discardingQueue, setDiscardingQueue] = useState(false);

  useEffect(() => {
    setProfileSaveMessage(null);
    setProfileSaveError(null);
  }, [session?.slot, session?.userId]);

  useEffect(() => {
    setDisplayNameDraft(session?.displayName ?? '');
  }, [session?.slot, session?.userId, session?.displayName]);

  const handleSaveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaveMessage(null);
    setProfileSaveError(null);

    const check = validateDisplayNameInput(displayNameDraft);
    if (!check.valid) {
      setProfileSaveError(check.error);
      return;
    }

    try {
      const savedName = await updateMyDisplayName(check.normalized);
      setDisplayNameDraft(savedName);
      setProfileSaveMessage(`表示名を「${savedName}」に更新しました。`);
    } catch (err) {
      setProfileSaveError(err instanceof Error ? err.message : '表示名の更新に失敗しました。');
    }
  };

  const handleAddCompetition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!compName.trim() || !compDate) return;
    await saveCompetitionsList([
      ...competitions,
      {
        id: createUuid(),
        name: compName.trim(),
        event_date: compDate,
        note: compNote.trim(),
      },
    ]);
    setCompName('');
    setCompDate('');
    setCompNote('');
  };

  const handleRemoveCompetition = async (id: string) => {
    await saveCompetitionsList(competitions.filter((c) => c.id !== id));
  };

  const handleExportBackup = async () => {
    setBackupMessage(null);
    setBackupError(null);
    try {
      const bundle = await exportJsonBackup();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swimlog-duo-backup-${bundle.owner_role}-${getTodayJst()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMessage('バックアップファイルを保存しました。');
    } catch (err) {
      setBackupError(
        err instanceof Error ? err.message : 'バックアップの保存に失敗しました。'
      );
    }
  };

  const handleSelectBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackupMessage(null);
    setBackupError(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('バックアップファイル（JSON形式）の読み込みに失敗しました。');
      }
      const previewResult = await previewJsonBackup(parsed);
      setPendingRestore(previewResult);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : 'ファイルの確認に失敗しました。');
    } finally {
      e.target.value = '';
    }
  };

  const handleConfirmRestoreBackup = async () => {
    if (!pendingRestore || restoringBackup) return;
    setRestoringBackup(true);
    setBackupError(null);
    try {
      const res = await importJsonBackup(pendingRestore.bundle);
      setPendingRestore(null);
      setBackupMessage(
        `バックアップを復元しました（未送信データ ${res.importedOutboxCount}件）。`
      );
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '復元に失敗しました。');
      setPendingRestore(null);
    } finally {
      setRestoringBackup(false);
    }
  };

  const openDiscardConfirm = (item: OutboxItem) => {
    const dependents = getOutboxDependentItems(outbox, item.queue_id);
    setPendingDiscardItem({ root: item, dependents });
  };

  const handleConfirmDiscard = async () => {
    if (!pendingDiscardItem || discardingQueue) return;
    setDiscardingQueue(true);
    try {
      await discardOutboxWithDependents(pendingDiscardItem.root.queue_id);
      setPendingDiscardItem(null);
    } finally {
      setDiscardingQueue(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-[#0b1f3a] dark:text-slate-50">
          設定
        </h1>
        <PWAInstallButton />
      </div>

      {/* Display Name Settings */}
      {session && (
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
                表示名の変更（{session.role === 'coach' ? 'コーチ' : '選手'}）
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                アプリ内に表示される自分の名前を変更できます。
              </p>
            </div>
            <span className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
              {[...normalizeDisplayName(displayNameDraft)].length} / {DISPLAY_NAME_MAX_LENGTH}文字
            </span>
          </div>

          <form onSubmit={handleSaveDisplayName} className="space-y-2">
            <label
              htmlFor="settings-display-name"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              表示名（必須）
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                id="settings-display-name"
                type="text"
                maxLength={60}
                value={displayNameDraft}
                onChange={(e) => {
                  setDisplayNameDraft(e.target.value);
                  if (profileSaveMessage) setProfileSaveMessage(null);
                  if (profileSaveError) setProfileSaveError(null);
                }}
                placeholder={session.role === 'coach' ? '例: 佐藤 コーチ' : '例: 田中 太郎'}
                className="flex-1 min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm text-[#0b1f3a] dark:border-slate-700 dark:bg-[#07111e] dark:text-slate-50"
              />
              <button
                type="submit"
                disabled={
                  !isOnline ||
                  isSyncing ||
                  isUpdatingProfile ||
                  normalizeDisplayName(displayNameDraft) === normalizeDisplayName(session.displayName)
                }
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc] whitespace-nowrap"
              >
                <Save className="h-4 w-4" />
                <span>{isUpdatingProfile ? '更新中...' : '表示名を保存'}</span>
              </button>
            </div>
          </form>

          {!isOnline && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              オフラインのため表示名の変更はできません。オンライン時に変更してください。
            </p>
          )}
          {profileSaveError && (
            <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400">
              {profileSaveError}
            </p>
          )}
          {profileSaveMessage && (
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{profileSaveMessage}</span>
            </p>
          )}
        </section>
      )}

      {/* 2-Account Slot Management */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div>
          <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
            アカウントの切替
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            コーチと選手を同じ端末で切り替えられます。切り替え後も下書きや未送信データは保持されます。
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(['coach', 'athlete'] as AccountSlot[]).map((slot) => {
            const meta = slotMetas[slot];
            const isCurrent = activeSlot === slot && session?.slot === slot;
            const queued = meta ? allOutboxCounts[meta.userId] ?? 0 : 0;
            return (
              <div
                key={slot}
                className={`rounded-2xl border p-4 space-y-3 ${
                  isCurrent
                    ? 'border-[#0077b6] bg-[#0077b6]/5 dark:border-[#38bdf8] dark:bg-[#38bdf8]/10'
                    : 'border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-[#07111e]/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-[#0b1f3a] dark:text-slate-50">
                    {slot === 'coach' ? 'コーチ' : '選手'}
                  </span>
                  <span className="font-mono-num text-xs font-medium text-slate-500 dark:text-slate-400">
                    {isCurrent ? '使用中' : meta ? '待機中' : '未ログイン'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  {meta
                    ? formatAccountCardName(meta.displayName, slot)
                    : 'サインインしていません'}
                </div>
                {queued > 0 && (
                  <div className="font-mono-num text-xs font-semibold text-amber-700 dark:text-amber-300">
                    未送信データ: {queued}件
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {!isCurrent && (
                    <button
                      type="button"
                      disabled={isUpdatingProfile}
                      onClick={() => void switchSlot(slot)}
                      className="min-h-[44px] rounded-xl bg-[#0077b6] px-3.5 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
                    >
                      {meta ? 'この枠へ切替' : 'この枠でログイン'}
                    </button>
                  )}
                  {meta && (
                    <button
                      type="button"
                      disabled={isUpdatingProfile}
                      onClick={() => void signOutSlot(slot)}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-[#0e1b2e] dark:text-slate-200"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      <span>サインアウト</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sync Status & Pending Queue */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
              データの同期状況
            </h2>
            {lastSyncMessage && (
              <p className="text-xs text-slate-500 dark:text-slate-400">{lastSyncMessage}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {errorItems.length > 1 && (
              <button
                type="button"
                disabled={isSyncing || !isOnline}
                onClick={() => void retryAllErroredItems()}
                className="min-h-[44px] rounded-xl border border-amber-400 bg-amber-50 px-3.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200"
              >
                すべて再試行
              </button>
            )}
            <button
              type="button"
              disabled={isSyncing || !isOnline}
              onClick={() => void syncNow()}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
            >
              <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>今すぐ同期する</span>
            </button>
          </div>
        </div>

        {outbox.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            未送信データはありません（すべてクラウドと同期済み）。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {outbox.map((item) => (
              <div
                key={item.queue_id}
                className="py-3 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="font-bold text-[#0b1f3a] dark:text-slate-100">
                    {formatOutboxTableLabel(item.table_name)} · {formatOutboxOpLabel(item.operation)} ·{' '}
                    {formatOutboxStatusLabel(item.status)}
                  </div>
                  {item.last_error && (
                    <div className="text-rose-600 dark:text-rose-400 break-words">
                      {item.last_error}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {item.status === 'conflict' && (
                    <button
                      type="button"
                      onClick={() => setSelectedConflict(item)}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-xl bg-rose-600 px-3.5 font-semibold text-white"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>競合を解決</span>
                    </button>
                  )}
                  {item.status === 'error' && (
                    <button
                      type="button"
                      disabled={isSyncing || !isOnline}
                      onClick={() => void retryErroredItem(item)}
                      className="min-h-[44px] rounded-xl border border-slate-300 px-3.5 font-semibold disabled:opacity-50 dark:border-slate-700"
                    >
                      再試行
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => openDiscardConfirm(item)}
                    aria-label="未送信データを削除"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Data Backup & Restore */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-3">
        <div>
          <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
            データのバックアップ・復元
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            未送信の記録や大会予定をファイルに保存し、内容を確認したうえで安全に復元できます。
          </p>
        </div>
        {backupError && (
          <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400">
            {backupError}
          </p>
        )}
        {backupMessage && (
          <p className="text-xs font-semibold text-[#0077b6] dark:text-[#38bdf8]">
            {backupMessage}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleExportBackup()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-4 text-xs font-semibold text-[#0b1f3a] hover:bg-slate-100 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="h-4 w-4" />
            <span>バックアップを保存</span>
          </button>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-4 text-xs font-semibold text-[#0b1f3a] hover:bg-slate-100 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800">
            <Upload className="h-4 w-4" />
            <span>バックアップから復元</span>
            <input
              type="file"
              accept="application/json"
              onChange={handleSelectBackupFile}
              className="hidden"
            />
          </label>
        </div>
      </section>

      {/* Competition Countdown */}
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800/80 dark:bg-[#0e1b2e] space-y-4">
        <div>
          <h2 className="text-base font-bold text-[#0b1f3a] dark:text-slate-50">
            大会カウントダウン
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            ホームと分析画面に表示する大会日程を登録できます。
          </p>
        </div>

        <form onSubmit={handleAddCompetition} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label
              htmlFor="comp-name-input"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              大会名（必須）
            </label>
            <input
              id="comp-name-input"
              type="text"
              required
              value={compName}
              onChange={(e) => setCompName(e.target.value)}
              placeholder="例: 冬季チャンピオンシップ"
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
          </div>
          <div>
            <label
              htmlFor="comp-date-input"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              大会開催日（必須）
            </label>
            <input
              id="comp-date-input"
              type="date"
              required
              value={compDate}
              onChange={(e) => setCompDate(e.target.value)}
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
          </div>
          <div>
            <label
              htmlFor="comp-note-input"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              目標メモ（任意）
            </label>
            <input
              id="comp-note-input"
              type="text"
              value={compNote}
              onChange={(e) => setCompNote(e.target.value)}
              placeholder="例: 100m Fr ベスト更新"
              className="mt-1 w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-[#07111e]"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] dark:bg-[#38bdf8] dark:text-[#0b1f3a] dark:hover:bg-[#7dd3fc]"
          >
            <Plus className="h-4 w-4" />
            <span>追加</span>
          </button>
        </form>

        {competitions.length > 0 && (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
            {competitions.map((c) => (
              <div key={c.id} className="py-2 flex items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-[#0b1f3a] dark:text-slate-100">{c.name}</span>{' '}
                  <span className="font-mono-num text-xs text-slate-500 dark:text-slate-400">
                    ({c.event_date})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemoveCompetition(c.id)}
                  aria-label="大会を削除"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Discard Unsent Item Confirmation Modal */}
      {pendingDiscardItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="discard-queue-modal-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#0e1b2e] space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3
                id="discard-queue-modal-title"
                className="text-base font-bold text-[#0b1f3a] dark:text-slate-50"
              >
                未送信データの削除確認
              </h3>
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => setPendingDiscardItem(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2 text-xs text-slate-700 dark:text-slate-300">
              <p className="font-semibold text-rose-700 dark:text-rose-300">
                この操作は取り消せません。クラウド未送信の下書きデータも端末から完全に削除されます。
              </p>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-[#07111e]">
                <div className="font-bold text-[#0b1f3a] dark:text-slate-100">
                  対象: {formatOutboxTableLabel(pendingDiscardItem.root.table_name)} ·{' '}
                  {formatOutboxOpLabel(pendingDiscardItem.root.operation)}
                </div>
                {pendingDiscardItem.dependents.length > 0 && (
                  <div className="mt-2 space-y-1 text-amber-800 dark:text-amber-300">
                    <p className="font-semibold">
                      関連する未送信データ（{pendingDiscardItem.dependents.length}件）も同時に削除されます：
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {pendingDiscardItem.dependents.map((dep) => (
                        <li key={dep.queue_id}>
                          {formatOutboxTableLabel(dep.table_name)}（{formatOutboxOpLabel(dep.operation)}）
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                disabled={discardingQueue}
                onClick={() => setPendingDiscardItem(null)}
                className="min-h-[44px] rounded-xl border border-slate-300 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={discardingQueue}
                onClick={() => void handleConfirmDiscard()}
                className="min-h-[44px] rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {discardingQueue
                  ? '削除中...'
                  : pendingDiscardItem.dependents.length > 0
                  ? `関連データごと削除（${pendingDiscardItem.dependents.length + 1}件）`
                  : 'この未送信データを削除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backup Restore Preview & Confirmation Modal */}
      {pendingRestore && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-preview-modal-title"
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-[#0e1b2e] space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3
                id="backup-preview-modal-title"
                className="text-base font-bold text-[#0b1f3a] dark:text-slate-50"
              >
                バックアップ復元の確認
              </h3>
              <button
                type="button"
                aria-label="閉じる"
                onClick={() => setPendingRestore(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-700 dark:text-slate-300">
              <p>
                作成日時（日本時間）:{' '}
                <strong className="font-mono-num">
                  {formatIsoToJstDateTime(pendingRestore.preview.exportedAt)}
                </strong>
              </p>

              <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-[#07111e] text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-semibold">項目</th>
                      <th className="px-3 py-2 font-semibold text-right">現在の端末</th>
                      <th className="px-3 py-2 font-semibold text-right">バックアップ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono-num">
                    <tr>
                      <td className="px-3 py-2 font-sans">練習メニュー</td>
                      <td className="px-3 py-2 text-right">{pendingRestore.preview.currentCounts.menus}件</td>
                      <td className="px-3 py-2 text-right font-bold">{pendingRestore.preview.backupCounts.menus}件</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-sans">練習日</td>
                      <td className="px-3 py-2 text-right">{pendingRestore.preview.currentCounts.practiceDays}件</td>
                      <td className="px-3 py-2 text-right font-bold">{pendingRestore.preview.backupCounts.practiceDays}件</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-sans">未送信データ</td>
                      <td className="px-3 py-2 text-right">{pendingRestore.preview.currentCounts.outbox}件</td>
                      <td className="px-3 py-2 text-right font-bold">{pendingRestore.preview.backupCounts.outbox}件</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-sans">大会予定</td>
                      <td className="px-3 py-2 text-right">{pendingRestore.preview.currentCounts.competitions}件</td>
                      <td className="px-3 py-2 text-right font-bold">{pendingRestore.preview.backupCounts.competitions}件</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {pendingRestore.preview.protectedLocalOutboxCount > 0 && (
                <p className="rounded-xl border border-sky-200 bg-sky-50 p-2.5 text-[#0b1f3a] dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100">
                  現在の端末に残っている未送信データ（{pendingRestore.preview.protectedLocalOutboxCount}件）は消さずに保護されます。
                </p>
              )}

              {pendingRestore.preview.conflictingQueueIds.length > 0 && (
                <p className="rounded-xl border border-rose-300 bg-rose-50 p-2.5 font-semibold text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                  注意: 現在の端末の未送信データと内容が異なる項目が{' '}
                  {pendingRestore.preview.conflictingQueueIds.length} 件あるため、データ保護のため復元を実行すると中止されます。
                </p>
              )}
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                disabled={restoringBackup}
                onClick={() => setPendingRestore(null)}
                className="min-h-[44px] rounded-xl border border-slate-300 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={restoringBackup}
                onClick={() => void handleConfirmRestoreBackup()}
                className="min-h-[44px] rounded-xl bg-[#0077b6] px-4 text-xs font-semibold text-white hover:bg-[#005f92] disabled:opacity-50 dark:bg-[#38bdf8] dark:text-[#0b1f3a]"
              >
                {restoringBackup ? '復元中...' : '復元を実行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedConflict && (
        <ConflictResolverModal
          item={selectedConflict}
          onClose={() => setSelectedConflict(null)}
        />
      )}
    </div>
  );
};
