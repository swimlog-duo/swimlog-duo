import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProfileRow, UserRole } from '../types/database';
import type {
  AppDatasetSnapshot,
  LocalCompetitionGoal,
  LocalTemplateMeta,
  OutboxItem,
  SwimlogBackupBundle,
} from '../types/domain';
import { applyOutboxOverlayToDataset, validateBackupBundleStructure } from './outboxOverlay';

export const OFFLINE_DB_NAME = 'swimlog_duo_offline_v1';
const OFFLINE_DB_VERSION = 1;

interface CacheEntry {
  key: string; // `${owner_user_id}`
  owner_user_id: string;
  dataset: AppDatasetSnapshot;
  updated_at: string;
}

interface DraftEntry {
  key: string; // `${owner_user_id}:${draft_id}`
  owner_user_id: string;
  draft_id: string;
  data: unknown;
  updated_at: string;
}

interface LocalMetaEntry {
  key: string; // `${owner_user_id}:competitions` | `${owner_user_id}:templates` | `${owner_user_id}:id_map` | `${owner_user_id}:sync_lease` | `${owner_user_id}:backup_restore_seq`
  owner_user_id: string;
  kind: 'competitions' | 'templates' | 'id_map' | 'sync_lease' | 'backup_restore_seq';
  value: unknown;
  updated_at: string;
}

export interface SyncLeaseRecord {
  context_id: string;
  started_at: string;
  expires_at: string;
}

export interface SyncLeaseOwnershipGuard {
  ownerUserId: string;
  contextId: string;
}

interface SwimlogOfflineSchema extends DBSchema {
  cache_snapshots: {
    key: string;
    value: CacheEntry;
  };
  outbox_queue: {
    key: string;
    value: OutboxItem;
    indexes: {
      'by-owner': string;
      'by-created': string;
    };
  };
  drafts: {
    key: string;
    value: DraftEntry;
    indexes: {
      'by-owner': string;
    };
  };
  local_meta: {
    key: string;
    value: LocalMetaEntry;
    indexes: {
      'by-owner': string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<SwimlogOfflineSchema>> | null = null;
const cacheSnapshotLocks = new Map<string, Promise<void>>();

export function getOfflineDb(): Promise<IDBPDatabase<SwimlogOfflineSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<SwimlogOfflineSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('cache_snapshots')) {
          db.createObjectStore('cache_snapshots', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('outbox_queue')) {
          const outbox = db.createObjectStore('outbox_queue', { keyPath: 'queue_id' });
          outbox.createIndex('by-owner', 'owner_user_id');
          outbox.createIndex('by-created', 'created_at');
        }
        if (!db.objectStoreNames.contains('drafts')) {
          const drafts = db.createObjectStore('drafts', { keyPath: 'key' });
          drafts.createIndex('by-owner', 'owner_user_id');
        }
        if (!db.objectStoreNames.contains('local_meta')) {
          const meta = db.createObjectStore('local_meta', { keyPath: 'key' });
          meta.createIndex('by-owner', 'owner_user_id');
        }
      },
    });
  }
  return dbPromise;
}

export function resetOfflineDbConnectionForTest(): void {
  dbPromise = null;
  cacheSnapshotLocks.clear();
}

export async function runWithCacheSnapshotLock<T>(
  ownerUserId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = cacheSnapshotLocks.get(ownerUserId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  cacheSnapshotLocks.set(ownerUserId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (cacheSnapshotLocks.get(ownerUserId) === queued) {
      cacheSnapshotLocks.delete(ownerUserId);
    }
  }
}

export function createEmptyDataset(): AppDatasetSnapshot {
  return {
    profiles: [],
    menus: [],
    menu_versions: [],
    menu_status_history: [],
    practice_days: [],
    practice_entries: [],
    set_results: [],
    record_history: [],
    coach_comments: [],
    last_synced_at: null,
  };
}

function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function isLeaseRecordOwnedAndActive(
  entry: LocalMetaEntry | undefined,
  ownerUserId: string,
  contextId: string,
  nowMs: number
): boolean {
  if (
    !entry ||
    entry.owner_user_id !== ownerUserId ||
    !entry.value ||
    typeof entry.value !== 'object'
  ) {
    return false;
  }
  const cur = entry.value as Partial<SyncLeaseRecord>;
  if (cur.context_id !== contextId) return false;
  const expMs = typeof cur.expires_at === 'string' ? Date.parse(cur.expires_at) : 0;
  return Number.isFinite(expMs) && expMs > nowMs;
}

export async function loadCachedDataset(ownerUserId: string): Promise<AppDatasetSnapshot> {
  const db = await getOfflineDb();
  const entry = await db.get('cache_snapshots', ownerUserId);
  return entry?.dataset ?? createEmptyDataset();
}

export async function saveCachedDataset(
  ownerUserId: string,
  dataset: AppDatasetSnapshot,
  options?: { syncLease?: SyncLeaseOwnershipGuard; rejectOlderThanExisting?: boolean }
): Promise<boolean> {
  const db = await getOfflineDb();
  if (!options?.syncLease && !options?.rejectOlderThanExisting) {
    await db.put('cache_snapshots', {
      key: ownerUserId,
      owner_user_id: ownerUserId,
      dataset,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  const tx = db.transaction(['cache_snapshots', 'local_meta'], 'readwrite');
  const nowMs = Date.now();
  if (options.syncLease) {
    if (options.syncLease.ownerUserId !== ownerUserId) {
      await tx.done;
      return false;
    }
    const leaseEntry = await tx.objectStore('local_meta').get(`${ownerUserId}:sync_lease`);
    if (
      !isLeaseRecordOwnedAndActive(
        leaseEntry,
        options.syncLease.ownerUserId,
        options.syncLease.contextId,
        nowMs
      )
    ) {
      await tx.done;
      return false;
    }
  }

  const existing = await tx.objectStore('cache_snapshots').get(ownerUserId);
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) {
      await tx.done;
      return false;
    }
    const existingLastSyncMs = parseTimestampMs(existing.dataset.last_synced_at);
    const incomingLastSyncMs = parseTimestampMs(dataset.last_synced_at);
    if (
      existingLastSyncMs > 0 &&
      (incomingLastSyncMs === 0 || existingLastSyncMs > incomingLastSyncMs)
    ) {
      await tx.done;
      return false;
    }
  }

  await tx.objectStore('cache_snapshots').put({
    key: ownerUserId,
    owner_user_id: ownerUserId,
    dataset,
    updated_at: new Date(nowMs).toISOString(),
  });
  await tx.done;
  return true;
}

export async function getBackupRestoreSeq(ownerUserId: string): Promise<number> {
  const db = await getOfflineDb();
  const entry = await db.get('local_meta', `${ownerUserId}:backup_restore_seq`);
  return typeof entry?.value === 'number' ? entry.value : 0;
}

export async function commitSyncCacheWithLease(params: {
  ownerUserId: string;
  contextId: string;
  serverSnapshot: AppDatasetSnapshot | null;
  backupRestoreSeqAtStart: number;
  buildOverlay: (
    base: AppDatasetSnapshot,
    remainingOutbox: OutboxItem[],
    idMap: Record<string, string>
  ) => AppDatasetSnapshot;
}): Promise<{
  saved: boolean;
  dataset: AppDatasetSnapshot;
  reason?: 'lease_lost' | 'stale_cache' | 'owner_mismatch';
}> {
  const { ownerUserId, contextId, serverSnapshot, backupRestoreSeqAtStart, buildOverlay } =
    params;

  return runWithCacheSnapshotLock(ownerUserId, async () => {
    const db = await getOfflineDb();
    const tx = db.transaction(['cache_snapshots', 'outbox_queue', 'local_meta'], 'readwrite');
    const nowMs = Date.now();

    const leaseEntry = await tx.objectStore('local_meta').get(`${ownerUserId}:sync_lease`);
    if (!isLeaseRecordOwnedAndActive(leaseEntry, ownerUserId, contextId, nowMs)) {
      const existingEntry = await tx.objectStore('cache_snapshots').get(ownerUserId);
      await tx.done;
      return {
        saved: false,
        dataset: existingEntry?.dataset ?? createEmptyDataset(),
        reason: 'lease_lost',
      };
    }

    const existingEntry = await tx.objectStore('cache_snapshots').get(ownerUserId);
    if (existingEntry && existingEntry.owner_user_id !== ownerUserId) {
      await tx.done;
      return {
        saved: false,
        dataset: createEmptyDataset(),
        reason: 'owner_mismatch',
      };
    }

    const restoreSeqEntry = await tx
      .objectStore('local_meta')
      .get(`${ownerUserId}:backup_restore_seq`);
    const currentRestoreSeq =
      typeof restoreSeqEntry?.value === 'number' ? restoreSeqEntry.value : 0;
    const hasConcurrentRestore = currentRestoreSeq !== backupRestoreSeqAtStart;

    if (!hasConcurrentRestore && serverSnapshot && existingEntry) {
      const existingLastSyncMs = parseTimestampMs(existingEntry.dataset.last_synced_at);
      const serverLastSyncMs = parseTimestampMs(serverSnapshot.last_synced_at);
      if (
        existingLastSyncMs > 0 &&
        (serverLastSyncMs === 0 || existingLastSyncMs > serverLastSyncMs)
      ) {
        await tx.done;
        return {
          saved: false,
          dataset: existingEntry.dataset,
          reason: 'stale_cache',
        };
      }
    }

    const remainingOutboxRaw = await tx
      .objectStore('outbox_queue')
      .index('by-owner')
      .getAll(ownerUserId);
    const remainingOutbox = remainingOutboxRaw.sort((a, b) =>
      a.created_at.localeCompare(b.created_at)
    );
    const idMapEntry = await tx.objectStore('local_meta').get(`${ownerUserId}:id_map`);
    const idMap =
      idMapEntry?.value && typeof idMapEntry.value === 'object' && !Array.isArray(idMapEntry.value)
        ? (idMapEntry.value as Record<string, string>)
        : {};

    let base: AppDatasetSnapshot;
    if (serverSnapshot) {
      base =
        hasConcurrentRestore && existingEntry?.dataset
          ? mergeDatasetsForBackupRestore(existingEntry.dataset, serverSnapshot)
          : serverSnapshot;
    } else {
      base = existingEntry?.dataset ?? createEmptyDataset();
    }

    const overlaid = buildOverlay(base, remainingOutbox, idMap);

    await tx.objectStore('cache_snapshots').put({
      key: ownerUserId,
      owner_user_id: ownerUserId,
      dataset: overlaid,
      updated_at: new Date(nowMs).toISOString(),
    });
    await tx.done;
    return {
      saved: true,
      dataset: overlaid,
    };
  });
}

/**
 * Re-reads the latest IndexedDB `cache_snapshots` entry for `ownerUserId` under a
 * per-owner mutex and patches ONLY `display_name` on the matching own `profiles` row.
 * Never fabricates missing rows or alters other profiles/tables/outbox.
 */
export async function patchOwnProfileDisplayNameInCache(
  ownerUserId: string,
  savedDisplayName: string
): Promise<AppDatasetSnapshot> {
  return runWithCacheSnapshotLock(ownerUserId, async () => {
    const db = await getOfflineDb();
    const tx = db.transaction('cache_snapshots', 'readwrite');
    try {
      const entry = await tx.store.get(ownerUserId);
      const latestCache = entry?.dataset ?? createEmptyDataset();
      const targetIndex = latestCache.profiles.findIndex((p) => p.id === ownerUserId);
      if (targetIndex === -1) {
        throw new Error('ローカルキャッシュに本人プロフィール行が見つかりません。');
      }

      const nextProfiles = latestCache.profiles.map((p, idx) =>
        idx === targetIndex ? { ...p, display_name: savedDisplayName } : p
      );
      const nextCache: AppDatasetSnapshot = {
        ...latestCache,
        profiles: nextProfiles,
      };
      await tx.store.put({
        key: ownerUserId,
        owner_user_id: ownerUserId,
        dataset: nextCache,
        updated_at: new Date().toISOString(),
      });
      await tx.done;
      return nextCache;
    } catch (err) {
      tx.done.catch(() => {});
      try {
        tx.abort();
      } catch {
        // Ignore if already aborted
      }
      throw err;
    }
  });
}

export async function listOutboxForOwner(ownerUserId: string): Promise<OutboxItem[]> {
  const db = await getOfflineDb();
  const items = await db.getAllFromIndex('outbox_queue', 'by-owner', ownerUserId);
  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function listAllOutboxCountsByOwner(): Promise<Record<string, number>> {
  const db = await getOfflineDb();
  const all = await db.getAll('outbox_queue');
  const counts: Record<string, number> = {};
  for (const item of all) {
    counts[item.owner_user_id] = (counts[item.owner_user_id] ?? 0) + 1;
  }
  return counts;
}

function ensureMonotonicCreatedAt(candidateIso: string, existing: OutboxItem[]): string {
  if (existing.length === 0) return candidateIso;
  let maxMs = 0;
  for (const item of existing) {
    const ms = Date.parse(item.created_at);
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
    }
  }
  const candMs = Date.parse(candidateIso);
  if (!Number.isFinite(candMs) || candMs <= maxMs) {
    return new Date(maxMs + 1).toISOString();
  }
  return candidateIso;
}

function applyEnqueueLogicInMemory(
  workingList: OutboxItem[],
  item: OutboxItem,
  mode: 'coalesce' | 'raw'
): { stored: OutboxItem; nextList: OutboxItem[] } {
  if (mode === 'coalesce' && item.operation === 'update') {
    const pendingUpdates = workingList.filter(
      (q) =>
        q.status === 'pending' &&
        q.table_name === item.table_name &&
        q.client_temp_id === item.client_temp_id &&
        q.operation === 'update'
    );
    const lastPendingUpdate = pendingUpdates[pendingUpdates.length - 1];

    if (lastPendingUpdate) {
      const hasInterveningRevise =
        item.table_name === 'menus' &&
        workingList.some(
          (q) =>
            q.operation === 'revise_menu_version' &&
            String(q.payload.menu_id ?? '') === item.client_temp_id &&
            q.created_at > lastPendingUpdate.created_at
        );

      if (!hasInterveningRevise) {
        const merged: OutboxItem = {
          ...lastPendingUpdate,
          payload: { ...lastPendingUpdate.payload, ...item.payload },
          expected_revision: lastPendingUpdate.expected_revision,
          updated_at: new Date().toISOString(),
        };
        return {
          stored: merged,
          nextList: workingList.map((q) => (q.queue_id === merged.queue_id ? merged : q)),
        };
      }
    }

    if (item.table_name !== 'menus') {
      const pendingInsert = workingList.find(
        (q) =>
          q.status === 'pending' &&
          q.table_name === item.table_name &&
          q.client_temp_id === item.client_temp_id &&
          q.operation === 'insert'
      );
      if (pendingInsert) {
        const merged: OutboxItem = {
          ...pendingInsert,
          payload: { ...pendingInsert.payload, ...item.payload },
          updated_at: new Date().toISOString(),
        };
        return {
          stored: merged,
          nextList: workingList.map((q) => (q.queue_id === merged.queue_id ? merged : q)),
        };
      }
    }
  }

  const orderedItem: OutboxItem = {
    ...item,
    created_at: ensureMonotonicCreatedAt(item.created_at, workingList),
  };
  return {
    stored: orderedItem,
    nextList: [...workingList, orderedItem],
  };
}

/**
 * Atomically enqueues a batch of Outbox items within a single IndexedDB readwrite
 * transaction so multi-step saves (e.g. menu + version + share, or practice batch)
 * never leave partial/orphaned items on failure.
 */
export async function enqueueOutboxBatch(
  entries: Array<{ item: OutboxItem; mode?: 'coalesce' | 'raw' }>
): Promise<OutboxItem[]> {
  if (entries.length === 0) return [];
  const ownerUserId = entries[0].item.owner_user_id;
  for (const entry of entries) {
    if (entry.item.owner_user_id !== ownerUserId) {
      throw new Error('異なるアカウントのデータを同時に保存することはできません。');
    }
  }

  const db = await getOfflineDb();
  const tx = db.transaction('outbox_queue', 'readwrite');
  const existingRaw = await tx.store.index('by-owner').getAll(ownerUserId);
  let workingList = existingRaw.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const touched = new Map<string, OutboxItem>();
  const results: OutboxItem[] = [];

  for (const entry of entries) {
    const res = applyEnqueueLogicInMemory(
      workingList,
      entry.item,
      entry.mode ?? 'coalesce'
    );
    workingList = res.nextList;
    touched.set(res.stored.queue_id, res.stored);
    results.push(res.stored);
  }

  for (const itemToPut of touched.values()) {
    await tx.store.put(itemToPut);
  }
  await tx.done;
  return results;
}

/**
 * Enqueues an Outbox item with dependency-safe coalescing.
 */
export async function enqueueOutboxItem(item: OutboxItem): Promise<OutboxItem> {
  const [stored] = await enqueueOutboxBatch([{ item, mode: 'coalesce' }]);
  return stored;
}

export async function enqueueOutboxItemRaw(item: OutboxItem): Promise<OutboxItem> {
  const [stored] = await enqueueOutboxBatch([{ item, mode: 'raw' }]);
  return stored;
}

export async function updateOutboxItem(
  item: OutboxItem,
  options?: {
    syncLease?: SyncLeaseOwnershipGuard;
    expectedStatus?: OutboxItem['status'];
    expectedSyncContextId?: string | null;
  }
): Promise<boolean> {
  const db = await getOfflineDb();
  if (!options?.syncLease) {
    await db.put('outbox_queue', {
      ...item,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  const { syncLease, expectedStatus, expectedSyncContextId } = options;
  const tx = db.transaction(['outbox_queue', 'local_meta'], 'readwrite');
  const nowMs = Date.now();
  const leaseEntry = await tx
    .objectStore('local_meta')
    .get(`${syncLease.ownerUserId}:sync_lease`);
  if (!isLeaseRecordOwnedAndActive(leaseEntry, syncLease.ownerUserId, syncLease.contextId, nowMs)) {
    await tx.done;
    return false;
  }

  const existing = await tx.objectStore('outbox_queue').get(item.queue_id);
  if (!existing) {
    await tx.done;
    return false;
  }
  if (
    existing.owner_user_id !== syncLease.ownerUserId ||
    existing.owner_user_id !== item.owner_user_id
  ) {
    await tx.done;
    return false;
  }
  if (expectedStatus !== undefined && existing.status !== expectedStatus) {
    await tx.done;
    return false;
  }
  if (
    expectedSyncContextId !== undefined &&
    (existing.sync_context_id ?? null) !== expectedSyncContextId
  ) {
    await tx.done;
    return false;
  }
  if (
    expectedSyncContextId === undefined &&
    existing.status === 'syncing' &&
    existing.sync_context_id &&
    existing.sync_context_id !== syncLease.contextId
  ) {
    await tx.done;
    return false;
  }

  await tx.objectStore('outbox_queue').put({
    ...item,
    updated_at: new Date(nowMs).toISOString(),
  });
  await tx.done;
  return true;
}

export async function removeOutboxItem(
  queueId: string,
  options?: {
    syncLease?: SyncLeaseOwnershipGuard;
    expectedSyncContextId?: string | null;
  }
): Promise<boolean> {
  const db = await getOfflineDb();
  if (!options?.syncLease) {
    await db.delete('outbox_queue', queueId);
    return true;
  }

  const { syncLease, expectedSyncContextId } = options;
  const tx = db.transaction(['outbox_queue', 'local_meta'], 'readwrite');
  const leaseEntry = await tx
    .objectStore('local_meta')
    .get(`${syncLease.ownerUserId}:sync_lease`);
  if (
    !isLeaseRecordOwnedAndActive(
      leaseEntry,
      syncLease.ownerUserId,
      syncLease.contextId,
      Date.now()
    )
  ) {
    await tx.done;
    return false;
  }

  const existing = await tx.objectStore('outbox_queue').get(queueId);
  if (!existing) {
    await tx.done;
    return false;
  }
  if (existing.owner_user_id !== syncLease.ownerUserId) {
    await tx.done;
    return false;
  }
  if (
    expectedSyncContextId !== undefined &&
    (existing.sync_context_id ?? null) !== expectedSyncContextId
  ) {
    await tx.done;
    return false;
  }
  if (
    expectedSyncContextId === undefined &&
    existing.status === 'syncing' &&
    existing.sync_context_id &&
    existing.sync_context_id !== syncLease.contextId
  ) {
    await tx.done;
    return false;
  }

  await tx.objectStore('outbox_queue').delete(queueId);
  await tx.done;
  return true;
}

export async function removeOutboxItemsBatch(
  queueIds: string[],
  options?: { syncLease?: SyncLeaseOwnershipGuard }
): Promise<boolean> {
  if (queueIds.length === 0) return true;
  const db = await getOfflineDb();
  if (!options?.syncLease) {
    const tx = db.transaction('outbox_queue', 'readwrite');
    for (const qid of queueIds) {
      await tx.store.delete(qid);
    }
    await tx.done;
    return true;
  }

  const { syncLease } = options;
  const tx = db.transaction(['outbox_queue', 'local_meta'], 'readwrite');
  const leaseEntry = await tx
    .objectStore('local_meta')
    .get(`${syncLease.ownerUserId}:sync_lease`);
  if (
    !isLeaseRecordOwnedAndActive(
      leaseEntry,
      syncLease.ownerUserId,
      syncLease.contextId,
      Date.now()
    )
  ) {
    await tx.done;
    return false;
  }

  for (const qid of queueIds) {
    const existing = await tx.objectStore('outbox_queue').get(qid);
    if (!existing) continue;
    if (
      existing.owner_user_id !== syncLease.ownerUserId ||
      (existing.status === 'syncing' &&
        existing.sync_context_id &&
        existing.sync_context_id !== syncLease.contextId)
    ) {
      await tx.done;
      return false;
    }
  }

  for (const qid of queueIds) {
    await tx.objectStore('outbox_queue').delete(qid);
  }
  await tx.done;
  return true;
}

export async function retryErroredOutboxForOwner(ownerUserId: string): Promise<number> {
  const db = await getOfflineDb();
  const tx = db.transaction('outbox_queue', 'readwrite');
  const items = await tx.store.index('by-owner').getAll(ownerUserId);
  let count = 0;
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status === 'error') {
      await tx.store.put({
        ...item,
        status: 'pending',
        last_error: null,
        sync_context_id: null,
        sync_started_at: null,
        updated_at: now,
      });
      count += 1;
    }
  }
  await tx.done;
  return count;
}

export async function saveDraft(
  ownerUserId: string,
  draftId: string,
  data: unknown
): Promise<void> {
  const db = await getOfflineDb();
  await db.put('drafts', {
    key: `${ownerUserId}:${draftId}`,
    owner_user_id: ownerUserId,
    draft_id: draftId,
    data,
    updated_at: new Date().toISOString(),
  });
}

export async function loadDraft<T>(ownerUserId: string, draftId: string): Promise<T | null> {
  const db = await getOfflineDb();
  const entry = await db.get('drafts', `${ownerUserId}:${draftId}`);
  return (entry?.data as T | undefined) ?? null;
}

export async function deleteDraft(ownerUserId: string, draftId: string): Promise<void> {
  const db = await getOfflineDb();
  await db.delete('drafts', `${ownerUserId}:${draftId}`);
}

export async function loadCompetitions(ownerUserId: string): Promise<LocalCompetitionGoal[]> {
  const db = await getOfflineDb();
  const entry = await db.get('local_meta', `${ownerUserId}:competitions`);
  return Array.isArray(entry?.value) ? (entry.value as LocalCompetitionGoal[]) : [];
}

export async function saveCompetitions(
  ownerUserId: string,
  items: LocalCompetitionGoal[]
): Promise<void> {
  const db = await getOfflineDb();
  await db.put('local_meta', {
    key: `${ownerUserId}:competitions`,
    owner_user_id: ownerUserId,
    kind: 'competitions',
    value: items,
    updated_at: new Date().toISOString(),
  });
}

export async function loadTemplateMeta(ownerUserId: string): Promise<LocalTemplateMeta[]> {
  const db = await getOfflineDb();
  const entry = await db.get('local_meta', `${ownerUserId}:templates`);
  return Array.isArray(entry?.value) ? (entry.value as LocalTemplateMeta[]) : [];
}

export async function saveTemplateMeta(
  ownerUserId: string,
  items: LocalTemplateMeta[]
): Promise<void> {
  const db = await getOfflineDb();
  await db.put('local_meta', {
    key: `${ownerUserId}:templates`,
    owner_user_id: ownerUserId,
    kind: 'templates',
    value: items,
    updated_at: new Date().toISOString(),
  });
}

export async function loadIdMap(ownerUserId: string): Promise<Record<string, string>> {
  const db = await getOfflineDb();
  const entry = await db.get('local_meta', `${ownerUserId}:id_map`);
  if (entry?.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
    return entry.value as Record<string, string>;
  }
  return {};
}

export async function saveIdMap(
  ownerUserId: string,
  idMap: Record<string, string>,
  options?: { syncLease?: SyncLeaseOwnershipGuard }
): Promise<boolean> {
  const db = await getOfflineDb();
  if (!options?.syncLease) {
    await db.put('local_meta', {
      key: `${ownerUserId}:id_map`,
      owner_user_id: ownerUserId,
      kind: 'id_map',
      value: idMap,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  const { syncLease } = options;
  if (syncLease.ownerUserId !== ownerUserId) {
    return false;
  }
  const tx = db.transaction('local_meta', 'readwrite');
  const nowMs = Date.now();
  const leaseEntry = await tx.store.get(`${ownerUserId}:sync_lease`);
  if (!isLeaseRecordOwnedAndActive(leaseEntry, syncLease.ownerUserId, syncLease.contextId, nowMs)) {
    await tx.done;
    return false;
  }
  await tx.store.put({
    key: `${ownerUserId}:id_map`,
    owner_user_id: ownerUserId,
    kind: 'id_map',
    value: idMap,
    updated_at: new Date(nowMs).toISOString(),
  });
  await tx.done;
  return true;
}

const SYNC_LEASE_TTL_MS = 60_000;

export async function getSyncLease(ownerUserId: string): Promise<SyncLeaseRecord | null> {
  const db = await getOfflineDb();
  const entry = await db.get('local_meta', `${ownerUserId}:sync_lease`);
  if (!entry?.value || typeof entry.value !== 'object') return null;
  const val = entry.value as Partial<SyncLeaseRecord>;
  if (typeof val.context_id !== 'string' || typeof val.expires_at !== 'string') {
    return null;
  }
  return {
    context_id: val.context_id,
    started_at: typeof val.started_at === 'string' ? val.started_at : val.expires_at,
    expires_at: val.expires_at,
  };
}

export async function isForeignSyncLeaseActive(
  ownerUserId: string,
  currentContextId: string
): Promise<boolean> {
  const lease = await getSyncLease(ownerUserId);
  if (!lease) return false;
  if (lease.context_id === currentContextId) return false;
  const expMs = Date.parse(lease.expires_at);
  return Number.isFinite(expMs) && expMs > Date.now();
}

export async function acquireOrRefreshSyncLease(
  ownerUserId: string,
  contextId: string,
  options?: { force?: boolean }
): Promise<boolean> {
  const db = await getOfflineDb();
  const tx = db.transaction('local_meta', 'readwrite');
  const key = `${ownerUserId}:sync_lease`;
  const existing = await tx.store.get(key);
  const nowMs = Date.now();
  if (!options?.force && existing?.value && typeof existing.value === 'object') {
    const cur = existing.value as Partial<SyncLeaseRecord>;
    const expMs = typeof cur.expires_at === 'string' ? Date.parse(cur.expires_at) : 0;
    if (
      typeof cur.context_id === 'string' &&
      cur.context_id !== contextId &&
      Number.isFinite(expMs) &&
      expMs > nowMs
    ) {
      await tx.done;
      return false;
    }
  }
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + SYNC_LEASE_TTL_MS).toISOString();
  const prevLease =
    existing?.value && typeof existing.value === 'object'
      ? (existing.value as Partial<SyncLeaseRecord>)
      : null;
  const preservedStartedAt =
    prevLease?.context_id === contextId && typeof prevLease.started_at === 'string'
      ? prevLease.started_at
      : nowIso;
  await tx.store.put({
    key,
    owner_user_id: ownerUserId,
    kind: 'sync_lease',
    value: {
      context_id: contextId,
      started_at: preservedStartedAt,
      expires_at: expiresIso,
    } satisfies SyncLeaseRecord,
    updated_at: nowIso,
  });
  await tx.done;
  return true;
}

export async function refreshOwnedSyncLease(
  ownerUserId: string,
  contextId: string
): Promise<boolean> {
  const db = await getOfflineDb();
  const tx = db.transaction('local_meta', 'readwrite');
  const key = `${ownerUserId}:sync_lease`;
  const existing = await tx.store.get(key);
  const nowMs = Date.now();
  if (!isLeaseRecordOwnedAndActive(existing, ownerUserId, contextId, nowMs)) {
    await tx.done;
    return false;
  }
  const cur = existing!.value as SyncLeaseRecord;
  const nowIso = new Date(nowMs).toISOString();
  await tx.store.put({
    key,
    owner_user_id: ownerUserId,
    kind: 'sync_lease',
    value: {
      context_id: contextId,
      started_at: typeof cur.started_at === 'string' ? cur.started_at : nowIso,
      expires_at: new Date(nowMs + SYNC_LEASE_TTL_MS).toISOString(),
    } satisfies SyncLeaseRecord,
    updated_at: nowIso,
  });
  await tx.done;
  return true;
}

export async function releaseSyncLease(
  ownerUserId: string,
  contextId: string
): Promise<void> {
  const db = await getOfflineDb();
  const tx = db.transaction('local_meta', 'readwrite');
  const key = `${ownerUserId}:sync_lease`;
  const existing = await tx.store.get(key);
  const cur = existing?.value as Partial<SyncLeaseRecord> | undefined;
  if (cur?.context_id === contextId) {
    await tx.store.delete(key);
  }
  await tx.done;
}

export async function exportBackupBundle(
  ownerUserId: string,
  ownerRole: UserRole
): Promise<SwimlogBackupBundle> {
  const [cachedDataset, outbox, competitions, template_meta, idMap] = await Promise.all([
    loadCachedDataset(ownerUserId),
    listOutboxForOwner(ownerUserId),
    loadCompetitions(ownerUserId),
    loadTemplateMeta(ownerUserId),
    loadIdMap(ownerUserId),
  ]);

  const dataset = applyOutboxOverlayToDataset(cachedDataset, outbox, idMap);

  return {
    app: 'swimlog-duo',
    version: 1,
    exported_at: new Date().toISOString(),
    owner_user_id: ownerUserId,
    owner_role: ownerRole,
    dataset,
    outbox,
    competitions,
    template_meta,
  };
}

export interface BackupImportPreview {
  exportedAt: string;
  backupCounts: {
    menus: number;
    practiceDays: number;
    outbox: number;
    competitions: number;
  };
  currentCounts: {
    menus: number;
    practiceDays: number;
    outbox: number;
    competitions: number;
  };
  conflictingQueueIds: string[];
  protectedLocalOutboxCount: number;
}

function stableJson(val: unknown): string {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableJson).join(',')}]`;
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function outboxItemsEquivalent(a: OutboxItem, b: OutboxItem): boolean {
  return (
    a.table_name === b.table_name &&
    a.operation === b.operation &&
    a.client_temp_id === b.client_temp_id &&
    a.expected_revision === b.expected_revision &&
    stableJson(a.payload) === stableJson(b.payload)
  );
}

export async function previewBackupImport(
  rawBundle: unknown,
  targetUserId: string,
  targetRole: UserRole
): Promise<{ bundle: SwimlogBackupBundle; preview: BackupImportPreview }> {
  const validated = validateBackupBundleStructure(rawBundle, targetUserId, targetRole);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const bundle = validated.bundle;
  const [currentDataset, currentOutbox, currentComps] = await Promise.all([
    loadCachedDataset(targetUserId),
    listOutboxForOwner(targetUserId),
    loadCompetitions(targetUserId),
  ]);

  const currentByQueueId = new Map(currentOutbox.map((i) => [i.queue_id, i]));
  const currentByTargetOp = new Map<string, OutboxItem[]>();
  for (const curItem of currentOutbox) {
    const sig = `${curItem.table_name}:${curItem.client_temp_id}:${curItem.operation}`;
    const list = currentByTargetOp.get(sig) ?? [];
    list.push(curItem);
    currentByTargetOp.set(sig, list);
  }
  const conflictingQueueIds: string[] = [];
  const protectedLocalOutboxCount = currentOutbox.length;

  for (const bItem of bundle.outbox ?? []) {
    const cur = currentByQueueId.get(bItem.queue_id);
    if (cur) {
      if (!outboxItemsEquivalent(cur, bItem)) {
        conflictingQueueIds.push(bItem.queue_id);
      }
      continue;
    }
    const opSig = `${bItem.table_name}:${bItem.client_temp_id}:${bItem.operation}`;
    const targetConflicts = currentByTargetOp.get(opSig);
    if (targetConflicts && targetConflicts.length > 0) {
      conflictingQueueIds.push(bItem.queue_id);
    }
  }

  return {
    bundle,
    preview: {
      exportedAt: bundle.exported_at,
      backupCounts: {
        menus: bundle.dataset.menus.length,
        practiceDays: bundle.dataset.practice_days.filter((d) => !d.is_deleted).length,
        outbox: (bundle.outbox ?? []).length,
        competitions: (bundle.competitions ?? []).length,
      },
      currentCounts: {
        menus: currentDataset.menus.length,
        practiceDays: currentDataset.practice_days.filter((d) => !d.is_deleted).length,
        outbox: currentOutbox.length,
        competitions: currentComps.length,
      },
      conflictingQueueIds,
      protectedLocalOutboxCount,
    },
  };
}

function mergeByIdAppendOnly<T extends { id: string }>(
  existingList: T[],
  backupList: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const row of backupList) {
    byId.set(row.id, row);
  }
  for (const row of existingList) {
    byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

function mergeByIdNewerUpdatedAt<
  T extends { id: string; updated_at?: string; created_at?: string },
>(existingList: T[], backupList: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of backupList) {
    byId.set(row.id, row);
  }
  for (const row of existingList) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    const existingMs = parseTimestampMs(row.updated_at ?? row.created_at);
    const backupMs = parseTimestampMs(prev.updated_at ?? prev.created_at);
    if (existingMs >= backupMs) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values());
}

function mergeByIdRevisionAndUpdatedAt<
  T extends { id: string; revision?: number; updated_at?: string; created_at?: string },
>(existingList: T[], backupList: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of backupList) {
    byId.set(row.id, row);
  }
  for (const row of existingList) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    const existingRev = typeof row.revision === 'number' ? row.revision : 0;
    const backupRev = typeof prev.revision === 'number' ? prev.revision : 0;
    if (existingRev > backupRev) {
      byId.set(row.id, row);
    } else if (existingRev === backupRev) {
      const existingMs = parseTimestampMs(row.updated_at ?? row.created_at);
      const backupMs = parseTimestampMs(prev.updated_at ?? prev.created_at);
      if (existingMs >= backupMs) {
        byId.set(row.id, row);
      }
    }
  }
  return Array.from(byId.values());
}

export function mergeDatasetsForBackupRestore(
  existing: AppDatasetSnapshot | null | undefined,
  backup: AppDatasetSnapshot
): AppDatasetSnapshot {
  if (!existing) {
    return backup;
  }

  const existingLastSyncMs = parseTimestampMs(existing.last_synced_at);
  const backupLastSyncMs = parseTimestampMs(backup.last_synced_at);

  const profilesById = new Map<string, ProfileRow>();
  for (const p of backup.profiles) {
    profilesById.set(p.id, p);
  }
  for (const p of existing.profiles) {
    const prev = profilesById.get(p.id);
    if (!prev || existingLastSyncMs >= backupLastSyncMs) {
      profilesById.set(p.id, p);
    }
  }

  const mergedLastSyncedAt =
    existingLastSyncMs > 0 || backupLastSyncMs > 0
      ? existingLastSyncMs >= backupLastSyncMs
        ? existing.last_synced_at
        : backup.last_synced_at
      : existing.last_synced_at ?? backup.last_synced_at ?? null;

  return {
    profiles: Array.from(profilesById.values()),
    menus: mergeByIdNewerUpdatedAt(existing.menus, backup.menus),
    menu_versions: mergeByIdAppendOnly(existing.menu_versions, backup.menu_versions),
    menu_status_history: mergeByIdAppendOnly(
      existing.menu_status_history,
      backup.menu_status_history
    ),
    practice_days: mergeByIdRevisionAndUpdatedAt(existing.practice_days, backup.practice_days),
    practice_entries: mergeByIdRevisionAndUpdatedAt(
      existing.practice_entries,
      backup.practice_entries
    ),
    set_results: mergeByIdRevisionAndUpdatedAt(existing.set_results, backup.set_results),
    record_history: mergeByIdAppendOnly(existing.record_history, backup.record_history),
    coach_comments: mergeByIdAppendOnly(existing.coach_comments, backup.coach_comments),
    last_synced_at: mergedLastSyncedAt,
  };
}

export async function importBackupBundle(
  bundle: SwimlogBackupBundle,
  targetUserId: string,
  targetRole: UserRole
): Promise<{ importedOutboxCount: number; skippedDuplicateCount: number }> {
  const validated = validateBackupBundleStructure(bundle, targetUserId, targetRole);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const safeBundle = validated.bundle;

  return runWithCacheSnapshotLock(targetUserId, async () => {
    const db = await getOfflineDb();
    const tx = db.transaction(['cache_snapshots', 'outbox_queue', 'local_meta'], 'readwrite');
    try {
      const existingOutbox = await tx
        .objectStore('outbox_queue')
        .index('by-owner')
        .getAll(targetUserId);
      const existingByQueueId = new Map(existingOutbox.map((i) => [i.queue_id, i]));
      const initialExistingByTargetOp = new Map<string, OutboxItem[]>();
      for (const curItem of existingOutbox) {
        const sig = `${curItem.table_name}:${curItem.client_temp_id}:${curItem.operation}`;
        const list = initialExistingByTargetOp.get(sig) ?? [];
        list.push(curItem);
        initialExistingByTargetOp.set(sig, list);
      }

      let importedOutboxCount = 0;
      let skippedDuplicateCount = 0;

      for (const item of safeBundle.outbox ?? []) {
        if (item.owner_user_id !== targetUserId || item.owner_role !== targetRole) {
          throw new Error('別アカウントの未送信データが含まれているため復元を中止しました。');
        }
        const sameQueueItem = existingByQueueId.get(item.queue_id);
        if (sameQueueItem) {
          if (outboxItemsEquivalent(sameQueueItem, item)) {
            skippedDuplicateCount += 1;
            continue;
          }
          throw new Error(
            '現在の端末にある未送信データと異なる内容のキューが重複しているため、データを保護して復元を中止しました。'
          );
        }
        const opSig = `${item.table_name}:${item.client_temp_id}:${item.operation}`;
        const sameTargetItems = initialExistingByTargetOp.get(opSig);
        if (sameTargetItems && sameTargetItems.length > 0) {
          const hasDifferentContent = sameTargetItems.some(
            (cur) => !outboxItemsEquivalent(cur, item)
          );
          if (hasDifferentContent) {
            throw new Error(
              '異なるキューIDで同一対象に対する異なる内容の未送信データが競合しているため、データを保護して復元を中止しました。'
            );
          }
          throw new Error(
            '異なるキューIDで同一対象・同一操作の未送信データが重複しているため、データを保護して復元を中止しました。'
          );
        }
        await tx.objectStore('outbox_queue').put(item);
        existingByQueueId.set(item.queue_id, item);
        importedOutboxCount += 1;
      }

      const existingCacheEntry = await tx.objectStore('cache_snapshots').get(targetUserId);
      if (existingCacheEntry && existingCacheEntry.owner_user_id !== targetUserId) {
        throw new Error('別アカウントのローカルキャッシュと競合したため復元を中止しました。');
      }
      const mergedDataset = mergeDatasetsForBackupRestore(
        existingCacheEntry?.dataset,
        safeBundle.dataset
      );

      const nowIso = new Date().toISOString();
      await tx.objectStore('cache_snapshots').put({
        key: targetUserId,
        owner_user_id: targetUserId,
        dataset: mergedDataset,
        updated_at: nowIso,
      });

      const restoreSeqEntry = await tx
        .objectStore('local_meta')
        .get(`${targetUserId}:backup_restore_seq`);
      const nextRestoreSeq =
        (typeof restoreSeqEntry?.value === 'number' ? restoreSeqEntry.value : 0) + 1;
      await tx.objectStore('local_meta').put({
        key: `${targetUserId}:backup_restore_seq`,
        owner_user_id: targetUserId,
        kind: 'backup_restore_seq',
        value: nextRestoreSeq,
        updated_at: nowIso,
      });

      const compEntry = await tx.objectStore('local_meta').get(`${targetUserId}:competitions`);
      const existingComps = Array.isArray(compEntry?.value)
        ? (compEntry.value as LocalCompetitionGoal[])
        : [];
      const mergedCompsMap = new Map<string, LocalCompetitionGoal>();
      for (const c of safeBundle.competitions ?? []) {
        if (c && typeof c.id === 'string') mergedCompsMap.set(c.id, c);
      }
      for (const c of existingComps) {
        if (c && typeof c.id === 'string') mergedCompsMap.set(c.id, c);
      }
      await tx.objectStore('local_meta').put({
        key: `${targetUserId}:competitions`,
        owner_user_id: targetUserId,
        kind: 'competitions',
        value: Array.from(mergedCompsMap.values()),
        updated_at: nowIso,
      });

      const tplEntry = await tx.objectStore('local_meta').get(`${targetUserId}:templates`);
      const existingTpls = Array.isArray(tplEntry?.value)
        ? (tplEntry.value as LocalTemplateMeta[])
        : [];
      const mergedTplsMap = new Map<string, LocalTemplateMeta>();
      for (const t of safeBundle.template_meta ?? []) {
        if (t && typeof t.menu_id === 'string') mergedTplsMap.set(t.menu_id, t);
      }
      for (const t of existingTpls) {
        if (t && typeof t.menu_id === 'string') mergedTplsMap.set(t.menu_id, t);
      }
      await tx.objectStore('local_meta').put({
        key: `${targetUserId}:templates`,
        owner_user_id: targetUserId,
        kind: 'templates',
        value: Array.from(mergedTplsMap.values()),
        updated_at: nowIso,
      });

      await tx.done;
      return { importedOutboxCount, skippedDuplicateCount };
    } catch (err) {
      tx.done.catch(() => {});
      try {
        tx.abort();
      } catch {
        // Ignore if transaction already aborted
      }
      throw err;
    }
  });
}
