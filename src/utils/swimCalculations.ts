import {
  INTENSITY_LEVELS,
  type MenuContentJson,
  type MenuItemRow,
  type MenuRowRecord,
  type MenuStatusHistoryRow,
} from '../types/database';
import type { MenuDerivedStatus, MenuIntensityBreakdown, MenuMetrics } from '../types/domain';

export const MAX_MENU_TITLE_LENGTH = 200;
export const MAX_MENU_ROWS = 200;
export const MAX_MENU_ROW_ID_LENGTH = 100;
export const MAX_MENU_CONTENT_BYTES = 262144;

export function createRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `row_${crypto.randomUUID()}`;
  }
  return `row_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-4${s4().slice(1)}-a${s4().slice(1)}-${s4()}${s4()}${s4()}`;
}

export function computeRowDistance(row: MenuItemRow): number {
  if (row.is_group_header) {
    return 0;
  }
  const dist = Number.isFinite(row.distance_m) ? Math.max(0, row.distance_m) : 0;
  const reps = Number.isFinite(row.reps) ? Math.max(0, row.reps) : 0;
  const sets = Number.isFinite(row.sets) ? Math.max(0, row.sets) : 0;
  return Math.round(dist * reps * sets);
}

/**
 * Client-side computation of total distance and intensity breakdown.
 * Skips `is_group_header` parent rows so nested sets are never double-counted.
 */
export function calculateMenuMetrics(rows: MenuItemRow[]): MenuMetrics {
  const intensityMap = new Map<string, number>();
  let totalDistanceM = 0;
  let executableRowCount = 0;

  for (const row of rows) {
    if (row.is_group_header) continue;
    executableRowCount += 1;
    const rowDist = computeRowDistance(row);
    totalDistanceM += rowDist;
    if (rowDist > 0) {
      const key = (row.intensity || 'A1').trim() || 'A1';
      intensityMap.set(key, (intensityMap.get(key) ?? 0) + rowDist);
    }
  }

  const orderedKeys: string[] = [...INTENSITY_LEVELS];
  for (const k of intensityMap.keys()) {
    if (!orderedKeys.includes(k)) {
      orderedKeys.push(k);
    }
  }

  const byIntensity: MenuIntensityBreakdown[] = [];
  for (const key of orderedKeys) {
    const dist = intensityMap.get(key) ?? 0;
    if (dist > 0) {
      byIntensity.push({
        intensity: key,
        distance_m: dist,
        percentage: totalDistanceM > 0 ? Math.round((dist / totalDistanceM) * 1000) / 10 : 0,
      });
    }
  }

  return {
    totalDistanceM,
    executableRowCount,
    byIntensity,
  };
}

export function getMenuContentByteLength(content: MenuContentJson): number {
  const json = JSON.stringify(content);
  return new TextEncoder().encode(json).length;
}

export interface MenuValidationResult {
  valid: boolean;
  errors: string[];
  byteLength: number;
}

/**
 * Validates against existing DB trigger constraints (`stamp_version_insert`, `check_set_result_row`):
 * - title: 1..200 chars
 * - content: strictly `{ rows: [...] }`
 * - rows: 1..200 items
 * - rows[].id: 1..100 chars, unique
 * - content total bytes: <= 262144 bytes
 */
export function validateMenuVersionInput(
  title: string,
  rows: MenuItemRow[]
): MenuValidationResult {
  const errors: string[] = [];
  const trimmedTitle = title.trim();

  if (trimmedTitle.length < 1 || trimmedTitle.length > MAX_MENU_TITLE_LENGTH) {
    errors.push(`メニュー名は1〜${MAX_MENU_TITLE_LENGTH}文字で入力してください。`);
  }

  if (!Array.isArray(rows)) {
    errors.push('メニュー明細行が配列ではありません。');
    return { valid: false, errors, byteLength: 0 };
  }

  if (rows.length === 0) {
    errors.push('メニュー明細を1行以上追加してください。');
  }

  if (rows.length > MAX_MENU_ROWS) {
    errors.push(`メニュー明細は最大${MAX_MENU_ROWS}行までです（現在 ${rows.length} 行）。`);
  }

  const seenIds = new Set<string>();
  rows.forEach((row, index) => {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (id.length < 1 || id.length > MAX_MENU_ROW_ID_LENGTH) {
      errors.push(`${index + 1}行目の行IDは1〜${MAX_MENU_ROW_ID_LENGTH}文字である必要があります。`);
    } else if (seenIds.has(id)) {
      errors.push(`${index + 1}行目の行ID「${id}」が重複しています。`);
    } else {
      seenIds.add(id);
    }
  });

  const payload: MenuContentJson = { rows };
  const byteLength = getMenuContentByteLength(payload);
  if (byteLength > MAX_MENU_CONTENT_BYTES) {
    errors.push('メニューの内容量が上限を超えています。行やメモを減らしてください。');
  }

  return {
    valid: errors.length === 0,
    errors,
    byteLength,
  };
}

export function deriveMenuStatus(
  menu: MenuRowRecord,
  statusHistory: MenuStatusHistoryRow[]
): MenuDerivedStatus {
  if (menu.is_archived) return 'archived';
  if (menu.is_shared) return 'shared';
  const wasEverShared = statusHistory.some(
    (h) => h.menu_id === menu.id && h.new_is_shared === true
  );
  return wasEverShared ? 'unlisted' : 'unshared';
}

export function formatMenuStatusLabel(status: MenuDerivedStatus): string {
  switch (status) {
    case 'unshared':
      return '下書き';
    case 'shared':
      return '共有中';
    case 'unlisted':
      return '非共有';
    case 'archived':
      return 'アーカイブ';
  }
}

export function formatTimeMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--.--';
  const totalCentis = Math.round(ms / 10);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);

  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }
  return `${seconds}.${String(centis).padStart(2, '0')}`;
}

/**
 * Parses formats like "1:23.45", "32.4", "32.40", "1:05" into milliseconds.
 */
export function parseTimeInputToMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length !== 2) return null;
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0 || secs >= 60) {
      return null;
    }
    return Math.round((mins * 60 + secs) * 1000);
  }

  const secs = Number(trimmed);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.round(secs * 1000);
}

export function formatDistanceM(distanceM: number): string {
  return `${distanceM.toLocaleString()}m`;
}
