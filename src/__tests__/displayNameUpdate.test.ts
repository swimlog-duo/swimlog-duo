import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enqueueOutboxItem,
  getOfflineDb,
  listOutboxForOwner,
  loadCachedDataset,
  patchOwnProfileDisplayNameInCache,
  resetOfflineDbConnectionForTest,
  saveCachedDataset,
} from '../lib/offlineDb';
import { executeDisplayNameUpdate } from '../lib/profileService';
import type { AppDatasetSnapshot, OutboxItem } from '../types/domain';
import {
  isDisplayNameEmpty,
  normalizeDisplayName,
  validateDisplayNameInput,
} from '../utils/displayName';

function makeSnapshot(overrides: Partial<AppDatasetSnapshot> = {}): AppDatasetSnapshot {
  return {
    profiles: [
      {
        id: 'ath-uid-1',
        role: 'athlete',
        display_name: '',
        created_at: '2026-11-20T00:00:00Z',
      },
      {
        id: 'coach-uid-1',
        role: 'coach',
        display_name: '佐藤 コーチ',
        created_at: '2026-11-19T00:00:00Z',
      },
    ],
    menus: [],
    menu_versions: [],
    menu_status_history: [],
    practice_days: [],
    practice_entries: [],
    set_results: [],
    record_history: [],
    coach_comments: [],
    last_synced_at: '2026-11-24T00:00:00Z',
    ...overrides,
  };
}

function makeOutbox(overrides: Partial<OutboxItem> = {}): OutboxItem {
  const now = new Date().toISOString();
  return {
    queue_id: `q_${Math.random().toString(36).slice(2)}`,
    owner_user_id: 'ath-uid-1',
    owner_role: 'athlete',
    table_name: 'practice_days',
    client_temp_id: 'day-temp-1',
    operation: 'insert',
    expected_revision: null,
    payload: { practice_date: '2026-11-24', note: '朝練' },
    status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('display name validation & concurrent cache-safe update workflow', () => {
  beforeEach(async () => {
    resetOfflineDbConnectionForTest();
    const db = await getOfflineDb();
    await Promise.all([
      db.clear('cache_snapshots'),
      db.clear('outbox_queue'),
      db.clear('drafts'),
      db.clear('local_meta'),
    ]);
    const store = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    };
  });

  it('validates and trims half-width and full-width spaces while rejecting control chars and over-50 chars', () => {
    expect(normalizeDisplayName(' \u3000田中 太郎\u3000 ')).toBe('田中 太郎');
    expect(isDisplayNameEmpty('')).toBe(true);
    expect(isDisplayNameEmpty('  \u3000  ')).toBe(true);
    expect(isDisplayNameEmpty('佐藤')).toBe(false);

    expect(validateDisplayNameInput(' \u3000田中 太郎\u3000 ')).toEqual({
      valid: true,
      normalized: '田中 太郎',
    });
    expect(validateDisplayNameInput('\u3000  \u3000').valid).toBe(false);
    expect(validateDisplayNameInput('田中\n太郎').valid).toBe(false);
    expect(validateDisplayNameInput('田中\r太郎').valid).toBe(false);
    expect(validateDisplayNameInput('田中\t太郎').valid).toBe(false);

    const fifty = 'あ'.repeat(50);
    const fiftyOne = 'あ'.repeat(51);
    expect(validateDisplayNameInput(fifty)).toEqual({ valid: true, normalized: fifty });
    expect(validateDisplayNameInput(fiftyOne).valid).toBe(false);
  });

  it('preserves practice logs & outbox items added while update_my_display_name RPC is in flight', async () => {
    await saveCachedDataset('ath-uid-1', makeSnapshot());

    let resolveRpc!: (val: { data: string; error: null }) => void;
    const rpcPromise = new Promise<{ data: string; error: null }>((resolve) => {
      resolveRpc = resolve;
    });

    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const fromCalls: string[] = [];
    const fakeClient = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return rpcPromise;
      },
      from: (table: string) => {
        fromCalls.push(table);
        throw new Error('Unexpected table query during display name RPC');
      },
    } as unknown as SupabaseClient;

    const updateSessionSpy = vi.fn();
    const updatePromise = executeDisplayNameUpdate({
      slot: 'athlete',
      userId: 'ath-uid-1',
      role: 'athlete',
      client: fakeClient,
      rawDisplayName: '\u3000田中 太郎 ',
      isOnline: true,
      skipOwnershipCheck: true,
      updateSessionDisplayName: updateSessionSpy,
    });

    // Wait a microtask until RPC is invoked
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1));
    expect(rpcCalls[0]).toEqual({
      fn: 'update_my_display_name',
      args: { new_display_name: '田中 太郎' },
    });

    // Simulate athlete saving a practice log + multiple outbox items while RPC is still pending
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q-day-during-rpc',
        client_temp_id: 'day-during-rpc',
        table_name: 'practice_days',
        payload: { practice_date: '2026-11-24', note: 'RPC中に入力した朝練' },
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q-entry-during-rpc',
        client_temp_id: 'entry-during-rpc',
        table_name: 'practice_entries',
        payload: {
          day_id: 'day-during-rpc',
          menu_version_id: 'ver-1',
          sort_order: 1,
          total_time_ms: 45000,
          rating: 5,
          impression: '絶好調',
        },
      })
    );

    resolveRpc({ data: '田中 太郎', error: null });
    const res = await updatePromise;

    expect(res.savedName).toBe('田中 太郎');
    expect(fromCalls).toEqual([]); // Must NOT re-fetch all 9 tables
    expect(updateSessionSpy).toHaveBeenCalledWith('athlete', 'ath-uid-1', 'athlete', '田中 太郎');

    const outboxAfter = await listOutboxForOwner('ath-uid-1');
    expect(outboxAfter.map((o) => o.queue_id)).toEqual(['q-day-during-rpc', 'q-entry-during-rpc']);
    expect(res.overlayDataset.practice_days.some((d) => d.id === 'day-during-rpc')).toBe(true);
    expect(res.overlayDataset.practice_entries.some((e) => e.id === 'entry-during-rpc')).toBe(true);

    const savedCache = await loadCachedDataset('ath-uid-1');
    expect(savedCache.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('田中 太郎');
  });

  it('re-reads latest cache_snapshots after RPC so concurrent updates to other tables are never overwritten by preCache', async () => {
    await saveCachedDataset('ath-uid-1', makeSnapshot());

    let resolveRpc!: (val: { data: string; error: null }) => void;
    const fakeClient = {
      rpc: () =>
        new Promise<{ data: string; error: null }>((resolve) => {
          resolveRpc = resolve;
        }),
    } as unknown as SupabaseClient;

    const updatePromise = executeDisplayNameUpdate({
      slot: 'athlete',
      userId: 'ath-uid-1',
      role: 'athlete',
      client: fakeClient,
      rawDisplayName: '新表示名',
      isOnline: true,
      skipOwnershipCheck: true,
      updateSessionDisplayName: vi.fn(),
    });

    await vi.waitFor(() => expect(typeof resolveRpc).toBe('function'));

    // Another cache write lands while RPC is in flight
    await saveCachedDataset(
      'ath-uid-1',
      makeSnapshot({
        menus: [
          {
            id: 'menu-latest-1',
            is_shared: true,
            is_archived: false,
            created_by: 'coach-uid-1',
            created_at: '2026-11-24T05:00:00Z',
            updated_by: 'coach-uid-1',
            updated_at: '2026-11-24T05:00:00Z',
          },
        ],
        coach_comments: [
          {
            id: 'comment-latest-1',
            entry_id: 'entry-1',
            set_result_id: null,
            body: '最新のコーチコメント',
            created_by: 'coach-uid-1',
            created_at: '2026-11-24T06:00:00Z',
          },
        ],
        last_synced_at: '2026-11-24T06:05:00Z',
      })
    );

    resolveRpc({ data: '新表示名', error: null });
    await updatePromise;

    const finalCache = await loadCachedDataset('ath-uid-1');
    // Latest menus, comments, last_synced_at, other profile, and own created_at are all preserved
    expect(finalCache.menus.map((m) => m.id)).toEqual(['menu-latest-1']);
    expect(finalCache.coach_comments.map((c) => c.id)).toEqual(['comment-latest-1']);
    expect(finalCache.last_synced_at).toBe('2026-11-24T06:05:00Z');
    expect(finalCache.profiles.find((p) => p.id === 'coach-uid-1')?.display_name).toBe('佐藤 コーチ');
    expect(finalCache.profiles.find((p) => p.id === 'ath-uid-1')).toEqual({
      id: 'ath-uid-1',
      role: 'athlete',
      display_name: '新表示名',
      created_at: '2026-11-20T00:00:00Z',
    });
  });

  it('preserves existing cache/outbox and attempts session refresh when post-RPC cache patch fails', async () => {
    await saveCachedDataset('ath-uid-1', makeSnapshot());
    await enqueueOutboxItem(makeOutbox({ queue_id: 'q-keep-me' }));

    let resolveRpc!: (val: { data: string; error: null }) => void;
    const fakeClient = {
      rpc: () =>
        new Promise<{ data: string; error: null }>((resolve) => {
          resolveRpc = resolve;
        }),
    } as unknown as SupabaseClient;

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const updatePromise = executeDisplayNameUpdate({
      slot: 'athlete',
      userId: 'ath-uid-1',
      role: 'athlete',
      client: fakeClient,
      rawDisplayName: '田中 太郎',
      isOnline: true,
      skipOwnershipCheck: true,
      updateSessionDisplayName: vi.fn(),
      refreshSessionOnCacheFailure: refreshSpy,
    });

    await vi.waitFor(() => expect(typeof resolveRpc).toBe('function'));

    // Simulate cache row disappearing before post-RPC re-read
    await saveCachedDataset(
      'ath-uid-1',
      makeSnapshot({
        profiles: [
          {
            id: 'coach-uid-1',
            role: 'coach',
            display_name: '佐藤 コーチ',
            created_at: '2026-11-19T00:00:00Z',
          },
        ],
      })
    );

    resolveRpc({ data: '田中 太郎', error: null });

    await expect(updatePromise).rejects.toThrow(/手動同期を実行/);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Outbox and remaining cache data were NOT deleted
    const outboxAfter = await listOutboxForOwner('ath-uid-1');
    expect(outboxAfter.map((i) => i.queue_id)).toEqual(['q-keep-me']);
    const cacheAfter = await loadCachedDataset('ath-uid-1');
    expect(cacheAfter.profiles).toHaveLength(1);
    expect(cacheAfter.profiles[0].id).toBe('coach-uid-1');
  });

  it('isolates coach and athlete caches and serializes concurrent cache patches per owner', async () => {
    await saveCachedDataset('ath-uid-1', makeSnapshot());
    await saveCachedDataset(
      'coach-uid-1',
      makeSnapshot({
        last_synced_at: '2026-11-24T01:00:00Z',
      })
    );
    await enqueueOutboxItem(
      makeOutbox({
        queue_id: 'q-coach-1',
        owner_user_id: 'coach-uid-1',
        owner_role: 'coach',
        table_name: 'menus',
      })
    );

    const fakeClient = {
      rpc: async () => ({ data: '田中 選手', error: null }),
    } as unknown as SupabaseClient;

    await executeDisplayNameUpdate({
      slot: 'athlete',
      userId: 'ath-uid-1',
      role: 'athlete',
      client: fakeClient,
      rawDisplayName: '田中 選手',
      isOnline: true,
      skipOwnershipCheck: true,
      updateSessionDisplayName: vi.fn(),
    });

    // Athlete cache updated; Coach cache & Outbox completely untouched
    const athCache = await loadCachedDataset('ath-uid-1');
    const coachCache = await loadCachedDataset('coach-uid-1');
    expect(athCache.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('田中 選手');
    expect(coachCache.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('');
    expect(coachCache.last_synced_at).toBe('2026-11-24T01:00:00Z');
    expect((await listOutboxForOwner('coach-uid-1')).map((o) => o.queue_id)).toEqual(['q-coach-1']);

    // Serialized mutex execution check for same ownerUserId
    const [p1, p2] = await Promise.all([
      patchOwnProfileDisplayNameInCache('ath-uid-1', 'Name One'),
      patchOwnProfileDisplayNameInCache('ath-uid-1', 'Name Two'),
    ]);
    expect(p1.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('Name One');
    expect(p2.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('Name Two');
    const finalAth = await loadCachedDataset('ath-uid-1');
    expect(finalAth.profiles.find((p) => p.id === 'ath-uid-1')?.display_name).toBe('Name Two');
  });

  it('does not recreate localStorage slotMeta if the slot signs out while RPC is in flight', async () => {
    const { clearSlotMetaOnly, getSlotMeta, syncSlotMetaDisplayName } = await import(
      '../lib/authManager'
    );

    await saveCachedDataset('ath-uid-1', makeSnapshot());
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-athlete',
      JSON.stringify({
        slot: 'athlete',
        userId: 'ath-uid-1',
        role: 'athlete',
        displayName: '',
        lastAuthenticatedAt: '2026-11-24T00:00:00Z',
      })
    );

    let resolveRpc!: (val: { data: string; error: null }) => void;
    const fakeClient = {
      rpc: () =>
        new Promise<{ data: string; error: null }>((resolve) => {
          resolveRpc = resolve;
        }),
    } as unknown as SupabaseClient;

    const updatePromise = executeDisplayNameUpdate({
      slot: 'athlete',
      userId: 'ath-uid-1',
      role: 'athlete',
      client: fakeClient,
      rawDisplayName: '田中 太郎',
      isOnline: true,
      skipOwnershipCheck: true,
      updateSessionDisplayName: (slot, userId, role, displayName) => {
        syncSlotMetaDisplayName(slot, userId, role, displayName);
      },
    });

    await vi.waitFor(() => expect(typeof resolveRpc).toBe('function'));
    clearSlotMetaOnly('athlete');
    resolveRpc({ data: '田中 太郎', error: null });
    await updatePromise;

    expect(getSlotMeta('athlete')).toBeNull();
    expect(window.localStorage.getItem('swimlog-duo-slot-meta-athlete')).toBeNull();
  });
});

