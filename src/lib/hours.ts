// Working-hours helpers shared by the barber and customer screens.

import { WEEKDAYS, type WorkingHours } from './types.ts';

type Range = Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>;

/** Monday first, the way most people read a week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** "20:00" or "20:00:00" -> "8:00 pm". */
export function formatClock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Shop-level opening times per weekday (0 = Sunday): from the earliest
 * barber start to the latest finish, or null when nobody works that day.
 */
export function shopWeek(hours: Range[]): ({ opens: string; closes: string } | null)[] {
  return WEEKDAYS.map((_, weekday) => {
    const day = hours.filter((h) => h.weekday === weekday);
    if (day.length === 0) return null;
    const opens = day.map((h) => h.opens_at.slice(0, 5)).sort()[0];
    const closes = day.map((h) => h.closes_at.slice(0, 5)).sort().at(-1)!;
    return { opens, closes };
  });
}

/** "Mon–Sat · 10:00–20:00" style summary of one barber's week. */
export function summarizeWeek(hours: Range[]): string {
  if (hours.length === 0) return 'No hours set, so not bookable';
  const days = [...new Set(hours.map((h) => h.weekday))].sort((a, b) => a - b);
  const ranges = [...new Set(hours.map((h) => `${h.opens_at.slice(0, 5)}–${h.closes_at.slice(0, 5)}`))];
  // Read the week Monday first so Mon–Sat is a run, with Sunday at the end.
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  const positions = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const consecutive = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  const dayText =
    days.length === 7
      ? 'Every day'
      : consecutive && ordered.length > 2
        ? `${WEEKDAYS[ordered[0]]}–${WEEKDAYS[ordered[ordered.length - 1]]}`
        : ordered.map((d) => WEEKDAYS[d]).join(', ');
  return `${dayText} · ${ranges.length === 1 ? ranges[0] : 'varied hours'}`;
}
