// Shop-wide closed days (e.g. Hari Raya), as the barber sees them on My shop.

import { addDays, formatDay } from './time.ts';

/**
 * A day shop_closed_days returns; is_closure is false for a day everyone who works it just happens to have
 * off, and barber_id is set when only that barber has the whole day off.
 */
export type ClosedDay = { day: string; reason: string | null; is_closure?: boolean; barber_id?: string | null };
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

/**
 * The days a shop's page still has to ask shop_closed_days for. Its one
 * request (shop_page) counts the 14 days from the server's date, and the day
 * strip counts them from the phone's: they agree, and nothing more is asked,
 * unless the phone's clock is a few minutes off around midnight. Then the
 * strip's own days are asked for, so neither end of it loses its closed days
 * and barbers off.
 */
export function stripToAsk(answeredFrom: string, strip: { date: string }[]): { from: string; to: string } | null {
  if (strip.length === 0 || strip[0].date === answeredFrom) return null;
  return { from: strip[0].date, to: strip[strip.length - 1].date };
}

/** "Fri, 20 Mar" or "Fri, 20 Mar – Sun, 22 Mar" for YYYY-MM-DD dates. */
export function dateRange(from: string, to: string): string {
  const day = (d: string) => formatDay(`${d}T12:00:00Z`, 'UTC');
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}
