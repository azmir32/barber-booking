// Working-hours helpers shared by the barber and customer screens.

import { t } from './lang.ts';
import {
  addDays,
  clockLabel,
  DEFAULT_TIME_ZONE,
  formatTime,
  localClock,
  localDateString,
  normalizeTime,
} from './time.ts';
import { WEEKDAYS, type WorkingHours } from './types.ts';

type Range = Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>;

/** Monday first, the way most people read a week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** "20:00" or "20:00:00" -> "8:00 pm" ("8.00 malam" in Malay). */
export function formatClock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return clockLabel(h, m);
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

export type OpenStatus = { state: 'open' | 'later' | 'closed'; label: string };

/**
 * Whether a shop is open right now, from today's first opening and last
 * closing time in its zone ("10:00" or "10:00:00", null when nobody works
 * today): "Opens 10:00 am", "Open now · until 8:00 pm" or "Closed today".
 * Breaks don't count, so a shop on its lunch break still reads as open.
 */
export function openStatus(
  opensToday: string | null,
  closesToday: string | null,
  now: Date | number = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): OpenStatus {
  const clock = localClock(new Date(now), timeZone);
  const opens = opensToday?.slice(0, 5);
  const closes = closesToday?.slice(0, 5);
  if (!opens || !closes || clock >= closes) return { state: 'closed', label: t('Closed today') };
  if (clock < opens) return { state: 'later', label: t('Opens {time}', { time: formatClock(opens) }) };
  return { state: 'open', label: t('Open now · until {time}', { time: formatClock(closes) }) };
}

/** How close a free time has to be to read as "Free now". */
const FREE_NOW_MS = 15 * 60_000;

/**
 * The line under a listed shop's open status, from its earliest free start
 * today or tomorrow: "Free now" when that is within 15 minutes and the shop
 * is open, else "Next free: today, 3:15 pm" or "Next free: tomorrow, 10:00 am".
 * Null when there is none or it has passed, for a time today when the open
 * line says "Closed today", so the two lines never disagree, and for the
 * opening time itself, which the open line already gives.
 */
export function nextFreeLine(
  nextFreeAt: string | null,
  open: OpenStatus['state'],
  now: Date | number = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  opensToday: string | null = null,
): { soon: boolean; label: string } | null {
  const at = nextFreeAt ? Date.parse(nextFreeAt) : NaN;
  const current = new Date(now).getTime();
  if (!(at > current)) return null;
  const today = localDateString(new Date(current), timeZone);
  const day = localDateString(new Date(at), timeZone);
  const time = formatTime(new Date(at), timeZone);
  if (day === addDays(today, 1)) return { soon: false, label: t('Next free: tomorrow, {time}', { time }) };
  if (day !== today || open === 'closed') return null;
  if (open === 'later' && localClock(new Date(at), timeZone) === opensToday?.slice(0, 5)) return null;
  if (open === 'open' && at - current <= FREE_NOW_MS) return { soon: true, label: t('Free now') };
  return { soon: false, label: t('Next free: today, {time}', { time }) };
}

/** "10:00 am–8:00 pm". */
const clockRange = (from: string, to: string) => `${formatClock(from)}–${formatClock(to)}`;

/** "Mon–Sat", "Mon, Wed, Fri" or "Every day". */
function dayNames(days: number[]): string {
  if (days.length === 7) return t('Every day');
  // Read the week Monday first so Mon–Sat is a run, with Sunday at the end.
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  const positions = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const consecutive = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  const name = (d: number) => t(WEEKDAYS[d]);
  return consecutive && ordered.length > 2
    ? `${name(ordered[0])}–${name(ordered[ordered.length - 1])}`
    : ordered.map(name).join(', ');
}

/**
 * One barber's week, breaks included so a missing Friday prayers break is
 * easy to spot: "Mon–Sat · 10:00 am–8:00 pm · Fri break 12:45 pm–2:30 pm".
 */
export function summarizeWeek(hours: Range[]): string {
  if (hours.length === 0) return t('No hours set, so not bookable');
  const days = WEEK_ORDER.filter((d) => hours.some((h) => h.weekday === d));
  const spans = shopWeek(hours);
  const ranges = [...new Set(days.map((d) => clockRange(spans[d]!.opens, spans[d]!.closes)))];
  const parts = [dayNames(days), ranges.length === 1 ? ranges[0] : t('varied hours')];
  // The gaps between a day's ranges are its breaks; days with the same break share a line.
  const breaks = new Map<string, number[]>();
  for (const d of days) {
    const day = hours.filter((h) => h.weekday === d).sort((a, b) => a.opens_at.localeCompare(b.opens_at));
    const gaps = day.slice(1).flatMap((h, i) => {
      const from = day[i].closes_at.slice(0, 5);
      const to = h.opens_at.slice(0, 5);
      return from < to ? [clockRange(from, to)] : [];
    });
    if (gaps.length === 0) continue;
    const time = gaps.join(', ');
    breaks.set(time, [...(breaks.get(time) ?? []), d]);
  }
  for (const [time, breakDays] of breaks) {
    parts.push(
      breakDays.length === days.length
        ? t('break {time}', { time })
        : t('{days} break {time}', { days: dayNames(breakDays), time }),
    );
  }
  return parts.join(' · ');
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
  if (!opens || !closes) return t('use times like 09:00 or 21:30.');
  if (closes <= opens) return t('closing time must be after opening time.');
  if (!plan.hasBreak) return [{ opens_at: opens, closes_at: closes }];
  const from = normalizeTime(plan.breakFrom);
  const to = normalizeTime(plan.breakTo);
  if (!from || !to) return t('use times like 13:00 for the break.');
  if (!(opens < from && from < to && to < closes)) return t('the break must sit inside opening hours.');
  return [
    { opens_at: opens, closes_at: from },
    { opens_at: to, closes_at: closes },
  ];
}
