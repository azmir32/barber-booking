// The shop's customer list: how long since someone's last cut, said the way
// people say it, and the WhatsApp message that asks them back.

import { t } from './lang.ts';
import { localDateString } from './time.ts';

/** One row of shop_customers (supabase/migrations). */
export type ShopCustomer = {
  /** "c:" and the account for online customers; "p:" and the number, or "n:" and the name, for guests. */
  customer_key: string;
  customer_id: string | null;
  name: string | null;
  phone: string | null;
  visits: number;
  no_shows: number;
  last_visit_at: string | null;
  next_booking_at: string | null;
  usual_gap_days: number;
  is_due: boolean;
  /** Everyone the search matches, not just this page. */
  total_count: number;
  due_count: number;
};

/** Calendar days from an instant to now on the shop's clock, so last night is "yesterday" this morning. */
export function daysSince(at: string, now: number, timeZone: string): number {
  const day = (d: Date) => Date.parse(`${localDateString(d, timeZone)}T00:00:00Z`);
  return Math.round((day(new Date(now)) - day(new Date(at))) / 86_400_000);
}

/** "5 days", "a week", "6 weeks", "3 months" or "over a year". */
export function timeSpan(days: number): string {
  if (days < 7) return days === 1 ? t('1 day') : t('{count} days', { count: days });
  if (days < 14) return t('a week');
  if (days < 60) return t('{count} weeks', { count: Math.floor(days / 7) });
  if (days < 365) return t('{count} months', { count: Math.round(days / 30.4) });
  return t('over a year');
}

/** "14 customers · 4 due for a cut". */
export function customerCounts(total: number, due: number): string {
  const people = total === 1 ? t('1 customer') : t('{count} customers', { count: total });
  return due > 0 ? `${people} · ${t('{count} due for a cut', { count: due })}` : people;
}

export function lastCutLabel(lastVisitAt: string | null, now: number, timeZone: string): string {
  if (!lastVisitAt) return t('No visits yet');
  const days = daysSince(lastVisitAt, now, timeZone);
  if (days <= 0) return t('Last cut today');
  if (days === 1) return t('Last cut yesterday');
  return t('Last cut {time} ago', { time: timeSpan(days) });
}

export function visitsLabel(visits: number): string {
  return visits === 1 ? t('1 visit') : t('{count} visits', { count: visits });
}

export function noShowsLabel(noShows: number): string {
  return noShows === 1 ? t('1 no-show') : t('{count} no-shows', { count: noShows });
}

/** How often they come, in round numbers: the gap is a median, not a promise. */
export function usualGapLabel(days: number): string {
  if (days < 14) {
    return days === 7 ? t('Comes about once a week') : t('Comes about every {time}', { time: t('{count} days', { count: days }) });
  }
  const span =
    days < 60 ? t('{count} weeks', { count: Math.round(days / 7) }) : t('{count} months', { count: Math.round(days / 30.4) });
  return t('Comes about every {time}', { time: span });
}

/**
 * The WhatsApp message asking someone due for a cut to book, with the shop's
 * booking link when it has a web one (an app link only opens for people who
 * have the app).
 */
export function inviteMessage(
  vars: { name: string; shop: string; link: string },
  lastVisitAt: string,
  now: number,
  timeZone: string,
): string {
  const weeks = Math.floor(daysSince(lastVisitAt, now, timeZone) / 7);
  const text =
    weeks <= 1
      ? t('Hi {name}, it’s been a week since your last cut at {shop}. Want to book a time?', vars)
      : t('Hi {name}, it’s been {weeks} weeks since your last cut at {shop}. Want to book a time?', { ...vars, weeks });
  return /^https?:\/\//.test(vars.link) ? `${text} ${vars.link}` : text;
}
