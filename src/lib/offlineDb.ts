import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { UserRole } from '../types/database';
import type {
  AppDatasetSnapshot,
  LocalCompetitionGoal,
  LocalTemplateMeta,
  OutboxItem,
  SwimlogBackupBundle,
} from '../types/domain';

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
  key: string; // `${owner_user_id}:competitions` | `${owner_user_id}:templates` | `${owner_user_id}:id_map`
  owner_user_id: string;
  kind: 'competitions' | 'templates' | 'id_map';
  value: unknown;
  updated_at: string;
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

export async function loadCachedDataset(ownerUserId: string): Promise<AppDatasetSnapshot> {
  const db = await getOfflineDb();
  const entry = await db.get('cache_snapshots', ownerUserId);
  return entry?.dataset ?? createEmptyDataset();
}

export async function saveCachedDataset(
  ownerUserId: string,
  dataset: AppDatasetSnapshot
): Promise<void> {
  const db = await getOfflineDb();
  await db.put('cache_snapshots', {
    key: ownerUserId,
    owner_user_id: ownerUserId,
    dataset,
    updated_at: new Date().toISOString(),
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
    const latestCache = await loadCachedDataset(ownerUserId);
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
    await saveCachedDataset(ownerUserId, nextCache);
    return nextCache;
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

/**
 * Enqueues an Outbox item with dependency-safe coalescing:
 * - For `menus`, an `update` NEVER coalesces into `menus(insert)` because `stamp_menu_insert()`
 *   requires new menus to start unshared and `menu_versions(insert)` must run before sharing.
 * - For `menus`, an `update` only coalesces into a prior pending `menus(update)` if no later
 *   `revise_menu_version` exists for that same `menu_id` after it.
 * - For other tables (`practice_days`, `practice_entries`, `set_results`), an offline `update`
 *   coalesces into a pending `update` (keeping original `expected_revision`) or a pending `insert`.
 */
export async function enqueueOutboxItem(item: OutboxItem): Promise<OutboxItem> {
  const db = await getOfflineDb();
  const existingForOwner = await listOutboxForOwner(item.owner_user_id);

  if (item.operation === 'update') {
    const pendingUpdates = existingForOwner.filter(
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
        existingForOwner.some(
          (q) =>
            q.operation === 'revise_menu_version' &&
            String(q.payload.menu_id ?? '') === item.client_temp_id &&
            q.created_at > lastPendingUpdate.created_at
        );

      if (!hasInterveningRevise) {
        const merged: OutboxItem = {
          ...lastPendingUpdate,
          payload: { ...lastPendingUpdate.payload, ...item.payload },
          // Keep original expected_revision from server snapshot
          expected_revision: lastPendingUpdate.expected_revision,
          updated_at: new Date().toISOString(),
        };
        await db.put('outbox_queue', merged);
        return merged;
      }
    }

    if (item.table_name !== 'menus') {
      const pendingInsert = existingForOwner.find(
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
        await db.put('outbox_queue', merged);
        return merged;
      }
    }
  }

  const orderedItem: OutboxItem = {
    ...item,
    created_at: ensureMonotonicCreatedAt(item.created_at, existingForOwner),
  };
  await db.put('outbox_queue', orderedItem);
  return orderedItem;
}

export async function enqueueOutboxItemRaw(item: OutboxItem): Promise<OutboxItem> {
  const db = await getOfflineDb();
  const existingForOwner = await listOutboxForOwner(item.owner_user_id);
  const orderedItem: OutboxItem = {
    ...item,
    created_at: ensureMonotonicCreatedAt(item.created_at, existingForOwner),
  };
  await db.put('outbox_queue', orderedItem);
  return orderedItem;
}

export async function updateOutboxItem(item: OutboxItem): Promise<void> {
  const db = await getOfflineDb();
  await db.put('outbox_queue', {
    ...item,
    updated_at: new Date().toISOString(),
  });
}

export async function removeOutboxItem(queueId: string): Promise<void> {
  const db = await getOfflineDb();
  await db.delete('outbox_queue', queueId);
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
  idMap: Record<string, string>
): Promise<void> {
  const db = await getOfflineDb();
  await db.put('local_meta', {
    key: `${ownerUserId}:id_map`,
    owner_user_id: ownerUserId,
    kind: 'id_map',
    value: idMap,
    updated_at: new Date().toISOString(),
  });
}

export async function exportBackupBundle(
  ownerUserId: string,
  ownerRole: UserRole
): Promise<SwimlogBackupBundle> {
  const [dataset, outbox, competitions, template_meta] = await Promise.all([
    loadCachedDataset(ownerUserId),
    listOutboxForOwner(ownerUserId),
    loadCompetitions(ownerUserId),
    loadTemplateMeta(ownerUserId),
  ]);

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

export async function importBackupBundle(
  bundle: SwimlogBackupBundle,
  targetUserId: string,
  targetRole: UserRole
): Promise<{ importedOutboxCount: number }> {
  if (!bundle || bundle.app !== 'swimlog-duo' || bundle.version !== 1) {
    throw new Error('無効なバックアップファイル形式です。');
  }
  if (bundle.owner_user_id !== targetUserId || bundle.owner_role !== targetRole) {
    throw new Error(
      '別アカウントのバックアップファイルは現在のアカウントへ復元できません（混同防止ガード）。'
    );
  }

  await runWithCacheSnapshotLock(targetUserId, async () => {
    await saveCachedDataset(targetUserId, bundle.dataset);
  });
  await saveCompetitions(targetUserId, bundle.competitions ?? []);
  await saveTemplateMeta(targetUserId, bundle.template_meta ?? []);

  const db = await getOfflineDb();
  let importedOutboxCount = 0;
  for (const item of bundle.outbox ?? []) {
    if (item.owner_user_id === targetUserId && item.owner_role === targetRole) {
      await db.put('outbox_queue', item);
      importedOutboxCount += 1;
    }
  }

  return { importedOutboxCount };
}
