import type {
  CoachCommentRow,
  IntensityLevel,
  MenuRowRecord,
  MenuStatusHistoryRow,
  MenuVersionRowRecord,
  PracticeDayRow,
  PracticeEntryRow,
  ProfileRow,
  RecordHistoryRow,
  SetResultRow,
  UserRole,
} from './database';

export type AccountSlot = UserRole;

export type MenuDerivedStatus = 'unshared' | 'shared' | 'unlisted' | 'archived';

export interface SlotAccountMeta {
  slot: AccountSlot;
  userId: string;
  email: string;
  role: UserRole;
  displayName: string;
  lastAuthenticatedAt: string;
}

export type SyncTableName =
  | 'menus'
  | 'menu_versions'
  | 'practice_days'
  | 'practice_entries'
  | 'set_results'
  | 'coach_comments';

export type OutboxOperation =
  | 'insert'
  | 'update'
  | 'revise_menu_version';

export type OutboxStatus = 'pending' | 'syncing' | 'conflict' | 'error';

export interface OutboxParentLinks {
  menu_temp_id?: string;
  day_temp_id?: string;
  entry_temp_id?: string;
}

export interface ConflictDetail {
  table: string;
  id: string;
  server_revision: number | null;
  message: string;
  server_record: Record<string, unknown> | null;
}

export interface OutboxItem {
  queue_id: string;
  owner_user_id: string;
  owner_role: UserRole;
  table_name: SyncTableName;
  client_temp_id: string;
  operation: OutboxOperation;
  expected_revision: number | null;
  payload: Record<string, unknown>;
  parent_links?: OutboxParentLinks;
  status: OutboxStatus;
  conflict_detail?: ConflictDetail | null;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalCompetitionGoal {
  id: string;
  name: string;
  event_date: string; // YYYY-MM-DD
  note: string;
}

export interface LocalTemplateMeta {
  menu_id: string;
  is_template: boolean;
  planned_date?: string;
}

export interface AppDatasetSnapshot {
  profiles: ProfileRow[];
  menus: MenuRowRecord[];
  menu_versions: MenuVersionRowRecord[];
  menu_status_history: MenuStatusHistoryRow[];
  practice_days: PracticeDayRow[];
  practice_entries: PracticeEntryRow[];
  set_results: SetResultRow[];
  record_history: RecordHistoryRow[];
  coach_comments: CoachCommentRow[];
  last_synced_at: string | null;
}

export interface MenuIntensityBreakdown {
  intensity: IntensityLevel | string;
  distance_m: number;
  percentage: number;
}

export interface MenuMetrics {
  totalDistanceM: number;
  executableRowCount: number;
  byIntensity: MenuIntensityBreakdown[];
}

export interface SwimlogBackupBundle {
  app: 'swimlog-duo';
  version: 1;
  exported_at: string;
  owner_user_id: string;
  owner_role: UserRole;
  dataset: AppDatasetSnapshot;
  outbox: OutboxItem[];
  competitions: LocalCompetitionGoal[];
  template_meta: LocalTemplateMeta[];
}
