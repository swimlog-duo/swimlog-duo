import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MenuContentJson,
  PracticeDayRow,
  PracticeEntryRow,
  SetResultRow,
  UserRole,
} from '../types/database';
import type { AppDatasetSnapshot, OutboxItem } from '../types/domain';
import { verifyClientOwnership } from './authManager';
import {
  listOutboxForOwner,
  loadCachedDataset,
  loadIdMap,
  removeOutboxItem,
  runWithCacheSnapshotLock,
  saveCachedDataset,
  saveIdMap,
  updateOutboxItem,
} from './offlineDb';
import {
  fetchAllDatasetFromServer,
  fetchSingleRecordForConflict,
  insertCoachCommentOnServer,
  insertMenuOnServer,
  insertMenuVersionOnServer,
  insertPracticeDayOnServer,
  insertPracticeEntryOnServer,
  insertSetResultOnServer,
  parseSupabaseError,
  reviseMenuVersionOnServer,
  updateMenuStatusOnServer,
  updatePracticeDayOnServer,
  updatePracticeEntryOnServer,
  updateSetResultOnServer,
} from './supabaseRepository';

export interface SyncRunResult {
  syncedCount: number;
  conflictCount: number;
  errorCount: number;
  skippedReason?: string;
  dataset: AppDatasetSnapshot;
}

function replaceOrAppendById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [item, ...list];
  const copy = [...list];
  copy[idx] = item;
  return copy;
}

function remapPayloadIds(
  payload: Record<string, unknown>,
  idMap: Map<string, string>
): Record<string, unknown> {
  const next = { ...payload };
  for (const key of [
    'menu_id',
    'menu_version_id',
    'day_id',
    'entry_id',
    'set_result_id',
  ] as const) {
    const val = next[key];
    if (typeof val === 'string' && idMap.has(val)) {
      next[key] = idMap.get(val);
    }
  }
  return next;
}

function collectDirectDependencyIds(item: OutboxItem): string[] {
  const deps: string[] = [];
  if (item.operation === 'update') {
    deps.push(item.client_temp_id);
  }
  for (const key of [
    'menu_id',
    'menu_version_id',
    'day_id',
    'entry_id',
    'set_result_id',
  ] as const) {
    const val = item.payload[key];
    if (typeof val === 'string' && val.length > 0) {
      deps.push(val);
    }
  }
  if (item.parent_links) {
    for (const val of [
      item.parent_links.menu_temp_id,
      item.parent_links.day_temp_id,
      item.parent_links.entry_temp_id,
    ]) {
      if (typeof val === 'string' && val.length > 0) {
        deps.push(val);
      }
    }
  }
  return deps;
}

function isItemBlocked(
  item: OutboxItem,
  blockedIds: Set<string>,
  blockedMenuStatusIds: Set<string>
): boolean {
  if (
    item.table_name === 'menus' &&
    item.operation === 'update' &&
    blockedMenuStatusIds.has(item.client_temp_id)
  ) {
    return true;
  }
  const deps = collectDirectDependencyIds(item);
  return deps.some((id) => blockedIds.has(id));
}

function recordBlockedItem(
  item: OutboxItem,
  blockedIds: Set<string>,
  blockedMenuStatusIds: Set<string>
): void {
  if (
    item.operation === 'insert' ||
    item.operation === 'revise_menu_version' ||
    blockedIds.has(item.client_temp_id)
  ) {
    blockedIds.add(item.client_temp_id);
  }
  if (item.table_name === 'menu_versions' && typeof item.payload.menu_id === 'string') {
    blockedMenuStatusIds.add(item.payload.menu_id);
  }
}

/**
 * Flushes ONLY pending Outbox items whose `owner_user_id` and `owner_role`
 * strictly match the currently verified client session UID & role,
 * then pulls the latest server snapshot into IndexedDB cache.
 */
export async function runSyncForAccount(params: {
  client: SupabaseClient;
  slot: UserRole;
  userId: string;
  role: UserRole;
  isOnline: boolean;
  skipOwnershipCheck?: boolean;
}): Promise<SyncRunResult> {
  const { client, slot, userId, role, isOnline, skipOwnershipCheck } = params;
  const cached = await loadCachedDataset(userId);

  if (!isOnline) {
    return {
      syncedCount: 0,
      conflictCount: 0,
      errorCount: 0,
      skippedReason: 'オフラインのため同期を待機しています。',
      dataset: cached,
    };
  }

  if (!skipOwnershipCheck) {
    const ownership = await verifyClientOwnership(slot, userId, role);
    if (!ownership.ok) {
      return {
        syncedCount: 0,
        conflictCount: 0,
        errorCount: 0,
        skippedReason: ownership.reason,
        dataset: cached,
      };
    }
  }

  const allItems = await listOutboxForOwner(userId);
  const blockedIds = new Set<string>();
  const blockedMenuStatusIds = new Set<string>();

  // Seed dependency blocks from any already-errored/conflicted items in Outbox
  for (const existing of allItems) {
    if (existing.status === 'error' || existing.status === 'conflict') {
      recordBlockedItem(existing, blockedIds, blockedMenuStatusIds);
    }
  }

  const pendingItems = allItems.filter(
    (item) =>
      item.owner_user_id === userId &&
      item.owner_role === role &&
      item.status === 'pending'
  );

  const persistedIdMap = await loadIdMap(userId);
  const idMap = new Map<string, string>(Object.entries(persistedIdMap));
  let idMapDirty = false;
  const recordIdMapping = (tempId: string, serverId: string) => {
    if (serverId !== tempId && idMap.get(tempId) !== serverId) {
      idMap.set(tempId, serverId);
      idMapDirty = true;
    }
  };

  let syncedCount = 0;
  let conflictCount = 0;
  let errorCount = 0;
  let workingDataset = cached;

  for (const rawItem of pendingItems) {
    // Re-check strict ownership before each item
    if (rawItem.owner_user_id !== userId || rawItem.owner_role !== role) {
      continue;
    }

    // Do NOT send child/dependent operations if a parent INSERT or prerequisite failed
    if (isItemBlocked(rawItem, blockedIds, blockedMenuStatusIds)) {
      recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
      await updateOutboxItem({
        ...rawItem,
        status: 'pending',
        last_error: '親レコードの同期完了待ちのため保留中',
      });
      continue;
    }

    await updateOutboxItem({ ...rawItem, status: 'syncing' });

    const resolvedTargetId = idMap.get(rawItem.client_temp_id) ?? rawItem.client_temp_id;
    const payload = remapPayloadIds(rawItem.payload, idMap);

    try {
      if (rawItem.table_name === 'menus' && rawItem.operation === 'insert') {
        if (role !== 'coach') throw new Error('RLS違反: メニュー作成はコーチのみ可能です。');
        const created = await insertMenuOnServer(client, {
          id: rawItem.client_temp_id,
        });
        recordIdMapping(rawItem.client_temp_id, created.id);
        workingDataset = {
          ...workingDataset,
          menus: replaceOrAppendById(workingDataset.menus, created),
        };
      } else if (rawItem.table_name === 'menus' && rawItem.operation === 'update') {
        if (role !== 'coach') throw new Error('RLS違反: メニュー更新はコーチのみ可能です。');
        const updated = await updateMenuStatusOnServer(client, resolvedTargetId, {
          is_shared:
            typeof payload.is_shared === 'boolean' ? payload.is_shared : undefined,
          is_archived:
            typeof payload.is_archived === 'boolean' ? payload.is_archived : undefined,
        });
        workingDataset = {
          ...workingDataset,
          menus: replaceOrAppendById(workingDataset.menus, updated),
        };
      } else if (rawItem.table_name === 'menu_versions' && rawItem.operation === 'insert') {
        if (role !== 'coach') throw new Error('RLS違反: バージョン作成はコーチのみ可能です。');
        const created = await insertMenuVersionOnServer(client, {
          id: rawItem.client_temp_id,
          menu_id: String(payload.menu_id),
          version_no: Number(payload.version_no ?? 1),
          title: String(payload.title ?? ''),
          content: payload.content as MenuContentJson,
        });
        recordIdMapping(rawItem.client_temp_id, created.id);
        workingDataset = {
          ...workingDataset,
          menu_versions: replaceOrAppendById(workingDataset.menu_versions, created),
        };
      } else if (
        rawItem.table_name === 'menu_versions' &&
        rawItem.operation === 'revise_menu_version'
      ) {
        if (role !== 'coach') throw new Error('RLS違反: メニュー改訂はコーチのみ可能です。');
        const res = await reviseMenuVersionOnServer(client, {
          menu_id: String(payload.menu_id),
          version_id: rawItem.client_temp_id,
          title: String(payload.title ?? ''),
          content: payload.content as MenuContentJson,
          share_after: Boolean(payload.share_after),
        });
        recordIdMapping(rawItem.client_temp_id, res.version.id);
        workingDataset = {
          ...workingDataset,
          menus: replaceOrAppendById(workingDataset.menus, res.menu),
          menu_versions: replaceOrAppendById(workingDataset.menu_versions, res.version),
        };
      } else if (rawItem.table_name === 'practice_days' && rawItem.operation === 'insert') {
        if (role !== 'athlete') throw new Error('RLS違反: 練習日の新規作成は選手のみ可能です。');
        const created = await insertPracticeDayOnServer(client, {
          id: rawItem.client_temp_id,
          athlete_id: userId,
          practice_date: String(payload.practice_date),
          note: String(payload.note ?? ''),
        });
        recordIdMapping(rawItem.client_temp_id, created.id);
        workingDataset = {
          ...workingDataset,
          practice_days: replaceOrAppendById(workingDataset.practice_days, created),
        };
      } else if (rawItem.table_name === 'practice_days' && rawItem.operation === 'update') {
        const expectedRev = rawItem.expected_revision;
        if (expectedRev == null) {
          throw new Error('EXPECTED_REVISION_REQUIRED');
        }
        const updated = await updatePracticeDayOnServer(client, resolvedTargetId, expectedRev, {
          practice_date:
            typeof payload.practice_date === 'string' ? payload.practice_date : undefined,
          note: typeof payload.note === 'string' ? payload.note : undefined,
          is_deleted:
            typeof payload.is_deleted === 'boolean' ? payload.is_deleted : undefined,
        });
        workingDataset = {
          ...workingDataset,
          practice_days: replaceOrAppendById(workingDataset.practice_days, updated),
        };
      } else if (rawItem.table_name === 'practice_entries' && rawItem.operation === 'insert') {
        if (role !== 'athlete') throw new Error('RLS違反: 実施記録の新規作成は選手のみ可能です。');
        const created = await insertPracticeEntryOnServer(client, {
          id: rawItem.client_temp_id,
          day_id: String(payload.day_id),
          menu_version_id: String(payload.menu_version_id),
          sort_order: Number(payload.sort_order ?? 1),
          total_time_ms:
            typeof payload.total_time_ms === 'number' ? payload.total_time_ms : null,
          rating: typeof payload.rating === 'number' ? payload.rating : null,
          impression: String(payload.impression ?? ''),
        });
        recordIdMapping(rawItem.client_temp_id, created.id);
        workingDataset = {
          ...workingDataset,
          practice_entries: replaceOrAppendById(workingDataset.practice_entries, created),
        };
      } else if (rawItem.table_name === 'practice_entries' && rawItem.operation === 'update') {
        const expectedRev = rawItem.expected_revision;
        if (expectedRev == null) {
          throw new Error('EXPECTED_REVISION_REQUIRED');
        }
        const updated = await updatePracticeEntryOnServer(client, resolvedTargetId, expectedRev, {
          sort_order:
            typeof payload.sort_order === 'number' ? payload.sort_order : undefined,
          total_time_ms:
            payload.total_time_ms === null || typeof payload.total_time_ms === 'number'
              ? (payload.total_time_ms as number | null)
              : undefined,
          rating:
            payload.rating === null || typeof payload.rating === 'number'
              ? (payload.rating as number | null)
              : undefined,
          impression:
            typeof payload.impression === 'string' ? payload.impression : undefined,
          is_deleted:
            typeof payload.is_deleted === 'boolean' ? payload.is_deleted : undefined,
        });
        workingDataset = {
          ...workingDataset,
          practice_entries: replaceOrAppendById(workingDataset.practice_entries, updated),
        };
      } else if (rawItem.table_name === 'set_results' && rawItem.operation === 'insert') {
        if (role !== 'athlete') throw new Error('RLS違反: セット結果の新規作成は選手のみ可能です。');
        const created = await insertSetResultOnServer(client, {
          id: rawItem.client_temp_id,
          entry_id: String(payload.entry_id),
          row_id: String(payload.row_id),
          time_ms: typeof payload.time_ms === 'number' ? payload.time_ms : null,
          splits: Array.isArray(payload.splits) ? payload.splits : [],
          rating: typeof payload.rating === 'number' ? payload.rating : null,
          impression: String(payload.impression ?? ''),
        });
        recordIdMapping(rawItem.client_temp_id, created.id);
        workingDataset = {
          ...workingDataset,
          set_results: replaceOrAppendById(workingDataset.set_results, created),
        };
      } else if (rawItem.table_name === 'set_results' && rawItem.operation === 'update') {
        const expectedRev = rawItem.expected_revision;
        if (expectedRev == null) {
          throw new Error('EXPECTED_REVISION_REQUIRED');
        }
        const updated = await updateSetResultOnServer(client, resolvedTargetId, expectedRev, {
          time_ms:
            payload.time_ms === null || typeof payload.time_ms === 'number'
              ? (payload.time_ms as number | null)
              : undefined,
          splits: Array.isArray(payload.splits) ? payload.splits : undefined,
          rating:
            payload.rating === null || typeof payload.rating === 'number'
              ? (payload.rating as number | null)
              : undefined,
          impression:
            typeof payload.impression === 'string' ? payload.impression : undefined,
          is_deleted:
            typeof payload.is_deleted === 'boolean' ? payload.is_deleted : undefined,
        });
        workingDataset = {
          ...workingDataset,
          set_results: replaceOrAppendById(workingDataset.set_results, updated),
        };
      } else if (rawItem.table_name === 'coach_comments' && rawItem.operation === 'insert') {
        if (role !== 'coach') throw new Error('RLS違反: コメント投稿はコーチのみ可能です。');
        const created = await insertCoachCommentOnServer(client, {
          id: rawItem.client_temp_id,
          entry_id: String(payload.entry_id),
          set_result_id:
            typeof payload.set_result_id === 'string' ? payload.set_result_id : null,
          body: String(payload.body ?? ''),
        });
        workingDataset = {
          ...workingDataset,
          coach_comments: replaceOrAppendById(workingDataset.coach_comments, created),
        };
      }

      // Only remove Outbox item AFTER confirmed server acknowledgment
      await removeOutboxItem(rawItem.queue_id);
      syncedCount += 1;
    } catch (err) {
      const parsed = parseSupabaseError(err);

      if (parsed.kind === 'REVISION_CONFLICT') {
        const table = parsed.table ?? rawItem.table_name;
        const targetId = parsed.id ?? resolvedTargetId;
        const serverRecord = await fetchSingleRecordForConflict(client, table, targetId);
        const serverRev =
          parsed.serverRevision ??
          (typeof serverRecord?.revision === 'number' ? serverRecord.revision : null);

        recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
        await updateOutboxItem({
          ...rawItem,
          status: 'conflict',
          conflict_detail: {
            table,
            id: targetId,
            server_revision: serverRev,
            message: '別の端末または別アカウントによって先に更新されたため競合が発生しました。',
            server_record: serverRecord,
          },
          last_error: parsed.message,
        });
        conflictCount += 1;
        continue;
      }

      if (parsed.kind === 'NETWORK') {
        // Restore to pending for next reconnect without losing data
        await updateOutboxItem({
          ...rawItem,
          status: 'pending',
          retry_count: rawItem.retry_count + 1,
          last_error: '通信中断のため保留中',
        });
        break;
      }

      // Non-retryable error (e.g. PT422 ROW_NOT_IN_VERSION, VERSION_CONFLICT, RLS error)
      recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
      await updateOutboxItem({
        ...rawItem,
        status: 'error',
        retry_count: rawItem.retry_count + 1,
        last_error: `${parsed.code ? `[${parsed.code}] ` : ''}${parsed.message}`,
      });
      errorCount += 1;
    }
  }

  if (idMapDirty) {
    await saveIdMap(userId, Object.fromEntries(idMap));
  }

  // Pull latest authorized server dataset and merge any un-synced local pending/conflict items on top
  let serverSnapshot: AppDatasetSnapshot | null = null;
  try {
    serverSnapshot = await fetchAllDatasetFromServer(client, role);
  } catch {
    // Keep workingDataset cached if pull fails transiently
  }

  await runWithCacheSnapshotLock(userId, async () => {
    if (serverSnapshot) {
      const remainingOutbox = await listOutboxForOwner(userId);
      workingDataset = applyOutboxOverlayToDataset(serverSnapshot, remainingOutbox);
    }
    await saveCachedDataset(userId, workingDataset);
  });

  return {
    syncedCount,
    conflictCount,
    errorCount,
    dataset: workingDataset,
  };
}

/**
 * Overlays unsynced local Outbox items onto the latest server snapshot so the UI
 * preserves local edits/creations even before sync completes.
 */
export function applyOutboxOverlayToDataset(
  base: AppDatasetSnapshot,
  outbox: OutboxItem[]
): AppDatasetSnapshot {
  let next: AppDatasetSnapshot = { ...base };

  for (const item of outbox) {
    if (item.table_name === 'practice_days') {
      if (item.operation === 'insert') {
        const tempRow: PracticeDayRow = {
          id: item.client_temp_id,
          athlete_id: item.owner_user_id,
          practice_date: String(item.payload.practice_date ?? ''),
          note: String(item.payload.note ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: item.owner_user_id,
          created_at: item.created_at,
          updated_by: null,
          updated_at: item.updated_at,
        };
        next = { ...next, practice_days: replaceOrAppendById(next.practice_days, tempRow) };
      } else if (item.operation === 'update') {
        next = {
          ...next,
          practice_days: next.practice_days.map((d) =>
            d.id === item.client_temp_id ? { ...d, ...item.payload } : d
          ),
        };
      }
    } else if (item.table_name === 'practice_entries') {
      if (item.operation === 'insert') {
        const tempRow: PracticeEntryRow = {
          id: item.client_temp_id,
          day_id: String(item.payload.day_id ?? ''),
          menu_version_id: String(item.payload.menu_version_id ?? ''),
          sort_order: Number(item.payload.sort_order ?? 1),
          total_time_ms:
            typeof item.payload.total_time_ms === 'number'
              ? item.payload.total_time_ms
              : null,
          rating: typeof item.payload.rating === 'number' ? item.payload.rating : null,
          impression: String(item.payload.impression ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: item.owner_user_id,
          created_at: item.created_at,
          updated_by: null,
          updated_at: item.updated_at,
        };
        next = {
          ...next,
          practice_entries: replaceOrAppendById(next.practice_entries, tempRow),
        };
      } else if (item.operation === 'update') {
        next = {
          ...next,
          practice_entries: next.practice_entries.map((e) =>
            e.id === item.client_temp_id ? { ...e, ...item.payload } : e
          ),
        };
      }
    } else if (item.table_name === 'set_results') {
      if (item.operation === 'insert') {
        const tempRow: SetResultRow = {
          id: item.client_temp_id,
          entry_id: String(item.payload.entry_id ?? ''),
          row_id: String(item.payload.row_id ?? ''),
          time_ms: typeof item.payload.time_ms === 'number' ? item.payload.time_ms : null,
          splits: Array.isArray(item.payload.splits) ? item.payload.splits : [],
          rating: typeof item.payload.rating === 'number' ? item.payload.rating : null,
          impression: String(item.payload.impression ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: item.owner_user_id,
          created_at: item.created_at,
          updated_by: null,
          updated_at: item.updated_at,
        };
        next = {
          ...next,
          set_results: replaceOrAppendById(next.set_results, tempRow),
        };
      } else if (item.operation === 'update') {
        next = {
          ...next,
          set_results: next.set_results.map((s) =>
            s.id === item.client_temp_id ? { ...s, ...item.payload } : s
          ),
        };
      }
    } else if (item.table_name === 'menus') {
      if (item.operation === 'insert') {
        next = {
          ...next,
          menus: replaceOrAppendById(next.menus, {
            id: item.client_temp_id,
            is_shared: Boolean(item.payload.is_shared ?? false),
            is_archived: Boolean(item.payload.is_archived ?? false),
            created_by: item.owner_user_id,
            created_at: item.created_at,
            updated_by: null,
            updated_at: item.updated_at,
          }),
        };
      } else if (item.operation === 'update') {
        next = {
          ...next,
          menus: next.menus.map((m) =>
            m.id === item.client_temp_id ? { ...m, ...item.payload } : m
          ),
        };
      }
    } else if (item.table_name === 'menu_versions') {
      if (item.operation === 'insert' || item.operation === 'revise_menu_version') {
        const menuId = String(item.payload.menu_id ?? '');
        next = {
          ...next,
          menus:
            item.operation === 'revise_menu_version' && typeof item.payload.share_after === 'boolean'
              ? next.menus.map((m) =>
                  m.id === menuId ? { ...m, is_shared: Boolean(item.payload.share_after) } : m
                )
              : next.menus,
          menu_versions: replaceOrAppendById(next.menu_versions, {
            id: item.client_temp_id,
            menu_id: menuId,
            version_no: Number(item.payload.version_no ?? 1),
            title: String(item.payload.title ?? ''),
            content: item.payload.content as MenuContentJson,
            created_by: item.owner_user_id,
            created_at: item.created_at,
          }),
        };
      }
    } else if (item.table_name === 'coach_comments' && item.operation === 'insert') {
      next = {
        ...next,
        coach_comments: replaceOrAppendById(next.coach_comments, {
          id: item.client_temp_id,
          entry_id: String(item.payload.entry_id ?? ''),
          set_result_id:
            typeof item.payload.set_result_id === 'string'
              ? item.payload.set_result_id
              : null,
          body: String(item.payload.body ?? ''),
          created_by: item.owner_user_id,
          created_at: item.created_at,
        }),
      };
    }
  }

  return next;
}

export async function resolveConflictUseServer(item: OutboxItem): Promise<void> {
  await removeOutboxItem(item.queue_id);
}

export async function resolveConflictWithMergedPayload(
  item: OutboxItem,
  mergedPayload: Record<string, unknown>,
  serverRevision: number
): Promise<void> {
  await updateOutboxItem({
    ...item,
    payload: mergedPayload,
    expected_revision: serverRevision,
    status: 'pending',
    conflict_detail: null,
    last_error: null,
  });
}

export async function refreshConflictServerRecord(params: {
  client: SupabaseClient;
  slot: UserRole;
  userId: string;
  role: UserRole;
  item: OutboxItem;
  skipOwnershipCheck?: boolean;
}): Promise<OutboxItem> {
  const { client, slot, userId, role, item, skipOwnershipCheck } = params;
  if (item.owner_user_id !== userId || item.owner_role !== role) {
    throw new Error('アカウント検証に失敗しました。');
  }
  if (!skipOwnershipCheck) {
    const ownership = await verifyClientOwnership(slot, userId, role);
    if (!ownership.ok) {
      throw new Error(ownership.reason || 'アカウント検証に失敗しました。');
    }
  }

  const persistedIdMap = await loadIdMap(userId);
  const table = item.conflict_detail?.table ?? item.table_name;
  const targetId =
    item.conflict_detail?.id ?? persistedIdMap[item.client_temp_id] ?? item.client_temp_id;

  const serverRecord = await fetchSingleRecordForConflict(client, table, targetId);
  if (!serverRecord || typeof serverRecord.revision !== 'number') {
    throw new Error(
      'サーバー最新データの取得に失敗しました。通信状況を確認して再度お試しください（端末の変更は保持されています）。'
    );
  }

  const updated: OutboxItem = {
    ...item,
    conflict_detail: {
      table,
      id: targetId,
      server_revision: serverRecord.revision,
      message:
        item.conflict_detail?.message ??
        '別の端末または別アカウントによって先に更新されたため競合が発生しました。',
      server_record: serverRecord,
    },
  };
  await updateOutboxItem(updated);
  return updated;
}
