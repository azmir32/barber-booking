// Find a barber for a returning customer: their next cut, and the barbers
// they keep going back to, said the way people say it.

import { daysSince, timeSpan } from './customers.ts';
import { t } from './lang.ts';
import { addDays, formatDay, formatTime, localDateString } from './time.ts';

/** The soonest of the customer's upcoming bookings (my_shops in supabase/migrations). */
export type NextCut = {
  id: string;
  starts_at: string;
  service_name: string;
  barber_name: string | null;
  shop_name: string;
  time_zone: string;
};

/** A shop the customer had cuts at, with their last one there. */
export type MyShop = {
  shop_id: string;
  name: string;
  slug: string;
  time_zone: string;
  /** False while the shop is paused or its free month has ended. */
  is_live: boolean;
  opens_today: string | null;
  closes_today: string | null;
  next_free_at: string | null;
  last_visit_at: string;
  /** Null when the shop has since deleted the service. */
  service_id: string | null;
  service_name: string;
  barber_id: string;
  barber_name: string;
  visits: number;
  usual_gap_days: number;
};

export type MyShops = {
  next: NextCut | null;
  /** All their upcoming bookings, the next one included. */
  upcoming: number;
  /** At most three, the latest cut first. */
  shops: MyShop[];
};

/** "Today, 4:30 pm", "Tomorrow, 4:30 pm" or "Sat, 17 Oct, 4:30 pm", on the shop's clock. */
export function whenLabel(at: string, now: number, timeZone: string): string {
  const today = localDateString(new Date(now), timeZone);
  const day = localDateString(new Date(at), timeZone);
  const name = day === today ? t('Today') : day === addDays(today, 1) ? t('Tomorrow') : formatDay(at, timeZone);
  return `${name}, ${formatTime(at, timeZone)}`;
}

/** "Fade with Danial, 4 weeks ago": the cut Book again repeats. */
export function lastCutLine(shop: Pick<MyShop, 'service_name' | 'barber_name' | 'last_visit_at' | 'time_zone'>, now: number) {
  const vars = { service: shop.service_name, barber: shop.barber_name };
  const days = daysSince(shop.last_visit_at, now, shop.time_zone);
  if (days <= 0) return t('{service} with {barber}, today', vars);
  if (days === 1) return t('{service} with {barber}, yesterday', vars);
  return t('{service} with {barber}, {time} ago', { ...vars, time: timeSpan(days) });
}

/**
 * Whether to say "Due for a cut" on the card of the shop they went to last
 * (only that one: they have had a cut since visiting the others): their
 * usual gap between cuts there has passed, and nothing is booked anywhere.
 * As on the shop's own customer list, someone away three gaps (and at least
 * 90 days) has most likely found another barber, so it stops saying so.
 */
export function isDue(
  shop: Pick<MyShop, 'last_visit_at' | 'usual_gap_days' | 'time_zone'>,
  booked: boolean,
  now: number,
): boolean {
  if (booked) return false;
  const days = daysSince(shop.last_visit_at, now, shop.time_zone);
  return days >= shop.usual_gap_days && days < Math.max(3 * shop.usual_gap_days, 90);
}
