// Shop-wide closed days (e.g. Hari Raya), as the barber sees them on My shop.

import { addDays, formatDay } from './time.ts';

/** A day shop_closed_days returns; is_closure is false for a day every barber just happens to have off. */
export type ClosedDay = { day: string; reason: string | null; is_closure?: boolean };
export type Closure = { from: string; to: string; days: number; reason: string | null };

/** Joins back-to-back closed days with the same reason into one closure. */
export function groupClosures(days: ClosedDay[]): Closure[] {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const runs: Closure[] = [];
  for (const { day, reason } of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === day && last.reason === reason) {
      last.to = day;
      last.days += 1;
    } else {
      runs.push({ from: day, to: day, days: 1, reason });
    }
  }
  return runs;
}

/** "Fri, 20 Mar" or "Fri, 20 Mar – Sun, 22 Mar" for YYYY-MM-DD dates. */
export function dateRange(from: string, to: string): string {
  const day = (d: string) => formatDay(`${d}T12:00:00Z`, 'UTC');
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}
