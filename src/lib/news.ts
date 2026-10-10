// What customers booked, moved or cancelled since this phone last looked at
// the shop's bookings: the number on the Bookings tab and the card at the top
// of it. The server counts (shop_changes in supabase/migrations); this is the
// wording, and which times count as "since".

import { t } from './lang.ts';
import { addDays, formatDay, formatTime, localDateString, noBreak } from './time.ts';

export type CustomerChange = 'booked' | 'moved' | 'cancelled';

/** One line of shop_changes. */
export type ShopChange = {
  booking_id: string;
  barber_id: string;
  barber_name: string;
  customer_name: string | null;
  service_name: string;
  starts_at: string;
  change: CustomerChange;
  changed_at: string;
  /** A cancelled time still to come that nobody has taken since. */
  chair_free: boolean;
};

export type ShopChanges = {
  /** Where the count started: the time asked from, or 24 hours ago, and never more than a week back. */
  since: string;
  count: number;
  /** The newest change's time, kept once they are seen to ask from next time. Null with none. */
  latest: string | null;
  /** The newest few, newest first. */
  changes: ShopChange[];
};

/** Lines on the card before "And 3 more"; also how many the badge's call asks for. */
export const NEWS_LINES = 5;

/** The name delete_my_account leaves on a deleted customer's bookings. */
const DELETED_ACCOUNT = 'Deleted account';

/** Where this phone keeps the newest change it has seen, per shop. */
export const seenKey = (shopId: string) => `potongku.changesSeen.${shopId}`;

/** The number on the tab: none without news, and at most "9+" so it fits on the icon. */
export function badgeText(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 9 ? '9+' : String(count);
}

/** What a screen reader says after the tab's name, since the badge alone is just a number. */
export function changesLabel(count: number): string {
  return count === 1 ? t('1 change since you last looked') : t('{count} changes since you last looked', { count });
}

/**
 * An instant as a number to the microsecond. Postgres keeps microseconds and
 * Date only milliseconds, and a booking made a fraction of a millisecond
 * after the last change seen is still new.
 */
export function micros(at: string): number {
  const fraction = /\.(\d+)/.exec(at);
  const digits = fraction?.[1] ?? '';
  const ms = Date.parse(fraction ? at.replace(fraction[0], `.${digits.slice(0, 3).padEnd(3, '0')}`) : at);
  return ms * 1000 + Number(digits.slice(3, 6).padEnd(3, '0'));
}

/** Whether `at` comes after `mark`. */
export const isAfter = (at: string, mark: string) => micros(at) > micros(mark);

/**
 * What to keep once the barber taps Got it: the newest change the server
 * returned, never the phone's clock, which can be wrong. Never goes back.
 */
export function nextSeen(seen: string | null, news: Pick<ShopChanges, 'latest'> | null): string | null {
  const latest = news?.latest ?? null;
  if (!latest) return seen;
  return !seen || isAfter(latest, seen) ? latest : seen;
}

/**
 * The time a booking counts as new after: where the server started counting,
 * so the cards agree with the badge (a phone that has never looked, or not
 * for over a week, gets a bound from the server). Until it answers, the
 * newest change this phone has seen.
 */
export function seenMark(seen: string | null, news: Pick<ShopChanges, 'since'> | null): string | null {
  return news?.since ?? seen;
}

/** "New" on a card the customer booked since the mark, "Moved" on one they moved; else nothing. */
export function changeTag(
  b: { customer_change?: CustomerChange | null; customer_changed_at?: string | null; status: string },
  mark: string | null,
): { kind: 'new' | 'moved'; label: string } | null {
  if (!mark || !b.customer_changed_at || b.status === 'cancelled' || !isAfter(b.customer_changed_at, mark)) return null;
  if (b.customer_change === 'booked') return { kind: 'new', label: t('New') };
  if (b.customer_change === 'moved') return { kind: 'moved', label: t('Moved') };
  return null;
}

/** "today at 5:30 pm", "tomorrow at 4:30 pm" or "Sun, 13 Oct at 11:00 am", by the shop's clock. */
export function whenText(at: string, now: number, timeZone: string): string {
  const day = localDateString(new Date(at), timeZone);
  const today = localDateString(new Date(now), timeZone);
  const time = noBreak(formatTime(at, timeZone));
  if (day === today) return t('today at {time}', { time });
  if (day === addDays(today, 1)) return t('tomorrow at {time}', { time });
  if (day === addDays(today, -1)) return t('yesterday at {time}', { time });
  return t('{day} at {time}', { day: noBreak(formatDay(at, timeZone)), time });
}

/**
 * One change as a sentence: "Hakim booked Fade for tomorrow at 4:30 pm with
 * Danial", "Wei Jie cancelled today at 5:30 pm with Ali, so that chair is
 * free" or "Aiman moved to Sun, 13 Oct at 11:00 am". The barber is named
 * when the shop has more than one.
 */
export function changeLine(c: ShopChange, now: number, timeZone: string, showBarber: boolean): string {
  const vars = {
    name: c.customer_name === DELETED_ACCOUNT ? t('Deleted account') : c.customer_name || t('Customer'),
    service: c.service_name,
    when: whenText(c.starts_at, now, timeZone),
    barber: c.barber_name,
  };
  if (c.change === 'booked') {
    return showBarber ? t('{name} booked {service} for {when} with {barber}', vars) : t('{name} booked {service} for {when}', vars);
  }
  if (c.change === 'moved') {
    return showBarber ? t('{name} moved to {when} with {barber}', vars) : t('{name} moved to {when}', vars);
  }
  // Worth a walk-in only while the time is still to come and nobody has taken it.
  if (c.chair_free && Date.parse(c.starts_at) > now) {
    return showBarber
      ? t('{name} cancelled {when} with {barber}, so that chair is free', vars)
      : t('{name} cancelled {when}, so that chair is free', vars);
  }
  return showBarber ? t('{name} cancelled {when} with {barber}', vars) : t('{name} cancelled {when}', vars);
}

/** "Just now", "5 min ago", "2 hr ago" or "3 days ago". */
export function ago(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('{count} min ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{count} hr ago', { count: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('1 day ago') : t('{count} days ago', { count: days });
}

/** Under the card's lines, for changes it has no room for. */
export function moreText(count: number, shown: number): string | null {
  const more = count - shown;
  return more > 0 ? t('And {count} more', { count: more }) : null;
}
