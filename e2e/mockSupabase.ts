import type { Page, Route } from '@playwright/test';

export const MOCK_COACH_ID = '11111111-1111-4111-8111-111111111111';
export const MOCK_ATHLETE_ID = '22222222-2222-4222-8222-222222222222';
export const MOCK_COACH_EMAIL = 'coach@test.local';
export const MOCK_ATHLETE_EMAIL = 'athlete@test.local';
export const MOCK_PASSWORD = 'swimlog-test-password';

interface MockDbState {
  profiles: Array<{
    id: string;
    role: 'coach' | 'athlete';
    display_name: string | null;
    created_at: string;
  }>;
  menus: Array<{
    id: string;
    is_shared: boolean;
    is_archived: boolean;
    created_by: string;
    created_at: string;
    updated_by: string | null;
    updated_at: string;
  }>;
  menu_versions: Array<{
    id: string;
    menu_id: string;
    version_no: number;
    title: string;
    content: { rows: unknown[] };
    created_by: string;
    created_at: string;
  }>;
  menu_status_history: Array<{
    id: string;
    menu_id: string;
    old_is_shared: boolean;
    old_is_archived: boolean;
    new_is_shared: boolean;
    new_is_archived: boolean;
    changed_by: string;
    changed_at: string;
  }>;
  practice_days: Array<Record<string, unknown>>;
  practice_entries: Array<Record<string, unknown>>;
  set_results: Array<Record<string, unknown>>;
  record_history: Array<Record<string, unknown>>;
  coach_comments: Array<Record<string, unknown>>;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createFakeJwt(userId: string, email: string): string {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      sub: userId,
      email,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  );
  return `${header}.${payload}.mock-sig`;
}

function decodeFakeJwtUserId(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof parsed.sub === 'string' ? parsed.sub : null;
  } catch {
    return null;
  }
}

function makeUuid(seq: number): string {
  const hex = seq.toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
}

export class MockSupabaseServer {
  public state: MockDbState;
  public offlineBlocked = false;
  public rpcDelayMs = 0;
  public failPostRules: Array<{
    table: string;
    status: number;
    code: string;
    message: string;
  }> = [];
  public dropNextResponseAfterCommitForTable: string | null = null;
  private seq = 100;

  constructor(options?: { athleteDisplayName?: string | null; coachDisplayName?: string | null }) {
    const now = '2026-11-24T06:00:00.000Z';
    const initialMenuId = '33333333-3333-4333-8333-333333333331';
    const initialVersionId = '44444444-4444-4444-8444-444444444441';
    const initialRowId = '55555555-5555-4555-8555-555555555551';

    this.state = {
      profiles: [
        {
          id: MOCK_COACH_ID,
          role: 'coach',
          display_name:
            options?.coachDisplayName === undefined ? '佐藤 コーチ' : options.coachDisplayName,
          created_at: now,
        },
        {
          id: MOCK_ATHLETE_ID,
          role: 'athlete',
          display_name:
            options?.athleteDisplayName === undefined ? null : options.athleteDisplayName,
          created_at: now,
        },
      ],
      menus: [
        {
          id: initialMenuId,
          is_shared: true,
          is_archived: false,
          created_by: MOCK_COACH_ID,
          created_at: now,
          updated_by: MOCK_COACH_ID,
          updated_at: now,
        },
      ],
      menu_versions: [
        {
          id: initialVersionId,
          menu_id: initialMenuId,
          version_no: 1,
          title: '2026-11-24 基本有酸素トレーニング',
          content: {
            rows: [
              {
                id: initialRowId,
                block_type: 'SWIM',
                stroke: 'Fr',
                intensity: 'A1',
                distance_m: 100,
                reps: 8,
                sets: 1,
                circle: '1:40',
                hr: 150,
                instruction: 'キャッチを丁寧に',
                free_text: 'フォーム確認',
                is_group_header: false,
                parent_row_id: null,
              },
            ],
          },
          created_by: MOCK_COACH_ID,
          created_at: now,
        },
      ],
      menu_status_history: [
        {
          id: '66666666-6666-4666-8666-666666666661',
          menu_id: initialMenuId,
          old_is_shared: false,
          old_is_archived: false,
          new_is_shared: true,
          new_is_archived: false,
          changed_by: MOCK_COACH_ID,
          changed_at: now,
        },
      ],
      practice_days: [],
      practice_entries: [],
      set_results: [],
      record_history: [],
      coach_comments: [],
    };
  }

  public bumpServerDayRevision(dayId: string, serverNote: string): void {
    const day = this.state.practice_days.find((d) => d.id === dayId);
    if (!day) {
      throw new Error(`Day ${dayId} not found in mock state`);
    }
    day.note = serverNote;
    day.revision = Number(day.revision ?? 1) + 1;
    day.updated_at = new Date().toISOString();
  }

  public async attach(page: Page): Promise<void> {
    await page.route('https://mock-supabase.invalid/**', async (route) => {
      await this.handleRoute(route);
    });
  }

  private async handleRoute(route: Route): Promise<void> {
    if (this.offlineBlocked) {
      await route.abort('internetdisconnected');
      return;
    }

    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    const headers = request.headers();
    const path = url.pathname;

    const json = async (status: number, body: unknown) => {
      await route.fulfill({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
    };

    // Auth endpoints
    if (path === '/auth/v1/token') {
      const grantType = url.searchParams.get('grant_type');
      const body = request.postDataJSON() as Record<string, unknown> | null;

      if (grantType === 'password') {
        const email = String(body?.email ?? '').trim().toLowerCase();
        const password = String(body?.password ?? '');
        let uid: string | null = null;
        if (email === MOCK_COACH_EMAIL && password === MOCK_PASSWORD) uid = MOCK_COACH_ID;
        if (email === MOCK_ATHLETE_EMAIL && password === MOCK_PASSWORD) uid = MOCK_ATHLETE_ID;
        if (!uid) {
          await json(400, {
            error: 'invalid_grant',
            error_description: 'Invalid login credentials',
          });
          return;
        }
        const accessToken = createFakeJwt(uid, email);
        await json(200, {
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `refresh-${uid}`,
          user: {
            id: uid,
            email,
            role: 'authenticated',
            aud: 'authenticated',
          },
        });
        return;
      }

      if (grantType === 'refresh_token') {
        const refresh = String(body?.refresh_token ?? '');
        const uid = refresh.replace('refresh-', '');
        const email = uid === MOCK_COACH_ID ? MOCK_COACH_EMAIL : MOCK_ATHLETE_EMAIL;
        if (uid !== MOCK_COACH_ID && uid !== MOCK_ATHLETE_ID) {
          await json(400, { error: 'invalid_grant', message: 'Invalid refresh token' });
          return;
        }
        await json(200, {
          access_token: createFakeJwt(uid, email),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `refresh-${uid}`,
          user: { id: uid, email, role: 'authenticated', aud: 'authenticated' },
        });
        return;
      }
    }

    if (path === '/auth/v1/user') {
      const uid = decodeFakeJwtUserId(headers.authorization);
      if (!uid) {
        await json(401, { message: 'Invalid JWT' });
        return;
      }
      const email = uid === MOCK_COACH_ID ? MOCK_COACH_EMAIL : MOCK_ATHLETE_EMAIL;
      await json(200, { id: uid, email, role: 'authenticated' });
      return;
    }

    if (path === '/auth/v1/logout') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    const uid = decodeFakeJwtUserId(headers.authorization);
    const callerProfile = uid ? this.state.profiles.find((p) => p.id === uid) ?? null : null;
    const callerRole = callerProfile?.role ?? null;

    // RPC: update_my_display_name
    if (path === '/rest/v1/rpc/update_my_display_name' && method === 'POST') {
      if (this.rpcDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.rpcDelayMs));
      }
      if (!callerProfile) {
        await json(401, { code: '42501', message: 'not authenticated' });
        return;
      }
      const body = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
      const raw = typeof body.new_display_name === 'string' ? body.new_display_name : '';
      const trimmed = raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
      if (!trimmed || /[\r\n\t]/.test(trimmed) || [...trimmed].length > 50) {
        await json(400, {
          code: '22023',
          message: 'display_name must be 1..50 chars without control whitespace',
        });
        return;
      }
      callerProfile.display_name = trimmed;
      await json(200, trimmed);
      return;
    }

    // REST table handlers
    const tableMatch = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!tableMatch) {
      await json(404, { message: `Unhandled route: ${method} ${path}` });
      return;
    }
    const tableName = tableMatch[1] as keyof MockDbState;
    if (!(tableName in this.state)) {
      await json(404, { message: `Unknown table ${tableName}` });
      return;
    }

    if (!callerProfile) {
      await json(401, { message: 'Unauthorized' });
      return;
    }

    const accept = headers.accept ?? '';
    const wantsObject = accept.includes('application/vnd.pgrst.object+json');
    const nowIso = new Date().toISOString();

    if (method === 'GET') {
      if (tableName === 'menu_status_history' && callerRole !== 'coach') {
        await json(403, { code: '42501', message: 'RLS violation for menu_status_history' });
        return;
      }

      let rows = [...(this.state[tableName] as Array<Record<string, unknown>>)];
      if (tableName === 'menus' && callerRole === 'athlete') {
        rows = rows.filter((m) => m.is_shared === true);
      }
      if (tableName === 'menu_versions' && callerRole === 'athlete') {
        const sharedIds = new Set(
          this.state.menus.filter((m) => m.is_shared).map((m) => m.id)
        );
        rows = rows.filter((v) => sharedIds.has(String(v.menu_id)));
      }

      for (const [k, v] of url.searchParams.entries()) {
        if (k === 'select' || k === 'order' || k === 'limit') continue;
        if (v.startsWith('eq.')) {
          const target = v.slice(3);
          rows = rows.filter((row) => String(row[k]) === target);
        }
      }

      const orderParam = url.searchParams.get('order');
      if (orderParam) {
        const [col, dir] = orderParam.split('.');
        rows.sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (typeof av === 'number' && typeof bv === 'number') {
            return dir === 'desc' ? bv - av : av - bv;
          }
          return dir === 'desc'
            ? String(bv ?? '').localeCompare(String(av ?? ''))
            : String(av ?? '').localeCompare(String(bv ?? ''));
        });
      }

      const limitParam = url.searchParams.get('limit');
      if (limitParam) {
        const limit = Number(limitParam);
        if (Number.isFinite(limit) && limit >= 0) {
          rows = rows.slice(0, limit);
        }
      }

      if (wantsObject) {
        if (rows.length !== 1) {
          await json(406, { code: 'PGRST116', message: 'The result contains 0 rows' });
          return;
        }
        await json(200, rows[0]);
        return;
      }

      await json(200, rows);
      return;
    }

    if (method === 'POST') {
      const failIdx = this.failPostRules.findIndex((r) => r.table === tableName);
      if (failIdx !== -1) {
        const [rule] = this.failPostRules.splice(failIdx, 1);
        await json(rule.status, { code: rule.code, message: rule.message });
        return;
      }

      const payload = (request.postDataJSON() as Record<string, unknown>) ?? {};
      const newId = typeof payload.id === 'string' && payload.id ? payload.id : makeUuid(++this.seq);

      const existingRows = this.state[tableName] as Array<Record<string, unknown>>;
      if (existingRows.some((r) => r.id === newId)) {
        await json(409, {
          code: '23505',
          message: `duplicate key value violates unique constraint "${tableName}_pkey"`,
        });
        return;
      }

      const finishInsert = async (row: Record<string, unknown>) => {
        if (this.dropNextResponseAfterCommitForTable === tableName) {
          this.dropNextResponseAfterCommitForTable = null;
          await route.abort('failed');
          return;
        }
        await json(201, wantsObject ? row : [row]);
      };

      if (tableName === 'menus') {
        if (callerRole !== 'coach') {
          await json(403, { code: '42501', message: 'Coach only' });
          return;
        }
        const row = {
          id: newId,
          is_shared: false,
          is_archived: false,
          created_by: callerProfile.id,
          created_at: nowIso,
          updated_by: callerProfile.id,
          updated_at: nowIso,
        };
        this.state.menus.push(row);
        await finishInsert(row);
        return;
      }

      if (tableName === 'menu_versions') {
        if (callerRole !== 'coach') {
          await json(403, { code: '42501', message: 'Coach only' });
          return;
        }
        const menu = this.state.menus.find((m) => m.id === payload.menu_id);
        if (!menu || menu.is_archived || menu.is_shared) {
          await json(409, { code: 'PT409', message: 'VERSION_CONFLICT' });
          return;
        }
        const row = {
          id: newId,
          menu_id: String(payload.menu_id),
          version_no: Number(payload.version_no ?? 1),
          title: String(payload.title ?? ''),
          content: (payload.content as { rows: unknown[] }) ?? { rows: [] },
          created_by: callerProfile.id,
          created_at: nowIso,
        };
        this.state.menu_versions.push(row);
        await finishInsert(row);
        return;
      }

      if (tableName === 'practice_days') {
        if (callerRole !== 'athlete') {
          await json(403, { code: '42501', message: 'Athlete only' });
          return;
        }
        const row = {
          id: newId,
          athlete_id: callerProfile.id,
          practice_date: String(payload.practice_date),
          note: String(payload.note ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: callerProfile.id,
          created_at: nowIso,
          updated_by: callerProfile.id,
          updated_at: nowIso,
        };
        this.state.practice_days.push(row);
        await finishInsert(row);
        return;
      }

      if (tableName === 'practice_entries') {
        if (callerRole !== 'athlete') {
          await json(403, { code: '42501', message: 'Athlete only' });
          return;
        }
        const row = {
          id: newId,
          day_id: String(payload.day_id),
          menu_version_id: String(payload.menu_version_id),
          sort_order: Number(payload.sort_order ?? 1),
          total_time_ms:
            typeof payload.total_time_ms === 'number' ? payload.total_time_ms : null,
          rating: typeof payload.rating === 'number' ? payload.rating : null,
          impression: String(payload.impression ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: callerProfile.id,
          created_at: nowIso,
          updated_by: callerProfile.id,
          updated_at: nowIso,
        };
        this.state.practice_entries.push(row);
        await finishInsert(row);
        return;
      }

      if (tableName === 'set_results') {
        if (callerRole !== 'athlete') {
          await json(403, { code: '42501', message: 'Athlete only' });
          return;
        }
        const row = {
          id: newId,
          entry_id: String(payload.entry_id),
          row_id: String(payload.row_id),
          time_ms: typeof payload.time_ms === 'number' ? payload.time_ms : null,
          splits: Array.isArray(payload.splits) ? payload.splits : [],
          rating: typeof payload.rating === 'number' ? payload.rating : null,
          impression: String(payload.impression ?? ''),
          is_deleted: false,
          revision: 1,
          expected_revision: null,
          created_by: callerProfile.id,
          created_at: nowIso,
          updated_by: callerProfile.id,
          updated_at: nowIso,
        };
        this.state.set_results.push(row);
        await finishInsert(row);
        return;
      }

      if (tableName === 'coach_comments') {
        if (callerRole !== 'coach') {
          await json(403, { code: '42501', message: 'Coach only' });
          return;
        }
        const row = {
          id: newId,
          entry_id: String(payload.entry_id),
          set_result_id:
            typeof payload.set_result_id === 'string' ? payload.set_result_id : null,
          body: String(payload.body ?? ''),
          created_by: callerProfile.id,
          created_at: nowIso,
        };
        this.state.coach_comments.push(row);
        await finishInsert(row);
        return;
      }
    }

    if (method === 'PATCH') {
      const idFilter = url.searchParams.get('id');
      const targetId = idFilter?.startsWith('eq.') ? idFilter.slice(3) : null;
      const patch = (request.postDataJSON() as Record<string, unknown>) ?? {};

      if (tableName === 'menus') {
        if (callerRole !== 'coach') {
          await json(403, { code: '42501', message: 'Coach only' });
          return;
        }
        const menu = this.state.menus.find((m) => m.id === targetId);
        if (!menu) {
          await json(404, { message: 'Menu not found' });
          return;
        }
        const oldShared = menu.is_shared;
        const oldArchived = menu.is_archived;
        if (typeof patch.is_shared === 'boolean') menu.is_shared = patch.is_shared;
        if (typeof patch.is_archived === 'boolean') menu.is_archived = patch.is_archived;
        menu.updated_by = callerProfile.id;
        menu.updated_at = nowIso;
        this.state.menu_status_history.push({
          id: makeUuid(++this.seq),
          menu_id: menu.id,
          old_is_shared: oldShared,
          old_is_archived: oldArchived,
          new_is_shared: menu.is_shared,
          new_is_archived: menu.is_archived,
          changed_by: callerProfile.id,
          changed_at: nowIso,
        });
        await json(200, wantsObject ? menu : [menu]);
        return;
      }

      if (
        tableName === 'practice_days' ||
        tableName === 'practice_entries' ||
        tableName === 'set_results'
      ) {
        const list = this.state[tableName] as Array<Record<string, unknown>>;
        const row = list.find((r) => r.id === targetId);
        if (!row) {
          await json(404, { message: `${tableName} row not found` });
          return;
        }
        const expectedRev = patch.expected_revision;
        const currentRev = Number(row.revision ?? 1);
        if (expectedRev !== currentRev) {
          await json(409, {
            code: 'PT409',
            message: 'REVISION_CONFLICT',
            details: JSON.stringify({
              table: tableName,
              id: targetId,
              server_revision: currentRev,
            }),
          });
          return;
        }
        const oldSnapshot = { ...row };
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'expected_revision') continue;
          if (v !== undefined) row[k] = v;
        }
        row.revision = currentRev + 1;
        row.expected_revision = null;
        row.updated_by = callerProfile.id;
        row.updated_at = nowIso;
        this.state.record_history.push({
          id: makeUuid(++this.seq),
          table_name: tableName,
          record_id: targetId,
          revision: row.revision,
          old_data: oldSnapshot,
          changed_by: callerProfile.id,
          changed_at: nowIso,
        });
        await json(200, wantsObject ? row : [row]);
        return;
      }
    }

    await json(400, { message: `Unsupported ${method} on ${tableName}` });
  }
}
