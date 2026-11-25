import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createEmptyDataset,
  enqueueOutboxItem,
  enqueueOutboxItemRaw,
  exportBackupBundle,
  importBackupBundle,
  listAllOutboxCountsByOwner,
  listOutboxForOwner,
  loadCachedDataset,
  loadCompetitions,
  loadTemplateMeta,
  removeOutboxItem,
  saveCompetitions,
  saveTemplateMeta,
  updateOutboxItem,
} from '../lib/offlineDb';
import {
  applyOutboxOverlayToDataset,
  refreshConflictServerRecord,
  resolveConflictUseServer,
  resolveConflictWithMergedPayload,
  runSyncForAccount,
} from '../lib/syncEngine';
import { executeDisplayNameUpdate } from '../lib/profileService';
import type { MenuContentJson, MenuItemRow, SplitRecord } from '../types/database';
import type {
  AppDatasetSnapshot,
  LocalCompetitionGoal,
  LocalTemplateMeta,
  OutboxItem,
  SwimlogBackupBundle,
} from '../types/domain';
import { validateDisplayNameInput } from '../utils/displayName';
import { createUuid, validateMenuVersionInput } from '../utils/swimCalculations';
import { useAuth } from './useAuth';
import { getCurrentOnlineStatus, useOnlineStatus } from './useOnlineStatus';

interface SwimDataContextValue {
  dataset: AppDatasetSnapshot;
  outbox: OutboxItem[];
  allOutboxCounts: Record<string, number>;
  competitions: LocalCompetitionGoal[];
  templateMeta: LocalTemplateMeta[];
  isSyncing: boolean;
  isUpdatingProfile: boolean;
  lastSyncMessage: string | null;
  pendingCount: number;
  conflictItems: OutboxItem[];
  errorItems: OutboxItem[];
  syncNow: () => Promise<void>;
  updateMyDisplayName: (rawDisplayName: string) => Promise<string>;
  // Coach menu actions
  createMenu: (params: {
    title: string;
    rows: MenuItemRow[];
    shareNow: boolean;
  }) => Promise<string>;
  reviseMenu: (params: {
    menuId: string;
    title: string;
    rows: MenuItemRow[];
    shareAfter: boolean;
  }) => Promise<void>;
  updateMenuStatus: (
    menuId: string,
    patch: { is_shared?: boolean; is_archived?: boolean }
  ) => Promise<void>;
  addCoachComment: (params: {
    entryId: string;
    setResultId: string | null;
    body: string;
  }) => Promise<void>;
  // Athlete creation actions
  createPracticeDay: (params: {
    practice_date: string;
    note: string;
  }) => Promise<string>;
  createPracticeEntry: (params: {
    day_id: string;
    menu_version_id: string;
    sort_order: number;
    total_time_ms: number | null;
    rating: number | null;
    impression: string;
  }) => Promise<string>;
  createSetResult: (params: {
    entry_id: string;
    row_id: string;
    time_ms: number | null;
    splits: SplitRecord[];
    rating: number | null;
    impression: string;
  }) => Promise<string>;
  savePracticeLogBatch: (params: {
    existingDayId: string | null;
    practice_date: string;
    day_note: string;
    menu_version_id: string;
    sort_order: number;
    total_time_ms: number | null;
    rating: number | null;
    impression: string;
    set_results: Array<{
      row_id: string;
      time_ms: number | null;
      splits: SplitRecord[];
      rating: number | null;
      impression: string;
    }>;
  }) => Promise<string>;
  // Shared update actions (with expected_revision)
  updatePracticeDay: (
    id: string,
    expectedRevision: number,
    patch: { practice_date?: string; note?: string; is_deleted?: boolean }
  ) => Promise<void>;
  updatePracticeEntry: (
    id: string,
    expectedRevision: number,
    patch: {
      sort_order?: number;
      total_time_ms?: number | null;
      rating?: number | null;
      impression?: string;
      is_deleted?: boolean;
    }
  ) => Promise<void>;
  updateSetResult: (
    id: string,
    expectedRevision: number,
    patch: {
      time_ms?: number | null;
      splits?: SplitRecord[];
      rating?: number | null;
      impression?: string;
      is_deleted?: boolean;
    }
  ) => Promise<void>;
  // Conflict & queue actions
  acceptServerOnConflict: (item: OutboxItem) => Promise<void>;
  submitMergedConflict: (
    item: OutboxItem,
    mergedPayload: Record<string, unknown>,
    serverRevision: number
  ) => Promise<void>;
  refreshConflictRecord: (item: OutboxItem) => Promise<OutboxItem>;
  retryErroredItem: (item: OutboxItem) => Promise<void>;
  discardOutboxItem: (queueId: string) => Promise<void>;
  // Local-only metadata & backup
  saveCompetitionsList: (items: LocalCompetitionGoal[]) => Promise<void>;
  toggleTemplateFlag: (menuId: string, isTemplate: boolean, plannedDate?: string) => Promise<void>;
  exportJsonBackup: () => Promise<SwimlogBackupBundle>;
  importJsonBackup: (bundle: SwimlogBackupBundle) => Promise<{ importedOutboxCount: number }>;
}

const SwimDataContext = createContext<SwimDataContextValue | null>(null);

export const SwimDataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { session, refreshSession, updateSessionDisplayName } = useAuth();
  const isOnline = useOnlineStatus();

  const [dataset, setDataset] = useState<AppDatasetSnapshot>(() => createEmptyDataset());
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [allOutboxCounts, setAllOutboxCounts] = useState<Record<string, number>>({});
  const [competitions, setCompetitions] = useState<LocalCompetitionGoal[]>([]);
  const [templateMeta, setTemplateMeta] = useState<LocalTemplateMeta[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const syncingKeysRef = useRef<Set<string>>(new Set());
  const pendingResyncKeysRef = useRef<Set<string>>(new Set());
  const profileUpdatingKeysRef = useRef<Set<string>>(new Set());
  const importingBackupKeysRef = useRef<Set<string>>(new Set());
  const lastSyncCompletedAtRef = useRef(0);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const prevOnlineForSyncRef = useRef<boolean>(getCurrentOnlineStatus());

  const refreshActiveOperationFlags = useCallback(() => {
    const active = sessionRef.current;
    if (!active) {
      setIsSyncing(false);
      setIsUpdatingProfile(false);
      return;
    }
    const key = `${active.slot}:${active.userId}`;
    setIsSyncing(syncingKeysRef.current.has(key));
    setIsUpdatingProfile(profileUpdatingKeysRef.current.has(key));
  }, []);

  const reloadLocalForSession = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      lastLoadedSessionKeyRef.current = null;
      setDataset(createEmptyDataset());
      setOutbox([]);
      setCompetitions([]);
      setTemplateMeta([]);
      setAllOutboxCounts(await listAllOutboxCountsByOwner());
      return;
    }
    const [cached, ownerOutbox, counts, comps, tpls] = await Promise.all([
      loadCachedDataset(activeSession.userId),
      listOutboxForOwner(activeSession.userId),
      listAllOutboxCountsByOwner(),
      loadCompetitions(activeSession.userId),
      loadTemplateMeta(activeSession.userId),
    ]);
    if (
      sessionRef.current?.userId !== activeSession.userId ||
      sessionRef.current?.slot !== activeSession.slot
    ) {
      return;
    }
    setDataset(applyOutboxOverlayToDataset(cached, ownerOutbox));
    setOutbox(ownerOutbox);
    setAllOutboxCounts(counts);
    setCompetitions(comps);
    setTemplateMeta(tpls);
  }, []);

  const syncNow = useCallback(async () => {
    const targetSession = sessionRef.current;
    if (!targetSession) return;
    const lockKey = `${targetSession.slot}:${targetSession.userId}`;
    const onlineNow = getCurrentOnlineStatus();
    if (!onlineNow) {
      setLastSyncMessage('オフラインのためローカル保存を継続中です。');
      return;
    }
    if (
      syncingKeysRef.current.has(lockKey) ||
      profileUpdatingKeysRef.current.has(lockKey) ||
      importingBackupKeysRef.current.has(lockKey)
    ) {
      pendingResyncKeysRef.current.add(lockKey);
      return;
    }

    syncingKeysRef.current.add(lockKey);
    refreshActiveOperationFlags();
    try {
      const result = await runSyncForAccount({
        client: targetSession.client,
        slot: targetSession.slot,
        userId: targetSession.userId,
        role: targetSession.role,
        isOnline: onlineNow,
      });
      const stillSameSession =
        sessionRef.current?.userId === targetSession.userId &&
        sessionRef.current?.slot === targetSession.slot;
      if (!stillSameSession) {
        return;
      }

      setDataset(result.dataset);
      const [ownerOutbox, counts] = await Promise.all([
        listOutboxForOwner(targetSession.userId),
        listAllOutboxCountsByOwner(),
      ]);
      setOutbox(ownerOutbox);
      setAllOutboxCounts(counts);
      lastSyncCompletedAtRef.current = Date.now();

      if (result.skippedReason) {
        setLastSyncMessage(result.skippedReason);
      } else if (result.conflictCount > 0) {
        setLastSyncMessage(`競合が ${result.conflictCount} 件あります。内容を確認してください。`);
      } else if (result.errorCount > 0) {
        setLastSyncMessage(`同期エラーが ${result.errorCount} 件あります。`);
      } else if (result.syncedCount > 0) {
        setLastSyncMessage(`${result.syncedCount} 件を同期しました。`);
      } else {
        setLastSyncMessage('最新状態です。');
      }
    } catch (err) {
      if (
        sessionRef.current?.userId === targetSession.userId &&
        sessionRef.current?.slot === targetSession.slot
      ) {
        setLastSyncMessage(err instanceof Error ? err.message : '同期中にエラーが発生しました。');
      }
    } finally {
      syncingKeysRef.current.delete(lockKey);
      refreshActiveOperationFlags();
      if (pendingResyncKeysRef.current.has(lockKey)) {
        pendingResyncKeysRef.current.delete(lockKey);
        const isVisible =
          typeof document === 'undefined' || document.visibilityState === 'visible';
        const activeNow = sessionRef.current;
        if (
          isVisible &&
          getCurrentOnlineStatus() &&
          activeNow &&
          activeNow.slot === targetSession.slot &&
          activeNow.userId === targetSession.userId
        ) {
          void syncNow();
        }
      }
    }
  }, [refreshActiveOperationFlags]);

  const updateMyDisplayName = useCallback(
    async (rawDisplayName: string): Promise<string> => {
      const check = validateDisplayNameInput(rawDisplayName);
      if (!check.valid) {
        throw new Error(check.error);
      }

      const targetSession = sessionRef.current;
      if (!targetSession) {
        throw new Error('ログインが必要です。');
      }
      if (!getCurrentOnlineStatus()) {
        throw new Error('オフラインのため表示名を更新できません。インターネット接続を確認してください。');
      }

      const lockKey = `${targetSession.slot}:${targetSession.userId}`;
      if (
        syncingKeysRef.current.has(lockKey) ||
        importingBackupKeysRef.current.has(lockKey)
      ) {
        throw new Error('同期またはバックアップ復元を実行中です。完了後にもう一度お試しください。');
      }
      if (profileUpdatingKeysRef.current.has(lockKey)) {
        throw new Error('表示名を更新中です。完了までお待ちください。');
      }

      profileUpdatingKeysRef.current.add(lockKey);
      refreshActiveOperationFlags();

      try {
        const res = await executeDisplayNameUpdate({
          slot: targetSession.slot,
          userId: targetSession.userId,
          role: targetSession.role,
          client: targetSession.client,
          rawDisplayName: check.normalized,
          isOnline: getCurrentOnlineStatus(),
          updateSessionDisplayName,
          refreshSessionOnCacheFailure: refreshSession,
        });

        const stillSameSession =
          sessionRef.current?.userId === targetSession.userId &&
          sessionRef.current?.slot === targetSession.slot;
        if (stillSameSession) {
          setDataset(res.overlayDataset);
          setOutbox(res.latestOutbox);
        }
        return res.savedName;
      } finally {
        profileUpdatingKeysRef.current.delete(lockKey);
        refreshActiveOperationFlags();
        if (pendingResyncKeysRef.current.has(lockKey)) {
          pendingResyncKeysRef.current.delete(lockKey);
          const isVisible =
            typeof document === 'undefined' || document.visibilityState === 'visible';
          const activeNow = sessionRef.current;
          if (
            isVisible &&
            getCurrentOnlineStatus() &&
            activeNow &&
            activeNow.slot === targetSession.slot &&
            activeNow.userId === targetSession.userId
          ) {
            void syncNow();
          }
        }
      }
    },
    [refreshActiveOperationFlags, refreshSession, syncNow, updateSessionDisplayName]
  );

  useEffect(() => {
    refreshActiveOperationFlags();
    if (!session) {
      void reloadLocalForSession();
      return;
    }
    const sessionKey = `${session.slot}:${session.userId}`;
    const isNewSessionContext = lastLoadedSessionKeyRef.current !== sessionKey;
    lastLoadedSessionKeyRef.current = sessionKey;

    if (!isNewSessionContext) {
      return;
    }

    prevOnlineForSyncRef.current = getCurrentOnlineStatus();
    void reloadLocalForSession().then(() => {
      if (getCurrentOnlineStatus()) {
        void syncNow();
      }
    });
  }, [session, refreshActiveOperationFlags, reloadLocalForSession, syncNow]);

  useEffect(() => {
    if (!session) return;
    const lockKey = `${session.slot}:${session.userId}`;

    const triggerOnlineRecoverySync = () => {
      if (!getCurrentOnlineStatus()) {
        prevOnlineForSyncRef.current = false;
        return;
      }
      const wasOffline = !prevOnlineForSyncRef.current;
      prevOnlineForSyncRef.current = true;
      const isVisible =
        typeof document === 'undefined' || document.visibilityState === 'visible';
      if (!isVisible) {
        return;
      }
      const hasUnsentPending = outboxRef.current.some(
        (item) => item.status === 'pending' || item.status === 'syncing'
      );
      if (wasOffline) {
        void syncNow();
      } else if (hasUnsentPending && !syncingKeysRef.current.has(lockKey)) {
        void syncNow();
      }
    };

    const triggerVisibilitySync = () => {
      if (!getCurrentOnlineStatus()) return;
      const hasUnsentPending = outboxRef.current.some(
        (item) => item.status === 'pending' || item.status === 'syncing'
      );
      if (!hasUnsentPending && Date.now() - lastSyncCompletedAtRef.current < 3000) {
        return;
      }
      void syncNow();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerVisibilitySync();
      }
    };
    const handleOnline = () => {
      triggerOnlineRecoverySync();
    };
    const handleOffline = () => {
      prevOnlineForSyncRef.current = false;
    };

    if (isOnline && !prevOnlineForSyncRef.current) {
      triggerOnlineRecoverySync();
    } else if (!isOnline) {
      prevOnlineForSyncRef.current = false;
    }

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session?.slot, session?.userId, isOnline, syncNow]);

  const enqueueAndApply = useCallback(
    async (items: OutboxItem[]) => {
      if (!session) throw new Error('ログインが必要です。');
      for (const item of items) {
        if (item.owner_user_id !== session.userId || item.owner_role !== session.role) {
          throw new Error('アカウント検証に失敗しました。');
        }
        await enqueueOutboxItem(item);
      }
      await reloadLocalForSession();

      if (getCurrentOnlineStatus()) {
        void syncNow();
      }
    },
    [session, reloadLocalForSession, syncNow]
  );

  const createMenu = useCallback(
    async ({ title, rows, shareNow }: { title: string; rows: MenuItemRow[]; shareNow: boolean }) => {
      if (!session || session.role !== 'coach') {
        throw new Error('メニュー作成はコーチアカウントのみ実行できます。');
      }
      const strictContent: MenuContentJson = { rows };
      const check = validateMenuVersionInput(title, strictContent.rows);
      if (!check.valid) throw new Error(check.errors.join(' '));

      const menuId = createUuid();
      const versionId = createUuid();
      const now = new Date().toISOString();

      const items: OutboxItem[] = [
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'insert',
          expected_revision: null,
          payload: { is_shared: false, is_archived: false },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: versionId,
          operation: 'insert',
          expected_revision: null,
          payload: {
            menu_id: menuId,
            version_no: 1,
            title: title.trim(),
            content: strictContent,
          },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: new Date(Date.now() + 1).toISOString(),
          updated_at: now,
        },
      ];

      if (shareNow) {
        items.push({
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'update',
          expected_revision: null,
          payload: { is_shared: true },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: new Date(Date.now() + 2).toISOString(),
          updated_at: now,
        });
      }

      // Note: Do NOT coalesce insert+update for `menus` because menu_versions insert must run BEFORE is_shared=true!
      // Therefore write menu_versions then enqueue is_shared=true directly without coalescing the initial insert:
      await enqueueOutboxItem(items[0]);
      await enqueueOutboxItem(items[1]);
      if (items[2]) {
        await enqueueOutboxItemRaw(items[2]);
      }

      await reloadLocalForSession();
      if (getCurrentOnlineStatus()) {
        void syncNow();
      }
      return menuId;
    },
    [session, reloadLocalForSession, syncNow]
  );

  const reviseMenu = useCallback(
    async ({
      menuId,
      title,
      rows,
      shareAfter,
    }: {
      menuId: string;
      title: string;
      rows: MenuItemRow[];
      shareAfter: boolean;
    }) => {
      if (!session || session.role !== 'coach') {
        throw new Error('メニュー改訂はコーチアカウントのみ実行できます。');
      }
      const strictContent: MenuContentJson = { rows };
      const check = validateMenuVersionInput(title, strictContent.rows);
      if (!check.valid) throw new Error(check.errors.join(' '));

      const existingVersions = dataset.menu_versions.filter((v) => v.menu_id === menuId);
      const maxVer = existingVersions.reduce((acc, v) => Math.max(acc, v.version_no), 0);
      const now = new Date().toISOString();

      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: createUuid(),
          operation: 'revise_menu_version',
          expected_revision: null,
          payload: {
            menu_id: menuId,
            version_no: maxVer + 1,
            title: title.trim(),
            content: strictContent,
            share_after: shareAfter,
          },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, dataset.menu_versions, enqueueAndApply]
  );

  const updateMenuStatus = useCallback(
    async (menuId: string, patch: { is_shared?: boolean; is_archived?: boolean }) => {
      if (!session || session.role !== 'coach') {
        throw new Error('メニュー状態変更はコーチアカウントのみ実行できます。');
      }
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'update',
          expected_revision: null,
          payload: patch,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, enqueueAndApply]
  );

  const addCoachComment = useCallback(
    async ({
      entryId,
      setResultId,
      body,
    }: {
      entryId: string;
      setResultId: string | null;
      body: string;
    }) => {
      if (!session || session.role !== 'coach') {
        throw new Error('コーチコメントの投稿はコーチアカウントのみ実行できます。');
      }
      if (!body.trim()) throw new Error('コメント本文を入力してください。');
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'coach',
          table_name: 'coach_comments',
          client_temp_id: createUuid(),
          operation: 'insert',
          expected_revision: null,
          payload: {
            entry_id: entryId,
            set_result_id: setResultId,
            body: body.trim(),
          },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, enqueueAndApply]
  );

  const createPracticeDay = useCallback(
    async ({ practice_date, note }: { practice_date: string; note: string }) => {
      if (!session || session.role !== 'athlete') {
        throw new Error('練習日の新規作成は選手アカウントのみ実行できます（RLS制約）。');
      }
      const id = createUuid();
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: id,
          operation: 'insert',
          expected_revision: null,
          payload: { practice_date, note },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
      return id;
    },
    [session, enqueueAndApply]
  );

  const createPracticeEntry = useCallback(
    async (params: {
      day_id: string;
      menu_version_id: string;
      sort_order: number;
      total_time_ms: number | null;
      rating: number | null;
      impression: string;
    }) => {
      if (!session || session.role !== 'athlete') {
        throw new Error('実施メニュー記録の新規作成は選手アカウントのみ実行できます（RLS制約）。');
      }
      const id = createUuid();
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'athlete',
          table_name: 'practice_entries',
          client_temp_id: id,
          operation: 'insert',
          expected_revision: null,
          payload: params,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
      return id;
    },
    [session, enqueueAndApply]
  );

  const createSetResult = useCallback(
    async (params: {
      entry_id: string;
      row_id: string;
      time_ms: number | null;
      splits: SplitRecord[];
      rating: number | null;
      impression: string;
    }) => {
      if (!session || session.role !== 'athlete') {
        throw new Error('セット結果の新規作成は選手アカウントのみ実行できます（RLS制約）。');
      }
      const id = createUuid();
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'athlete',
          table_name: 'set_results',
          client_temp_id: id,
          operation: 'insert',
          expected_revision: null,
          payload: params,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
      return id;
    },
    [session, enqueueAndApply]
  );

  const savePracticeLogBatch = useCallback(
    async (params: {
      existingDayId: string | null;
      practice_date: string;
      day_note: string;
      menu_version_id: string;
      sort_order: number;
      total_time_ms: number | null;
      rating: number | null;
      impression: string;
      set_results: Array<{
        row_id: string;
        time_ms: number | null;
        splits: SplitRecord[];
        rating: number | null;
        impression: string;
      }>;
    }) => {
      if (!session || session.role !== 'athlete') {
        throw new Error('練習記録の新規作成は選手アカウントのみ実行できます（RLS制約）。');
      }
      const now = new Date().toISOString();
      const batch: OutboxItem[] = [];

      const dayId = params.existingDayId ?? createUuid();
      if (!params.existingDayId) {
        batch.push({
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: dayId,
          operation: 'insert',
          expected_revision: null,
          payload: {
            practice_date: params.practice_date,
            note: params.day_note,
          },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        });
      }

      const entryId = createUuid();
      batch.push({
        queue_id: createUuid(),
        owner_user_id: session.userId,
        owner_role: 'athlete',
        table_name: 'practice_entries',
        client_temp_id: entryId,
        operation: 'insert',
        expected_revision: null,
        payload: {
          day_id: dayId,
          menu_version_id: params.menu_version_id,
          sort_order: params.sort_order,
          total_time_ms: params.total_time_ms,
          rating: params.rating,
          impression: params.impression,
        },
        status: 'pending',
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      });

      for (const sr of params.set_results) {
        batch.push({
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: 'athlete',
          table_name: 'set_results',
          client_temp_id: createUuid(),
          operation: 'insert',
          expected_revision: null,
          payload: {
            entry_id: entryId,
            row_id: sr.row_id,
            time_ms: sr.time_ms,
            splits: sr.splits,
            rating: sr.rating,
            impression: sr.impression,
          },
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        });
      }

      await enqueueAndApply(batch);
      return dayId;
    },
    [session, enqueueAndApply]
  );

  const updatePracticeDay = useCallback(
    async (
      id: string,
      expectedRevision: number,
      patch: { practice_date?: string; note?: string; is_deleted?: boolean }
    ) => {
      if (!session) throw new Error('ログインが必要です。');
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: session.role,
          table_name: 'practice_days',
          client_temp_id: id,
          operation: 'update',
          expected_revision: expectedRevision,
          payload: patch,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, enqueueAndApply]
  );

  const updatePracticeEntry = useCallback(
    async (
      id: string,
      expectedRevision: number,
      patch: {
        sort_order?: number;
        total_time_ms?: number | null;
        rating?: number | null;
        impression?: string;
        is_deleted?: boolean;
      }
    ) => {
      if (!session) throw new Error('ログインが必要です。');
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: session.role,
          table_name: 'practice_entries',
          client_temp_id: id,
          operation: 'update',
          expected_revision: expectedRevision,
          payload: patch,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, enqueueAndApply]
  );

  const updateSetResult = useCallback(
    async (
      id: string,
      expectedRevision: number,
      patch: {
        time_ms?: number | null;
        splits?: SplitRecord[];
        rating?: number | null;
        impression?: string;
        is_deleted?: boolean;
      }
    ) => {
      if (!session) throw new Error('ログインが必要です。');
      const now = new Date().toISOString();
      await enqueueAndApply([
        {
          queue_id: createUuid(),
          owner_user_id: session.userId,
          owner_role: session.role,
          table_name: 'set_results',
          client_temp_id: id,
          operation: 'update',
          expected_revision: expectedRevision,
          payload: patch,
          status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        },
      ]);
    },
    [session, enqueueAndApply]
  );

  const acceptServerOnConflict = useCallback(
    async (item: OutboxItem) => {
      await resolveConflictUseServer(item);
      await reloadLocalForSession();
      if (getCurrentOnlineStatus()) void syncNow();
    },
    [reloadLocalForSession, syncNow]
  );

  const submitMergedConflict = useCallback(
    async (
      item: OutboxItem,
      mergedPayload: Record<string, unknown>,
      serverRevision: number
    ) => {
      await resolveConflictWithMergedPayload(item, mergedPayload, serverRevision);
      await reloadLocalForSession();
      if (getCurrentOnlineStatus()) void syncNow();
    },
    [reloadLocalForSession, syncNow]
  );

  const refreshConflictRecord = useCallback(
    async (item: OutboxItem): Promise<OutboxItem> => {
      if (!session) throw new Error('ログインが必要です。');
      if (!isOnline) {
        throw new Error('オフラインのためサーバー最新データを取得できません。');
      }
      const updated = await refreshConflictServerRecord({
        client: session.client,
        slot: session.slot,
        userId: session.userId,
        role: session.role,
        item,
      });
      await reloadLocalForSession();
      return updated;
    },
    [session, isOnline, reloadLocalForSession]
  );

  const retryErroredItem = useCallback(
    async (item: OutboxItem) => {
      await updateOutboxItem({ ...item, status: 'pending', last_error: null });
      await reloadLocalForSession();
      if (getCurrentOnlineStatus()) void syncNow();
    },
    [reloadLocalForSession, syncNow]
  );

  const discardOutboxItem = useCallback(
    async (queueId: string) => {
      await removeOutboxItem(queueId);
      await reloadLocalForSession();
    },
    [reloadLocalForSession]
  );

  const saveCompetitionsList = useCallback(
    async (items: LocalCompetitionGoal[]) => {
      if (!session) return;
      await saveCompetitions(session.userId, items);
      setCompetitions(items);
    },
    [session]
  );

  const toggleTemplateFlag = useCallback(
    async (menuId: string, isTemplate: boolean, plannedDate?: string) => {
      if (!session) return;
      const next = templateMeta.filter((t) => t.menu_id !== menuId);
      if (isTemplate || plannedDate) {
        next.push({ menu_id: menuId, is_template: isTemplate, planned_date: plannedDate });
      }
      await saveTemplateMeta(session.userId, next);
      setTemplateMeta(next);
    },
    [session, templateMeta]
  );

  const exportJsonBackup = useCallback(async () => {
    if (!session) throw new Error('ログインが必要です。');
    return exportBackupBundle(session.userId, session.role);
  }, [session]);

  const importJsonBackup = useCallback(
    async (bundle: SwimlogBackupBundle) => {
      const targetSession = sessionRef.current;
      if (!targetSession) throw new Error('ログインが必要です。');
      const lockKey = `${targetSession.slot}:${targetSession.userId}`;
      if (
        syncingKeysRef.current.has(lockKey) ||
        profileUpdatingKeysRef.current.has(lockKey) ||
        importingBackupKeysRef.current.has(lockKey)
      ) {
        throw new Error('同期または表示名更新中のため、完了後に再度復元を実行してください。');
      }
      importingBackupKeysRef.current.add(lockKey);
      let importSucceeded = false;
      try {
        const res = await importBackupBundle(bundle, targetSession.userId, targetSession.role);
        await reloadLocalForSession();
        importSucceeded = true;
        return res;
      } finally {
        importingBackupKeysRef.current.delete(lockKey);
        if (pendingResyncKeysRef.current.has(lockKey)) {
          pendingResyncKeysRef.current.delete(lockKey);
          const isVisible =
            typeof document === 'undefined' || document.visibilityState === 'visible';
          const activeNow = sessionRef.current;
          if (
            !importSucceeded &&
            isVisible &&
            getCurrentOnlineStatus() &&
            activeNow &&
            activeNow.slot === targetSession.slot &&
            activeNow.userId === targetSession.userId
          ) {
            void syncNow();
          }
        }
      }
    },
    [reloadLocalForSession, syncNow]
  );

  const pendingCount = useMemo(
    () => outbox.filter((i) => i.status === 'pending' || i.status === 'syncing').length,
    [outbox]
  );
  const conflictItems = useMemo(
    () => outbox.filter((i) => i.status === 'conflict'),
    [outbox]
  );
  const errorItems = useMemo(
    () => outbox.filter((i) => i.status === 'error'),
    [outbox]
  );

  const contextValue = useMemo<SwimDataContextValue>(
    () => ({
      dataset,
      outbox,
      allOutboxCounts,
      competitions,
      templateMeta,
      isSyncing,
      isUpdatingProfile,
      lastSyncMessage,
      pendingCount,
      conflictItems,
      errorItems,
      syncNow,
      updateMyDisplayName,
      createMenu,
      reviseMenu,
      updateMenuStatus,
      addCoachComment,
      createPracticeDay,
      createPracticeEntry,
      createSetResult,
      savePracticeLogBatch,
      updatePracticeDay,
      updatePracticeEntry,
      updateSetResult,
      acceptServerOnConflict,
      submitMergedConflict,
      refreshConflictRecord,
      retryErroredItem,
      discardOutboxItem,
      saveCompetitionsList,
      toggleTemplateFlag,
      exportJsonBackup,
      importJsonBackup,
    }),
    [
      dataset,
      outbox,
      allOutboxCounts,
      competitions,
      templateMeta,
      isSyncing,
      isUpdatingProfile,
      lastSyncMessage,
      pendingCount,
      conflictItems,
      errorItems,
      syncNow,
      updateMyDisplayName,
      createMenu,
      reviseMenu,
      updateMenuStatus,
      addCoachComment,
      createPracticeDay,
      createPracticeEntry,
      createSetResult,
      savePracticeLogBatch,
      updatePracticeDay,
      updatePracticeEntry,
      updateSetResult,
      acceptServerOnConflict,
      submitMergedConflict,
      refreshConflictRecord,
      retryErroredItem,
      discardOutboxItem,
      saveCompetitionsList,
      toggleTemplateFlag,
      exportJsonBackup,
      importJsonBackup,
    ]
  );

  return (
    <SwimDataContext.Provider value={contextValue}>
      {children}
    </SwimDataContext.Provider>
  );
};

export function useSwimData(): SwimDataContextValue {
  const ctx = useContext(SwimDataContext);
  if (!ctx) {
    throw new Error('useSwimData must be used inside SwimDataProvider');
  }
  return ctx;
}
