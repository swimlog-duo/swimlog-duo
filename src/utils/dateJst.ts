const JST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const JST_DATETIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Returns today's calendar date (`YYYY-MM-DD`) in Japan Standard Time (Asia/Tokyo).
 */
export function getTodayJst(now: Date = new Date()): string {
  return JST_DATE_FORMATTER.format(now);
}

/**
 * Shifts a `YYYY-MM-DD` calendar date by `deltaDays` safely in UTC calendar arithmetic
 * (immune to DST or local timezone boundary shifts).
 */
export function shiftDateDays(dateYmd: string, deltaDays: number): string {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return dateYmd;
  }
  const utc = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Formats an ISO timestamp string to `YYYY-MM-DD` in Japan Standard Time (Asia/Tokyo).
 */
export function formatIsoToJstDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.slice(0, 10);
  }
  return JST_DATE_FORMATTER.format(d);
}

/**
 * Formats an ISO timestamp string to `YYYY-MM-DD HH:mm` in Japan Standard Time (Asia/Tokyo).
 */
export function formatIsoToJstDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.slice(0, 16).replace('T', ' ');
  }
  const parts = JST_DATETIME_FORMATTER.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

/**
 * Computes remaining days until `eventDateYmd` from `todayYmd` (defaults to current JST date).
 */
export function getDaysUntilJst(
  eventDateYmd: string,
  todayYmd: string = getTodayJst()
): number {
  const [ey, em, ed] = eventDateYmd.split('-').map(Number);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  if (
    !Number.isFinite(ey) ||
    !Number.isFinite(em) ||
    !Number.isFinite(ed) ||
    !Number.isFinite(ty) ||
    !Number.isFinite(tm) ||
    !Number.isFinite(td)
  ) {
    return 0;
  }
  const eventUtc = Date.UTC(ey, em - 1, ed);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((eventUtc - todayUtc) / (1000 * 60 * 60 * 24));
}

const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/**
 * Formats a `YYYY-MM-DD` date string with Japanese weekday, e.g. `2026-11-26 (木)`.
 */
export function formatYmdWithWeekdayJst(dateYmd: string | null | undefined): string {
  if (!dateYmd) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateYmd);
  if (!match) return dateYmd;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== m - 1 ||
    utc.getUTCDate() !== d
  ) {
    return dateYmd;
  }
  const wd = JA_WEEKDAYS[utc.getUTCDay()];
  return `${match[1]}-${match[2]}-${match[3]} (${wd})`;
}

