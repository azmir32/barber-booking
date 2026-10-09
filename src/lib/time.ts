// Date and money helpers. Times are shown in the shop's time zone, whatever
// zone the phone is set to, so a booking at 10:00 in Kajang always reads 10:00.

import { dateLocale, getLang, t } from './lang.ts';

export const DEFAULT_TIME_ZONE = 'Asia/Kuala_Lumpur';

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

const relativeLabel = (offset: number) =>
  offset === -1 ? t('Yesterday') : offset === 0 ? t('Today') : offset === 1 ? t('Tomorrow') : null;

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
      new Intl.DateTimeFormat(dateLocale(), { timeZone: 'UTC', ...opts }).format(asUtc);
    return {
      date,
      label: relativeLabel(offset) ?? fmt({ weekday: 'short' }),
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

/** "14:05": the 24-hour clock time of an instant in the zone, rounded down to `step` minutes. */
export function localClock(at: string | Date, timeZone = DEFAULT_TIME_ZONE, step = 1): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const minute = get('minute') - (get('minute') % step);
  return `${String(get('hour')).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * "8:30 pm", or "8.30 malam" in Malay, the way it is written on a shop sign.
 * Malay splits the day four ways: pagi, tengah hari (12 to 2), petang (2 to 7)
 * and malam.
 */
export function clockLabel(hour: number, minute: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = String(minute).padStart(2, '0');
  if (getLang() === 'ms') {
    const period = hour < 12 ? 'pagi' : hour < 14 ? 'tengah hari' : hour < 19 ? 'petang' : 'malam';
    return `${hour12}.${mm} ${period}`;
  }
  return `${hour12}:${mm} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "10:30 am" in the shop's zone. */
export function formatTime(at: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  const [h, m] = localClock(at, timeZone).split(':').map(Number);
  return clockLabel(h, m);
}

export type PartOfDay = 'Morning' | 'Midday' | 'Afternoon' | 'Evening';

/**
 * Which tab a start time sits under. English has morning, afternoon (12 to 5)
 * and evening; Malay follows its own clock words so "3.00 petang" is never
 * listed under "Tengah hari".
 */
export function partOfDay(hour: number): PartOfDay {
  if (hour < 12) return 'Morning';
  if (getLang() === 'ms') return hour < 14 ? 'Midday' : hour < 19 ? 'Afternoon' : 'Evening';
  return hour < 17 ? 'Afternoon' : 'Evening';
}

/** Start times grouped by part of the day in the shop's zone, empty parts left out. */
export function groupByPartOfDay(times: string[], timeZone = DEFAULT_TIME_ZONE): [PartOfDay, string[]][] {
  return groupTimes(times, (at) => Number(localClock(at, timeZone).slice(0, 2)));
}

/** Groups anything by the hour it falls in, keeping the day's order. */
export function groupTimes<T>(items: T[], hourOf: (item: T) => number): [PartOfDay, T[]][] {
  const groups: Record<PartOfDay, T[]> = { Morning: [], Midday: [], Afternoon: [], Evening: [] };
  for (const item of items) groups[partOfDay(hourOf(item))].push(item);
  return (Object.entries(groups) as [PartOfDay, T[]][]).filter(([, list]) => list.length > 0);
}

/** "Tue, 6 Oct" in the shop's zone. */
export function formatDay(at: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat(dateLocale(), {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(at));
}

/** "RM25", "RM25.50" or, for a week's takings, "RM1,240". */
export function formatPrice(amount: number | string): string {
  const n = Number(amount);
  const [whole, cents] = (Number.isInteger(n) ? String(n) : n.toFixed(2)).split('.');
  return `RM${whole.replace(/\B(?=(\d{3})+$)/g, ',')}${cents ? `.${cents}` : ''}`;
}

/** "45 min" or "1 hr 15 min". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('{m} min', { m });
  return m === 0 ? t('{h} hr', { h }) : t('{h} hr {m} min', { h, m });
}

/**
 * Reads a typed time the ways people write it: "9:00", "17.30", "1430",
 * "2pm", "2.30 pm", or in Malay "2.30 ptg" and "9 pagi". Returns "HH:MM" or
 * null. Without am/pm it is 24-hour time, so "2.30" is 02:30; a bare "2"
 * could be either, so it is refused.
 */
export function normalizeTime(input: string): string | null {
  const match = /^\s*(\d{1,2})(?:[:.]?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|pagi|pg|petang|ptg)?\s*$/i.exec(input);
  if (!match) return null;
  const [, hours, minutes, suffix] = match;
  let h = Number(hours);
  const m = Number(minutes ?? 0);
  if (m > 59) return null;
  if (suffix) {
    if (h < 1 || h > 12) return null;
    const pm = /^(p\.?m|petang|ptg)/i.test(suffix);
    h = (h % 12) + (pm ? 12 : 0);
  } else if (minutes === undefined || h > 23) {
    return null;
  }
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
