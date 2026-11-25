import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserRole } from '../types/database';
import type { AccountSlot, AppDatasetSnapshot, OutboxItem } from '../types/domain';
import { validateDisplayNameInput } from '../utils/displayName';
import { verifyClientOwnership } from './authManager';
import {
  listOutboxForOwner,
  loadCachedDataset,
  patchOwnProfileDisplayNameInCache,
} from './offlineDb';
import { updateMyDisplayNameOnServer } from './supabaseRepository';
import { applyOutboxOverlayToDataset } from './syncEngine';

export interface UpdateDisplayNameWorkflowParams {
  slot: AccountSlot;
  userId: string;
  role: UserRole;
  client: SupabaseClient;
  rawDisplayName: string;
  isOnline: boolean;
  skipOwnershipCheck?: boolean;
  updateSessionDisplayName: (
    slot: AccountSlot,
    userId: string,
    role: UserRole,
    displayName: string
  ) => void;
  refreshSessionOnCacheFailure?: () => Promise<void>;
}

export interface UpdateDisplayNameWorkflowResult {
  savedName: string;
  nextCache: AppDatasetSnapshot;
  latestOutbox: OutboxItem[];
  overlayDataset: AppDatasetSnapshot;
}

/**
 * Safely executes self-service `profiles.display_name` update:
 * 1. Validates input and online status.
 * 2. Verifies own profile row exists in local cache BEFORE RPC (never saves this snapshot).
 * 3. Verifies active client UID/role ownership.
 * 4. Calls `public.update_my_display_name` RPC (returns `text` only).
 * 5. Under per-owner IndexedDB lock, re-reads latest `cache_snapshots`, verifies own row,
 *    and patches ONLY `display_name = savedName` (preserving all other profiles, tables, and Outbox).
 * 6. Re-reads latest Outbox and returns merged overlay without discarding concurrent edits.
 */
export async function executeDisplayNameUpdate(
  params: UpdateDisplayNameWorkflowParams
): Promise<UpdateDisplayNameWorkflowResult> {
  const {
    slot,
    userId,
    role,
    client,
    rawDisplayName,
    isOnline,
    skipOwnershipCheck,
    updateSessionDisplayName,
    refreshSessionOnCacheFailure,
  } = params;

  const check = validateDisplayNameInput(rawDisplayName);
  if (!check.valid) {
    throw new Error(check.error);
  }

  if (!isOnline) {
    throw new Error('オフラインのため表示名を更新できません。インターネット接続を確認してください。');
  }

  const preCheckCache = await loadCachedDataset(userId);
  if (!preCheckCache.profiles.some((p) => p.id === userId)) {
    throw new Error(
      'ローカルキャッシュに本人プロフィールが見つかりません。同期完了後に再度お試しください。'
    );
  }

  if (!skipOwnershipCheck) {
    const ownership = await verifyClientOwnership(slot, userId, role);
    if (!ownership.ok) {
      throw new Error(ownership.reason ?? 'アカウント検証に失敗しました。');
    }
  }

  const savedName = await updateMyDisplayNameOnServer(client, check.normalized);

  let nextCache: AppDatasetSnapshot;
  try {
    nextCache = await patchOwnProfileDisplayNameInCache(userId, savedName);
  } catch (cacheErr) {
    if (refreshSessionOnCacheFailure) {
      try {
        await refreshSessionOnCacheFailure();
      } catch {
        // Keep recovery error visible even if session refresh fails
      }
    }
    const reason = cacheErr instanceof Error ? cacheErr.message : 'キャッシュ保存失敗';
    throw new Error(
      `サーバー上の表示名は「${savedName}」に更新されましたが、端末内キャッシュの更新に失敗しました（${reason}）。未送信データ・練習記録は保持されています。ページを再読み込みするか、設定画面の「手動同期を実行」で最新状態に反映してください。`
    );
  }

  updateSessionDisplayName(slot, userId, role, savedName);

  const latestOutbox = await listOutboxForOwner(userId);
  const overlayDataset = applyOutboxOverlayToDataset(nextCache, latestOutbox);

  return {
    savedName,
    nextCache,
    latestOutbox,
    overlayDataset,
  };
}
