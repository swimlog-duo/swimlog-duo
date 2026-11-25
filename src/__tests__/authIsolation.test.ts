import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_STORAGE_KEYS } from '../lib/supabase';

describe('2-account auth storage isolation', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    };
  });

  it('uses distinct Supabase Auth storageKeys for coach and athlete', () => {
    expect(AUTH_STORAGE_KEYS.coach).toBe('swimlog-duo-auth-coach');
    expect(AUTH_STORAGE_KEYS.athlete).toBe('swimlog-duo-auth-athlete');
    expect(AUTH_STORAGE_KEYS.coach).not.toBe(AUTH_STORAGE_KEYS.athlete);
  });

  it('does not overwrite athlete metadata when clearing coach slot metadata', async () => {
    const { clearSlotMetaOnly, getSlotMeta } = await import('../lib/authManager');

    window.localStorage.setItem(
      'swimlog-duo-slot-meta-coach',
      JSON.stringify({
        slot: 'coach',
        userId: 'coach-1',
        email: 'coach@example.com',
        role: 'coach',
        displayName: 'Coach',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-athlete',
      JSON.stringify({
        slot: 'athlete',
        userId: 'ath-1',
        email: 'ath@example.com',
        role: 'athlete',
        displayName: 'Athlete',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );

    clearSlotMetaOnly('coach');

    expect(getSlotMeta('coach')).toBeNull();
    expect(getSlotMeta('athlete')?.userId).toBe('ath-1');
  });

  it('preserves session on transient/weak network errors even when navigator.onLine is true, and restores coach & athlete independently', async () => {
    const { isAuthSessionDefinitelyInvalid, resolveSlotSessionDetailed } = await import(
      '../lib/authManager'
    );

    expect(
      isAuthSessionDefinitelyInvalid({
        name: 'AuthRetryableFetchError',
        status: 0,
        message: 'Failed to fetch',
      })
    ).toBe(false);
    expect(
      isAuthSessionDefinitelyInvalid({
        name: 'AuthApiError',
        status: 400,
        code: 'refresh_token_not_found',
        message: 'Invalid Refresh Token: Refresh Token Not Found',
      })
    ).toBe(true);

    // Without Vite env configured in test, isSupabaseConfigured() is false unless tested via helper,
    // so verify slot metadata isolation across simulated relaunch checks:
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-coach',
      JSON.stringify({
        slot: 'coach',
        userId: 'coach-uid-1',
        email: 'coach@example.com',
        role: 'coach',
        displayName: 'Coach Sato',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-athlete',
      JSON.stringify({
        slot: 'athlete',
        userId: 'ath-uid-1',
        email: 'ath@example.com',
        role: 'athlete',
        displayName: 'Swimmer Tanaka',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );

    const res = await resolveSlotSessionDetailed('coach', true);
    expect(res.reauthRequiredReason).toBeNull();
    expect(window.localStorage.getItem('swimlog-duo-slot-meta-athlete')).toContain('ath-uid-1');
  });

  it('restores session on app relaunch without password, stays signed in on weak network, and requires reauth only on invalid refresh token', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();

    let mode: 'valid' | 'network_err' | 'expired_token' = 'valid';
    const fakeCoachClient = {
      auth: {
        getSession: async () => {
          if (mode === 'network_err') {
            return {
              data: { session: null },
              error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
            };
          }
          if (mode === 'expired_token') {
            return {
              data: { session: null },
              error: {
                name: 'AuthApiError',
                status: 400,
                code: 'refresh_token_not_found',
                message: 'Invalid Refresh Token',
              },
            };
          }
          return {
            data: {
              session: {
                user: { id: 'coach-uid-1', email: 'coach@example.com' },
              },
            },
            error: null,
          };
        },
        signOut: async () => ({ error: null }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: 'coach-uid-1',
                role: 'coach',
                display_name: 'Coach Sato',
                created_at: '2026-11-23T00:00:00Z',
              },
              error: null,
            }),
          }),
        }),
      }),
    };

    vi.doMock('../lib/supabase', () => ({
      AUTH_STORAGE_KEYS: {
        coach: 'swimlog-duo-auth-coach',
        athlete: 'swimlog-duo-auth-athlete',
      },
      isSupabaseConfigured: () => true,
      getSupabaseClient: () => fakeCoachClient,
    }));

    window.localStorage.setItem(
      'swimlog-duo-slot-meta-coach',
      JSON.stringify({
        slot: 'coach',
        userId: 'coach-uid-1',
        email: 'coach@example.com',
        role: 'coach',
        displayName: 'Coach Sato',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-athlete',
      JSON.stringify({
        slot: 'athlete',
        userId: 'ath-uid-1',
        email: 'ath@example.com',
        role: 'athlete',
        displayName: 'Swimmer Tanaka',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );

    const { resolveSlotSessionDetailed, getSlotMeta } = await import('../lib/authManager');

    // 1. Valid relaunch: restored automatically with offlineFallback = false and without saving email
    mode = 'valid';
    const validRes = await resolveSlotSessionDetailed('coach', true);
    expect(validRes.session?.userId).toBe('coach-uid-1');
    expect(validRes.session?.displayName).toBe('Coach Sato');
    expect(validRes.session?.offlineFallback).toBe(false);
    expect(validRes.reauthRequiredReason).toBeNull();
    expect(getSlotMeta('coach')).not.toHaveProperty('email');
    expect(window.localStorage.getItem('swimlog-duo-slot-meta-coach')).not.toContain('coach@example.com');

    // Legacy slot metadata with email fallback is readable without forcing sign-out, but strips email
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-athlete',
      JSON.stringify({
        slot: 'athlete',
        userId: 'ath-uid-1',
        email: 'ath@example.com',
        role: 'athlete',
        displayName: 'ath@example.com',
        lastAuthenticatedAt: '2026-11-23T00:00:00Z',
      })
    );
    const legacyAth = getSlotMeta('athlete');
    expect(legacyAth?.userId).toBe('ath-uid-1');
    expect(legacyAth?.displayName).toBe('');
    expect(legacyAth).not.toHaveProperty('email');

    // 2. Weak network while navigator.onLine is true: preserved via offlineFallback = true
    mode = 'network_err';
    const weakRes = await resolveSlotSessionDetailed('coach', true);
    expect(weakRes.session?.userId).toBe('coach-uid-1');
    expect(weakRes.session?.offlineFallback).toBe(true);
    expect(weakRes.reauthRequiredReason).toBeNull();

    // 3. Genuine expired/revoked refresh token: asks re-login without touching athlete slot
    mode = 'expired_token';
    const expRes = await resolveSlotSessionDetailed('coach', true);
    expect(expRes.session).toBeNull();
    expect(expRes.reauthRequiredReason).toBeTruthy();
    expect(getSlotMeta('athlete')?.userId).toBe('ath-uid-1');

    vi.doUnmock('../lib/supabase');
  });

  it('validates public Supabase config and blocks service_role / sb_secret keys', async () => {
    const { validateSupabasePublicConfig } = await import('../lib/supabase');

    const toJwt = (payloadObj: Record<string, unknown>) => {
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = btoa(JSON.stringify(payloadObj));
      return `${header}.${payload}.sig`;
    };

    expect(validateSupabasePublicConfig('', '')).toBeTruthy();
    expect(validateSupabasePublicConfig('http://example.supabase.co', 'sb_publishable_abc')).toBeTruthy();
    expect(
      validateSupabasePublicConfig('https://demo.supabase.co', 'sb_secret_not_allowed')
    ).toContain('sb_secret_');
    expect(
      validateSupabasePublicConfig('https://demo.supabase.co', toJwt({ role: 'service_role' }))
    ).toContain('service_role');

    expect(
      validateSupabasePublicConfig('https://demo.supabase.co', toJwt({ role: 'anon' }))
    ).toBeNull();
    expect(
      validateSupabasePublicConfig('https://demo.supabase.co', 'sb_publishable_12345')
    ).toBeNull();
  });

  it('does not recreate slot metadata in syncSlotMetaDisplayName after sign-out and updates active slot cleanly without email', async () => {
    const { getSlotMeta, syncSlotMetaDisplayName } = await import('../lib/authManager');

    // Signed out (meta is null): must return null and leave localStorage empty
    const resWhenSignedOut = syncSlotMetaDisplayName('athlete', 'ath-uid-1', 'athlete', '田中 太郎');
    expect(resWhenSignedOut).toBeNull();
    expect(getSlotMeta('athlete')).toBeNull();
    expect(window.localStorage.getItem('swimlog-duo-slot-meta-athlete')).toBeNull();

    // Active slot: updates displayName without adding email and without touching coach slot
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
    window.localStorage.setItem(
      'swimlog-duo-slot-meta-coach',
      JSON.stringify({
        slot: 'coach',
        userId: 'coach-uid-1',
        role: 'coach',
        displayName: '佐藤 コーチ',
        lastAuthenticatedAt: '2026-11-24T00:00:00Z',
      })
    );

    const updated = syncSlotMetaDisplayName('athlete', 'ath-uid-1', 'athlete', ' \u3000田中 太郎\u3000 ');
    expect(updated?.displayName).toBe('田中 太郎');
    expect(updated).not.toHaveProperty('email');
    expect(getSlotMeta('athlete')?.displayName).toBe('田中 太郎');
    expect(getSlotMeta('coach')?.displayName).toBe('佐藤 コーチ');
    expect(() =>
      syncSlotMetaDisplayName('athlete', 'other-uid', 'athlete', '別ユーザー')
    ).toThrow();
  });
});

