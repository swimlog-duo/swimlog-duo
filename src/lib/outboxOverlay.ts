import type {
  MenuContentJson,
  PracticeDayRow,
  PracticeEntryRow,
  SetResultRow,
} from '../types/database';
import type { AppDatasetSnapshot, OutboxItem } from '../types/domain';

export type RecordSyncState = 'synced' | 'pending' | 'syncing' | 'error' | 'conflict';

export function replaceOrAppendById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [item, ...list];
  const copy = [...list];
  copy[idx] = item;
  return copy;
}

function resolveId(id: string, idMap?: Map<string, string> | Record<string, string>): string {
  if (!idMap) return id;
  if (idMap instanceof Map) {
    return idMap.get(id) ?? id;
  }
  return idMap[id] ?? id;
}

/**
 * Overlays unsynced local Outbox items onto the latest server snapshot so the UI
 * and local backups preserve local edits/creations even before sync completes.
 */
export function applyOutboxOverlayToDataset(
  base: AppDatasetSnapshot,
  outbox: OutboxItem[],
  idMap?: Map<string, string> | Record<string, string>
): AppDatasetSnapshot {
  let next: AppDatasetSnapshot = { ...base };

  for (const item of outbox) {
    const resolvedId = resolveId(item.client_temp_id, idMap);

    if (item.table_name === 'practice_days') {
      if (item.operation === 'insert') {
        const tempRow: PracticeDayRow = {
          id: resolvedId,
          athlete_id: item.owner_user_id,
          practice_date: String(item.payload.practice_date ?? ''),
          note: String(item.payload.note ?? ''),
          is_deleted: Boolean(item.payload.is_deleted ?? false),
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
            d.id === resolvedId ? { ...d, ...item.payload } : d
          ),
        };
      }
    } else if (item.table_name === 'practice_entries') {
      if (item.operation === 'insert') {
        const rawDayId = String(item.payload.day_id ?? '');
        const rawVersionId = String(item.payload.menu_version_id ?? '');
        const tempRow: PracticeEntryRow = {
          id: resolvedId,
          day_id: resolveId(rawDayId, idMap),
          menu_version_id: resolveId(rawVersionId, idMap),
          sort_order: Number(item.payload.sort_order ?? 1),
          total_time_ms:
            typeof item.payload.total_time_ms === 'number'
              ? item.payload.total_time_ms
              : null,
          rating: typeof item.payload.rating === 'number' ? item.payload.rating : null,
          impression: String(item.payload.impression ?? ''),
          is_deleted: Boolean(item.payload.is_deleted ?? false),
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
            e.id === resolvedId ? { ...e, ...item.payload } : e
          ),
        };
      }
    } else if (item.table_name === 'set_results') {
      if (item.operation === 'insert') {
        const rawEntryId = String(item.payload.entry_id ?? '');
        const tempRow: SetResultRow = {
          id: resolvedId,
          entry_id: resolveId(rawEntryId, idMap),
          row_id: String(item.payload.row_id ?? ''),
          time_ms: typeof item.payload.time_ms === 'number' ? item.payload.time_ms : null,
          splits: Array.isArray(item.payload.splits) ? item.payload.splits : [],
          rating: typeof item.payload.rating === 'number' ? item.payload.rating : null,
          impression: String(item.payload.impression ?? ''),
          is_deleted: Boolean(item.payload.is_deleted ?? false),
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
            s.id === resolvedId ? { ...s, ...item.payload } : s
          ),
        };
      }
    } else if (item.table_name === 'menus') {
      if (item.operation === 'insert') {
        next = {
          ...next,
          menus: replaceOrAppendById(next.menus, {
            id: resolvedId,
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
            m.id === resolvedId ? { ...m, ...item.payload } : m
          ),
        };
      }
    } else if (item.table_name === 'menu_versions') {
      if (item.operation === 'insert' || item.operation === 'revise_menu_version') {
        const menuId = resolveId(String(item.payload.menu_id ?? ''), idMap);
        next = {
          ...next,
          menus:
            item.operation === 'revise_menu_version' && typeof item.payload.share_after === 'boolean'
              ? next.menus.map((m) =>
                  m.id === menuId ? { ...m, is_shared: Boolean(item.payload.share_after) } : m
                )
              : next.menus,
          menu_versions: replaceOrAppendById(next.menu_versions, {
            id: resolvedId,
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
      const rawEntryId = String(item.payload.entry_id ?? '');
      const rawSetResultId =
        typeof item.payload.set_result_id === 'string'
          ? resolveId(item.payload.set_result_id, idMap)
          : null;
      next = {
        ...next,
        coach_comments: replaceOrAppendById(next.coach_comments, {
          id: resolvedId,
          entry_id: resolveId(rawEntryId, idMap),
          set_result_id: rawSetResultId,
          body: String(item.payload.body ?? ''),
          created_by: item.owner_user_id,
          created_at: item.created_at,
        }),
      };
    }
  }

  return next;
}

export function getOutboxItemsForTargets(
  outbox: OutboxItem[],
  targetIds: Iterable<string>
): OutboxItem[] {
  const idSet = new Set<string>(targetIds);
  if (idSet.size === 0) return [];
  return outbox.filter((item) => {
    if (idSet.has(item.client_temp_id)) return true;
    for (const key of ['menu_id', 'menu_version_id', 'day_id', 'entry_id', 'set_result_id'] as const) {
      const val = item.payload[key];
      if (typeof val === 'string' && idSet.has(val)) return true;
    }
    return false;
  });
}

export function getRecordSyncState(
  outbox: OutboxItem[],
  targetIds: Iterable<string>
): { state: RecordSyncState; items: OutboxItem[]; errorMessage: string | null } {
  const items = getOutboxItemsForTargets(outbox, targetIds);
  if (items.length === 0) {
    return { state: 'synced', items: [], errorMessage: null };
  }
  const conflictItem = items.find((i) => i.status === 'conflict');
  if (conflictItem) {
    return { state: 'conflict', items, errorMessage: conflictItem.last_error };
  }
  const erroredItem = items.find((i) => i.status === 'error');
  if (erroredItem) {
    return { state: 'error', items, errorMessage: erroredItem.last_error };
  }
  if (items.some((i) => i.status === 'syncing')) {
    return { state: 'syncing', items, errorMessage: null };
  }
  return { state: 'pending', items, errorMessage: null };
}

/**
 * Finds all downstream dependent Outbox items that rely on `rootQueueId`
 * so parent items are never orphaned or singly deleted while children still depend on them.
 */
export function getOutboxDependentItems(
  outbox: OutboxItem[],
  rootQueueId: string
): OutboxItem[] {
  const root = outbox.find((i) => i.queue_id === rootQueueId);
  if (!root) return [];

  const affectedTempIds = new Set<string>();
  if (root.operation === 'insert' || root.operation === 'revise_menu_version') {
    affectedTempIds.add(root.client_temp_id);
  }
  if (
    root.table_name === 'menu_versions' &&
    typeof root.payload.menu_id === 'string' &&
    root.operation === 'insert'
  ) {
    // Deleting the v1 version of a new menu affects trailing menus:update on that menu
    const rootMenuId = root.payload.menu_id;
    const dependents: OutboxItem[] = [];
    for (const item of outbox) {
      if (item.queue_id === root.queue_id) continue;
      if (
        item.table_name === 'menus' &&
        item.operation === 'update' &&
        item.client_temp_id === rootMenuId &&
        item.created_at >= root.created_at
      ) {
        dependents.push(item);
      }
      if (item.payload.menu_version_id === root.client_temp_id) {
        dependents.push(item);
      }
    }
    return dependents;
  }

  const result: OutboxItem[] = [];
  const addedQueueIds = new Set<string>([root.queue_id]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of outbox) {
      if (addedQueueIds.has(item.queue_id)) continue;
      const refsTarget =
        (item.operation === 'update' && affectedTempIds.has(item.client_temp_id)) ||
        (['menu_id', 'menu_version_id', 'day_id', 'entry_id', 'set_result_id'] as const).some(
          (key) => typeof item.payload[key] === 'string' && affectedTempIds.has(String(item.payload[key]))
        );
      if (refsTarget) {
        addedQueueIds.add(item.queue_id);
        result.push(item);
        if (item.operation === 'insert' || item.operation === 'revise_menu_version') {
          affectedTempIds.add(item.client_temp_id);
        }
        changed = true;
      }
    }
  }

  return result;
}

const VALID_TABLES = new Set([
  'menus',
  'menu_versions',
  'practice_days',
  'practice_entries',
  'set_results',
  'coach_comments',
]);

const VALID_OPS = new Set(['insert', 'update', 'revise_menu_version']);
const VALID_STATUSES = new Set(['pending', 'syncing', 'conflict', 'error']);

export function validateBackupBundleStructure(
  raw: unknown,
  targetUserId: string,
  targetRole: 'coach' | 'athlete'
): { ok: true; bundle: import('../types/domain').SwimlogBackupBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '無効なバックアップファイル形式です。' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.app !== 'swimlog-duo' || obj.version !== 1) {
    return {
      ok: false,
      error: '対応していないバックアップ形式またはバージョンです。',
    };
  }
  if (obj.owner_user_id !== targetUserId || obj.owner_role !== targetRole) {
    return {
      ok: false,
      error:
        '別アカウントのバックアップファイルは現在のアカウントへ復元できません（混同防止ガード）。',
    };
  }

  const ds = obj.dataset;
  if (!ds || typeof ds !== 'object' || Array.isArray(ds)) {
    return { ok: false, error: 'バックアップ内のデータ本体が破損しています。' };
  }
  const dsObj = ds as Record<string, unknown>;
  const requiredDatasetArrays = [
    'profiles',
    'menus',
    'menu_versions',
    'menu_status_history',
    'practice_days',
    'practice_entries',
    'set_results',
    'record_history',
    'coach_comments',
  ];
  for (const key of requiredDatasetArrays) {
    if (!Array.isArray(dsObj[key])) {
      return {
        ok: false,
        error: `バックアップデータの形式が不正です（${key} が配列ではありません）。`,
      };
    }
    for (const row of dsObj[key] as unknown[]) {
      if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') {
        return {
          ok: false,
          error: `バックアップデータ内のレコードに必須項目 (id) が不足しています（${key}）。`,
        };
      }
    }
  }

  if (obj.outbox !== undefined && !Array.isArray(obj.outbox)) {
    return { ok: false, error: '未送信キューの形式が不正です。' };
  }
  for (const item of (obj.outbox as unknown[]) ?? []) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: '未送信キュー項目が破損しています。' };
    }
    const q = item as Record<string, unknown>;
    if (
      typeof q.queue_id !== 'string' ||
      !q.queue_id ||
      typeof q.owner_user_id !== 'string' ||
      (q.owner_role !== 'coach' && q.owner_role !== 'athlete') ||
      typeof q.table_name !== 'string' ||
      !VALID_TABLES.has(q.table_name) ||
      typeof q.client_temp_id !== 'string' ||
      !q.client_temp_id ||
      typeof q.operation !== 'string' ||
      !VALID_OPS.has(q.operation) ||
      typeof q.status !== 'string' ||
      !VALID_STATUSES.has(q.status) ||
      !q.payload ||
      typeof q.payload !== 'object' ||
      Array.isArray(q.payload)
    ) {
      return { ok: false, error: '未送信キュー内の必須項目が不足または破損しています。' };
    }
  }

  if (obj.competitions !== undefined) {
    if (!Array.isArray(obj.competitions)) {
      return { ok: false, error: '大会予定データの形式が不正です。' };
    }
    for (const comp of obj.competitions as unknown[]) {
      if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
        return { ok: false, error: '大会予定データ内の項目が破損しています。' };
      }
      const c = comp as Record<string, unknown>;
      if (
        typeof c.id !== 'string' ||
        !c.id ||
        typeof c.name !== 'string' ||
        typeof c.event_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(c.event_date)
      ) {
        return { ok: false, error: '大会予定データ内の必須項目が不足または破損しています。' };
      }
    }
  }
  if (obj.template_meta !== undefined) {
    if (!Array.isArray(obj.template_meta)) {
      return { ok: false, error: 'テンプレート情報の形式が不正です。' };
    }
    for (const tpl of obj.template_meta as unknown[]) {
      if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) {
        return { ok: false, error: 'テンプレート情報内の項目が破損しています。' };
      }
      const t = tpl as Record<string, unknown>;
      if (typeof t.menu_id !== 'string' || !t.menu_id || typeof t.is_template !== 'boolean') {
        return { ok: false, error: 'テンプレート情報内の必須項目が不足または破損しています。' };
      }
    }
  }

  return {
    ok: true,
    bundle: raw as import('../types/domain').SwimlogBackupBundle,
  };
}

