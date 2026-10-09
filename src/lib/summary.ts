// The shop owner's takings summary (barber/summary.tsx): which days a period
// covers on the shop's clock, how it compares with the period before, and
// the numbers behind its charts.

import { dateRange } from './closures.ts';
import { dateLocale, t } from './lang.ts';
import { addDays, clockLabel, formatPrice, localDateString } from './time.ts';

export type Period = 'week' | 'last-week' | 'month';

type Totals = { done: number; takings: number; no_shows: number; no_show_value: number; cancelled: number };

/** What shop_summary returns. */
export type Summary = {
  from: string;
  to: string;
  totals: Totals & { to_come: number; to_come_value: number; unmarked: number; unmarked_value: number };
  /** Counted only up to `until` while the period is still running. */
  previous: Totals & { from: string; to: string; until: string };
  days: { day: string; bookings: number; done: number; takings: number }[];
  hours: { hour: number; bookings: number }[];
  barbers: { barber_id: string; name: string; bookings: number; done: number; takings: number; no_shows: number }[];
  services: { name: string; done: number; takings: number }[];
};

/** Monday of the week a YYYY-MM-DD date is in: weeks start on Monday in Malaysia. */
export function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** The first and last day of a period (YYYY-MM-DD, both included) on the shop's clock. */
export function periodDays(period: Period, now: number, timeZone: string): { from: string; to: string } {
  const today = localDateString(new Date(now), timeZone);
  if (period === 'month') {
    const [y, m] = today.split('-').map(Number);
    return { from: `${today.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  }
  const monday = addDays(weekStart(today), period === 'last-week' ? -7 : 0);
  return { from: monday, to: addDays(monday, 6) };
}

/** "Mon, 5 Oct – Sun, 11 Oct" for a week, "October 2026" for a month. */
export function periodTitle(period: Period, from: string, to: string): string {
  if (period !== 'month') return dateRange(from, to);
  return new Intl.DateTimeFormat(dateLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${from}T12:00:00Z`),
  );
}

/** Whether anyone booked in the period at all, cancelled bookings included. */
export function hasBookings(summary: Summary): boolean {
  return summary.totals.cancelled > 0 || summary.days.some((d) => d.bookings > 0);
}

/** The line on My shop: "This week: RM1,240 from 42 cuts". */
export function weekLine(totals: Pick<Totals, 'done' | 'takings'>): string {
  const money = formatPrice(totals.takings);
  if (totals.done === 0) return t('This week: no cuts marked done yet');
  if (totals.done === 1) return t('This week: {money} from 1 cut', { money });
  return t('This week: {money} from {count} cuts', { money, count: totals.done });
}

/** What the period before is called in a comparison. A running period is compared up to the same point. */
export function previousLabel(period: Period): string {
  if (period === 'week') return t('this time last week');
  if (period === 'last-week') return t('the week before');
  return t('this time last month');
}

export type Change = { direction: 'up' | 'down' | 'same'; label: string };

/** "RM120 more than this time last week". */
export function moneyChange(current: number, before: number, period: Period): Change {
  const then = previousLabel(period);
  const diff = Math.round((current - before) * 100) / 100;
  if (diff > 0) return { direction: 'up', label: t('{money} more than {then}', { money: formatPrice(diff), then }) };
  if (diff < 0) return { direction: 'down', label: t('{money} less than {then}', { money: formatPrice(-diff), then }) };
  return { direction: 'same', label: t('Same as {then}', { then }) };
}

/** "6 more than the week before". */
export function countChange(current: number, before: number, period: Period): Change {
  const then = previousLabel(period);
  const diff = current - before;
  if (diff > 0) return { direction: 'up', label: t('{count} more than {then}', { count: diff, then }) };
  if (diff < 0) return { direction: 'down', label: t('{count} fewer than {then}', { count: -diff, then }) };
  return { direction: 'same', label: t('Same as {then}', { then }) };
}

/** Bookings on each weekday over the period, Monday first. */
export function byWeekday(days: Summary['days']): number[] {
  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) totals[(new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7] += d.bookings;
  return totals;
}

/** Every hour from the first to the last that has bookings, quiet hours in between as 0. */
export function hourRange(hours: Summary['hours']): Summary['hours'] {
  if (hours.length === 0) return [];
  const first = Math.min(...hours.map((h) => h.hour));
  const last = Math.max(...hours.map((h) => h.hour));
  return Array.from({ length: last - first + 1 }, (_, i) => ({
    hour: first + i,
    bookings: hours.find((h) => h.hour === first + i)?.bookings ?? 0,
  }));
}

/** Where the biggest value is: every place, on a tie, and none when there is nothing. */
export function busiest(values: number[]): number[] {
  const top = Math.max(0, ...values);
  return top > 0 ? values.flatMap((v, i) => (v === top ? [i] : [])) : [];
}

/** Runs of back-to-back busiest hours, each as [its first hour, the hour after its last]. */
export function peakRanges(hours: Summary['hours']): [number, number][] {
  const ranges: [number, number][] = [];
  for (const i of busiest(hours.map((h) => h.bookings))) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === hours[i].hour) last[1] += 1;
    else ranges.push([hours[i].hour, hours[i].hour + 1]);
  }
  return ranges;
}

/** "Friday and Saturday", or "Monday, Friday and Saturday". */
export function joinAnd(items: string[]): string {
  if (items.length < 2) return items.join('');
  return t('{list} and {last}', { list: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

/** "Saturday" or "Sabtu", for a weekday counted from Monday = 0. */
export function weekdayName(mondayFirst: number): string {
  // 1 January 2024 was a Monday.
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 1 + mondayFirst)),
  );
}

/** The hour under a bar: "10", "12", "1", on the 12-hour clock like the rest of the app. */
export const hourMark = (hour: number) => String(hour % 12 === 0 ? 12 : hour % 12);

/** "5:00 pm" for the start of an hour. */
export const hourLabel = (hour: number) => clockLabel(hour, 0);
