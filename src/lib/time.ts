// Date and money helpers. Times are shown in the shop's time zone, whatever
// zone the phone is set to, so a booking at 10:00 in Kajang always reads 10:00.

export const DEFAULT_TIME_ZONE = 'Asia/Kuala_Lumpur';
const LOCALE = 'en-MY';

export type DayOption = {
  /** Local calendar date in the shop's zone, YYYY-MM-DD. */
  date: string;
  /** "Today", "Tomorrow" or a short weekday like "Wed". */
  label: string;
  dayOfMonth: string;
  month: string;
};

/** The calendar date (YYYY-MM-DD) of an instant in the given zone. */
export function localDateString(at: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const RELATIVE_LABELS: Record<number, string> = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' };

/**
 * `count` consecutive days in the shop's zone, starting `startOffset` days
 * from today (use -1 to include yesterday).
 */
export function upcomingDays(
  count: number,
  timeZone = DEFAULT_TIME_ZONE,
  now = new Date(),
  startOffset = 0,
): DayOption[] {
  const today = localDateString(now, timeZone);
  return Array.from({ length: count }, (_, i) => {
    const offset = i + startOffset;
    const date = addDays(today, offset);
    const asUtc = new Date(`${date}T00:00:00Z`);
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', ...opts }).format(asUtc);
    return {
      date,
      label: RELATIVE_LABELS[offset] ?? fmt({ weekday: 'short' }),
      dayOfMonth: fmt({ day: 'numeric' }),
      month: fmt({ month: 'short' }),
    };
  });
}

/** Minutes the zone is ahead of UTC at the given instant. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** The instants where a local calendar day starts and ends in the zone. */
export function dayBounds(date: string, timeZone = DEFAULT_TIME_ZONE): { start: Date; end: Date } {
  const startOf = (d: string) => {
    const guess = new Date(`${d}T00:00:00Z`);
    return new Date(guess.getTime() - zoneOffsetMinutes(guess, timeZone) * 60000);
  };
  return { start: startOf(date), end: startOf(addDays(date, 1)) };
}

/** "10:30 am" in the shop's zone. */
export function formatTime(at: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(at),
  );
}

export type PartOfDay = 'Morning' | 'Afternoon' | 'Evening';

/** Groups start times into morning (before 12), afternoon (before 5pm) and evening. */
export function groupByPartOfDay(times: string[], timeZone = DEFAULT_TIME_ZONE): [PartOfDay, string[]][] {
  const hourOf = (at: string) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at)));
  const groups: Record<PartOfDay, string[]> = { Morning: [], Afternoon: [], Evening: [] };
  for (const t of times) {
    const h = hourOf(t);
    groups[h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'].push(t);
  }
  return (Object.entries(groups) as [PartOfDay, string[]][]).filter(([, list]) => list.length > 0);
}

/** "Tue, 6 Oct" in the shop's zone. */
export function formatDay(at: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(at));
}

/** "RM25" or "RM25.50". */
export function formatPrice(amount: number | string): string {
  const n = Number(amount);
  return `RM${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** "45 min" or "1 hr 15 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** Accepts "9:00", "09:00" or "17:30"; returns "HH:MM" or null. */
export function normalizeTime(input: string): string | null {
  const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(input);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Turns a shop name into a booking-link slug: "Ali's Cuts!" -> "alis-cuts". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
