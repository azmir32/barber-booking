// The shop's customer list: how long since someone's last cut, said the way
// people say it, and the WhatsApp message that asks them back.

import { t } from './lang.ts';
import { localDateString } from './time.ts';

/**
 * What a walk-in added without a name is saved as. Not translated, so
 * shop_customers (supabase/migrations) can leave them out of the list.
 */
export const WALK_IN = 'Walk-in';

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

/** "12 days", "a week", "6 weeks" or "3 months", to the nearest. */
function roughly(days: number): string {
  if (days === 1) return t('1 day');
  if (days === 7) return t('a week');
  if (days < 14) return t('{count} days', { count: days });
  if (days < 60) return t('{count} weeks', { count: Math.round(days / 7) });
  return t('{count} months', { count: Math.round(days / 30.4) });
}

/**
 * "5 days", "a week", "6 weeks", "3 months" or "over a year". Rounded the
 * same way as usualGapLabel, so someone due never reads as "Last cut 3 weeks
 * ago · Comes about every 4 weeks".
 */
export function timeSpan(days: number): string {
  return days < 365 ? roughly(days) : t('over a year');
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
  return days === 7 ? t('Comes about once a week') : t('Comes about every {time}', { time: roughly(days) });
}

/**
 * The WhatsApp message asking someone back for a cut, saying how long it has
 * been the way their card does, with the shop's booking link when it has a
 * web one (an app link only opens for people who have the app). Someone with
 * no name on record gets a plain "Hi".
 */
export function inviteMessage(
  vars: { name: string | null; shop: string; link: string },
  lastVisitAt: string,
  now: number,
  timeZone: string,
): string {
  const time = timeSpan(daysSince(lastVisitAt, now, timeZone));
  const text = vars.name
    ? t('Hi {name}, it’s been {time} since your last cut at {shop}. Want to book a time?', {
        name: vars.name,
        shop: vars.shop,
        time,
      })
    : t('Hi, it’s been {time} since your last cut at {shop}. Want to book a time?', { shop: vars.shop, time });
  return /^https?:\/\//.test(vars.link) ? `${text} ${vars.link}` : text;
}
