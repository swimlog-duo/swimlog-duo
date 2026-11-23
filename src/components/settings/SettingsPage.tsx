import React, { useState } from 'react';
import {
  AlertTriangle,
  Download,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useSwimData } from '../../hooks/useSwimData';
import { useTheme, type ThemePreference } from '../../hooks/useTheme';
import type { AccountSlot, OutboxItem, SwimlogBackupBundle } from '../../types/domain';
import { createUuid } from '../../utils/swimCalculations';
import { PWAInstallButton } from '../pwa/PWAInstallButton';
import { ConflictResolverModal } from '../sync/ConflictResolverModal';

export const SettingsPage: React.FC = () => {
  const { activeSlot, session, slotMetas, switchSlot, signOutSlot } = useAuth();
  const isOnline = useOnlineStatus();
  const { preference, setPreference } = useTheme();
  const {
    outbox,
    allOutboxCounts,
    competitions,
    isSyncing,
    lastSyncMessage,
    syncNow,
    retryErroredItem,
    discardOutboxItem,
    saveCompetitionsList,
    exportJsonBackup,
    importJsonBackup,
  } = useSwimData();

  const [compName, setCompName] = useState('');
  const [compDate, setCompDate] = useState('');
  const [compNote, setCompNote] = useState('');
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<OutboxItem | null>(null);

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
    try {
      const bundle = await exportJsonBackup();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swimlog-duo-backup-${bundle.owner_role}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMessage('バックアップJSONをダウンロードしました。');
    } catch (err) {
      setBackupMessage(
        err instanceof Error ? err.message : 'バックアップ書き出しに失敗しました。'
      );
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackupMessage(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as SwimlogBackupBundle;
      const res = await importJsonBackup(bundle);
      setBackupMessage(
        `バックアップを復元しました（未送信キュー ${res.importedOutboxCount}件復元）。`
      );
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : '復元に失敗しました。');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">
          設定・アカウント・同期管理
        </h1>
        <PWAInstallButton />
      </div>

      {/* 2-Account Slot Management */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-4">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            2アカウント切替（独立セッション管理）
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            コーチ枠・選手枠はそれぞれ別の Supabase Auth 保存領域を持ち、切替時に他方のセッションや未送信データは上書き・削除されません。
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
                    ? 'border-sky-600 bg-sky-50/70 dark:border-sky-400 dark:bg-sky-950/30'
                    : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-50">
                    {slot === 'coach' ? 'コーチ枠 (coach)' : '選手枠 (athlete)'}
                  </span>
                  <span className="font-mono-num text-xs text-slate-500">
                    {isCurrent ? '使用中' : meta ? '待機中' : '未ログイン'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  {meta ? `${meta.displayName} (${meta.email})` : 'サインインしていません'}
                </div>
                {queued > 0 && (
                  <div className="font-mono-num text-xs font-semibold text-amber-700 dark:text-amber-300">
                    未送信キュー: {queued}件
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {!isCurrent && (
                    <button
                      type="button"
                      onClick={() => void switchSlot(slot)}
                      className="min-h-[44px] rounded-xl bg-sky-600 px-3.5 text-xs font-semibold text-white hover:bg-sky-700"
                    >
                      {meta ? 'この枠へ切替' : 'この枠でログイン'}
                    </button>
                  )}
                  {meta && (
                    <button
                      type="button"
                      onClick={() => void signOutSlot(slot)}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      <span>この枠のみサインアウト</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Outbox Queue & Manual Sync */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
              未送信データ・同期キュー（{session?.displayName}）
            </h2>
            {lastSyncMessage && (
              <p className="text-xs text-slate-500 dark:text-slate-400">{lastSyncMessage}</p>
            )}
          </div>
          <button
            type="button"
            disabled={isSyncing || !isOnline}
            onClick={() => void syncNow()}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>手動同期を実行</span>
          </button>
        </div>

        {outbox.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            未送信データはありません（すべて同期済み）。
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {outbox.map((item) => (
              <div
                key={item.queue_id}
                className="py-3 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="space-y-0.5">
                  <div className="font-mono-num font-bold text-slate-900 dark:text-slate-100">
                    {item.table_name} · {item.operation} · 状態: {item.status}
                  </div>
                  {item.last_error && (
                    <div className="text-rose-600 dark:text-rose-400">{item.last_error}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {item.status === 'conflict' && (
                    <button
                      type="button"
                      onClick={() => setSelectedConflict(item)}
                      className="inline-flex min-h-[40px] items-center gap-1 rounded-xl bg-rose-600 px-3 font-semibold text-white"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>競合解決</span>
                    </button>
                  )}
                  {item.status === 'error' && (
                    <button
                      type="button"
                      onClick={() => void retryErroredItem(item)}
                      className="min-h-[40px] rounded-xl border border-slate-300 px-3 font-semibold"
                    >
                      再試行
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void discardOutboxItem(item.queue_id)}
                    aria-label="キュー項目を破棄"
                    className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-400 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Theme & Local Backup */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            画面テーマ（プールサイド高コントラスト対応）
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'light', label: 'ライト（推奨）' },
                { id: 'dark', label: 'ダーク' },
                { id: 'system', label: '端末連動' },
              ] as Array<{ id: ThemePreference; label: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPreference(opt.id)}
                className={`min-h-[44px] rounded-xl border text-xs font-semibold transition ${
                  preference === opt.id
                    ? 'border-sky-600 bg-sky-50 text-sky-900 dark:border-sky-400 dark:bg-sky-950/40 dark:text-sky-100'
                    : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            未送信データ退避・復元（JSON）
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            iOS のストレージ自動削除に備え、このアカウントの未送信キューとキャッシュをファイル退避できます。
          </p>
          {backupMessage && (
            <p className="text-xs font-semibold text-sky-700 dark:text-sky-300">
              {backupMessage}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleExportBackup()}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-100"
            >
              <Download className="h-4 w-4" />
              <span>JSON 書き出し</span>
            </button>
            <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-100">
              <Upload className="h-4 w-4" />
              <span>JSON 読み込み</span>
              <input
                type="file"
                accept="application/json"
                onChange={handleImportBackup}
                className="hidden"
              />
            </label>
          </div>
        </section>
      </div>

      {/* Local Competition Countdown Manager */}
      <section className="rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 space-y-4">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
            大会カウントダウン管理（端末ローカル保存）
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            既存DBを変更せず、端末内の IndexedDB に大会日程を保存します（JSONバックアップに含まれます）。
          </p>
        </div>

        <form onSubmit={handleAddCompetition} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <input
            type="text"
            required
            value={compName}
            onChange={(e) => setCompName(e.target.value)}
            placeholder="大会名"
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <input
            type="date"
            required
            value={compDate}
            onChange={(e) => setCompDate(e.target.value)}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 font-mono-num text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <input
            type="text"
            value={compNote}
            onChange={(e) => setCompNote(e.target.value)}
            placeholder="目標メモ（任意）"
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="submit"
            className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl bg-sky-600 px-4 text-xs font-semibold text-white hover:bg-sky-700"
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
                  <span className="font-semibold">{c.name}</span>{' '}
                  <span className="font-mono-num text-xs text-slate-500">
                    ({c.event_date})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemoveCompetition(c.id)}
                  aria-label="大会を削除"
                  className="min-h-[40px] min-w-[40px] flex items-center justify-center text-slate-400 hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedConflict && (
        <ConflictResolverModal
          item={selectedConflict}
          onClose={() => setSelectedConflict(null)}
        />
      )}
    </div>
  );
};
