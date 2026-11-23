export type UserRole = 'coach' | 'athlete';

export interface ProfileRow {
  id: string;
  role: UserRole;
  display_name: string;
  created_at: string;
}

export interface MenuRowRecord {
  id: string;
  is_shared: boolean;
  is_archived: boolean;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface MenuVersionRowRecord {
  id: string;
  menu_id: string;
  version_no: number;
  title: string;
  content: MenuContentJson;
  created_by: string;
  created_at: string;
}

export interface MenuStatusHistoryRow {
  id: string;
  menu_id: string;
  old_is_shared: boolean;
  old_is_archived: boolean;
  new_is_shared: boolean;
  new_is_archived: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface PracticeDayRow {
  id: string;
  athlete_id: string;
  practice_date: string;
  note: string;
  is_deleted: boolean;
  revision: number;
  expected_revision: number | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface PracticeEntryRow {
  id: string;
  day_id: string;
  menu_version_id: string;
  sort_order: number;
  total_time_ms: number | null;
  rating: number | null;
  impression: string;
  is_deleted: boolean;
  revision: number;
  expected_revision: number | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface SplitRecord {
  rep: number;
  time_ms: number | null;
  hr?: number | null;
  memo?: string;
}

export interface SetResultRow {
  id: string;
  entry_id: string;
  row_id: string;
  time_ms: number | null;
  splits: SplitRecord[];
  rating: number | null;
  impression: string;
  is_deleted: boolean;
  revision: number;
  expected_revision: number | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface RecordHistoryRow {
  id: string;
  table_name: 'practice_days' | 'practice_entries' | 'set_results' | string;
  record_id: string;
  revision: number;
  old_data: Record<string, unknown>;
  changed_by: string | null;
  changed_at: string;
}

export interface CoachCommentRow {
  id: string;
  entry_id: string;
  set_result_id: string | null;
  body: string;
  created_by: string;
  created_at: string;
}

export const INTENSITY_LEVELS = [
  'A1',
  'A2',
  'EN1',
  'EN2',
  'EN3',
  'AN1',
  'AN2',
  'AN3',
] as const;

export type IntensityLevel = (typeof INTENSITY_LEVELS)[number];

export const STROKE_TYPES = ['Fr', 'Ba', 'Br', 'Fly', 'IMO', 'Choice'] as const;
export type StrokeType = (typeof STROKE_TYPES)[number];

export const BLOCK_TYPES = [
  'W-up',
  'DRILL',
  'SWIM',
  'PADDLE',
  'KICK',
  'PULL',
  'DOWN',
  'OTHER',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface MenuItemRow {
  id: string;
  block_type: BlockType | string;
  stroke: StrokeType | string;
  intensity: IntensityLevel | string;
  distance_m: number;
  reps: number;
  sets: number;
  circle: string;
  hr: number | null;
  instruction: string;
  free_text: string;
  is_group_header?: boolean;
  parent_row_id?: string | null;
}

/**
 * Initial implementation persists strictly `{ rows: MenuItemRow[] }` in `menu_versions.content`.
 * Do NOT send extra unverified top-level properties such as `summary`.
 */
export interface MenuContentJson {
  rows: MenuItemRow[];
}
