// Working-hours helpers shared by the barber and customer screens.

import { normalizeTime } from './time.ts';
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

/** "Mon–Sat · 10:00–20:00" style summary of one barber's week (breaks aside). */
export function summarizeWeek(hours: Range[]): string {
  if (hours.length === 0) return 'No hours set, so not bookable';
  const days = [...new Set(hours.map((h) => h.weekday))].sort((a, b) => a - b);
  const spans = shopWeek(hours);
  const ranges = [...new Set(days.map((d) => `${spans[d]!.opens}–${spans[d]!.closes}`))];
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

/** One day in the hours editor: open or off, with an optional break. */
export type DayPlan = {
  open: boolean;
  opens: string;
  closes: string;
  hasBreak: boolean;
  breakFrom: string;
  breakTo: string;
};

/** Reads a day's saved ranges back into the editor's shape. */
export function dayPlanFrom(ranges: Pick<Range, 'opens_at' | 'closes_at'>[]): DayPlan {
  const sorted = [...ranges].sort((a, b) => a.opens_at.localeCompare(b.opens_at));
  if (sorted.length === 0) {
    return { open: false, opens: '10:00', closes: '20:00', hasBreak: false, breakFrom: '13:00', breakTo: '14:00' };
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    open: true,
    opens: first.opens_at.slice(0, 5),
    closes: last.closes_at.slice(0, 5),
    hasBreak: sorted.length > 1,
    breakFrom: sorted.length > 1 ? first.closes_at.slice(0, 5) : '13:00',
    breakTo: sorted.length > 1 ? sorted[1].opens_at.slice(0, 5) : '14:00',
  };
}

/**
 * Turns an edited day into the ranges to save, or a sentence saying what
 * is wrong. An open day with a break becomes two ranges.
 */
export function rangesFromPlan(plan: DayPlan): { opens_at: string; closes_at: string }[] | string {
  if (!plan.open) return [];
  const opens = normalizeTime(plan.opens);
  const closes = normalizeTime(plan.closes);
  if (!opens || !closes) return 'use times like 09:00 or 21:30.';
  if (closes <= opens) return 'closing time must be after opening time.';
  if (!plan.hasBreak) return [{ opens_at: opens, closes_at: closes }];
  const from = normalizeTime(plan.breakFrom);
  const to = normalizeTime(plan.breakTo);
  if (!from || !to) return 'use times like 13:00 for the break.';
  if (!(opens < from && from < to && to < closes)) return 'the break must sit inside opening hours.';
  return [
    { opens_at: opens, closes_at: from },
    { opens_at: to, closes_at: closes },
  ];
}
