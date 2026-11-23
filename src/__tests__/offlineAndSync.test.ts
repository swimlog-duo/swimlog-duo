import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enqueueOutboxItem,
  enqueueOutboxItemRaw,
  exportBackupBundle,
  importBackupBundle,
  listOutboxForOwner,
  loadIdMap,
  resetOfflineDbConnectionForTest,
  updateOutboxItem,
} from '../lib/offlineDb';
import { parseSupabaseError } from '../lib/supabaseRepository';
import { refreshConflictServerRecord, runSyncForAccount } from '../lib/syncEngine';
import type { OutboxItem } from '../types/domain';

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
});
