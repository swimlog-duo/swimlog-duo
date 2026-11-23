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
import type { MenuContentJson, MenuItemRow, SplitRecord } from '../types/database';
import type {
  AppDatasetSnapshot,
  LocalCompetitionGoal,
  LocalTemplateMeta,
  OutboxItem,
  SwimlogBackupBundle,
} from '../types/domain';
import { createUuid, validateMenuVersionInput } from '../utils/swimCalculations';
import { useAuth } from './useAuth';
import { useOnlineStatus } from './useOnlineStatus';

interface SwimDataContextValue {
  dataset: AppDatasetSnapshot;
  outbox: OutboxItem[];
  allOutboxCounts: Record<string, number>;
  competitions: LocalCompetitionGoal[];
  templateMeta: LocalTemplateMeta[];
  isSyncing: boolean;
  lastSyncMessage: string | null;
  pendingCount: number;
  conflictItems: OutboxItem[];
  errorItems: OutboxItem[];
  syncNow: () => Promise<void>;
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
  const { session } = useAuth();
  const isOnline = useOnlineStatus();

  const [dataset, setDataset] = useState<AppDatasetSnapshot>(() => createEmptyDataset());
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [allOutboxCounts, setAllOutboxCounts] = useState<Record<string, number>>({});
  const [competitions, setCompetitions] = useState<LocalCompetitionGoal[]>([]);
  const [templateMeta, setTemplateMeta] = useState<LocalTemplateMeta[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const syncingRef = useRef(false);
  const pendingResyncRef = useRef(false);
  const lastSyncCompletedAtRef = useRef(0);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);

  const reloadLocalForSession = useCallback(async () => {
    if (!session) {
      lastLoadedSessionKeyRef.current = null;
      setDataset(createEmptyDataset());
      setOutbox([]);
      setCompetitions([]);
      setTemplateMeta([]);
      setAllOutboxCounts(await listAllOutboxCountsByOwner());
      return;
    }
    const [cached, ownerOutbox, counts, comps, tpls] = await Promise.all([
      loadCachedDataset(session.userId),
      listOutboxForOwner(session.userId),
      listAllOutboxCountsByOwner(),
      loadCompetitions(session.userId),
      loadTemplateMeta(session.userId),
    ]);
    setDataset(applyOutboxOverlayToDataset(cached, ownerOutbox));
    setOutbox(ownerOutbox);
    setAllOutboxCounts(counts);
    setCompetitions(comps);
    setTemplateMeta(tpls);
  }, [session]);

  const syncNow = useCallback(async () => {
    if (!session) return;
    if (!isOnline) {
      setLastSyncMessage('オフラインのためローカル保存を継続中です。');
      return;
    }
    if (syncingRef.current) {
      pendingResyncRef.current = true;
      return;
    }

    syncingRef.current = true;
    setIsSyncing(true);
    try {
      const result = await runSyncForAccount({
        client: session.client,
        slot: session.slot,
        userId: session.userId,
        role: session.role,
        isOnline,
      });
      setDataset(result.dataset);
      const [ownerOutbox, counts] = await Promise.all([
        listOutboxForOwner(session.userId),
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
      setLastSyncMessage(err instanceof Error ? err.message : '同期中にエラーが発生しました。');
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      if (pendingResyncRef.current) {
        pendingResyncRef.current = false;
        void syncNow();
      }
    }
  }, [session, isOnline]);

  useEffect(() => {
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

    void reloadLocalForSession().then(() => {
      if (isOnline) {
        void syncNow();
      }
    });
  }, [session, isOnline, reloadLocalForSession, syncNow]);

  useEffect(() => {
    if (!session) return;
    const triggerPassiveSync = () => {
      if (!navigator.onLine) return;
      if (Date.now() - lastSyncCompletedAtRef.current < 3000) return;
      void syncNow();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerPassiveSync();
      }
    };
    const handleOnline = () => {
      triggerPassiveSync();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
    };
  }, [session, syncNow]);

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

      if (isOnline) {
        void syncNow();
      }
    },
    [session, isOnline, reloadLocalForSession, syncNow]
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
      if (isOnline) {
        void syncNow();
      }
      return menuId;
    },
    [session, isOnline, reloadLocalForSession, syncNow]
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
      if (isOnline) void syncNow();
    },
    [reloadLocalForSession, isOnline, syncNow]
  );

  const submitMergedConflict = useCallback(
    async (
      item: OutboxItem,
      mergedPayload: Record<string, unknown>,
      serverRevision: number
    ) => {
      await resolveConflictWithMergedPayload(item, mergedPayload, serverRevision);
      await reloadLocalForSession();
      if (isOnline) void syncNow();
    },
    [reloadLocalForSession, isOnline, syncNow]
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
      if (isOnline) void syncNow();
    },
    [reloadLocalForSession, isOnline, syncNow]
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
      if (!session) throw new Error('ログインが必要です。');
      const res = await importBackupBundle(bundle, session.userId, session.role);
      await reloadLocalForSession();
      return res;
    },
    [session, reloadLocalForSession]
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
      lastSyncMessage,
      pendingCount,
      conflictItems,
      errorItems,
      syncNow,
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
      lastSyncMessage,
      pendingCount,
      conflictItems,
      errorItems,
      syncNow,
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
