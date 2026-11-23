import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AccountSlot } from '../types/domain';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';

export const AUTH_STORAGE_KEYS: Record<AccountSlot, string> = {
  coach: 'swimlog-duo-auth-coach',
  athlete: 'swimlog-duo-auth-athlete',
};

function decodeJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json) as { role?: unknown };
    return typeof parsed.role === 'string' ? parsed.role : null;
  } catch {
    return null;
  }
}

export function validateSupabasePublicConfig(
  url: string,
  anonKey: string
): string | null {
  const trimmedUrl = url.trim();
  const trimmedKey = anonKey.trim();

  if (!trimmedUrl || !trimmedKey) {
    return 'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY（Publishable / anon キー）を設定してください。';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return 'VITE_SUPABASE_URL の形式が正しくありません（https://... を指定してください）。';
  }

  const isLocalhost =
    parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  if (parsedUrl.protocol !== 'https:' && !(isLocalhost && parsedUrl.protocol === 'http:')) {
    return 'VITE_SUPABASE_URL は https:// で始まる必要があります。';
  }

  if (trimmedKey.startsWith('sb_secret_')) {
    return '秘密キー（sb_secret_）はフロントエンドに設定できません。anon / publishable キーのみ設定してください。';
  }

  const jwtRole = decodeJwtRole(trimmedKey);
  if (jwtRole === 'service_role') {
    return 'service_role キーはフロントエンドに設定できません。anon / publishable キーのみ設定してください。';
  }

  return null;
}

export function getSupabaseConfigError(): string | null {
  return validateSupabasePublicConfig(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfigError() === null;
}

export function getSupabaseHostLabel(): string | null {
  if (!isSupabaseConfigured()) return null;
  try {
    return new URL(SUPABASE_URL).host;
  } catch {
    return null;
  }
}

function createIsolatedClient(slot: AccountSlot): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storageKey: AUTH_STORAGE_KEYS[slot],
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

const clientRegistry: Record<AccountSlot, SupabaseClient | null> = {
  coach: createIsolatedClient('coach'),
  athlete: createIsolatedClient('athlete'),
};

/**
 * Returns the isolated SupabaseClient bound strictly to the requested account slot.
 * Coach and athlete never share an Auth storageKey or client instance.
 */
export function getSupabaseClient(slot: AccountSlot): SupabaseClient {
  const client = clientRegistry[slot];
  if (!client) {
    throw new Error(
      getSupabaseConfigError() ??
        'Supabase の接続設定（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）が未設定です。'
    );
  }
  return client;
}
