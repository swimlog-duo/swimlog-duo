import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CoachCommentRow,
  MenuContentJson,
  MenuRowRecord,
  MenuVersionRowRecord,
  PracticeDayRow,
  PracticeEntryRow,
  SetResultRow,
  UserRole,
} from '../types/database';
import type { AppDatasetSnapshot, OutboxItem, SyncTableName } from '../types/domain';
import { createUuid } from '../utils/swimCalculations';
import { verifyClientOwnership } from './authManager';
import {
  acquireOrRefreshSyncLease,
  commitSyncCacheWithLease,
  getBackupRestoreSeq,
  isForeignSyncLeaseActive,
  listOutboxForOwner,
  loadCachedDataset,
  loadIdMap,
  refreshOwnedSyncLease,
  releaseSyncLease,
  removeOutboxItem,
  saveIdMap,
  type SyncLeaseOwnershipGuard,
  updateOutboxItem,
} from './offlineDb';
import { applyOutboxOverlayToDataset, replaceOrAppendById } from './outboxOverlay';
import {
  fetchAllDatasetFromServer,
  fetchExistingRecordById,
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

export { applyOutboxOverlayToDataset };

const CURRENT_EXECUTION_CONTEXT_ID = `ctx_${createUuid()}`;

export function getSyncExecutionContextId(): string {
  return CURRENT_EXECUTION_CONTEXT_ID;
}

export interface SyncRunResult {
  syncedCount: number;
  conflictCount: number;
  errorCount: number;
  skippedReason?: string;
  dataset: AppDatasetSnapshot;
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
  if (item.table_name === 'menus' && item.operation === 'update') {
    blockedMenuStatusIds.add(item.client_temp_id);
  }
}

function stableNormalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      if (val !== undefined) {
        normalized[key] = stableNormalize(val);
      }
    }
    return normalized;
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stableNormalize(a)) === JSON.stringify(stableNormalize(b));
}

function serverMatchesPayloadPatch(
  serverRow: Record<string, unknown>,
  payload: Record<string, unknown>
): boolean {
  for (const [key, val] of Object.entries(payload)) {
    if (val === undefined) continue;
    if (!valuesEqual(serverRow[key], val)) {
      return false;
    }
  }
  return true;
}

export function verifyPersistedInsertMatches(
  item: OutboxItem,
  serverRow: Record<string, unknown>,
  userId: string,
  resolvedPayload: Record<string, unknown>
): boolean {
  if (item.table_name === 'menus') {
    const expectedShared =
      typeof resolvedPayload.is_shared === 'boolean' ? resolvedPayload.is_shared : false;
    const expectedArchived =
      typeof resolvedPayload.is_archived === 'boolean' ? resolvedPayload.is_archived : false;
    return (
      serverRow.created_by === userId &&
      typeof serverRow.is_shared === 'boolean' &&
      serverRow.is_shared === expectedShared &&
      typeof serverRow.is_archived === 'boolean' &&
      serverRow.is_archived === expectedArchived
    );
  }
  if (item.table_name === 'menu_versions') {
    const serverContent = serverRow.content;
    const payloadContent = resolvedPayload.content;
    if (
      !serverContent ||
      typeof serverContent !== 'object' ||
      Array.isArray(serverContent) ||
      !Array.isArray((serverContent as { rows?: unknown }).rows)
    ) {
      return false;
    }
    if (
      !payloadContent ||
      typeof payloadContent !== 'object' ||
      Array.isArray(payloadContent) ||
      !Array.isArray((payloadContent as { rows?: unknown }).rows)
    ) {
      return false;
    }
    const expectedVersionNo = Number(resolvedPayload.version_no ?? 1);
    const expectedTitle = String(resolvedPayload.title ?? '').trim();
    const expectedRows = (payloadContent as { rows: unknown[] }).rows;
    const versionMatches =
      item.operation === 'revise_menu_version'
        ? typeof serverRow.version_no === 'number' &&
          Number.isInteger(serverRow.version_no) &&
          serverRow.version_no >= 1
        : typeof serverRow.version_no === 'number' && serverRow.version_no === expectedVersionNo;
    return (
      serverRow.created_by === userId &&
      String(serverRow.menu_id ?? '') === String(resolvedPayload.menu_id ?? '') &&
      versionMatches &&
      typeof serverRow.title === 'string' &&
      serverRow.title.trim() === expectedTitle &&
      serverRow.title === expectedTitle &&
      valuesEqual(serverContent, { rows: expectedRows })
    );
  }
  if (item.table_name === 'practice_days') {
    return (
      serverRow.athlete_id === userId &&
      serverRow.created_by === userId &&
      String(serverRow.practice_date ?? '') === String(resolvedPayload.practice_date ?? '') &&
      String(serverRow.note ?? '') === String(resolvedPayload.note ?? '') &&
      serverRow.is_deleted === false
    );
  }
  if (item.table_name === 'practice_entries') {
    const expectedTotalTime =
      typeof resolvedPayload.total_time_ms === 'number'
        ? resolvedPayload.total_time_ms
        : null;
    const expectedRating =
      typeof resolvedPayload.rating === 'number' ? resolvedPayload.rating : null;
    return (
      serverRow.created_by === userId &&
      String(serverRow.day_id ?? '') === String(resolvedPayload.day_id ?? '') &&
      String(serverRow.menu_version_id ?? '') ===
        String(resolvedPayload.menu_version_id ?? '') &&
      typeof serverRow.sort_order === 'number' &&
      serverRow.sort_order === Number(resolvedPayload.sort_order ?? 1) &&
      valuesEqual(serverRow.total_time_ms ?? null, expectedTotalTime) &&
      valuesEqual(serverRow.rating ?? null, expectedRating) &&
      String(serverRow.impression ?? '') === String(resolvedPayload.impression ?? '') &&
      serverRow.is_deleted === false
    );
  }
  if (item.table_name === 'set_results') {
    const expectedTimeMs =
      typeof resolvedPayload.time_ms === 'number' ? resolvedPayload.time_ms : null;
    const expectedRating =
      typeof resolvedPayload.rating === 'number' ? resolvedPayload.rating : null;
    const expectedSplits = Array.isArray(resolvedPayload.splits) ? resolvedPayload.splits : [];
    return (
      serverRow.created_by === userId &&
      String(serverRow.entry_id ?? '') === String(resolvedPayload.entry_id ?? '') &&
      String(serverRow.row_id ?? '') === String(resolvedPayload.row_id ?? '') &&
      valuesEqual(serverRow.time_ms ?? null, expectedTimeMs) &&
      Array.isArray(serverRow.splits) &&
      valuesEqual(serverRow.splits, expectedSplits) &&
      valuesEqual(serverRow.rating ?? null, expectedRating) &&
      String(serverRow.impression ?? '') === String(resolvedPayload.impression ?? '') &&
      serverRow.is_deleted === false
    );
  }
  if (item.table_name === 'coach_comments') {
    const expectedSetResultId =
      typeof resolvedPayload.set_result_id === 'string'
        ? resolvedPayload.set_result_id
        : null;
    const expectedBody = String(resolvedPayload.body ?? '').trim();
    return (
      serverRow.created_by === userId &&
      String(serverRow.entry_id ?? '') === String(resolvedPayload.entry_id ?? '') &&
      valuesEqual(serverRow.set_result_id ?? null, expectedSetResultId) &&
      typeof serverRow.body === 'string' &&
      serverRow.body === expectedBody
    );
  }
  return false;
}

function applyConfirmedRowToDataset(
  dataset: AppDatasetSnapshot,
  table: SyncTableName,
  row: Record<string, unknown>
): AppDatasetSnapshot {
  switch (table) {
    case 'menus':
      return {
        ...dataset,
        menus: replaceOrAppendById(dataset.menus, row as unknown as MenuRowRecord),
      };
    case 'menu_versions':
      return {
        ...dataset,
        menu_versions: replaceOrAppendById(
          dataset.menu_versions,
          row as unknown as MenuVersionRowRecord
        ),
      };
    case 'practice_days':
      return {
        ...dataset,
        practice_days: replaceOrAppendById(
          dataset.practice_days,
          row as unknown as PracticeDayRow
        ),
      };
    case 'practice_entries':
      return {
        ...dataset,
        practice_entries: replaceOrAppendById(
          dataset.practice_entries,
          row as unknown as PracticeEntryRow
        ),
      };
    case 'set_results':
      return {
        ...dataset,
        set_results: replaceOrAppendById(dataset.set_results, row as unknown as SetResultRow),
      };
    case 'coach_comments':
      return {
        ...dataset,
        coach_comments: replaceOrAppendById(
          dataset.coach_comments,
          row as unknown as CoachCommentRow
        ),
      };
  }
}

const activeInProcessSyncUsers = new Set<string>();

async function runWithOwnerWebLock<T>(
  userId: string,
  fn: (usedWebLock: boolean) => Promise<T>,
  options?: { bypassInProcessSet?: boolean }
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lockApi =
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
      ? navigator.locks
      : null;
  if (!lockApi) {
    if (!options?.bypassInProcessSet) {
      if (activeInProcessSyncUsers.has(userId)) {
        return { acquired: false };
      }
      activeInProcessSyncUsers.add(userId);
      try {
        const value = await fn(false);
        return { acquired: true, value };
      } finally {
        activeInProcessSyncUsers.delete(userId);
      }
    }
    const value = await fn(false);
    return { acquired: true, value };
  }
  return lockApi.request(
    `swimlog_sync_${userId}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        return { acquired: false as const };
      }
      const value = await fn(true);
      return { acquired: true as const, value };
    }
  );
}

/**
 * Flushes ONLY pending Outbox items whose `owner_user_id` and `owner_role`
 * strictly match the currently verified client session UID & role,
 * recovers stranded `syncing` items after server reconciliation,
 * handles duplicate-key idempotency on response loss,
 * then pulls the latest server snapshot into IndexedDB cache.
 */
export async function runSyncForAccount(params: {
  client: SupabaseClient;
  slot: UserRole;
  userId: string;
  role: UserRole;
  isOnline: boolean;
  skipOwnershipCheck?: boolean;
  executionContextId?: string;
}): Promise<SyncRunResult> {
  const { client, slot, userId, role, isOnline, skipOwnershipCheck } = params;
  const runContextId =
    params.executionContextId ?? `${CURRENT_EXECUTION_CONTEXT_ID}:${createUuid()}`;
  const leaseGuard: SyncLeaseOwnershipGuard = {
    ownerUserId: userId,
    contextId: runContextId,
  };
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

  const hasWebLocks =
    typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

  // Fallback cross-tab guard only when Web Locks API is unavailable
  if (!hasWebLocks && (await isForeignSyncLeaseActive(userId, runContextId))) {
    return {
      syncedCount: 0,
      conflictCount: 0,
      errorCount: 0,
      skippedReason: '別の画面で同期を実行中のため完了を待っています。',
      dataset: cached,
    };
  }

  const lockResult = await runWithOwnerWebLock(
    userId,
    async (usedWebLock): Promise<SyncRunResult> => {
    const leaseAcquired = await acquireOrRefreshSyncLease(userId, runContextId, {
      force: usedWebLock,
    });
    if (!leaseAcquired) {
      return {
        syncedCount: 0,
        conflictCount: 0,
        errorCount: 0,
        skippedReason: '別の画面で同期を実行中のため完了を待っています。',
        dataset: cached,
      };
    }

    try {
      const backupRestoreSeqAtStart = await getBackupRestoreSeq(userId);
      const persistedIdMap = await loadIdMap(userId);
      const idMap = new Map<string, string>(Object.entries(persistedIdMap));
      let idMapDirty = false;
      const recordIdMapping = (tempId: string, serverId: string) => {
        if (serverId !== tempId && idMap.get(tempId) !== serverId) {
          idMap.set(tempId, serverId);
          idMapDirty = true;
        }
      };

      let allItems = await listOutboxForOwner(userId);
      let syncedCount = 0;
      let conflictCount = 0;
      let errorCount = 0;
      let workingDataset = cached;
      let abortedForNetwork = false;
      let abortedForLeaseLoss = false;

      // Step 1: Reconcile any stranded `syncing` items left over from a previous terminated session
      for (const stranded of allItems) {
        if (
          stranded.owner_user_id !== userId ||
          stranded.owner_role !== role ||
          stranded.status !== 'syncing'
        ) {
          continue;
        }

        const leaseOk = await refreshOwnedSyncLease(userId, runContextId);
        if (!leaseOk) {
          abortedForLeaseLoss = true;
          break;
        }

        const strandedContextId = stranded.sync_context_id ?? null;
        const resolvedTargetId =
          idMap.get(stranded.client_temp_id) ?? stranded.client_temp_id;
        const resolvedPayload = remapPayloadIds(stranded.payload, idMap);

        try {
          if (
            stranded.operation === 'insert' ||
            stranded.operation === 'revise_menu_version'
          ) {
            const serverRow = await fetchExistingRecordById(
              client,
              stranded.table_name,
              resolvedTargetId
            );
            if (!(await refreshOwnedSyncLease(userId, runContextId))) {
              abortedForLeaseLoss = true;
              break;
            }

            if (serverRow) {
              if (
                verifyPersistedInsertMatches(stranded, serverRow, userId, resolvedPayload)
              ) {
                let extraMenuRow: MenuRowRecord | null = null;
                // Ensure revise_menu_version share_after completed if needed
                if (
                  stranded.operation === 'revise_menu_version' &&
                  typeof stranded.payload.share_after === 'boolean'
                ) {
                  const desiredShared = stranded.payload.share_after;
                  const menuId = String(resolvedPayload.menu_id ?? '');
                  const menuRow = await fetchExistingRecordById(client, 'menus', menuId);
                  if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                  if (menuRow && !menuRow.is_archived && menuRow.is_shared !== desiredShared) {
                    extraMenuRow = await updateMenuStatusOnServer(client, menuId, {
                      is_shared: desiredShared,
                    });
                    if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                      abortedForLeaseLoss = true;
                      break;
                    }
                  }
                }

                const removed = await removeOutboxItem(stranded.queue_id, {
                  syncLease: leaseGuard,
                  expectedSyncContextId: strandedContextId,
                });
                if (!removed) {
                  abortedForLeaseLoss = true;
                  break;
                }
                const serverId =
                  typeof serverRow.id === 'string' ? serverRow.id : resolvedTargetId;
                recordIdMapping(stranded.client_temp_id, serverId);
                workingDataset = applyConfirmedRowToDataset(
                  workingDataset,
                  stranded.table_name,
                  serverRow
                );
                if (extraMenuRow) {
                  workingDataset = {
                    ...workingDataset,
                    menus: replaceOrAppendById(workingDataset.menus, extraMenuRow),
                  };
                }
                if (idMapDirty) {
                  if (
                    !(await saveIdMap(userId, Object.fromEntries(idMap), {
                      syncLease: leaseGuard,
                    }))
                  ) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                  idMapDirty = false;
                }
                syncedCount += 1;
              } else {
                const updatedErr = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'error',
                    sync_context_id: null,
                    sync_started_at: null,
                    last_error:
                      '前回の同期中断後の確認でサーバー側データと一致しないため停止しました（端末のデータは保持されています）。',
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!updatedErr) {
                  abortedForLeaseLoss = true;
                  break;
                }
                errorCount += 1;
              }
            } else {
              // Safely confirmed NOT present on server -> restore to pending for normal resend
              const restored = await updateOutboxItem(
                {
                  ...stranded,
                  status: 'pending',
                  sync_context_id: null,
                  sync_started_at: null,
                  last_error: '前回の同期中断から安全に再開しました',
                },
                { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
              );
              if (!restored) {
                abortedForLeaseLoss = true;
                break;
              }
            }
          } else if (stranded.operation === 'update') {
            const serverRow = await fetchExistingRecordById(
              client,
              stranded.table_name,
              resolvedTargetId
            );
            if (!(await refreshOwnedSyncLease(userId, runContextId))) {
              abortedForLeaseLoss = true;
              break;
            }
            const hasPendingParentInsert = allItems.some(
              (q) =>
                q.queue_id !== stranded.queue_id &&
                q.table_name === stranded.table_name &&
                q.operation === 'insert' &&
                q.client_temp_id === stranded.client_temp_id
            );

            if (!serverRow) {
              if (hasPendingParentInsert) {
                const restored = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'pending',
                    sync_context_id: null,
                    sync_started_at: null,
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!restored) {
                  abortedForLeaseLoss = true;
                  break;
                }
              } else {
                const errored = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'error',
                    sync_context_id: null,
                    sync_started_at: null,
                    last_error:
                      '更新対象のデータがサーバーに見つからないため再開できません（端末の入力は保持されています）。',
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!errored) {
                  abortedForLeaseLoss = true;
                  break;
                }
                errorCount += 1;
              }
              continue;
            }

            if (stranded.table_name === 'menus') {
              if (serverRow.created_by !== userId) {
                const errored = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'error',
                    sync_context_id: null,
                    sync_started_at: null,
                    last_error: 'アカウント検証に失敗したため再開を停止しました。',
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!errored) {
                  abortedForLeaseLoss = true;
                  break;
                }
                errorCount += 1;
              } else if (
                !hasPendingParentInsert &&
                !allItems.some(
                  (q) =>
                    q.queue_id !== stranded.queue_id &&
                    q.table_name === 'menu_versions' &&
                    String(q.payload.menu_id ?? '') === stranded.client_temp_id &&
                    q.created_at <= stranded.created_at
                ) &&
                serverMatchesPayloadPatch(serverRow, resolvedPayload)
              ) {
                const removed = await removeOutboxItem(stranded.queue_id, {
                  syncLease: leaseGuard,
                  expectedSyncContextId: strandedContextId,
                });
                if (!removed) {
                  abortedForLeaseLoss = true;
                  break;
                }
                workingDataset = applyConfirmedRowToDataset(
                  workingDataset,
                  'menus',
                  serverRow
                );
                syncedCount += 1;
              } else {
                const restored = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'pending',
                    sync_context_id: null,
                    sync_started_at: null,
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!restored) {
                  abortedForLeaseLoss = true;
                  break;
                }
              }
            } else {
              // practice_days / practice_entries / set_results with expected_revision
              const serverRev =
                typeof serverRow.revision === 'number' ? serverRow.revision : null;
              const expectedRev = stranded.expected_revision;
              if (serverRev != null && expectedRev != null) {
                if (serverRev === expectedRev) {
                  // Server did not apply the interrupted update -> safe to revert to pending
                  const restored = await updateOutboxItem(
                    {
                      ...stranded,
                      status: 'pending',
                      sync_context_id: null,
                      sync_started_at: null,
                    },
                    { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                  );
                  if (!restored) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                } else if (
                  serverRev === expectedRev + 1 &&
                  serverRow.updated_by === userId &&
                  serverMatchesPayloadPatch(serverRow, resolvedPayload)
                ) {
                  // Interrupted right after server commit -> treat as already synced
                  const removed = await removeOutboxItem(stranded.queue_id, {
                    syncLease: leaseGuard,
                    expectedSyncContextId: strandedContextId,
                  });
                  if (!removed) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                  workingDataset = applyConfirmedRowToDataset(
                    workingDataset,
                    stranded.table_name,
                    serverRow
                  );
                  syncedCount += 1;
                } else {
                  const conflicted = await updateOutboxItem(
                    {
                      ...stranded,
                      status: 'conflict',
                      sync_context_id: null,
                      sync_started_at: null,
                      conflict_detail: {
                        table: stranded.table_name,
                        id: resolvedTargetId,
                        server_revision: serverRev,
                        message:
                          '別の端末または別アカウントによって先に更新されたため競合が発生しました。',
                        server_record: serverRow,
                      },
                      last_error: 'REVISION_CONFLICT',
                    },
                    { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                  );
                  if (!conflicted) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                  conflictCount += 1;
                }
              } else {
                const errored = await updateOutboxItem(
                  {
                    ...stranded,
                    status: 'error',
                    sync_context_id: null,
                    sync_started_at: null,
                    last_error:
                      'リビジョン情報が確認できないため自動再開を保留しました（端末の入力は保持されています）。',
                  },
                  { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
                );
                if (!errored) {
                  abortedForLeaseLoss = true;
                  break;
                }
                errorCount += 1;
              }
            }
          }
        } catch (reconcileErr) {
          if (!(await refreshOwnedSyncLease(userId, runContextId))) {
            abortedForLeaseLoss = true;
            break;
          }
          const parsed = parseSupabaseError(reconcileErr);
          if (parsed.kind === 'NETWORK') {
            abortedForNetwork = true;
            break;
          }
          const errored = await updateOutboxItem(
            {
              ...stranded,
              status: 'error',
              sync_context_id: null,
              sync_started_at: null,
              last_error: `${parsed.code ? `[${parsed.code}] ` : ''}${parsed.message}`,
            },
            { syncLease: leaseGuard, expectedSyncContextId: strandedContextId }
          );
          if (!errored) {
            abortedForLeaseLoss = true;
            break;
          }
          errorCount += 1;
        }
      }

      if (abortedForLeaseLoss) {
        return {
          syncedCount,
          conflictCount,
          errorCount,
          skippedReason: '同期ロックの維持に失敗したため同期を安全に中断しました。',
          dataset: await loadCachedDataset(userId),
        };
      }

      if (abortedForNetwork) {
        if (idMapDirty) {
          await saveIdMap(userId, Object.fromEntries(idMap), { syncLease: leaseGuard });
        }
        return {
          syncedCount,
          conflictCount,
          errorCount,
          skippedReason: '通信が切断されたため同期を一時中断しました（端末にデータは保持されています）。',
          dataset: workingDataset,
        };
      }

      allItems = await listOutboxForOwner(userId);
      const blockedIds = new Set<string>();
      const blockedMenuStatusIds = new Set<string>();

      // Seed dependency blocks from any errored/conflicted/remaining syncing items
      for (const existing of allItems) {
        if (
          existing.status === 'error' ||
          existing.status === 'conflict' ||
          existing.status === 'syncing'
        ) {
          recordBlockedItem(existing, blockedIds, blockedMenuStatusIds);
        }
      }

      const pendingItems = allItems.filter(
        (item) =>
          item.owner_user_id === userId &&
          item.owner_role === role &&
          item.status === 'pending'
      );

      for (const rawItem of pendingItems) {
        if (rawItem.owner_user_id !== userId || rawItem.owner_role !== role) {
          continue;
        }

        const leaseRefreshed = await refreshOwnedSyncLease(userId, runContextId);
        if (!leaseRefreshed) {
          abortedForLeaseLoss = true;
          break;
        }

        if (isItemBlocked(rawItem, blockedIds, blockedMenuStatusIds)) {
          recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
          const blockedUpdated = await updateOutboxItem(
            {
              ...rawItem,
              status: 'pending',
              last_error: '親レコードの同期完了待ちのため保留中',
            },
            { syncLease: leaseGuard, expectedStatus: 'pending' }
          );
          if (!blockedUpdated) {
            abortedForLeaseLoss = true;
            break;
          }
          continue;
        }

        const markedSyncing = await updateOutboxItem(
          {
            ...rawItem,
            status: 'syncing',
            sync_context_id: runContextId,
            sync_started_at: new Date().toISOString(),
          },
          { syncLease: leaseGuard, expectedStatus: 'pending' }
        );
        if (!markedSyncing) {
          abortedForLeaseLoss = true;
          break;
        }

        const resolvedTargetId = idMap.get(rawItem.client_temp_id) ?? rawItem.client_temp_id;
        const payload = remapPayloadIds(rawItem.payload, idMap);

        try {
          let pendingIdMapping: { tempId: string; serverId: string } | null = null;
          let pendingDatasetUpdate: ((ds: AppDatasetSnapshot) => AppDatasetSnapshot) | null = null;
          if (rawItem.table_name === 'menus' && rawItem.operation === 'insert') {
            if (role !== 'coach') throw new Error('メニュー作成はコーチアカウントのみ操作できます。');
            const created = await insertMenuOnServer(client, {
              id: rawItem.client_temp_id,
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: created.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              menus: replaceOrAppendById(ds.menus, created),
            });
          } else if (rawItem.table_name === 'menus' && rawItem.operation === 'update') {
            if (role !== 'coach') throw new Error('メニュー更新はコーチアカウントのみ操作できます。');
            const updated = await updateMenuStatusOnServer(client, resolvedTargetId, {
              is_shared:
                typeof payload.is_shared === 'boolean' ? payload.is_shared : undefined,
              is_archived:
                typeof payload.is_archived === 'boolean' ? payload.is_archived : undefined,
            });
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              menus: replaceOrAppendById(ds.menus, updated),
            });
          } else if (rawItem.table_name === 'menu_versions' && rawItem.operation === 'insert') {
            if (role !== 'coach') throw new Error('バージョン作成はコーチアカウントのみ操作できます。');
            const created = await insertMenuVersionOnServer(client, {
              id: rawItem.client_temp_id,
              menu_id: String(payload.menu_id),
              version_no: Number(payload.version_no ?? 1),
              title: String(payload.title ?? ''),
              content: payload.content as MenuContentJson,
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: created.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              menu_versions: replaceOrAppendById(ds.menu_versions, created),
            });
          } else if (
            rawItem.table_name === 'menu_versions' &&
            rawItem.operation === 'revise_menu_version'
          ) {
            if (role !== 'coach') throw new Error('メニュー改訂はコーチアカウントのみ操作できます。');
            const res = await reviseMenuVersionOnServer(client, {
              menu_id: String(payload.menu_id),
              version_id: rawItem.client_temp_id,
              title: String(payload.title ?? ''),
              content: payload.content as MenuContentJson,
              share_after: Boolean(payload.share_after),
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                res.version as unknown as Record<string, unknown>,
                userId,
                { ...payload, version_no: res.version.version_no }
              )
            ) {
              throw new Error(
                'サーバー保存後の改訂版データ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: res.version.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              menus: replaceOrAppendById(ds.menus, res.menu),
              menu_versions: replaceOrAppendById(ds.menu_versions, res.version),
            });
          } else if (rawItem.table_name === 'practice_days' && rawItem.operation === 'insert') {
            if (role !== 'athlete') throw new Error('練習日の新規作成は選手アカウントのみ操作できます。');
            const created = await insertPracticeDayOnServer(client, {
              id: rawItem.client_temp_id,
              athlete_id: userId,
              practice_date: String(payload.practice_date),
              note: String(payload.note ?? ''),
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: created.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              practice_days: replaceOrAppendById(ds.practice_days, created),
            });
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
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              practice_days: replaceOrAppendById(ds.practice_days, updated),
            });
          } else if (rawItem.table_name === 'practice_entries' && rawItem.operation === 'insert') {
            if (role !== 'athlete') throw new Error('実施記録の新規作成は選手アカウントのみ操作できます。');
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
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: created.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              practice_entries: replaceOrAppendById(ds.practice_entries, created),
            });
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
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              practice_entries: replaceOrAppendById(ds.practice_entries, updated),
            });
          } else if (rawItem.table_name === 'set_results' && rawItem.operation === 'insert') {
            if (role !== 'athlete') throw new Error('セット結果の新規作成は選手アカウントのみ操作できます。');
            const created = await insertSetResultOnServer(client, {
              id: rawItem.client_temp_id,
              entry_id: String(payload.entry_id),
              row_id: String(payload.row_id),
              time_ms: typeof payload.time_ms === 'number' ? payload.time_ms : null,
              splits: Array.isArray(payload.splits) ? payload.splits : [],
              rating: typeof payload.rating === 'number' ? payload.rating : null,
              impression: String(payload.impression ?? ''),
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingIdMapping = { tempId: rawItem.client_temp_id, serverId: created.id };
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              set_results: replaceOrAppendById(ds.set_results, created),
            });
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
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              set_results: replaceOrAppendById(ds.set_results, updated),
            });
          } else if (rawItem.table_name === 'coach_comments' && rawItem.operation === 'insert') {
            if (role !== 'coach') throw new Error('コメント投稿はコーチアカウントのみ操作できます。');
            const created = await insertCoachCommentOnServer(client, {
              id: rawItem.client_temp_id,
              entry_id: String(payload.entry_id),
              set_result_id:
                typeof payload.set_result_id === 'string' ? payload.set_result_id : null,
              body: String(payload.body ?? ''),
            });
            if (
              !verifyPersistedInsertMatches(
                rawItem,
                created as unknown as Record<string, unknown>,
                userId,
                payload
              )
            ) {
              throw new Error(
                'サーバー保存後のデータ照合が送信内容と一致しないため同期を停止しました（端末のデータは保持されています）。'
              );
            }
            pendingDatasetUpdate = (ds) => ({
              ...ds,
              coach_comments: replaceOrAppendById(ds.coach_comments, created),
            });
          }

          if (!(await refreshOwnedSyncLease(userId, runContextId))) {
            abortedForLeaseLoss = true;
            break;
          }

          const removed = await removeOutboxItem(rawItem.queue_id, {
            syncLease: leaseGuard,
            expectedSyncContextId: runContextId,
          });
          if (!removed) {
            abortedForLeaseLoss = true;
            break;
          }

          if (pendingIdMapping) {
            recordIdMapping(pendingIdMapping.tempId, pendingIdMapping.serverId);
          }
          if (pendingDatasetUpdate) {
            workingDataset = pendingDatasetUpdate(workingDataset);
          }
          if (idMapDirty) {
            const savedMap = await saveIdMap(userId, Object.fromEntries(idMap), {
              syncLease: leaseGuard,
            });
            if (!savedMap) {
              abortedForLeaseLoss = true;
              break;
            }
            idMapDirty = false;
          }
          syncedCount += 1;
        } catch (err) {
          if (!(await refreshOwnedSyncLease(userId, runContextId))) {
            abortedForLeaseLoss = true;
            break;
          }

          let effectiveErr: unknown = err;
          const parsed = parseSupabaseError(err);

          // Idempotent check for duplicate key (`23505`): happens when server committed
          // an earlier insert whose response was dropped before client received it
          if (
            parsed.kind === 'DUPLICATE_KEY' &&
            (rawItem.operation === 'insert' || rawItem.operation === 'revise_menu_version')
          ) {
            try {
              const existingRow = await fetchExistingRecordById(
                client,
                rawItem.table_name,
                resolvedTargetId
              );
              if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                abortedForLeaseLoss = true;
                break;
              }
              if (existingRow) {
                if (verifyPersistedInsertMatches(rawItem, existingRow, userId, payload)) {
                  let extraMenuRow: MenuRowRecord | null = null;
                  if (
                    rawItem.operation === 'revise_menu_version' &&
                    typeof rawItem.payload.share_after === 'boolean'
                  ) {
                    const desiredShared = rawItem.payload.share_after;
                    const menuId = String(payload.menu_id ?? '');
                    const menuRow = await fetchExistingRecordById(client, 'menus', menuId);
                    if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                      abortedForLeaseLoss = true;
                      break;
                    }
                    if (menuRow && !menuRow.is_archived && menuRow.is_shared !== desiredShared) {
                      extraMenuRow = await updateMenuStatusOnServer(client, menuId, {
                        is_shared: desiredShared,
                      });
                      if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                        abortedForLeaseLoss = true;
                        break;
                      }
                    }
                  }

                  const removedDup = await removeOutboxItem(rawItem.queue_id, {
                    syncLease: leaseGuard,
                    expectedSyncContextId: runContextId,
                  });
                  if (!removedDup) {
                    abortedForLeaseLoss = true;
                    break;
                  }
                  const serverId =
                    typeof existingRow.id === 'string' ? existingRow.id : resolvedTargetId;
                  recordIdMapping(rawItem.client_temp_id, serverId);
                  workingDataset = applyConfirmedRowToDataset(
                    workingDataset,
                    rawItem.table_name,
                    existingRow
                  );
                  if (extraMenuRow) {
                    workingDataset = {
                      ...workingDataset,
                      menus: replaceOrAppendById(workingDataset.menus, extraMenuRow),
                    };
                  }
                  if (idMapDirty) {
                    const savedMap = await saveIdMap(userId, Object.fromEntries(idMap), {
                      syncLease: leaseGuard,
                    });
                    if (!savedMap) {
                      abortedForLeaseLoss = true;
                      break;
                    }
                    idMapDirty = false;
                  }
                  syncedCount += 1;
                  continue;
                }
                effectiveErr = new Error(
                  '重複キー検出後のサーバー側データ照合で内容が一致しないため同期を停止しました（端末のデータは保持されています）。'
                );
              }
            } catch {
              if (!(await refreshOwnedSyncLease(userId, runContextId))) {
                abortedForLeaseLoss = true;
                break;
              }
              // Fall through to error handling below if verification lookup fails
            }
          }

          if (parsed.kind === 'REVISION_CONFLICT') {
            const table = parsed.table ?? rawItem.table_name;
            const targetId = parsed.id ?? resolvedTargetId;
            const serverRecord = await fetchSingleRecordForConflict(client, table, targetId);
            if (!(await refreshOwnedSyncLease(userId, runContextId))) {
              abortedForLeaseLoss = true;
              break;
            }
            const serverRev =
              parsed.serverRevision ??
              (typeof serverRecord?.revision === 'number' ? serverRecord.revision : null);

            const conflictUpdated = await updateOutboxItem(
              {
                ...rawItem,
                status: 'conflict',
                sync_context_id: null,
                sync_started_at: null,
                conflict_detail: {
                  table,
                  id: targetId,
                  server_revision: serverRev,
                  message:
                    '別の端末または別アカウントによって先に更新されたため競合が発生しました。',
                  server_record: serverRecord,
                },
                last_error: parsed.message,
              },
              { syncLease: leaseGuard, expectedSyncContextId: runContextId }
            );
            if (!conflictUpdated) {
              abortedForLeaseLoss = true;
              break;
            }
            recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
            conflictCount += 1;
            continue;
          }

          if (parsed.kind === 'NETWORK') {
            // Restore to pending for next reconnect without losing data
            const restored = await updateOutboxItem(
              {
                ...rawItem,
                status: 'pending',
                sync_context_id: null,
                sync_started_at: null,
                retry_count: rawItem.retry_count + 1,
                last_error: '通信中断のため保留中',
              },
              { syncLease: leaseGuard, expectedSyncContextId: runContextId }
            );
            if (!restored) {
              abortedForLeaseLoss = true;
            }
            break;
          }

          const finalErrParsed = parseSupabaseError(effectiveErr);
          const errored = await updateOutboxItem(
            {
              ...rawItem,
              status: 'error',
              sync_context_id: null,
              sync_started_at: null,
              retry_count: rawItem.retry_count + 1,
              last_error: `${finalErrParsed.code ? `[${finalErrParsed.code}] ` : ''}${finalErrParsed.message}`,
            },
            { syncLease: leaseGuard, expectedSyncContextId: runContextId }
          );
          if (!errored) {
            abortedForLeaseLoss = true;
            break;
          }
          recordBlockedItem(rawItem, blockedIds, blockedMenuStatusIds);
          errorCount += 1;
        }
      }

      if (abortedForLeaseLoss || !(await refreshOwnedSyncLease(userId, runContextId))) {
        return {
          syncedCount,
          conflictCount,
          errorCount,
          skippedReason: '同期ロックの維持に失敗したため同期を安全に中断しました。',
          dataset: await loadCachedDataset(userId),
        };
      }

      if (idMapDirty) {
        const savedMap = await saveIdMap(userId, Object.fromEntries(idMap), {
          syncLease: leaseGuard,
        });
        if (!savedMap) {
          return {
            syncedCount,
            conflictCount,
            errorCount,
            skippedReason: '同期ロックの維持に失敗したため同期を安全に中断しました。',
            dataset: await loadCachedDataset(userId),
          };
        }
      }

      let serverSnapshot: AppDatasetSnapshot | null = null;
      try {
        serverSnapshot = await fetchAllDatasetFromServer(client, role);
      } catch {
        // Keep cached dataset if pull fails transiently
      }

      if (!(await refreshOwnedSyncLease(userId, runContextId))) {
        return {
          syncedCount,
          conflictCount,
          errorCount,
          skippedReason: '同期ロックの維持に失敗したため同期を安全に中断しました。',
          dataset: await loadCachedDataset(userId),
        };
      }

      const cacheCommit = await commitSyncCacheWithLease({
        ownerUserId: userId,
        contextId: runContextId,
        serverSnapshot,
        backupRestoreSeqAtStart,
        buildOverlay: applyOutboxOverlayToDataset,
      });
      if (!cacheCommit.saved) {
        const skippedReason =
          cacheCommit.reason === 'stale_cache'
            ? 'より新しいキャッシュが保存されているため古い同期結果での上書きを中止しました。'
            : '同期ロックの維持に失敗したため同期を安全に中断しました。';
        return {
          syncedCount,
          conflictCount,
          errorCount,
          skippedReason,
          dataset: cacheCommit.dataset,
        };
      }

      return {
        syncedCount,
        conflictCount,
        errorCount,
        dataset: cacheCommit.dataset,
      };
    } finally {
      await releaseSyncLease(userId, runContextId);
    }
  },
  { bypassInProcessSet: Boolean(params.executionContextId) }
  );

  if (!lockResult.acquired) {
    return {
      syncedCount: 0,
      conflictCount: 0,
      errorCount: 0,
      skippedReason: '別の画面で同期を実行中のため完了を待っています。',
      dataset: cached,
    };
  }

  return lockResult.value;
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
    sync_context_id: null,
    sync_started_at: null,
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
