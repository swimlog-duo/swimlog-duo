import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  executeBackupImportWithResync,
  shouldResumeSyncAfterBackupImport,
} from '../hooks/useSwimData';
import {
  acquireOrRefreshSyncLease,
  commitSyncCacheWithLease,
  createEmptyDataset,
  enqueueOutboxBatch,
  enqueueOutboxItem,
  enqueueOutboxItemRaw,
  exportBackupBundle,
  getBackupRestoreSeq,
  getSyncLease,
  importBackupBundle,
  listOutboxForOwner,
  loadCachedDataset,
  loadCompetitions,
  loadIdMap,
  loadTemplateMeta,
  previewBackupImport,
  refreshOwnedSyncLease,
  releaseSyncLease,
  removeOutboxItem,
  removeOutboxItemsBatch,
  resetOfflineDbConnectionForTest,
  saveCachedDataset,
  saveCompetitions,
  saveIdMap,
  saveTemplateMeta,
  updateOutboxItem,
} from '../lib/offlineDb';
import { getOutboxDependentItems } from '../lib/outboxOverlay';
import { parseSupabaseError, reviseMenuVersionOnServer } from '../lib/supabaseRepository';
import {
  getSyncExecutionContextId,
  refreshConflictServerRecord,
  runSyncForAccount,
  verifyPersistedInsertMatches,
} from '../lib/syncEngine';
import type { AppDatasetSnapshot, OutboxItem } from '../types/domain';
import {
  formatIsoToJstDate,
  formatIsoToJstDateTime,
  getDaysUntilJst,
  getTodayJst,
  shiftDateDays,
} from '../utils/dateJst';

function makeOutbox(overrides: Partial<OutboxItem>): OutboxItem {
  const now = new Date().toISOString();
  return {
    queue_id: `q_${Math.random().toString(36).slice(2)}`,
    owner_user_id: 'athlete-uid',
    owner_role: 'athlete',
    table_name: 'practice_days',
    client_temp_id: 'day-temp-1',
    operation: 'insert',
    expected_revision: null,
    payload: { practice_date: '2026-11-23', note: 'initial' },
    status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('offlineDb, error parsing & simulated sync engine', () => {
  beforeEach(() => {
    resetOfflineDbConnectionForTest();
  });

  it('isolates Outbox items per owner_user_id and blocks cross-account backup import', async () => {
    await enqueueOutboxItem(
      makeOutbox({ queue_id: 'q_ath', owner_user_id: 'uid-ath', owner_role: 'athlete' })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_coach',
        owner_user_id: 'uid-coach',
        owner_role: 'coach',
        table_name: 'menus',
      })
    );

    const athItems = await listOutboxForOwner('uid-ath');
    const coachItems = await listOutboxForOwner('uid-coach');
    expect(athItems).toHaveLength(1);
    expect(coachItems).toHaveLength(1);

    const bundle = await exportBackupBundle('uid-ath', 'athlete');
    await expect(importBackupBundle(bundle, 'uid-coach', 'coach')).rejects.toThrow();
  });

  it('coalesces offline updates while keeping original expected_revision', async () => {
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_u1',
        owner_user_id: 'uid-u1',
        operation: 'update',
        client_temp_id: 'entry-1',
        table_name: 'practice_entries',
        expected_revision: 3,
        payload: { impression: 'first' },
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_u2',
        owner_user_id: 'uid-u1',
        operation: 'update',
        client_temp_id: 'entry-1',
        table_name: 'practice_entries',
        expected_revision: 3,
        payload: { impression: 'second', rating: 5 },
      })
    );

    const list = await listOutboxForOwner('uid-u1');
    expect(list).toHaveLength(1);
    expect(list[0].expected_revision).toBe(3);
    expect(list[0].payload).toEqual({ impression: 'second', rating: 5 });
  });

  it('parses PT409 REVISION_CONFLICT and PT422 ROW_NOT_IN_VERSION accurately', () => {
    const conflict = parseSupabaseError({
      code: 'PT409',
      message: 'REVISION_CONFLICT',
      details: JSON.stringify({
        table: 'set_results',
        id: '11111111-1111-1111-1111-111111111111',
        server_revision: 7,
      }),
    });
    expect(conflict.kind).toBe('REVISION_CONFLICT');
    expect(conflict.table).toBe('set_results');
    expect(conflict.serverRevision).toBe(7);

    const rowErr = parseSupabaseError({
      code: 'PT422',
      message: 'ROW_NOT_IN_VERSION',
    });
    expect(rowErr.kind).toBe('ROW_NOT_IN_VERSION');
  });

  it('preserves local changes in conflict state on PT409 and sends menu content with { rows } only', async () => {
    const ownerCoach = 'coach-sync-test';
    const capturedVersionInserts: unknown[] = [];

    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_menu_1',
        owner_user_id: ownerCoach,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: 'menu-temp-1',
        operation: 'insert',
        payload: { is_shared: false, is_archived: false },
        created_at: '2026-11-23T00:00:01Z',
      })
    );

    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_ver_1',
        owner_user_id: ownerCoach,
        owner_role: 'coach',
        table_name: 'menu_versions',
        client_temp_id: 'ver-temp-1',
        operation: 'insert',
        payload: {
          menu_id: 'menu-temp-1',
          version_no: 1,
          title: 'Test Menu',
          content: {
            rows: [
              {
                id: 'r1',
                block_type: 'SWIM',
                stroke: 'Fr',
                intensity: 'A1',
                distance_m: 100,
                reps: 2,
                sets: 1,
                circle: '1:40',
                hr: null,
                instruction: '',
                free_text: '',
              },
            ],
            summary: { shouldBeStripped: true },
          },
        },
        created_at: '2026-11-23T00:00:02Z',
      })
    );

    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_conflict_day',
        owner_user_id: ownerCoach,
        owner_role: 'coach',
        table_name: 'practice_days',
        client_temp_id: 'day-server-99',
        operation: 'update',
        expected_revision: 2,
        payload: { note: 'coach offline edit' },
        created_at: '2026-11-23T00:00:03Z',
      })
    );

    // Simulated Supabase client for local test only
    const fakeClient = {
      from: (table: string) => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (table === 'menus') {
                return {
                  data: {
                    id: 'menu-server-uuid', // simulates server assigning UUID
                    is_shared: false,
                    is_archived: false,
                    created_by: ownerCoach,
                    created_at: '2026-11-23T00:00:01Z',
                    updated_by: ownerCoach,
                    updated_at: '2026-11-23T00:00:01Z',
                  },
                  error: null,
                };
              }
              if (table === 'menu_versions') {
                capturedVersionInserts.push(body);
                return {
                  data: {
                    id: 'ver-server-uuid',
                    menu_id: body.menu_id,
                    version_no: 1,
                    title: body.title,
                    content: body.content,
                    created_by: ownerCoach,
                    created_at: '2026-11-23T00:00:02Z',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({
                data: null,
                error: {
                  code: 'PT409',
                  message: 'REVISION_CONFLICT',
                  details: JSON.stringify({
                    table: 'practice_days',
                    id: 'day-server-99',
                    server_revision: 4,
                  }),
                },
              }),
            }),
          }),
        }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: 'day-server-99', revision: 4, note: 'athlete latest note' },
              error: null,
            }),
          }),
          order: () => Promise.resolve({ data: [], error: null }),
          then: undefined,
        }),
      }),
    } as unknown as SupabaseClient;

    const result = await runSyncForAccount({
      client: fakeClient,
      slot: 'coach',
      userId: ownerCoach,
      role: 'coach',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(result.syncedCount).toBe(2);
    expect(result.conflictCount).toBe(1);

    // Parent menu temp ID was remapped to server UUID before inserting menu_versions
    expect((capturedVersionInserts[0] as Record<string, unknown>).menu_id).toBe(
      'menu-server-uuid'
    );
    // Strict `{ rows }` only — no `summary` key sent
    expect(
      Object.keys(
        (capturedVersionInserts[0] as { content: Record<string, unknown> }).content
      )
    ).toEqual(['rows']);

    const remaining = await listOutboxForOwner(ownerCoach);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('conflict');
    expect(remaining[0].conflict_detail?.server_revision).toBe(4);
    expect(remaining[0].payload.note).toBe('coach offline edit');
  });

  it('preserves operation order and final state for offline menu create -> share -> unshare -> sync', async () => {
    const coachUid = 'coach-menu-order';
    const menuId = 'menu-offline-1';
    const verId = 'ver-offline-1';
    const callLog: Array<{ op: string; payload: Record<string, unknown> }> = [];

    // 1. Offline createMenu (initial unshared insert + v1 insert)
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_m_ins',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: menuId,
        operation: 'insert',
        payload: { is_shared: false, is_archived: false },
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_v_ins',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menu_versions',
        client_temp_id: verId,
        operation: 'insert',
        payload: {
          menu_id: menuId,
          version_no: 1,
          title: 'Sprint Set',
          content: {
            rows: [
              {
                id: 'r1',
                block_type: 'SWIM',
                stroke: 'Fr',
                intensity: 'AN1',
                distance_m: 50,
                reps: 4,
                sets: 1,
                circle: '1:00',
                hr: null,
                instruction: '',
                free_text: '',
              },
            ],
          },
        },
      })
    );
    // Optional initial shareNow: true via raw enqueue (as createMenu does)
    await enqueueOutboxItemRaw(
      makeOutbox({
        queue_id: 'q_m_share',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: menuId,
        operation: 'update',
        payload: { is_shared: true },
      })
    );

    // 2. Offline unshare AFTER share
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_m_unshare',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: menuId,
        operation: 'update',
        payload: { is_shared: false },
      })
    );

    const queued = await listOutboxForOwner(coachUid);
    expect(queued.map((q) => `${q.table_name}:${q.operation}`)).toEqual([
      'menus:insert',
      'menu_versions:insert',
      'menus:update',
    ]);
    // Insert stays unshared; trailing update holds final state { is_shared: false }
    expect(queued[0].payload.is_shared).toBe(false);
    expect(queued[2].payload.is_shared).toBe(false);

    const fakeClient = {
      from: (table: string) => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              callLog.push({ op: `${table}:insert`, payload: body });
              return {
                data: {
                  ...body,
                  id: table === 'menus' ? menuId : verId,
                  created_by: coachUid,
                  created_at: '2026-11-23T00:00:00Z',
                  updated_by: coachUid,
                  updated_at: '2026-11-23T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            select: () => ({
              single: async () => {
                callLog.push({ op: `${table}:update`, payload: patch });
                return {
                  data: {
                    id: menuId,
                    is_shared: Boolean(patch.is_shared),
                    is_archived: Boolean(patch.is_archived ?? false),
                    created_by: coachUid,
                    created_at: '2026-11-23T00:00:00Z',
                    updated_by: coachUid,
                    updated_at: '2026-11-23T00:00:05Z',
                  },
                  error: null,
                };
              },
            }),
          }),
        }),
        select: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'coach',
      userId: coachUid,
      role: 'coach',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(res.syncedCount).toBe(3);
    expect(res.errorCount).toBe(0);
    expect(callLog.map((c) => c.op)).toEqual([
      'menus:insert',
      'menu_versions:insert',
      'menus:update',
    ]);
    expect(callLog[0].payload.is_shared).toBe(false);
    expect(callLog[2].payload.is_shared).toBe(false);
    expect(await listOutboxForOwner(coachUid)).toHaveLength(0);
  });

  it('blocks dependent child and grandchild inserts when parent INSERT fails, then succeeds on retry using persisted id_map', async () => {
    const athUid = 'ath-parent-fail';
    const dayTempId = 'day-temp-parent';
    const entryTempId = 'entry-temp-child';
    const setTempId = 'set-temp-grandchild';
    const sentOps: Array<{ table: string; body: Record<string, unknown> }> = [];
    let shouldFailDayInsert = true;

    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_day',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'practice_days',
        client_temp_id: dayTempId,
        operation: 'insert',
        payload: { practice_date: '2026-11-23', note: 'Morning' },
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_entry',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'practice_entries',
        client_temp_id: entryTempId,
        operation: 'insert',
        payload: {
          day_id: dayTempId,
          menu_version_id: 'ver-shared-1',
          sort_order: 1,
          total_time_ms: 60000,
          rating: 4,
          impression: 'good',
        },
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_set',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'set_results',
        client_temp_id: setTempId,
        operation: 'insert',
        payload: {
          entry_id: entryTempId,
          row_id: 'row_1',
          time_ms: 30500,
          splits: [],
          rating: 4,
          impression: 'strong finish',
        },
      })
    );

    const fakeClient = {
      from: (table: string) => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              sentOps.push({ table, body });
              if (table === 'practice_days' && shouldFailDayInsert) {
                return {
                  data: null,
                  error: { code: '42501', message: 'temporary RLS/validation failure' },
                };
              }
              const assignedId =
                table === 'practice_days'
                  ? 'day-server-uuid-1'
                  : table === 'practice_entries'
                  ? 'entry-server-uuid-1'
                  : 'set-server-uuid-1';
              return {
                data: {
                  ...body,
                  id: assignedId,
                  is_deleted: false,
                  revision: 1,
                  expected_revision: null,
                  created_by: athUid,
                  created_at: '2026-11-23T00:00:00Z',
                  updated_by: null,
                  updated_at: '2026-11-23T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
        select: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    // Sync #1: Parent fails -> children MUST NOT be sent
    const run1 = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });
    expect(run1.errorCount).toBe(1);
    expect(run1.syncedCount).toBe(0);
    expect(sentOps).toHaveLength(1);
    expect(sentOps[0].table).toBe('practice_days');

    const afterRun1 = await listOutboxForOwner(athUid);
    expect(afterRun1.map((i) => i.status)).toEqual(['error', 'pending', 'pending']);

    // Retry parent only, first sync parent succeeds & persists id_map, second sync (simulated restart) syncs children
    shouldFailDayInsert = false;
    await updateOutboxItem({ ...afterRun1[0], status: 'pending', last_error: null });

    const run2 = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });
    expect(run2.syncedCount).toBe(3);
    expect(run2.errorCount).toBe(0);

    // Check child & grandchild received server-assigned parent IDs
    const entryInsert = sentOps.find((s) => s.table === 'practice_entries');
    const setInsert = sentOps.find((s) => s.table === 'set_results');
    expect(entryInsert?.body.day_id).toBe('day-server-uuid-1');
    expect(setInsert?.body.entry_id).toBe('entry-server-uuid-1');

    // Check persisted id_map in IndexedDB
    const savedMap = await loadIdMap(athUid);
    expect(savedMap[dayTempId]).toBe('day-server-uuid-1');
    expect(savedMap[entryTempId]).toBe('entry-server-uuid-1');
    expect(await listOutboxForOwner(athUid)).toHaveLength(0);
  });

  it('refetches latest server record on PT409 conflict without losing local payload', async () => {
    const athUid = 'ath-conflict-refetch';
    const item = makeOutbox({
      queue_id: 'q_conf_1',
      owner_user_id: athUid,
      owner_role: 'athlete',
      table_name: 'practice_entries',
      client_temp_id: 'entry-srv-5',
      operation: 'update',
      expected_revision: 2,
      payload: { impression: 'my preserved offline impression' },
      status: 'conflict',
      conflict_detail: {
        table: 'practice_entries',
        id: 'entry-srv-5',
        server_revision: null,
        message: '競合発生',
        server_record: null,
      },
    });
    await enqueueOutboxItem(item);

    const fakeClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: 'entry-srv-5',
                revision: 6,
                impression: 'coach server impression',
                total_time_ms: 92000,
                rating: 4,
              },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const refreshed = await refreshConflictServerRecord({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      item,
      skipOwnershipCheck: true,
    });

    expect(refreshed.conflict_detail?.server_revision).toBe(6);
    expect(refreshed.conflict_detail?.server_record?.impression).toBe('coach server impression');
    expect(refreshed.payload.impression).toBe('my preserved offline impression');
  });

  it('computes JST calendar dates and date shifts accurately across UTC midnight boundaries', () => {
    // 2026-11-25 16:30 UTC == 2026-11-26 01:30 JST
    const utcEvening = new Date('2026-11-25T16:30:00.000Z');
    expect(getTodayJst(utcEvening)).toBe('2026-11-26');
    expect(formatIsoToJstDate('2026-11-25T16:30:00.000Z')).toBe('2026-11-26');
    expect(formatIsoToJstDateTime('2026-11-25T16:30:00.000Z')).toBe('2026-11-26 01:30');
    expect(shiftDateDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(getDaysUntilJst('2026-12-01', '2026-11-26')).toBe(5);
  });

  it('rejects mixed-owner enqueueOutboxBatch atomically without partial writes', async () => {
    const itemA = makeOutbox({
      queue_id: 'q_batch_1',
      owner_user_id: 'owner-a',
      owner_role: 'athlete',
    });
    const itemB = makeOutbox({
      queue_id: 'q_batch_2',
      owner_user_id: 'owner-b',
      owner_role: 'coach',
    });

    await expect(
      enqueueOutboxBatch([{ item: itemA }, { item: itemB }])
    ).rejects.toThrow();

    expect(await listOutboxForOwner('owner-a')).toHaveLength(0);
    expect(await listOutboxForOwner('owner-b')).toHaveLength(0);
  });

  it('skips sync safely when an active foreign tab lease exists', async () => {
    const uid = 'uid-lease-skip';
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_lease_1',
        owner_user_id: uid,
        owner_role: 'athlete',
      })
    );

    const acquired = await acquireOrRefreshSyncLease(uid, 'foreign-tab-ctx');
    expect(acquired).toBe(true);

    const fakeClient = {
      from: () => {
        throw new Error('Must not call Supabase while foreign lease is active');
      },
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(res.skippedReason).toContain('別の画面で同期を実行中');
    expect(await listOutboxForOwner(uid)).toHaveLength(1);

    await releaseSyncLease(uid, 'foreign-tab-ctx');
  });

  it('reconciles stranded syncing items (committed insert, uncommitted insert, and revision conflict update)', async () => {
    const uid = 'ath-stranded-reconcile';
    const committedDayId = 'day-already-committed';
    const uncommittedDayId = 'day-never-committed';
    const conflictDayId = 'day-server-advanced';

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_str_committed',
          owner_user_id: uid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: committedDayId,
          operation: 'insert',
          status: 'syncing',
          sync_context_id: 'dead-tab-1',
          sync_started_at: '2026-11-24T00:00:00Z',
          payload: { practice_date: '2026-11-24', note: 'committed before crash' },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_str_uncommitted',
          owner_user_id: uid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: uncommittedDayId,
          operation: 'insert',
          status: 'syncing',
          sync_context_id: 'dead-tab-1',
          sync_started_at: '2026-11-24T00:00:01Z',
          payload: { practice_date: '2026-11-25', note: 'dropped before server' },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_str_conflict',
          owner_user_id: uid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: conflictDayId,
          operation: 'update',
          expected_revision: 1,
          status: 'syncing',
          sync_context_id: 'dead-tab-1',
          sync_started_at: '2026-11-24T00:00:02Z',
          payload: { note: 'athlete stale edit' },
        }),
      },
    ]);

    const insertedOnRetry: string[] = [];

    const fakeClient = {
      from: (table: string) => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              if (table === 'practice_days' && val === committedDayId) {
                return {
                  data: {
                    id: committedDayId,
                    athlete_id: uid,
                    practice_date: '2026-11-24',
                    note: 'committed before crash',
                    is_deleted: false,
                    revision: 1,
                    expected_revision: null,
                    created_by: uid,
                    created_at: '2026-11-24T00:00:00Z',
                    updated_by: uid,
                    updated_at: '2026-11-24T00:00:00Z',
                  },
                  error: null,
                };
              }
              if (table === 'practice_days' && val === conflictDayId) {
                return {
                  data: {
                    id: conflictDayId,
                    athlete_id: uid,
                    practice_date: '2026-11-22',
                    note: 'coach edited concurrently',
                    is_deleted: false,
                    revision: 3,
                    expected_revision: null,
                    created_by: uid,
                    created_at: '2026-11-22T00:00:00Z',
                    updated_by: 'coach-uid',
                    updated_at: '2026-11-24T00:00:00Z',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              insertedOnRetry.push(String(body.id));
              return {
                data: {
                  ...body,
                  is_deleted: false,
                  revision: 1,
                  expected_revision: null,
                  created_by: uid,
                  created_at: '2026-11-25T00:00:00Z',
                  updated_by: uid,
                  updated_at: '2026-11-25T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    // Committed stranded item reconciled (1) + uncommitted stranded item resent (1) = 2 synced, conflict = 1
    expect(res.syncedCount).toBe(2);
    expect(res.conflictCount).toBe(1);
    expect(insertedOnRetry).toEqual([uncommittedDayId]);

    const remaining = await listOutboxForOwner(uid);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].queue_id).toBe('q_str_conflict');
    expect(remaining[0].status).toBe('conflict');
    expect(remaining[0].conflict_detail?.server_revision).toBe(3);
  });

  it('recovers idempotently from duplicate key 23505 on menus insert and proceeds to menu_versions', async () => {
    const coachUid = 'coach-dup-23505';
    const menuId = 'menu-uuid-dup-1';
    const verId = 'ver-uuid-dup-1';

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_dup_m',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'insert',
          payload: { is_shared: false, is_archived: false },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_dup_v',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: verId,
          operation: 'insert',
          payload: {
            menu_id: menuId,
            version_no: 1,
            title: '23505 Menu',
            content: {
              rows: [
                {
                  id: 'r1',
                  block_type: 'SWIM',
                  stroke: 'Fr',
                  intensity: 'A1',
                  distance_m: 100,
                  reps: 4,
                  sets: 1,
                  circle: '1:30',
                  hr: null,
                  instruction: '',
                  free_text: '',
                },
              ],
            },
          },
        }),
      },
    ]);

    const fakeClient = {
      from: (table: string) => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (table === 'menus') {
                return {
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                };
              }
              return {
                data: {
                  ...body,
                  created_by: coachUid,
                  created_at: '2026-11-25T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              if (table === 'menus' && val === menuId) {
                return {
                  data: {
                    id: menuId,
                    is_shared: false,
                    is_archived: false,
                    created_by: coachUid,
                    created_at: '2026-11-25T00:00:00Z',
                    updated_by: coachUid,
                    updated_at: '2026-11-25T00:00:00Z',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'coach',
      userId: coachUid,
      role: 'coach',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(res.syncedCount).toBe(2);
    expect(res.errorCount).toBe(0);
    expect(await listOutboxForOwner(coachUid)).toHaveLength(0);
  });

  it('finds all dependent outbox items and deletes parent + children atomically', async () => {
    const coachUid = 'coach-dep-discard';
    const menuId = 'menu-dep-1';
    const verId = 'ver-dep-1';

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_dep_m',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'insert',
          payload: { is_shared: false, is_archived: false },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_dep_v',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: verId,
          operation: 'insert',
          payload: { menu_id: menuId, version_no: 1, title: 'Dep', content: { rows: [] } },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_dep_s',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: menuId,
          operation: 'update',
          payload: { is_shared: true },
        }),
        mode: 'raw',
      },
    ]);

    const list = await listOutboxForOwner(coachUid);
    const deps = getOutboxDependentItems(list, 'q_dep_m');
    expect(deps.map((d) => d.queue_id)).toEqual(['q_dep_v', 'q_dep_s']);

    await removeOutboxItemsBatch(['q_dep_m', ...deps.map((d) => d.queue_id)]);
    expect(await listOutboxForOwner(coachUid)).toHaveLength(0);
  });

  it('includes unsynced offline menus in backup export, previews counts, and rolls back atomically on conflict', async () => {
    const coachUid = 'coach-backup-test';
    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_bk_m',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-bk-1',
          operation: 'insert',
          payload: { is_shared: false, is_archived: false },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_bk_v',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: 'ver-bk-1',
          operation: 'insert',
          payload: { menu_id: 'menu-bk-1', version_no: 1, title: 'Offline Menu', content: { rows: [] } },
        }),
      },
    ]);

    const exported = await exportBackupBundle(coachUid, 'coach');
    expect(exported.dataset.menus.some((m) => m.id === 'menu-bk-1')).toBe(true);
    expect(exported.dataset.menu_versions.some((v) => v.title === 'Offline Menu')).toBe(true);
    expect(exported.outbox).toHaveLength(2);

    // Reject malformed structure
    await expect(
      previewBackupImport({ app: 'other-app' }, coachUid, 'coach')
    ).rejects.toThrow();

    // Simulate local change to same queue_id -> preview detects conflict & import rolls back cache_snapshots too
    await updateOutboxItem({
      ...exported.outbox[0],
      payload: { is_shared: true, is_archived: false },
    });

    const previewRes = await previewBackupImport(exported, coachUid, 'coach');
    expect(previewRes.preview.conflictingQueueIds).toEqual(['q_bk_m']);

    // Mutate local cached dataset to confirm failed import leaves cache untouched
    await saveCachedDataset(coachUid, {
      ...exported.dataset,
      profiles: [
        {
          id: coachUid,
          role: 'coach',
          display_name: 'Kept After Abort',
          created_at: '2026-11-25T00:00:00Z',
        },
      ],
    });

    await expect(
      importBackupBundle(exported, coachUid, 'coach')
    ).rejects.toThrow(/異なる内容のキューが重複/);

    const cachedAfterAbort = await loadCachedDataset(coachUid);
    expect(cachedAfterAbort.profiles[0]?.display_name).toBe('Kept After Abort');

    // Reject malformed competitions / template_meta entries without modifying existing state
    await expect(
      previewBackupImport(
        {
          ...exported,
          competitions: [{ id: 'c1', name: 'Bad Comp', event_date: 'invalid-date' }],
        },
        coachUid,
        'coach'
      )
    ).rejects.toThrow(/大会予定データ/);

    await expect(
      previewBackupImport(
        {
          ...exported,
          template_meta: [{ menu_id: 'm1', is_template: 'yes' }],
        },
        coachUid,
        'coach'
      )
    ).rejects.toThrow(/テンプレート情報/);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('[Audit 1] refuses to mark outbox item synced when server row for same ID has different data (23505 & syncing recovery)', async () => {
    const athUid = 'ath-strict-mismatch';
    const dayId1 = 'day-mismatch-23505';
    const dayId2 = 'day-mismatch-syncing';

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_mis_23505',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: dayId1,
          operation: 'insert',
          status: 'pending',
          payload: { practice_date: '2026-11-26', note: 'local note A' },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_mis_syncing',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: dayId2,
          operation: 'insert',
          status: 'syncing',
          sync_context_id: 'crashed-ctx',
          sync_started_at: '2026-11-26T00:00:00Z',
          payload: { practice_date: '2026-11-25', note: 'local note B' },
        }),
      },
    ]);

    const fakeClient = {
      from: (table: string) => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: '23505', message: 'duplicate key value' },
            }),
          }),
        }),
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              if (table === 'practice_days' && val === dayId1) {
                return {
                  data: {
                    id: dayId1,
                    athlete_id: athUid,
                    created_by: athUid,
                    practice_date: '2026-11-26',
                    note: 'DIFFERENT server note',
                    is_deleted: false,
                  },
                  error: null,
                };
              }
              if (table === 'practice_days' && val === dayId2) {
                return {
                  data: {
                    id: dayId2,
                    athlete_id: athUid,
                    created_by: athUid,
                    practice_date: '2026-11-24', // different date!
                    note: 'local note B',
                    is_deleted: false,
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(res.syncedCount).toBe(0);
    expect(res.errorCount).toBe(2);

    const remaining = await listOutboxForOwner(athUid);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((item) => item.status === 'error')).toBe(true);
    expect(remaining.find((i) => i.queue_id === 'q_mis_23505')?.payload.note).toBe(
      'local note A'
    );
    expect(remaining.find((i) => i.queue_id === 'q_mis_syncing')?.payload.note).toBe(
      'local note B'
    );
  });

  it('[Audit 2] enforces strict field-by-field verification across all 6 tables with canonical normalization', () => {
    const coachUid = 'coach-verify-all';
    const athUid = 'ath-verify-all';

    // 1. menus
    const menuItem = makeOutbox({
      owner_user_id: coachUid,
      owner_role: 'coach',
      table_name: 'menus',
      client_temp_id: 'm1',
      payload: { is_shared: false, is_archived: false },
    });
    expect(
      verifyPersistedInsertMatches(
        menuItem,
        { id: 'm1', created_by: coachUid, is_shared: false, is_archived: false, created_at: '2026-11-26T00:00:00Z' },
        coachUid,
        menuItem.payload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        menuItem,
        { id: 'm1', created_by: coachUid, is_shared: true, is_archived: false },
        coachUid,
        menuItem.payload
      )
    ).toBe(false);

    // 2. menu_versions (trimmed title + reordered JSON keys in rows match; version_no or row field mismatch fails)
    const verPayload = {
      menu_id: 'm1',
      version_no: 2,
      title: '  Sprint Set  ',
      content: {
        rows: [
          {
            id: 'r1',
            block_type: 'SWIM',
            stroke: 'Fr',
            intensity: 'AN1',
            distance_m: 50,
            reps: 4,
            sets: 1,
            circle: '1:00',
            hr: null,
            instruction: 'fast',
            free_text: '',
          },
        ],
        ignoredExtraMeta: true,
      },
    };
    const verItem = makeOutbox({
      owner_user_id: coachUid,
      owner_role: 'coach',
      table_name: 'menu_versions',
      client_temp_id: 'v1',
      payload: verPayload,
    });
    expect(
      verifyPersistedInsertMatches(
        verItem,
        {
          id: 'v1',
          menu_id: 'm1',
          version_no: 2,
          title: 'Sprint Set',
          content: {
            rows: [
              {
                free_text: '',
                instruction: 'fast',
                hr: null,
                circle: '1:00',
                sets: 1,
                reps: 4,
                distance_m: 50,
                intensity: 'AN1',
                stroke: 'Fr',
                block_type: 'SWIM',
                id: 'r1',
              },
            ],
          },
          created_by: coachUid,
        },
        coachUid,
        verPayload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        verItem,
        {
          id: 'v1',
          menu_id: 'm1',
          version_no: 1, // mismatched version_no
          title: 'Sprint Set',
          content: { rows: verPayload.content.rows },
          created_by: coachUid,
        },
        coachUid,
        verPayload
      )
    ).toBe(false);
    expect(
      verifyPersistedInsertMatches(
        verItem,
        {
          id: 'v1',
          menu_id: 'm1',
          version_no: 2,
          title: 'Sprint Set',
          content: {
            rows: [{ ...verPayload.content.rows[0], distance_m: 100 }], // mismatched content row
          },
          created_by: coachUid,
        },
        coachUid,
        verPayload
      )
    ).toBe(false);

    // 3. practice_days
    const dayItem = makeOutbox({
      owner_user_id: athUid,
      owner_role: 'athlete',
      table_name: 'practice_days',
      client_temp_id: 'd1',
      payload: { practice_date: '2026-11-26', note: 'Morning session' },
    });
    expect(
      verifyPersistedInsertMatches(
        dayItem,
        {
          id: 'd1',
          athlete_id: athUid,
          created_by: athUid,
          practice_date: '2026-11-26',
          note: 'Morning session',
          is_deleted: false,
        },
        athUid,
        dayItem.payload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        dayItem,
        {
          id: 'd1',
          athlete_id: athUid,
          created_by: athUid,
          practice_date: '2026-11-26',
          note: 'Wrong note',
          is_deleted: false,
        },
        athUid,
        dayItem.payload
      )
    ).toBe(false);

    // 4. practice_entries
    const entryItem = makeOutbox({
      owner_user_id: athUid,
      owner_role: 'athlete',
      table_name: 'practice_entries',
      client_temp_id: 'e1',
      payload: {
        day_id: 'd1',
        menu_version_id: 'v1',
        sort_order: 2,
        total_time_ms: 120000,
        rating: null,
        impression: 'solid',
      },
    });
    expect(
      verifyPersistedInsertMatches(
        entryItem,
        {
          id: 'e1',
          created_by: athUid,
          day_id: 'd1',
          menu_version_id: 'v1',
          sort_order: 2,
          total_time_ms: 120000,
          rating: null,
          impression: 'solid',
          is_deleted: false,
        },
        athUid,
        entryItem.payload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        entryItem,
        {
          id: 'e1',
          created_by: athUid,
          day_id: 'd1',
          menu_version_id: 'v1',
          sort_order: 2,
          total_time_ms: 120500, // mismatched total_time_ms
          rating: null,
          impression: 'solid',
          is_deleted: false,
        },
        athUid,
        entryItem.payload
      )
    ).toBe(false);

    // 5. set_results
    const setItem = makeOutbox({
      owner_user_id: athUid,
      owner_role: 'athlete',
      table_name: 'set_results',
      client_temp_id: 's1',
      payload: {
        entry_id: 'e1',
        row_id: 'r1',
        time_ms: 30450,
        splits: [{ rep: 1, time_ms: 30450 }],
        rating: 5,
        impression: 'great',
      },
    });
    expect(
      verifyPersistedInsertMatches(
        setItem,
        {
          id: 's1',
          created_by: athUid,
          entry_id: 'e1',
          row_id: 'r1',
          time_ms: 30450,
          splits: [{ time_ms: 30450, rep: 1 }],
          rating: 5,
          impression: 'great',
          is_deleted: false,
        },
        athUid,
        setItem.payload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        setItem,
        {
          id: 's1',
          created_by: athUid,
          entry_id: 'e1',
          row_id: 'r1',
          time_ms: 30450,
          splits: [{ rep: 1, time_ms: 31000 }], // mismatched splits
          rating: 5,
          impression: 'great',
          is_deleted: false,
        },
        athUid,
        setItem.payload
      )
    ).toBe(false);

    // 6. coach_comments
    const commentItem = makeOutbox({
      owner_user_id: coachUid,
      owner_role: 'coach',
      table_name: 'coach_comments',
      client_temp_id: 'c1',
      payload: { entry_id: 'e1', set_result_id: 's1', body: '  Nice catch!  ' },
    });
    expect(
      verifyPersistedInsertMatches(
        commentItem,
        {
          id: 'c1',
          created_by: coachUid,
          entry_id: 'e1',
          set_result_id: 's1',
          body: 'Nice catch!',
        },
        coachUid,
        commentItem.payload
      )
    ).toBe(true);
    expect(
      verifyPersistedInsertMatches(
        commentItem,
        {
          id: 'c1',
          created_by: coachUid,
          entry_id: 'e1',
          set_result_id: null, // mismatched set_result_id
          body: 'Nice catch!',
        },
        coachUid,
        commentItem.payload
      )
    ).toBe(false);
  });

  it('[Audit 3] aborts sync immediately and stops sending subsequent items when sync lease refresh fails', async () => {
    const athUid = 'ath-lease-refresh-fail';
    const sentIds: string[] = [];

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_lr_1',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-lr-1',
          operation: 'insert',
          payload: { practice_date: '2026-11-25', note: 'first' },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_lr_2',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-lr-2',
          operation: 'insert',
          payload: { practice_date: '2026-11-26', note: 'second should not send' },
        }),
      },
    ]);

    const fakeClient = {
      from: (table: string) => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              sentIds.push(String(body.id));
              if (table === 'practice_days' && body.id === 'day-lr-1') {
                // Simulate lease expiring and another tab acquiring it before item #2 runs
                await acquireOrRefreshSyncLease(athUid, 'foreign-tab-takeover', { force: true });
              }
              return {
                data: {
                  ...body,
                  is_deleted: false,
                  revision: 1,
                  expected_revision: null,
                  created_by: athUid,
                  created_at: '2026-11-25T00:00:00Z',
                  updated_by: athUid,
                  updated_at: '2026-11-25T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
        select: () => ({
          order: () => {
            throw new Error('Must NOT pull server snapshot after lease loss');
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    expect(res.syncedCount).toBe(0);
    expect(res.skippedReason).toContain('同期ロックの維持に失敗');
    expect(sentIds).toEqual(['day-lr-1']);

    // Because lease was lost mid-flight during day-lr-1, neither q_lr_1 deletion nor q_lr_2 send happens
    const remaining = await listOutboxForOwner(athUid);
    expect(remaining).toHaveLength(2);
    expect(remaining.find((i) => i.queue_id === 'q_lr_1')?.status).toBe('syncing');
    expect(remaining.find((i) => i.queue_id === 'q_lr_2')?.status).toBe('pending');
    const lease = await getSyncLease(athUid);
    expect(lease?.context_id).toBe('foreign-tab-takeover');
    await releaseSyncLease(athUid, 'foreign-tab-takeover');
  });

  it('[Audit 4] operates IndexedDB sync lease safely without Web Locks API and handles expiration/release', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));
    vi.stubGlobal('navigator', {}); // Explicitly remove navigator.locks (Web Locks unavailable)

    const uid = 'uid-no-weblocks';
    const ctx1 = 'tab-context-1';
    const ctx2 = 'tab-context-2';

    expect(await acquireOrRefreshSyncLease(uid, ctx1)).toBe(true);
    const initialLease = await getSyncLease(uid);
    expect(initialLease?.context_id).toBe(ctx1);

    // Foreign context blocked while lease is active
    expect(await acquireOrRefreshSyncLease(uid, ctx2)).toBe(false);

    // Refresh preserves started_at and extends expires_at
    vi.advanceTimersByTime(10_000);
    expect(await acquireOrRefreshSyncLease(uid, ctx1)).toBe(true);
    const refreshedLease = await getSyncLease(uid);
    expect(refreshedLease?.started_at).toBe(initialLease?.started_at);
    expect(Date.parse(refreshedLease!.expires_at)).toBeGreaterThan(
      Date.parse(initialLease!.expires_at)
    );

    // Advance past lease TTL -> ctx2 can take over, and ctx1 cannot delete ctx2's lease
    vi.advanceTimersByTime(65_000);
    expect(await acquireOrRefreshSyncLease(uid, ctx2)).toBe(true);
    await releaseSyncLease(uid, ctx1);
    expect((await getSyncLease(uid))?.context_id).toBe(ctx2);
    await releaseSyncLease(uid, ctx2);
    expect(await getSyncLease(uid)).toBeNull();

    // Concurrent in-process runSyncForAccount without navigator.locks skips duplicate run
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    const slowClient = {
      from: () => ({
        select: () => ({
          order: async () => {
            await firstSyncGate;
            return { data: [], error: null };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const p1 = runSyncForAccount({
      client: slowClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });
    const p2 = runSyncForAccount({
      client: slowClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    const res2 = await p2;
    expect(res2.skippedReason).toContain('別の画面で同期を実行中');

    releaseFirstSync();
    const res1 = await p1;
    expect(res1.skippedReason).toBeUndefined();
    expect(await getSyncLease(uid)).toBeNull();

    // Also verify Web Locks path when navigator.locks IS present
    let webLockRequests = 0;
    vi.stubGlobal('navigator', {
      locks: {
        request: async (
          _name: string,
          _opts: unknown,
          cb: (lock: object | null) => Promise<unknown>
        ) => {
          webLockRequests += 1;
          return cb({ name: _name });
        },
      },
    });
    const withLocksRes = await runSyncForAccount({
      client: {
        from: () => ({
          select: () => ({
            order: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      } as unknown as SupabaseClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });
    expect(webLockRequests).toBe(1);
    expect(withLocksRes.skippedReason).toBeUndefined();
    expect(getSyncExecutionContextId()).toContain('ctx_');
  });

  it('[Audit 5] restores menus.is_shared when reviseMenuVersionOnServer fails mid-way and avoids duplicate versions on retry', async () => {
    const coachUid = 'coach-revise-rollback';
    const menuId = 'menu-shared-rev';
    const versionId = 'ver-rev-2';
    let serverMenuShared = true;
    const serverVersions = [{ id: 'ver-rev-1', menu_id: menuId, version_no: 1 }];
    let failVersionInsertMode: 'fail_with_rollback_ok' | 'fail_with_rollback_fail' | 'none' =
      'fail_with_rollback_ok';
    let failRollbackUpdate = false;

    const fakeClient = {
      from: (table: string) => ({
        select: () => {
          const query = {
            eq: () => query,
            order: () => query,
            limit: async () => ({
              data: serverVersions.slice(-1).map((v) => ({ version_no: v.version_no })),
              error: null,
            }),
            single: async () => ({
              data: {
                id: menuId,
                is_shared: serverMenuShared,
                is_archived: false,
                created_by: coachUid,
                created_at: '2026-11-24T00:00:00Z',
                updated_by: coachUid,
                updated_at: '2026-11-24T00:00:00Z',
              },
              error: null,
            }),
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return query;
        },
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            select: () => ({
              single: async () => {
                if (table === 'menus' && patch.is_shared === true && failRollbackUpdate) {
                  return {
                    data: null,
                    error: { code: '500', message: 'rollback network failure' },
                  };
                }
                if (typeof patch.is_shared === 'boolean') {
                  serverMenuShared = patch.is_shared;
                }
                return {
                  data: {
                    id: menuId,
                    is_shared: serverMenuShared,
                    is_archived: false,
                    created_by: coachUid,
                    created_at: '2026-11-24T00:00:00Z',
                    updated_by: coachUid,
                    updated_at: '2026-11-26T00:00:00Z',
                  },
                  error: null,
                };
              },
            }),
          }),
        }),
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (table === 'menu_versions' && failVersionInsertMode !== 'none') {
                return {
                  data: null,
                  error: { code: 'PT409', message: 'VERSION_CONFLICT' },
                };
              }
              const row = {
                ...body,
                id: String(body.id ?? versionId),
                created_by: coachUid,
                created_at: '2026-11-26T00:00:01Z',
              };
              serverVersions.push({
                id: row.id,
                menu_id: menuId,
                version_no: Number(body.version_no),
              });
              return { data: row, error: null };
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    const validContent = {
      rows: [
        {
          id: 'r1',
          block_type: 'SWIM' as const,
          stroke: 'Fr' as const,
          intensity: 'A1' as const,
          distance_m: 100,
          reps: 4,
          sets: 1,
          circle: '1:30',
          hr: null,
          instruction: '',
          free_text: '',
        },
      ],
    };

    // Case 1: Mid-operation version insert fails -> is_shared MUST be restored to true!
    await expect(
      reviseMenuVersionOnServer(fakeClient, {
        menu_id: menuId,
        version_id: versionId,
        title: 'Revised v2',
        content: validContent,
        share_after: true,
      })
    ).rejects.toThrow(/VERSION_CONFLICT/);
    expect(serverMenuShared).toBe(true);
    expect(serverVersions).toHaveLength(1);

    // Case 2: Rollback itself also fails -> explicit combined error surfaces so outbox preserves retry
    failRollbackUpdate = true;
    await expect(
      reviseMenuVersionOnServer(fakeClient, {
        menu_id: menuId,
        version_id: versionId,
        title: 'Revised v2',
        content: validContent,
        share_after: true,
      })
    ).rejects.toThrow(/自動復旧にも失敗しました/);

    // Case 3: Retry via syncEngine succeeds cleanly without duplicate versions and restores shared=true
    failRollbackUpdate = false;
    failVersionInsertMode = 'none';
    serverMenuShared = true;
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_rev_retry',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menu_versions',
        client_temp_id: versionId,
        operation: 'revise_menu_version',
        payload: {
          menu_id: menuId,
          version_no: 2,
          title: 'Revised v2',
          content: validContent,
          share_after: true,
        },
      })
    );
    const retryRes = await runSyncForAccount({
      client: {
        from: (table: string) => ({
          ...fakeClient.from(table),
          select: () => {
            const inner = fakeClient.from(table).select();
            return {
              ...inner,
              order: () => Promise.resolve({ data: [], error: null }),
            };
          },
        }),
      } as unknown as SupabaseClient,
      slot: 'coach',
      userId: coachUid,
      role: 'coach',
      isOnline: true,
      skipOwnershipCheck: true,
    });
    expect(retryRes.syncedCount).toBe(1);
    expect(retryRes.errorCount).toBe(0);
    expect(serverMenuShared).toBe(true);
    expect(serverVersions.filter((v) => v.id === versionId)).toHaveLength(1);
    expect(await listOutboxForOwner(coachUid)).toHaveLength(0);
  });

  it('[Audit 6] preserves newer synced local cache and unsent outbox items when restoring an older backup', async () => {
    const athUid = 'ath-older-backup-merge';
    const newerCache: AppDatasetSnapshot = {
      ...createEmptyDataset(),
      profiles: [
        {
          id: athUid,
          role: 'athlete',
          display_name: '田中 太郎 (最新)',
          created_at: '2026-11-20T00:00:00Z',
        },
      ],
      menus: [
        {
          id: 'menu-1',
          is_shared: true,
          is_archived: false,
          created_by: 'coach-1',
          created_at: '2026-11-20T00:00:00Z',
          updated_by: 'coach-1',
          updated_at: '2026-11-26T01:00:00Z',
        },
        {
          id: 'menu-2-new',
          is_shared: true,
          is_archived: false,
          created_by: 'coach-1',
          created_at: '2026-11-25T00:00:00Z',
          updated_by: 'coach-1',
          updated_at: '2026-11-25T00:00:00Z',
        },
      ],
      practice_days: [
        {
          id: 'day-1',
          athlete_id: athUid,
          practice_date: '2026-11-21',
          note: 'Server rev 3 newer note',
          is_deleted: false,
          revision: 3,
          expected_revision: null,
          created_by: athUid,
          created_at: '2026-11-21T00:00:00Z',
          updated_by: athUid,
          updated_at: '2026-11-26T00:00:00Z',
        },
        {
          id: 'day-2-newer',
          athlete_id: athUid,
          practice_date: '2026-11-26',
          note: 'Day added after backup',
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: athUid,
          created_at: '2026-11-26T00:00:00Z',
          updated_by: athUid,
          updated_at: '2026-11-26T00:00:00Z',
        },
      ],
      last_synced_at: '2026-11-26T01:00:00Z',
    };
    await saveCachedDataset(athUid, newerCache);

    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_local_unsent',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'practice_days',
        client_temp_id: 'day-unsent-local',
        operation: 'insert',
        payload: { practice_date: '2026-11-26', note: 'local unsent edit' },
      })
    );

    const olderBackup = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-22T00:00:00Z',
      owner_user_id: athUid,
      owner_role: 'athlete' as const,
      dataset: {
        ...createEmptyDataset(),
        profiles: [
          {
            id: athUid,
            role: 'athlete' as const,
            display_name: '田中 太郎 (旧)',
            created_at: '2026-11-20T00:00:00Z',
          },
        ],
        menus: [
          {
            id: 'menu-1',
            is_shared: false,
            is_archived: false,
            created_by: 'coach-1',
            created_at: '2026-11-20T00:00:00Z',
            updated_by: 'coach-1',
            updated_at: '2026-11-21T00:00:00Z',
          },
        ],
        practice_days: [
          {
            id: 'day-1',
            athlete_id: athUid,
            practice_date: '2026-11-21',
            note: 'Old backup rev 1 note',
            is_deleted: false,
            revision: 1,
            expected_revision: null,
            created_by: athUid,
            created_at: '2026-11-21T00:00:00Z',
            updated_by: athUid,
            updated_at: '2026-11-21T00:00:00Z',
          },
          {
            id: 'day-only-in-backup',
            athlete_id: athUid,
            practice_date: '2026-11-19',
            note: 'Recovered historical day',
            is_deleted: false,
            revision: 1,
            expected_revision: null,
            created_by: athUid,
            created_at: '2026-11-19T00:00:00Z',
            updated_by: athUid,
            updated_at: '2026-11-19T00:00:00Z',
          },
        ],
        last_synced_at: '2026-11-22T00:00:00Z',
      },
      outbox: [
        makeOutbox({
          queue_id: 'q_from_backup',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-from-backup-outbox',
          operation: 'insert',
          payload: { practice_date: '2026-11-22', note: 'from backup outbox' },
        }),
      ],
      competitions: [],
      template_meta: [],
    };

    const importRes = await importBackupBundle(olderBackup, athUid, 'athlete');
    expect(importRes.importedOutboxCount).toBe(1);

    const mergedCache = await loadCachedDataset(athUid);
    // Newer server/local records survived and did NOT revert to older backup
    expect(mergedCache.profiles[0]?.display_name).toBe('田中 太郎 (最新)');
    expect(mergedCache.menus.find((m) => m.id === 'menu-1')?.is_shared).toBe(true);
    expect(mergedCache.menus.some((m) => m.id === 'menu-2-new')).toBe(true);
    expect(mergedCache.practice_days.find((d) => d.id === 'day-1')?.revision).toBe(3);
    expect(mergedCache.practice_days.find((d) => d.id === 'day-1')?.note).toBe(
      'Server rev 3 newer note'
    );
    expect(mergedCache.practice_days.some((d) => d.id === 'day-2-newer')).toBe(true);
    // Missing record from backup WAS restored
    expect(mergedCache.practice_days.some((d) => d.id === 'day-only-in-backup')).toBe(true);
    expect(mergedCache.last_synced_at).toBe('2026-11-26T01:00:00Z');

    // Both existing local unsent outbox AND non-conflicting backup outbox are preserved
    const outboxAfter = await listOutboxForOwner(athUid);
    expect(outboxAfter.map((o) => o.queue_id).sort()).toEqual([
      'q_from_backup',
      'q_local_unsent',
    ]);
  });

  it('[Audit 7] performs full atomic rollback across outbox, cache, competitions, and templates when backup restore fails mid-flight', async () => {
    const coachUid = 'coach-atomic-rollback';
    await saveCachedDataset(coachUid, {
      ...createEmptyDataset(),
      profiles: [
        {
          id: coachUid,
          role: 'coach',
          display_name: 'Original Coach',
          created_at: '2026-11-20T00:00:00Z',
        },
      ],
    });
    await saveCompetitions(coachUid, [
      { id: 'comp-orig', name: 'Original Meet', event_date: '2026-12-01', note: '' },
    ]);
    await saveTemplateMeta(coachUid, [{ menu_id: 'm-orig', is_template: true }]);

    // Queue #1 is new (would be written first in loop), Queue #2 has foreign owner (throws mid-transaction)
    const failingBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-26T00:00:00Z',
      owner_user_id: coachUid,
      owner_role: 'coach' as const,
      dataset: {
        ...createEmptyDataset(),
        menus: [
          {
            id: 'menu-should-rollback',
            is_shared: false,
            is_archived: false,
            created_by: coachUid,
            created_at: '2026-11-26T00:00:00Z',
            updated_by: null,
            updated_at: '2026-11-26T00:00:00Z',
          },
        ],
      },
      outbox: [
        makeOutbox({
          queue_id: 'q_should_rollback_1',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-rb-1',
        }),
        makeOutbox({
          queue_id: 'q_triggers_abort_2',
          owner_user_id: 'other-account-uid',
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-rb-2',
        }),
      ],
      competitions: [{ id: 'comp-new', name: 'Should Rollback', event_date: '2026-12-15', note: '' }],
      template_meta: [{ menu_id: 'm-new', is_template: true }],
    };

    await expect(importBackupBundle(failingBundle, coachUid, 'coach')).rejects.toThrow(
      /別アカウントの未送信データ/
    );

    // Nothing partial persisted anywhere
    expect(await listOutboxForOwner(coachUid)).toHaveLength(0);
    const cacheAfter = await loadCachedDataset(coachUid);
    expect(cacheAfter.menus).toHaveLength(0);
    expect(cacheAfter.profiles[0]?.display_name).toBe('Original Coach');
    expect((await loadCompetitions(coachUid)).map((c) => c.id)).toEqual(['comp-orig']);
    expect((await loadTemplateMeta(coachUid)).map((t) => t.menu_id)).toEqual(['m-orig']);
  });

  it('[Audit 8] resumes sync safely after backup restore succeeds when visible, online, same account, and import lock cleared', async () => {
    // Pure guard assertions
    expect(
      shouldResumeSyncAfterBackupImport({
        importSucceeded: true,
        hadPendingResync: false,
        isVisible: true,
        isOnline: true,
        isStillImporting: false,
        targetSlot: 'athlete',
        targetUserId: 'ath-1',
        activeSlot: 'athlete',
        activeUserId: 'ath-1',
      })
    ).toBe(true);
    expect(
      shouldResumeSyncAfterBackupImport({
        importSucceeded: true,
        hadPendingResync: true,
        isVisible: false,
        isOnline: true,
        isStillImporting: false,
        targetSlot: 'athlete',
        targetUserId: 'ath-1',
        activeSlot: 'athlete',
        activeUserId: 'ath-1',
      })
    ).toBe(false);
    expect(
      shouldResumeSyncAfterBackupImport({
        importSucceeded: false,
        hadPendingResync: true,
        isVisible: true,
        isOnline: true,
        isStillImporting: false,
        targetSlot: 'athlete',
        targetUserId: 'ath-1',
        activeSlot: 'athlete',
        activeUserId: 'ath-1',
      })
    ).toBe(true);

    // Integration of executeBackupImportWithResync: ensures sync does NOT run during import and DOES resume after completion
    const events: string[] = [];
    const importingKeys = new Set<string>();
    const pendingResyncKeys = new Set<string>();
    const session = { slot: 'athlete' as const, userId: 'ath-resume', role: 'athlete' as const };

    await executeBackupImportWithResync({
      targetSession: session,
      getActiveSession: () => session,
      syncingKeys: new Set(),
      profileUpdatingKeys: new Set(),
      importingBackupKeys: importingKeys,
      pendingResyncKeys,
      isVisible: () => true,
      isOnline: () => true,
      runImport: async () => {
        expect(importingKeys.has('athlete:ath-resume')).toBe(true);
        // Simulate sync requested while import is active
        pendingResyncKeys.add('athlete:ath-resume');
        events.push('import_done');
        return { importedOutboxCount: 0, skippedDuplicateCount: 0 };
      },
      onImportApplied: async () => {
        events.push('reloaded');
      },
      onResumeSync: async () => {
        expect(importingKeys.has('athlete:ath-resume')).toBe(false);
        events.push('sync_resumed');
      },
    });

    expect(events).toEqual(['import_done', 'reloaded', 'sync_resumed']);
    expect(importingKeys.size).toBe(0);
    expect(pendingResyncKeys.size).toBe(0);
  });

  it('[Audit 9] does NOT apply restored UI state or resume sync to another account if user switches accounts mid-restore', async () => {
    const coachSession = { slot: 'coach' as const, userId: 'coach-A', role: 'coach' as const };
    const athleteSession = {
      slot: 'athlete' as const,
      userId: 'athlete-B',
      role: 'athlete' as const,
    };
    let activeSession: typeof coachSession | typeof athleteSession = coachSession;
    let appliedCalls = 0;
    let resumedSyncCalls = 0;
    const importingKeys = new Set<string>();
    const pendingResyncKeys = new Set<string>(['coach:coach-A']);

    await executeBackupImportWithResync({
      targetSession: coachSession,
      getActiveSession: () => activeSession,
      syncingKeys: new Set(),
      profileUpdatingKeys: new Set(),
      importingBackupKeys: importingKeys,
      pendingResyncKeys,
      isVisible: () => true,
      isOnline: () => true,
      runImport: async (userId, role) => {
        expect(userId).toBe('coach-A');
        expect(role).toBe('coach');
        // Account switches from coach-A to athlete-B while IndexedDB import is running!
        activeSession = athleteSession;
        return { importedOutboxCount: 1, skippedDuplicateCount: 0 };
      },
      onImportApplied: async () => {
        appliedCalls += 1;
      },
      onResumeSync: async () => {
        resumedSyncCalls += 1;
      },
    });

    expect(appliedCalls).toBe(0);
    expect(resumedSyncCalls).toBe(0);
    expect(importingKeys.has('coach:coach-A')).toBe(false);
    expect(pendingResyncKeys.has('coach:coach-A')).toBe(false);
  });

  it('[Safety 1] does not delete or mutate outbox items after sync lease expires mid-sync', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));

    const athUid = 'ath-lease-expired-no-delete';
    await saveCachedDataset(athUid, {
      ...createEmptyDataset(),
      last_synced_at: '2026-11-27T00:00:00.000Z',
    });

    await enqueueOutboxBatch([
      {
        item: makeOutbox({
          queue_id: 'q_exp_1',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-exp-1',
          operation: 'insert',
          payload: { practice_date: '2026-11-27', note: 'must not be deleted after expiry' },
        }),
      },
      {
        item: makeOutbox({
          queue_id: 'q_exp_2',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-exp-2',
          operation: 'insert',
          payload: { practice_date: '2026-11-28', note: 'must not send after expiry' },
        }),
      },
    ]);

    const sentIds: string[] = [];
    const fakeClient = {
      from: () => ({
        insert: (body: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              sentIds.push(String(body.id));
              // Simulate slow network call exceeding 60s lease TTL (no other tab needed)
              vi.advanceTimersByTime(65_000);
              return {
                data: {
                  ...body,
                  is_deleted: false,
                  revision: 1,
                  expected_revision: null,
                  created_by: athUid,
                  created_at: '2026-11-27T00:00:00Z',
                  updated_by: athUid,
                  updated_at: '2026-11-27T00:00:00Z',
                },
                error: null,
              };
            },
          }),
        }),
        select: () => ({
          order: () => {
            throw new Error('Must NOT pull server snapshot after lease expiration');
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'ctx-expire-1',
    });

    expect(res.syncedCount).toBe(0);
    expect(res.skippedReason).toContain('同期ロックの維持に失敗');
    expect(sentIds).toEqual(['day-exp-1']);

    const remaining = await listOutboxForOwner(athUid);
    expect(remaining.map((i) => i.queue_id)).toEqual(['q_exp_1', 'q_exp_2']);
    expect(remaining[0].status).toBe('syncing');
    expect(remaining[1].status).toBe('pending');

    // Direct lease-guarded helpers also refuse writes once lease expired
    expect(await refreshOwnedSyncLease(athUid, 'ctx-expire-1')).toBe(false);
    expect(
      await removeOutboxItem('q_exp_1', {
        syncLease: { ownerUserId: athUid, contextId: 'ctx-expire-1' },
      })
    ).toBe(false);
    expect(
      await removeOutboxItemsBatch(['q_exp_1', 'q_exp_2'], {
        syncLease: { ownerUserId: athUid, contextId: 'ctx-expire-1' },
      })
    ).toBe(false);
    expect(
      await updateOutboxItem(
        { ...remaining[0], status: 'error', last_error: 'stale' },
        { syncLease: { ownerUserId: athUid, contextId: 'ctx-expire-1' } }
      )
    ).toBe(false);
    expect(await listOutboxForOwner(athUid)).toHaveLength(2);
  });

  it('[Safety 2] refuses cache save when lease owner changes during post-sync server pull', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T01:00:00.000Z'));

    const athUid = 'ath-lease-changed-before-cache';
    await saveCachedDataset(athUid, {
      ...createEmptyDataset(),
      practice_days: [
        {
          id: 'day-new-tab2',
          athlete_id: athUid,
          practice_date: '2026-11-27',
          note: 'Kept from new owner',
          is_deleted: false,
          revision: 2,
          expected_revision: null,
          created_by: athUid,
          created_at: '2026-11-27T01:00:00Z',
          updated_by: athUid,
          updated_at: '2026-11-27T01:00:00Z',
        },
      ],
      last_synced_at: '2026-11-27T01:00:00Z',
    });

    const fakeClient = {
      from: (table: string) => ({
        select: () => ({
          order: async () => {
            // Only during one of the pulled tables, simulate TTL expiry + Tab 2 taking lease
            if (table === 'menus') {
              vi.advanceTimersByTime(65_000);
              expect(await acquireOrRefreshSyncLease(athUid, 'ctx-new-owner')).toBe(true);
            }
            if (table === 'practice_days') {
              return {
                data: [
                  {
                    id: 'day-from-stale-old-sync',
                    athlete_id: athUid,
                    practice_date: '2026-11-20',
                    note: 'Stale old sync cache must not overwrite',
                    is_deleted: false,
                    revision: 1,
                    expected_revision: null,
                    created_by: athUid,
                    created_at: '2026-11-20T00:00:00Z',
                    updated_by: athUid,
                    updated_at: '2026-11-20T00:00:00Z',
                  },
                ],
                error: null,
              };
            }
            return { data: [], error: null };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const res = await runSyncForAccount({
      client: fakeClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'ctx-old-owner',
    });

    expect(res.skippedReason).toContain('同期ロックの維持に失敗');

    // Direct saveCachedDataset with stale lease also rejects
    expect(
      await saveCachedDataset(
        athUid,
        {
          ...createEmptyDataset(),
          last_synced_at: '2026-11-27T05:00:00Z',
        },
        { syncLease: { ownerUserId: athUid, contextId: 'ctx-old-owner' } }
      )
    ).toBe(false);

    const cacheAfter = await loadCachedDataset(athUid);
    expect(cacheAfter.practice_days.map((d) => d.id)).toEqual(['day-new-tab2']);
    expect((await getSyncLease(athUid))?.context_id).toBe('ctx-new-owner');
    await releaseSyncLease(athUid, 'ctx-new-owner');
  });

  it('[Safety 3] ensures an old sync run finishing late never releases the new sync run lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T02:00:00.000Z'));

    const uid = 'uid-no-release-foreign-lease';
    let releaseRun1Pull!: () => void;
    const run1PullStarted = new Promise<void>((resolveStarted) => {
      releaseRun1Pull = resolveStarted;
    });
    let resumeRun1!: () => void;
    const run1Gate = new Promise<void>((resolveGate) => {
      resumeRun1 = resolveGate;
    });

    const slowRun1Client = {
      from: (table: string) => ({
        select: () => ({
          order: async () => {
            if (table === 'menus') {
              releaseRun1Pull();
              await run1Gate;
            }
            return { data: [], error: null };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    let releaseRun2!: () => void;
    const run2PullStarted = new Promise<void>((resolve) => {
      releaseRun2 = resolve;
    });
    let resumeRun2!: () => void;
    const run2Gate = new Promise<void>((resolve) => {
      resumeRun2 = resolve;
    });

    const run2Client = {
      from: (table: string) => ({
        select: () => ({
          order: async () => {
            if (table === 'menus') {
              releaseRun2();
              await run2Gate;
            }
            return { data: [], error: null };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    // Remove navigator.locks to ensure two explicit simulated executionContextIds contend on IDB lease
    vi.stubGlobal('navigator', {});

    const run1Promise = runSyncForAccount({
      client: slowRun1Client,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'tab-run-1',
    });

    await run1PullStarted;
    expect((await getSyncLease(uid))?.context_id).toBe('tab-run-1');

    // Expire Run 1's lease and start Run 2
    vi.advanceTimersByTime(65_000);
    const run2Promise = runSyncForAccount({
      client: run2Client,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'tab-run-2',
    });

    await run2PullStarted;
    expect((await getSyncLease(uid))?.context_id).toBe('tab-run-2');

    // Finish Run 1 while Run 2 is active -> Run 1's finally must NOT release tab-run-2's lease
    resumeRun1();
    const res1 = await run1Promise;
    expect(res1.skippedReason).toContain('同期ロックの維持に失敗');
    expect((await getSyncLease(uid))?.context_id).toBe('tab-run-2');

    // Finish Run 2 cleanly
    resumeRun2();
    const res2 = await run2Promise;
    expect(res2.skippedReason).toBeUndefined();
    expect(await getSyncLease(uid)).toBeNull();
  });

  it('[Safety 4] prevents cross-tab contention from reverting cache_snapshots to older last_synced_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T03:00:00.000Z'));

    const uid = 'uid-no-stale-cache-revert';
    vi.stubGlobal('navigator', {});

    // Run 1 pulls an older snapshot (03:00Z), stalls while Run 2 commits newer snapshot (03:05Z)
    let notifyRun1Pull!: () => void;
    const run1InPull = new Promise<void>((r) => {
      notifyRun1Pull = r;
    });
    let resumeRun1!: () => void;
    const run1PullGate = new Promise<void>((r) => {
      resumeRun1 = r;
    });

    const makePullClient = (dayId: string, note: string, syncIso: string, gate?: () => Promise<void>) =>
      ({
        from: (table: string) => ({
          select: () => ({
            order: async () => {
              if (table === 'menus' && gate) {
                notifyRun1Pull();
                await gate();
              }
              if (table === 'practice_days') {
                return {
                  data: [
                    {
                      id: dayId,
                      athlete_id: uid,
                      practice_date: '2026-11-27',
                      note,
                      is_deleted: false,
                      revision: 1,
                      expected_revision: null,
                      created_by: uid,
                      created_at: syncIso,
                      updated_by: uid,
                      updated_at: syncIso,
                    },
                  ],
                  error: null,
                };
              }
              return { data: [], error: null };
            },
          }),
        }),
      }) as unknown as SupabaseClient;

    const run1Promise = runSyncForAccount({
      client: makePullClient('day-stale', 'Older Run 1', '2026-11-27T03:00:00Z', () => run1PullGate),
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'tab-stale-1',
    });
    await run1InPull;

    vi.advanceTimersByTime(65_000);
    // Use fixed system clock for Run 2's fetched_at by ensuring Run 2 commits a strictly newer timestamp
    const run2Res = await runSyncForAccount({
      client: {
        from: (table: string) => ({
          select: () => ({
            order: async () => {
              if (table === 'practice_days') {
                return {
                  data: [
                    {
                      id: 'day-fresh-tab2',
                      athlete_id: uid,
                      practice_date: '2026-11-27',
                      note: 'Newer Run 2',
                      is_deleted: false,
                      revision: 2,
                      expected_revision: null,
                      created_by: uid,
                      created_at: '2026-11-27T03:05:00Z',
                      updated_by: uid,
                      updated_at: '2026-11-27T03:05:00Z',
                    },
                  ],
                  error: null,
                };
              }
              return { data: [], error: null };
            },
          }),
        }),
      } as unknown as SupabaseClient,
      slot: 'athlete',
      userId: uid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
      executionContextId: 'tab-fresh-2',
    });
    expect(run2Res.skippedReason).toBeUndefined();
    expect(run2Res.dataset.practice_days.map((d) => d.id)).toEqual(['day-fresh-tab2']);

    resumeRun1();
    const run1Res = await run1Promise;
    expect(run1Res.skippedReason).toContain('同期ロックの維持に失敗');

    // Also verify direct atomic commitSyncCacheWithLease rejects an older last_synced_at even for current lease owner
    await acquireOrRefreshSyncLease(uid, 'ctx-active-stale-test');
    await saveCachedDataset(uid, {
      ...createEmptyDataset(),
      practice_days: run2Res.dataset.practice_days,
      last_synced_at: '2026-11-27T03:10:00.000Z',
    });
    const staleAttempt = await commitSyncCacheWithLease({
      ownerUserId: uid,
      contextId: 'ctx-active-stale-test',
      serverSnapshot: {
        ...createEmptyDataset(),
        practice_days: [
          {
            id: 'day-older-revert',
            athlete_id: uid,
            practice_date: '2026-11-20',
            note: 'Should never overwrite newer cache',
            is_deleted: false,
            revision: 1,
            expected_revision: null,
            created_by: uid,
            created_at: '2026-11-20T00:00:00Z',
            updated_by: uid,
            updated_at: '2026-11-20T00:00:00Z',
          },
        ],
        last_synced_at: '2026-11-27T03:02:00.000Z',
      },
      backupRestoreSeqAtStart: await getBackupRestoreSeq(uid),
      buildOverlay: (base) => base,
    });
    expect(staleAttempt.saved).toBe(false);
    expect(staleAttempt.reason).toBe('stale_cache');
    await releaseSyncLease(uid, 'ctx-active-stale-test');

    const finalCache = await loadCachedDataset(uid);
    expect(finalCache.practice_days.map((d) => d.id)).toEqual(['day-fresh-tab2']);
  });

  it('[Safety 5] preserves both server snapshot and backup-restored data when importBackupBundle runs concurrently with sync', async () => {
    const athUid = 'ath-concurrent-backup-and-sync';

    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((r) => {
      signalFetchStarted = r;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((r) => {
      releaseFetch = r;
    });

    const syncClient = {
      from: (table: string) => ({
        select: () => {
          if (table === 'profiles') {
            return Promise.resolve({
              data: [
                {
                  id: athUid,
                  role: 'athlete',
                  display_name: 'Server Name',
                  created_at: '2026-11-20T00:00:00Z',
                },
              ],
              error: null,
            });
          }
          return {
            order: async () => {
              if (table === 'menus') {
                signalFetchStarted();
                await fetchGate;
              }
              if (table === 'practice_days') {
                return {
                  data: [
                    {
                      id: 'day-server-live',
                      athlete_id: athUid,
                      practice_date: '2026-11-27',
                      note: 'Fetched live from server',
                      is_deleted: false,
                      revision: 2,
                      expected_revision: null,
                      created_by: athUid,
                      created_at: '2026-11-27T04:00:00Z',
                      updated_by: athUid,
                      updated_at: '2026-11-27T04:00:00Z',
                    },
                  ],
                  error: null,
                };
              }
              return { data: [], error: null };
            },
          };
        },
      }),
    } as unknown as SupabaseClient;

    const syncPromise = runSyncForAccount({
      client: syncClient,
      slot: 'athlete',
      userId: athUid,
      role: 'athlete',
      isOnline: true,
      skipOwnershipCheck: true,
    });

    await fetchStarted;

    // Concurrent backup restore runs while sync pull is in flight
    const concurrentBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T04:10:00Z',
      owner_user_id: athUid,
      owner_role: 'athlete' as const,
      dataset: {
        ...createEmptyDataset(),
        practice_days: [
          {
            id: 'day-restored-from-backup',
            athlete_id: athUid,
            practice_date: '2026-11-18',
            note: 'Restored historical day',
            is_deleted: false,
            revision: 1,
            expected_revision: null,
            created_by: athUid,
            created_at: '2026-11-18T00:00:00Z',
            updated_by: athUid,
            updated_at: '2026-11-18T00:00:00Z',
          },
        ],
        last_synced_at: '2026-11-27T04:10:00Z',
      },
      outbox: [
        makeOutbox({
          queue_id: 'q_bk_concurrent_unsent',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-bk-unsent',
          operation: 'insert',
          payload: { practice_date: '2026-11-26', note: 'Unsent from backup' },
        }),
      ],
      competitions: [{ id: 'comp-bk', name: 'Winter Open', event_date: '2026-12-20', note: '' }],
      template_meta: [],
    };

    const importRes = await importBackupBundle(concurrentBundle, athUid, 'athlete');
    expect(importRes.importedOutboxCount).toBe(1);

    releaseFetch();
    const syncRes = await syncPromise;
    expect(syncRes.skippedReason).toBeUndefined();

    const finalCache = await loadCachedDataset(athUid);
    const dayIds = finalCache.practice_days.map((d) => d.id);
    expect(dayIds).toContain('day-server-live');
    expect(dayIds).toContain('day-restored-from-backup');
    expect(dayIds).toContain('day-bk-unsent');
    expect((await listOutboxForOwner(athUid)).map((o) => o.queue_id)).toEqual([
      'q_bk_concurrent_unsent',
    ]);
    expect((await loadCompetitions(athUid)).map((c) => c.id)).toEqual(['comp-bk']);
  });

  it('[Safety 6] skips duplicate backup outbox item only when BOTH queue_id and content match', async () => {
    const coachUid = 'coach-same-qid-same-content';
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_same_1',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: 'menu-s1',
        operation: 'update',
        payload: { is_shared: true, is_archived: false },
      })
    );

    const bundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T05:00:00Z',
      owner_user_id: coachUid,
      owner_role: 'coach' as const,
      dataset: createEmptyDataset(),
      outbox: [
        makeOutbox({
          queue_id: 'q_same_1',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-s1',
          operation: 'update',
          payload: { is_archived: false, is_shared: true }, // key order differs, content identical
        }),
        makeOutbox({
          queue_id: 'q_new_from_bk',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-new-2',
          operation: 'insert',
          payload: { is_shared: false, is_archived: false },
        }),
      ],
      competitions: [],
      template_meta: [],
    };

    const { preview } = await previewBackupImport(bundle, coachUid, 'coach');
    expect(preview.conflictingQueueIds).toEqual([]);

    const imported = await importBackupBundle(bundle, coachUid, 'coach');
    expect(imported).toEqual({ importedOutboxCount: 1, skippedDuplicateCount: 1 });
    expect((await listOutboxForOwner(coachUid)).map((i) => i.queue_id).sort()).toEqual([
      'q_new_from_bk',
      'q_same_1',
    ]);
  });

  it('[Safety 7] aborts restore when same queue_id has different content and keeps existing state untouched', async () => {
    const athUid = 'ath-same-qid-diff-content';
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_conflict_same_qid',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'practice_days',
        client_temp_id: 'day-c1',
        operation: 'update',
        expected_revision: 3,
        payload: { note: 'terminal edited note' },
      })
    );

    const bundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T05:00:00Z',
      owner_user_id: athUid,
      owner_role: 'athlete' as const,
      dataset: createEmptyDataset(),
      outbox: [
        makeOutbox({
          queue_id: 'q_conflict_same_qid',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-c1',
          operation: 'update',
          expected_revision: 3,
          payload: { note: 'different backup note' },
        }),
      ],
      competitions: [{ id: 'comp-abort', name: 'Should Abort', event_date: '2026-12-20', note: '' }],
      template_meta: [],
    };

    const { preview } = await previewBackupImport(bundle, athUid, 'athlete');
    expect(preview.conflictingQueueIds).toEqual(['q_conflict_same_qid']);

    await expect(importBackupBundle(bundle, athUid, 'athlete')).rejects.toThrow(
      /異なる内容のキューが重複/
    );
    const outbox = await listOutboxForOwner(athUid);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toEqual({ note: 'terminal edited note' });
    expect(await loadCompetitions(athUid)).toHaveLength(0);
  });

  it('[Safety 8] never silently skips when different queue_id collides on same target & operation with different content', async () => {
    const coachUid = 'coach-diff-qid-same-target-op';
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_local_update_1',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: 'menu-target-99',
        operation: 'update',
        payload: { is_shared: true },
      })
    );

    const collidingBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T06:00:00Z',
      owner_user_id: coachUid,
      owner_role: 'coach' as const,
      dataset: {
        ...createEmptyDataset(),
        menus: [
          {
            id: 'menu-should-not-partial-save',
            is_shared: false,
            is_archived: false,
            created_by: coachUid,
            created_at: '2026-11-27T06:00:00Z',
            updated_by: coachUid,
            updated_at: '2026-11-27T06:00:00Z',
          },
        ],
      },
      outbox: [
        makeOutbox({
          queue_id: 'q_backup_diff_qid',
          owner_user_id: coachUid,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'menu-target-99',
          operation: 'update',
          payload: { is_shared: false }, // Different content, different queue_id, same target+op!
        }),
      ],
      competitions: [],
      template_meta: [{ menu_id: 'menu-should-not-partial-save', is_template: true }],
    };

    const { preview } = await previewBackupImport(collidingBundle, coachUid, 'coach');
    expect(preview.conflictingQueueIds).toEqual(['q_backup_diff_qid']);

    await expect(importBackupBundle(collidingBundle, coachUid, 'coach')).rejects.toThrow(
      /異なるキューIDで同一対象に対する異なる内容の未送信データが競合/
    );

    const outboxAfter = await listOutboxForOwner(coachUid);
    expect(outboxAfter).toHaveLength(1);
    expect(outboxAfter[0].queue_id).toBe('q_local_update_1');
    expect(outboxAfter[0].payload).toEqual({ is_shared: true });
    expect((await loadCachedDataset(coachUid)).menus).toHaveLength(0);
    expect(await loadTemplateMeta(coachUid)).toHaveLength(0);

    // Also confirm a standalone backup chain with revise_menu_version restores cleanly on clean terminal
    const chainUser = 'coach-revise-chain-restore';
    const chainBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T06:10:00Z',
      owner_user_id: chainUser,
      owner_role: 'coach' as const,
      dataset: createEmptyDataset(),
      outbox: [
        makeOutbox({
          queue_id: 'q_ch_1',
          owner_user_id: chainUser,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'm-ch-1',
          operation: 'update',
          payload: { is_shared: true },
          created_at: '2026-11-27T06:01:00Z',
        }),
        makeOutbox({
          queue_id: 'q_ch_2',
          owner_user_id: chainUser,
          owner_role: 'coach',
          table_name: 'menu_versions',
          client_temp_id: 'v-ch-2',
          operation: 'revise_menu_version',
          payload: { menu_id: 'm-ch-1', version_no: 2, title: 'v2', content: { rows: [] } },
          created_at: '2026-11-27T06:02:00Z',
        }),
        makeOutbox({
          queue_id: 'q_ch_3',
          owner_user_id: chainUser,
          owner_role: 'coach',
          table_name: 'menus',
          client_temp_id: 'm-ch-1',
          operation: 'update',
          payload: { is_archived: true },
          created_at: '2026-11-27T06:03:00Z',
        }),
      ],
      competitions: [],
      template_meta: [],
    };
    const chainRes = await importBackupBundle(chainBundle, chainUser, 'coach');
    expect(chainRes).toEqual({ importedOutboxCount: 3, skippedDuplicateCount: 0 });
  });

  it('[Safety 9] rejects backups belonging to another account or another role without modifying IndexedDB', async () => {
    const coachUid = 'coach-account-isolation';
    await saveCachedDataset(coachUid, {
      ...createEmptyDataset(),
      profiles: [
        {
          id: coachUid,
          role: 'coach',
          display_name: 'Kept Coach',
          created_at: '2026-11-20T00:00:00Z',
        },
      ],
    });
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_iso_keep',
        owner_user_id: coachUid,
        owner_role: 'coach',
        table_name: 'menus',
        client_temp_id: 'm-keep',
      })
    );

    const wrongRoleBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T07:00:00Z',
      owner_user_id: coachUid,
      owner_role: 'athlete' as const,
      dataset: createEmptyDataset(),
      outbox: [],
      competitions: [{ id: 'comp-bad', name: 'Bad', event_date: '2026-12-20', note: '' }],
      template_meta: [],
    };
    const wrongAccountBundle = {
      ...wrongRoleBundle,
      owner_user_id: 'other-coach-uid',
      owner_role: 'coach' as const,
    };

    await expect(importBackupBundle(wrongRoleBundle, coachUid, 'coach')).rejects.toThrow(
      /別アカウントのバックアップファイルは現在のアカウントへ復元できません/
    );
    await expect(importBackupBundle(wrongAccountBundle, coachUid, 'coach')).rejects.toThrow(
      /別アカウントのバックアップファイルは現在のアカウントへ復元できません/
    );

    expect((await loadCachedDataset(coachUid)).profiles[0]?.display_name).toBe('Kept Coach');
    expect((await listOutboxForOwner(coachUid)).map((i) => i.queue_id)).toEqual(['q_iso_keep']);
    expect(await loadCompetitions(coachUid)).toHaveLength(0);
  });

  it('[Safety 10] leaves cache_snapshots, outbox_queue, and local_meta untouched on mid-restore failure', async () => {
    const athUid = 'ath-full-rollback-stores';
    await saveCachedDataset(athUid, {
      ...createEmptyDataset(),
      profiles: [
        {
          id: athUid,
          role: 'athlete',
          display_name: 'Original Athlete',
          created_at: '2026-11-20T00:00:00Z',
        },
      ],
    });
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q_existing_keep',
        owner_user_id: athUid,
        owner_role: 'athlete',
        table_name: 'practice_days',
        client_temp_id: 'day-rb-target',
        operation: 'update',
        expected_revision: 1,
        payload: { note: 'existing note' },
      })
    );
    await saveCompetitions(athUid, [
      { id: 'comp-keep', name: 'Existing Meet', event_date: '2026-12-01', note: '' },
    ]);
    await saveTemplateMeta(athUid, [{ menu_id: 'tpl-keep', is_template: true }]);
    await saveIdMap(athUid, { 'temp-1': 'srv-1' });
    const seqBefore = await getBackupRestoreSeq(athUid);

    const midFailBundle = {
      app: 'swimlog-duo' as const,
      version: 1 as const,
      exported_at: '2026-11-27T08:00:00Z',
      owner_user_id: athUid,
      owner_role: 'athlete' as const,
      dataset: {
        ...createEmptyDataset(),
        practice_days: [
          {
            id: 'day-new-should-rollback',
            athlete_id: athUid,
            practice_date: '2026-11-27',
            note: 'Should rollback',
            is_deleted: false,
            revision: 1,
            expected_revision: null,
            created_by: athUid,
            created_at: '2026-11-27T08:00:00Z',
            updated_by: athUid,
            updated_at: '2026-11-27T08:00:00Z',
          },
        ],
      },
      outbox: [
        // Item #1 gets put first in transaction before Item #2 aborts
        makeOutbox({
          queue_id: 'q_put_then_rollback',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-other-1',
          operation: 'insert',
          payload: { practice_date: '2026-11-27', note: 'partial insert' },
        }),
        // Item #2 triggers different-queue_id target/op conflict mid-transaction
        makeOutbox({
          queue_id: 'q_triggers_conflict_2',
          owner_user_id: athUid,
          owner_role: 'athlete',
          table_name: 'practice_days',
          client_temp_id: 'day-rb-target',
          operation: 'update',
          expected_revision: 1,
          payload: { note: 'conflicting note' },
        }),
      ],
      competitions: [{ id: 'comp-new', name: 'New Meet', event_date: '2026-12-30', note: '' }],
      template_meta: [{ menu_id: 'tpl-new', is_template: true }],
    };

    await expect(importBackupBundle(midFailBundle, athUid, 'athlete')).rejects.toThrow();

    expect((await listOutboxForOwner(athUid)).map((i) => i.queue_id)).toEqual(['q_existing_keep']);
    const cacheAfter = await loadCachedDataset(athUid);
    expect(cacheAfter.profiles[0]?.display_name).toBe('Original Athlete');
    expect(cacheAfter.practice_days).toHaveLength(0);
    expect((await loadCompetitions(athUid)).map((c) => c.id)).toEqual(['comp-keep']);
    expect((await loadTemplateMeta(athUid)).map((t) => t.menu_id)).toEqual(['tpl-keep']);
    expect(await loadIdMap(athUid)).toEqual({ 'temp-1': 'srv-1' });
    expect(await getBackupRestoreSeq(athUid)).toBe(seqBefore);
  });
});
