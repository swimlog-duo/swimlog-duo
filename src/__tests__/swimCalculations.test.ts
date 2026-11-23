import { describe, expect, it } from 'vitest';
import type { MenuItemRow, MenuRowRecord, MenuStatusHistoryRow } from '../types/database';
import {
  calculateMenuMetrics,
  deriveMenuStatus,
  formatTimeMs,
  MAX_MENU_CONTENT_BYTES,
  parseTimeInputToMs,
  validateMenuVersionInput,
} from '../utils/swimCalculations';

function makeRow(overrides: Partial<MenuItemRow> = {}): MenuItemRow {
  return {
    id: 'row_1',
    block_type: 'SWIM',
    stroke: 'Fr',
    intensity: 'EN2',
    distance_m: 50,
    reps: 4,
    sets: 2,
    circle: '1:30',
    hr: 160,
    instruction: '',
    free_text: '',
    is_group_header: false,
    parent_row_id: null,
    ...overrides,
  };
}

describe('swimCalculations', () => {
  it('computes distance * reps * sets and skips group headers to prevent double counting', () => {
    const rows: MenuItemRow[] = [
      makeRow({ id: 'hdr_1', is_group_header: true, distance_m: 999, reps: 9, sets: 9 }),
      makeRow({ id: 'r1', distance_m: 50, reps: 4, sets: 2, intensity: 'EN2' }), // 400m
      makeRow({ id: 'r2', distance_m: 100, reps: 4, sets: 1, intensity: 'A1' }), // 400m
    ];

    const metrics = calculateMenuMetrics(rows);
    expect(metrics.totalDistanceM).toBe(800);
    expect(metrics.executableRowCount).toBe(2);
    expect(metrics.byIntensity).toEqual([
      { intensity: 'A1', distance_m: 400, percentage: 50 },
      { intensity: 'EN2', distance_m: 400, percentage: 50 },
    ]);
  });

  it('calculates pyramid sets accurately across separate rows', () => {
    const rows: MenuItemRow[] = [
      makeRow({ id: 'p1', distance_m: 50, reps: 1, sets: 1, intensity: 'EN1' }),
      makeRow({ id: 'p2', distance_m: 100, reps: 1, sets: 1, intensity: 'EN1' }),
      makeRow({ id: 'p3', distance_m: 150, reps: 1, sets: 1, intensity: 'EN2' }),
      makeRow({ id: 'p4', distance_m: 100, reps: 1, sets: 1, intensity: 'EN1' }),
      makeRow({ id: 'p5', distance_m: 50, reps: 1, sets: 1, intensity: 'EN1' }),
    ];

    const metrics = calculateMenuMetrics(rows);
    expect(metrics.totalDistanceM).toBe(450);
  });

  it('validates title length, unique row IDs, max 200 rows, and 262144 byte limit', () => {
    expect(validateMenuVersionInput('', [makeRow()]).valid).toBe(false);
    expect(validateMenuVersionInput('a'.repeat(201), [makeRow()]).valid).toBe(false);

    const dupRows = [makeRow({ id: 'dup' }), makeRow({ id: 'dup' })];
    expect(validateMenuVersionInput('Valid', dupRows).valid).toBe(false);

    const tooMany = Array.from({ length: 201 }, (_, i) => makeRow({ id: `row_${i}` }));
    expect(validateMenuVersionInput('Too many', tooMany).valid).toBe(false);

    const huge = [makeRow({ id: 'big', free_text: 'x'.repeat(MAX_MENU_CONTENT_BYTES) })];
    expect(validateMenuVersionInput('Too big', huge).valid).toBe(false);

    expect(validateMenuVersionInput('Morning Swim', [makeRow()]).valid).toBe(true);
  });

  it('derives all 4 menu states from menus + menu_status_history without extra columns', () => {
    const base: MenuRowRecord = {
      id: 'm1',
      is_shared: false,
      is_archived: false,
      created_by: 'u1',
      created_at: '2026-11-23T00:00:00Z',
      updated_by: null,
      updated_at: '2026-11-23T00:00:00Z',
    };

    expect(deriveMenuStatus(base, [])).toBe('unshared');
    expect(deriveMenuStatus({ ...base, is_shared: true }, [])).toBe('shared');

    const history: MenuStatusHistoryRow[] = [
      {
        id: 'h1',
        menu_id: 'm1',
        old_is_shared: false,
        old_is_archived: false,
        new_is_shared: true,
        new_is_archived: false,
        changed_by: 'u1',
        changed_at: '2026-11-23T01:00:00Z',
      },
    ];
    expect(deriveMenuStatus(base, history)).toBe('unlisted');
    expect(deriveMenuStatus({ ...base, is_archived: true }, history)).toBe('archived');
  });

  it('parses and formats swim times cleanly', () => {
    expect(parseTimeInputToMs('31.45')).toBe(31450);
    expect(parseTimeInputToMs('1:23.45')).toBe(83450);
    expect(formatTimeMs(83450)).toBe('1:23.45');
    expect(formatTimeMs(31450)).toBe('31.45');
  });
});
