import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CoachCommentRow,
  MenuContentJson,
  MenuRowRecord,
  MenuStatusHistoryRow,
  MenuVersionRowRecord,
  PracticeDayRow,
  PracticeEntryRow,
  ProfileRow,
  RecordHistoryRow,
  SetResultRow,
  UserRole,
} from '../types/database';
import type { AppDatasetSnapshot, ConflictDetail } from '../types/domain';
import { validateMenuVersionInput } from '../utils/swimCalculations';
import { normalizeDisplayName, validateDisplayNameInput } from '../utils/displayName';

export interface ParsedSupabaseError {
  kind:
    | 'REVISION_CONFLICT'
    | 'VERSION_CONFLICT'
    | 'MENU_HAS_NO_VERSION'
    | 'EXPECTED_REVISION_REQUIRED'
    | 'ROW_NOT_IN_VERSION'
    | 'NETWORK'
    | 'AUTH'
    | 'OTHER';
  code: string | null;
  message: string;
  table?: string;
  id?: string;
  serverRevision?: number | null;
}

function tryParseConflictDetails(detailsRaw: unknown): {
  table?: string;
  id?: string;
  server_revision?: number | null;
} {
  if (!detailsRaw) return {};
  if (typeof detailsRaw === 'object') {
    const obj = detailsRaw as Record<string, unknown>;
    return {
      table: typeof obj.table === 'string' ? obj.table : undefined,
      id: typeof obj.id === 'string' ? obj.id : undefined,
      server_revision:
        typeof obj.server_revision === 'number' ? obj.server_revision : null,
    };
  }
  if (typeof detailsRaw === 'string') {
    try {
      const parsed = JSON.parse(detailsRaw) as Record<string, unknown>;
      return tryParseConflictDetails(parsed);
    } catch {
      const tableMatch = detailsRaw.match(/table[=:]\s*([a-z_]+)/i);
      const idMatch = detailsRaw.match(/id[=:]\s*([0-9a-f-]{36})/i);
      const revMatch = detailsRaw.match(/server_revision[=:]\s*(\d+)/i);
      return {
        table: tableMatch?.[1],
        id: idMatch?.[1],
        server_revision: revMatch ? Number(revMatch[1]) : null,
      };
    }
  }
  return {};
}

export function parseSupabaseError(err: unknown): ParsedSupabaseError {
  const e = (err ?? {}) as {
    code?: string;
    message?: string;
    details?: unknown;
    hint?: string;
    status?: number;
  };
  const code = e.code ?? null;
  const msg = e.message ?? '不明なエラーが発生しました。';
  const combined = `${code ?? ''} ${msg} ${typeof e.details === 'string' ? e.details : ''}`;

  if (
    combined.includes('REVISION_CONFLICT') ||
    (code === 'PT409' && !combined.includes('VERSION_CONFLICT') && !combined.includes('MENU_HAS_NO_VERSION'))
  ) {
    const parsed = tryParseConflictDetails(e.details);
    return {
      kind: 'REVISION_CONFLICT',
      code: code ?? 'PT409',
      message: msg,
      table: parsed.table,
      id: parsed.id,
      serverRevision: parsed.server_revision ?? null,
    };
  }

  if (combined.includes('VERSION_CONFLICT')) {
    return { kind: 'VERSION_CONFLICT', code, message: msg };
  }

  if (combined.includes('MENU_HAS_NO_VERSION')) {
    return { kind: 'MENU_HAS_NO_VERSION', code, message: msg };
  }

  if (combined.includes('EXPECTED_REVISION_REQUIRED')) {
    return { kind: 'EXPECTED_REVISION_REQUIRED', code, message: msg };
  }

  if (combined.includes('ROW_NOT_IN_VERSION') || code === 'PT422') {
    return { kind: 'ROW_NOT_IN_VERSION', code: code ?? 'PT422', message: msg };
  }

  if (
    e.status === 401 ||
    combined.toLowerCase().includes('jwt') ||
    combined.toLowerCase().includes('not authenticated')
  ) {
    return { kind: 'AUTH', code, message: msg };
  }

  if (
    combined.toLowerCase().includes('failed to fetch') ||
    combined.toLowerCase().includes('networkerror') ||
    combined.toLowerCase().includes('fetch')
  ) {
    return { kind: 'NETWORK', code, message: msg };
  }

  return { kind: 'OTHER', code, message: msg };
}

/**
 * Fetches permitted tables strictly respecting existing RLS policies:
 * - `athlete` NEVER queries `menu_status_history`.
 */
export async function fetchAllDatasetFromServer(
  client: SupabaseClient,
  role: UserRole
): Promise<AppDatasetSnapshot> {
  const [
    profilesRes,
    menusRes,
    versionsRes,
    statusHistoryRes,
    daysRes,
    entriesRes,
    setsRes,
    historyRes,
    commentsRes,
  ] = await Promise.all([
    client.from('profiles').select('id, role, display_name, created_at'),
    client
      .from('menus')
      .select('id, is_shared, is_archived, created_by, created_at, updated_by, updated_at')
      .order('updated_at', { ascending: false }),
    client
      .from('menu_versions')
      .select('id, menu_id, version_no, title, content, created_by, created_at')
      .order('version_no', { ascending: false }),
    role === 'coach'
      ? client
          .from('menu_status_history')
          .select(
            'id, menu_id, old_is_shared, old_is_archived, new_is_shared, new_is_archived, changed_by, changed_at'
          )
          .order('changed_at', { ascending: false })
      : Promise.resolve({ data: [] as MenuStatusHistoryRow[], error: null }),
    client
      .from('practice_days')
      .select(
        'id, athlete_id, practice_date, note, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
      )
      .order('practice_date', { ascending: false }),
    client
      .from('practice_entries')
      .select(
        'id, day_id, menu_version_id, sort_order, total_time_ms, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
      )
      .order('sort_order', { ascending: true }),
    client
      .from('set_results')
      .select(
        'id, entry_id, row_id, time_ms, splits, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
      )
      .order('created_at', { ascending: true }),
    client
      .from('record_history')
      .select('id, table_name, record_id, revision, old_data, changed_by, changed_at')
      .order('changed_at', { ascending: false }),
    client
      .from('coach_comments')
      .select('id, entry_id, set_result_id, body, created_by, created_at')
      .order('created_at', { ascending: true }),
  ]);

  const errors = [
    profilesRes.error,
    menusRes.error,
    versionsRes.error,
    statusHistoryRes.error,
    daysRes.error,
    entriesRes.error,
    setsRes.error,
    historyRes.error,
    commentsRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    throw errors[0];
  }

  return {
    profiles: (profilesRes.data ?? []) as ProfileRow[],
    menus: (menusRes.data ?? []) as MenuRowRecord[],
    menu_versions: (versionsRes.data ?? []) as MenuVersionRowRecord[],
    menu_status_history: (statusHistoryRes.data ?? []) as MenuStatusHistoryRow[],
    practice_days: (daysRes.data ?? []) as PracticeDayRow[],
    practice_entries: (entriesRes.data ?? []) as PracticeEntryRow[],
    set_results: (setsRes.data ?? []) as SetResultRow[],
    record_history: (historyRes.data ?? []) as RecordHistoryRow[],
    coach_comments: (commentsRes.data ?? []) as CoachCommentRow[],
    last_synced_at: new Date().toISOString(),
  };
}

export async function insertMenuOnServer(
  client: SupabaseClient,
  payload: { id?: string }
): Promise<MenuRowRecord> {
  // stamp_menu_insert() requires new menus to start unshared (is_shared: false)
  const insertBody: Record<string, unknown> = {
    is_shared: false,
    is_archived: false,
  };
  if (payload.id) {
    insertBody.id = payload.id;
  }

  const { data, error } = await client
    .from('menus')
    .insert(insertBody)
    .select('id, is_shared, is_archived, created_by, created_at, updated_by, updated_at')
    .single<MenuRowRecord>();

  if (error) throw error;
  return data;
}

export async function updateMenuStatusOnServer(
  client: SupabaseClient,
  menuId: string,
  patch: { is_shared?: boolean; is_archived?: boolean }
): Promise<MenuRowRecord> {
  const { data, error } = await client
    .from('menus')
    .update(patch)
    .eq('id', menuId)
    .select('id, is_shared, is_archived, created_by, created_at, updated_by, updated_at')
    .single<MenuRowRecord>();

  if (error) throw error;
  return data;
}

export async function insertMenuVersionOnServer(
  client: SupabaseClient,
  params: {
    id?: string;
    menu_id: string;
    version_no: number;
    title: string;
    content: MenuContentJson;
  }
): Promise<MenuVersionRowRecord> {
  // Strictly send `{ rows }` ONLY in initial implementation
  const strictContent: MenuContentJson = {
    rows: params.content.rows,
  };
  const check = validateMenuVersionInput(params.title, strictContent.rows);
  if (!check.valid) {
    throw new Error(check.errors.join(' '));
  }

  const insertBody: Record<string, unknown> = {
    menu_id: params.menu_id,
    version_no: params.version_no,
    title: params.title.trim(),
    content: strictContent,
  };
  if (params.id) {
    insertBody.id = params.id;
  }

  const { data, error } = await client
    .from('menu_versions')
    .insert(insertBody)
    .select('id, menu_id, version_no, title, content, created_by, created_at')
    .single<MenuVersionRowRecord>();

  if (error) throw error;
  return data;
}

/**
 * Safely revises a menu respecting `stamp_version_insert()`:
 * - Cannot add a version to an archived menu
 * - Cannot add a version while `is_shared === true`
 * - `version_no` must equal `max(version_no) + 1`
 */
export async function reviseMenuVersionOnServer(
  client: SupabaseClient,
  params: {
    menu_id: string;
    version_id?: string;
    title: string;
    content: MenuContentJson;
    share_after: boolean;
  }
): Promise<{ menu: MenuRowRecord; version: MenuVersionRowRecord }> {
  const { data: currentMenu, error: menuErr } = await client
    .from('menus')
    .select('id, is_shared, is_archived, created_by, created_at, updated_by, updated_at')
    .eq('id', params.menu_id)
    .single<MenuRowRecord>();

  if (menuErr) throw menuErr;
  if (currentMenu.is_archived) {
    throw new Error('アーカイブ済みのメニューには新しいバージョンを追加できません。');
  }

  let workingMenu = currentMenu;
  if (workingMenu.is_shared) {
    workingMenu = await updateMenuStatusOnServer(client, params.menu_id, { is_shared: false });
  }

  const { data: latestVersions, error: verErr } = await client
    .from('menu_versions')
    .select('version_no')
    .eq('menu_id', params.menu_id)
    .order('version_no', { ascending: false })
    .limit(1);

  if (verErr) throw verErr;
  const maxVersionNo = latestVersions && latestVersions.length > 0 ? latestVersions[0].version_no : 0;

  const newVersion = await insertMenuVersionOnServer(client, {
    id: params.version_id,
    menu_id: params.menu_id,
    version_no: maxVersionNo + 1,
    title: params.title,
    content: params.content,
  });

  if (params.share_after) {
    workingMenu = await updateMenuStatusOnServer(client, params.menu_id, { is_shared: true });
  }

  return { menu: workingMenu, version: newVersion };
}

export async function insertPracticeDayOnServer(
  client: SupabaseClient,
  payload: {
    id?: string;
    athlete_id: string;
    practice_date: string;
    note: string;
  }
): Promise<PracticeDayRow> {
  const body: Record<string, unknown> = {
    athlete_id: payload.athlete_id,
    practice_date: payload.practice_date,
    note: payload.note ?? '',
    is_deleted: false,
  };
  if (payload.id) body.id = payload.id;

  const { data, error } = await client
    .from('practice_days')
    .insert(body)
    .select(
      'id, athlete_id, practice_date, note, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<PracticeDayRow>();

  if (error) throw error;
  return data;
}

export async function updatePracticeDayOnServer(
  client: SupabaseClient,
  id: string,
  expectedRevision: number,
  patch: { practice_date?: string; note?: string; is_deleted?: boolean }
): Promise<PracticeDayRow> {
  if (!Number.isInteger(expectedRevision)) {
    throw new Error('EXPECTED_REVISION_REQUIRED: expected_revision は必須の整数です。');
  }

  const { data, error } = await client
    .from('practice_days')
    .update({ ...patch, expected_revision: expectedRevision })
    .eq('id', id)
    .select(
      'id, athlete_id, practice_date, note, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<PracticeDayRow>();

  if (error) throw error;
  return data;
}

export async function insertPracticeEntryOnServer(
  client: SupabaseClient,
  payload: {
    id?: string;
    day_id: string;
    menu_version_id: string;
    sort_order: number;
    total_time_ms: number | null;
    rating: number | null;
    impression: string;
  }
): Promise<PracticeEntryRow> {
  const body: Record<string, unknown> = {
    day_id: payload.day_id,
    menu_version_id: payload.menu_version_id,
    sort_order: payload.sort_order,
    total_time_ms: payload.total_time_ms,
    rating: payload.rating,
    impression: payload.impression ?? '',
    is_deleted: false,
  };
  if (payload.id) body.id = payload.id;

  const { data, error } = await client
    .from('practice_entries')
    .insert(body)
    .select(
      'id, day_id, menu_version_id, sort_order, total_time_ms, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<PracticeEntryRow>();

  if (error) throw error;
  return data;
}

export async function updatePracticeEntryOnServer(
  client: SupabaseClient,
  id: string,
  expectedRevision: number,
  patch: {
    sort_order?: number;
    total_time_ms?: number | null;
    rating?: number | null;
    impression?: string;
    is_deleted?: boolean;
  }
): Promise<PracticeEntryRow> {
  if (!Number.isInteger(expectedRevision)) {
    throw new Error('EXPECTED_REVISION_REQUIRED: expected_revision は必須の整数です。');
  }

  const { data, error } = await client
    .from('practice_entries')
    .update({ ...patch, expected_revision: expectedRevision })
    .eq('id', id)
    .select(
      'id, day_id, menu_version_id, sort_order, total_time_ms, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<PracticeEntryRow>();

  if (error) throw error;
  return data;
}

export async function insertSetResultOnServer(
  client: SupabaseClient,
  payload: {
    id?: string;
    entry_id: string;
    row_id: string;
    time_ms: number | null;
    splits: unknown[];
    rating: number | null;
    impression: string;
  }
): Promise<SetResultRow> {
  const body: Record<string, unknown> = {
    entry_id: payload.entry_id,
    row_id: payload.row_id,
    time_ms: payload.time_ms,
    splits: payload.splits ?? [],
    rating: payload.rating,
    impression: payload.impression ?? '',
    is_deleted: false,
  };
  if (payload.id) body.id = payload.id;

  const { data, error } = await client
    .from('set_results')
    .insert(body)
    .select(
      'id, entry_id, row_id, time_ms, splits, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<SetResultRow>();

  if (error) throw error;
  return data;
}

export async function updateSetResultOnServer(
  client: SupabaseClient,
  id: string,
  expectedRevision: number,
  patch: {
    time_ms?: number | null;
    splits?: unknown[];
    rating?: number | null;
    impression?: string;
    is_deleted?: boolean;
  }
): Promise<SetResultRow> {
  if (!Number.isInteger(expectedRevision)) {
    throw new Error('EXPECTED_REVISION_REQUIRED: expected_revision は必須の整数です。');
  }

  const { data, error } = await client
    .from('set_results')
    .update({ ...patch, expected_revision: expectedRevision })
    .eq('id', id)
    .select(
      'id, entry_id, row_id, time_ms, splits, rating, impression, is_deleted, revision, expected_revision, created_by, created_at, updated_by, updated_at'
    )
    .single<SetResultRow>();

  if (error) throw error;
  return data;
}

export async function insertCoachCommentOnServer(
  client: SupabaseClient,
  payload: {
    id?: string;
    entry_id: string;
    set_result_id: string | null;
    body: string;
  }
): Promise<CoachCommentRow> {
  const body: Record<string, unknown> = {
    entry_id: payload.entry_id,
    set_result_id: payload.set_result_id,
    body: payload.body.trim(),
  };
  if (payload.id) body.id = payload.id;

  const { data, error } = await client
    .from('coach_comments')
    .insert(body)
    .select('id, entry_id, set_result_id, body, created_by, created_at')
    .single<CoachCommentRow>();

  if (error) throw error;
  return data;
}

export async function fetchSingleRecordForConflict(
  client: SupabaseClient,
  table: string,
  id: string
): Promise<ConflictDetail['server_record']> {
  if (
    table !== 'practice_days' &&
    table !== 'practice_entries' &&
    table !== 'set_results'
  ) {
    return null;
  }
  const { data, error } = await client.from(table).select('*').eq('id', id).maybeSingle();
  if (error) return null;
  return (data as Record<string, unknown> | null) ?? null;
}

export async function updateMyDisplayNameOnServer(
  client: SupabaseClient,
  rawDisplayName: string
): Promise<string> {
  const check = validateDisplayNameInput(rawDisplayName);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const { data, error } = await client.rpc('update_my_display_name', {
    new_display_name: check.normalized,
  });

  if (error) {
    const parsed = parseSupabaseError(error);
    if (parsed.kind === 'AUTH' || error.code === '42501') {
      throw new Error('認証状態を確認できませんでした。再度ログインしてからお試しください。');
    }
    if (parsed.kind === 'NETWORK') {
      throw new Error('通信エラーのため表示名を更新できませんでした。通信環境を確認してください。');
    }
    if (error.code === 'P0002') {
      throw new Error('対象アカウントのプロフィール行が見つかりません。管理者設定を確認してください。');
    }
    if (error.code === '22023') {
      throw new Error(error.message || '表示名の入力形式が正しくありません。');
    }
    throw new Error(error.message || '表示名の更新に失敗しました。');
  }

  const saved = typeof data === 'string' ? normalizeDisplayName(data) : '';
  if (!saved) {
    throw new Error('サーバーから有効な表示名が返されませんでした。');
  }
  return saved;
}

