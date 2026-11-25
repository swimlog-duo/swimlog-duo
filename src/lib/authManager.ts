import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { ProfileRow, UserRole } from '../types/database';
import type { AccountSlot, SlotAccountMeta } from '../types/domain';
import { normalizeDisplayName } from '../utils/displayName';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';

const ACTIVE_SLOT_KEY = 'swimlog-duo-active-slot';
const SLOT_META_KEYS: Record<AccountSlot, string> = {
  coach: 'swimlog-duo-slot-meta-coach',
  athlete: 'swimlog-duo-slot-meta-athlete',
};

export function getStoredActiveSlot(): AccountSlot {
  if (typeof window === 'undefined') return 'athlete';
  const raw = window.localStorage.getItem(ACTIVE_SLOT_KEY);
  return raw === 'coach' || raw === 'athlete' ? raw : 'athlete';
}

export function setStoredActiveSlot(slot: AccountSlot): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_SLOT_KEY, slot);
}

export function getSlotMeta(slot: AccountSlot): SlotAccountMeta | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(SLOT_META_KEYS[slot]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed &&
      parsed.slot === slot &&
      typeof parsed.userId === 'string' &&
      (parsed.role === 'coach' || parsed.role === 'athlete')
    ) {
      const rawName =
        typeof parsed.displayName === 'string' ? normalizeDisplayName(parsed.displayName) : '';
      const legacyEmail =
        typeof parsed.email === 'string' ? normalizeDisplayName(parsed.email) : '';
      const safeDisplayName =
        legacyEmail.length > 0 && rawName === legacyEmail ? '' : rawName;
      return {
        slot,
        userId: parsed.userId,
        role: parsed.role,
        displayName: safeDisplayName,
        lastAuthenticatedAt:
          typeof parsed.lastAuthenticatedAt === 'string' ? parsed.lastAuthenticatedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function saveSlotMeta(meta: SlotAccountMeta): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SLOT_META_KEYS[meta.slot], JSON.stringify(meta));
}

export function syncSlotMetaDisplayName(
  slot: AccountSlot,
  expectedUserId: string,
  role: UserRole,
  displayName: string
): SlotAccountMeta | null {
  const existing = getSlotMeta(slot);
  if (!existing) {
    return null;
  }
  if (existing.userId !== expectedUserId) {
    throw new Error('セッション不整合のため表示名メタを更新できませんでした。');
  }
  const updated: SlotAccountMeta = {
    slot,
    userId: expectedUserId,
    role,
    displayName: normalizeDisplayName(displayName),
    lastAuthenticatedAt: existing.lastAuthenticatedAt || new Date().toISOString(),
  };
  saveSlotMeta(updated);
  return updated;
}

export function clearSlotMetaOnly(slot: AccountSlot): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SLOT_META_KEYS[slot]);
}

export interface VerifiedSessionContext {
  slot: AccountSlot;
  client: SupabaseClient;
  userId: string;
  role: UserRole;
  displayName: string;
  offlineFallback: boolean;
}

export interface ResolveSessionDetailedResult {
  session: VerifiedSessionContext | null;
  reauthRequiredReason: string | null;
}

/**
 * Returns true ONLY when Supabase Auth explicitly rejected/invalidated the refresh token
 * or session (expired/revoked), as opposed to weak network / fetch / timeout failures.
 */
export function isAuthSessionDefinitelyInvalid(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; status?: number; message?: string; code?: string };
  const name = (e.name ?? '').toLowerCase();
  const msg = (e.message ?? '').toLowerCase();
  const code = (e.code ?? '').toLowerCase();

  if (
    name === 'authretryablefetcherror' ||
    e.status === 0 ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('abort')
  ) {
    return false;
  }

  if (
    e.status === 400 ||
    e.status === 401 ||
    e.status === 403 ||
    code === 'refresh_token_not_found' ||
    code === 'session_not_found' ||
    msg.includes('invalid refresh token') ||
    msg.includes('refresh token not found') ||
    msg.includes('invalid_grant') ||
    msg.includes('jwt expired')
  ) {
    return true;
  }

  return false;
}

function buildOfflineFallbackContext(
  slot: AccountSlot,
  client: SupabaseClient,
  cachedMeta: SlotAccountMeta
): VerifiedSessionContext {
  return {
    slot,
    client,
    userId: cachedMeta.userId,
    role: cachedMeta.role,
    displayName: cachedMeta.displayName,
    offlineFallback: true,
  };
}

/**
 * Verifies the active session UID and profiles.role on the isolated slot client.
 * - Preserves saved valid sessions across app restarts and weak/flaky poolside networks
 *   without redirecting to LoginScreen on transient network errors.
 * - Requires re-login ONLY when no saved session exists or refresh token is definitively expired/revoked.
 */
export async function resolveSlotSessionDetailed(
  slot: AccountSlot,
  isOnline: boolean
): Promise<ResolveSessionDetailedResult> {
  const cachedMeta = getSlotMeta(slot);

  if (!isSupabaseConfigured()) {
    return { session: null, reauthRequiredReason: null };
  }

  const client = getSupabaseClient(slot);

  try {
    const { data: sessionData, error: sessionErr } = await client.auth.getSession();
    const session: Session | null = sessionData?.session ?? null;

    if (sessionErr) {
      if (!isAuthSessionDefinitelyInvalid(sessionErr) && cachedMeta && cachedMeta.role === slot) {
        return {
          session: buildOfflineFallbackContext(slot, client, cachedMeta),
          reauthRequiredReason: null,
        };
      }
      return {
        session: null,
        reauthRequiredReason: 'セッションの有効期限が切れています。再度ログインしてください。',
      };
    }

    if (!session) {
      if (!isOnline && cachedMeta && cachedMeta.role === slot) {
        return {
          session: buildOfflineFallbackContext(slot, client, cachedMeta),
          reauthRequiredReason: null,
        };
      }
      return { session: null, reauthRequiredReason: null };
    }

    const uid = session.user.id;

    if (!isOnline) {
      if (cachedMeta && cachedMeta.userId === uid && cachedMeta.role === slot) {
        return {
          session: buildOfflineFallbackContext(slot, client, cachedMeta),
          reauthRequiredReason: null,
        };
      }
      return { session: null, reauthRequiredReason: null };
    }

    const { data: profile, error: profileErr } = await client
      .from('profiles')
      .select('id, role, display_name, created_at')
      .eq('id', uid)
      .single<ProfileRow>();

    if (profileErr || !profile) {
      // Transient fetch/timeout or server 5xx: preserve local session without forcing re-login
      if (
        !isAuthSessionDefinitelyInvalid(profileErr) &&
        cachedMeta &&
        cachedMeta.userId === uid &&
        cachedMeta.role === slot
      ) {
        return {
          session: buildOfflineFallbackContext(slot, client, cachedMeta),
          reauthRequiredReason: null,
        };
      }
      return {
        session: null,
        reauthRequiredReason:
          '認証セッションを確認できませんでした。通信環境を確認するか再度ログインしてください。',
      };
    }

    if (profile.role !== slot) {
      await client.auth.signOut({ scope: 'local' });
      clearSlotMetaOnly(slot);
      return {
        session: null,
        reauthRequiredReason: 'アカウントのロールと選択枠が一致しないため再ログインが必要です。',
      };
    }

    const updatedMeta: SlotAccountMeta = {
      slot,
      userId: uid,
      role: profile.role,
      displayName: normalizeDisplayName(profile.display_name ?? ''),
      lastAuthenticatedAt: new Date().toISOString(),
    };
    saveSlotMeta(updatedMeta);

    return {
      session: {
        slot,
        client,
        userId: uid,
        role: profile.role,
        displayName: updatedMeta.displayName,
        offlineFallback: false,
      },
      reauthRequiredReason: null,
    };
  } catch (err) {
    if (!isAuthSessionDefinitelyInvalid(err) && cachedMeta && cachedMeta.role === slot) {
      return {
        session: buildOfflineFallbackContext(slot, client, cachedMeta),
        reauthRequiredReason: null,
      };
    }
    return {
      session: null,
      reauthRequiredReason: isAuthSessionDefinitelyInvalid(err)
        ? 'セッションの有効期限が切れています。再度ログインしてください。'
        : null,
    };
  }
}

export async function resolveSlotSession(
  slot: AccountSlot,
  isOnline: boolean
): Promise<VerifiedSessionContext | null> {
  const res = await resolveSlotSessionDetailed(slot, isOnline);
  return res.session;
}

/**
 * Signs in strictly into the requested slot's isolated client and validates `profiles.role === slot`.
 * Never alters or overwrites the other slot's session or Outbox.
 */
export async function signInSlotAccount(
  slot: AccountSlot,
  email: string,
  password: string
): Promise<VerifiedSessionContext> {
  const client = getSupabaseClient(slot);

  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error || !data.user || !data.session) {
    throw new Error(error?.message || 'ログインに失敗しました。メールアドレスとパスワードを確認してください。');
  }

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id, role, display_name, created_at')
    .eq('id', data.user.id)
    .single<ProfileRow>();

  if (profileError || !profile) {
    await client.auth.signOut({ scope: 'local' });
    throw new Error('profiles テーブルからアカウントのロール情報を取得できませんでした。');
  }

  if (profile.role !== slot) {
    await client.auth.signOut({ scope: 'local' });
    const expectedLabel = slot === 'coach' ? 'コーチ（coach）' : '選手（athlete）';
    const actualLabel = profile.role === 'coach' ? 'コーチ（coach）' : '選手（athlete）';
    throw new Error(
      `選択した枠は「${expectedLabel}」用ですが、このアカウントのロールは「${actualLabel}」です。正しい枠からログインしてください。`
    );
  }

  const meta: SlotAccountMeta = {
    slot,
    userId: data.user.id,
    role: profile.role,
    displayName: normalizeDisplayName(profile.display_name ?? ''),
    lastAuthenticatedAt: new Date().toISOString(),
  };

  saveSlotMeta(meta);
  setStoredActiveSlot(slot);

  return {
    slot,
    client,
    userId: meta.userId,
    role: meta.role,
    displayName: meta.displayName,
    offlineFallback: false,
  };
}

/**
 * Signs out ONLY the specified slot's isolated client.
 * Does NOT wipe IndexedDB cached data or the other slot's session/Outbox.
 */
export async function signOutSlotAccount(slot: AccountSlot): Promise<void> {
  clearSlotMetaOnly(slot);
  if (!isSupabaseConfigured()) return;
  try {
    const client = getSupabaseClient(slot);
    await client.auth.signOut({ scope: 'local' });
  } catch {
    // Keep local-only cleanup resilient when offline
  }
}

/**
 * Verifies right before any remote write or Outbox sync that the active client's
 * current Auth UID and cached role match the target owner_user_id and owner_role.
 */
export async function verifyClientOwnership(
  slot: AccountSlot,
  expectedUserId: string,
  expectedRole: UserRole
): Promise<{ ok: boolean; reason?: string }> {
  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'Supabase 未設定' };
  }
  const client = getSupabaseClient(slot);
  const { data } = await client.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) {
    return { ok: false, reason: 'セッションが無効または未ログインです。再ログインしてください。' };
  }
  if (uid !== expectedUserId) {
    return {
      ok: false,
      reason: 'ログイン中のアカウントUIDが同期データの所有者UIDと一致しないため送信を中止しました。',
    };
  }
  const meta = getSlotMeta(slot);
  if (!meta || meta.userId !== uid || meta.role !== expectedRole) {
    return {
      ok: false,
      reason: 'アカウントのロール検証に失敗しました。アカウント状態を再確認してください。',
    };
  }
  return { ok: true };
}
