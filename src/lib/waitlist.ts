// The waiting list: a customer who finds a day full asks to hear if a time
// frees up, and the shop WhatsApps them one. The server keeps the list
// (join_waitlist and the rest in supabase/migrations); this is the wording,
// which free time fits a request, and which requests are still open.

import { SLOT_MINUTES } from './chairs.ts';
import { t } from './lang.ts';
import { ago, whenText } from './news.ts';
import { dayBounds, formatDay, formatTime, localDateString, noBreak } from './time.ts';
import type { Barber, Booking, WorkingHours } from './types.ts';

/** One request on the shop's list for a day, from shop_waitlist, oldest first. */
export type ShopWaiting = {
  id: string;
  /** The name and number the shop's customer list shows. */
  name: string | null;
  phone: string | null;
  service_id: string;
  service_name: string;
  duration_min: number;
  /** Null: any barber. */
  barber_id: string | null;
  barber_name: string | null;
  created_at: string;
  /** When someone in the shop last WhatsApped them a time. */
  offered_at: string | null;
};

/** One of the customer's own requests, from my_waitlist, soonest day first. */
export type MyWaiting = {
  id: string;
  shop_id: string;
  /** The shop's own date, YYYY-MM-DD. */
  day: string;
  service_id: string;
  service_name: string;
  barber_id: string | null;
  barber_name: string | null;
  created_at: string;
  shop: { name: string; slug: string; time_zone: string };
};

type FitBarber = Pick<Barber, 'id' | 'name' | 'is_active'> & {
  working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[];
};
type FitBooking = Pick<Booking, 'barber_id' | 'starts_at' | 'ends_at' | 'status'>;

const minutesOf = (clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};

/**
 * The earliest time still to come on `day` that a request could be booked
 * into, found as available_slots finds them: quarter hours from the start of
 * each of the barber's stretches that day, with the whole service done before
 * it ends, clear of everything booked or blocked but not cancelled. With any
 * barber, the earliest of the team's, the team's order breaking a tie. Null
 * when nothing fits. `bookings` are the whole day's, as the Bookings tab loads
 * them; the caller leaves out a day the shop is closed.
 */
export function freeTimeFor<B extends FitBarber>(
  request: Pick<ShopWaiting, 'barber_id' | 'duration_min'>,
  day: string,
  barbers: B[],
  bookings: FitBooking[],
  now: number,
  timeZone: string,
): { barber: B; startsAt: string } | null {
  const midnight = dayBounds(day, timeZone).start.getTime();
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const length = request.duration_min * 60_000;
  let best: { barber: B; at: number } | null = null;
  for (const barber of barbers) {
    if (!barber.is_active || (request.barber_id != null && barber.id !== request.barber_id)) continue;
    // Time blocked off counts as taken, a whole day off too.
    const taken = bookings.filter((b) => b.barber_id === barber.id && b.status !== 'cancelled');
    for (const h of barber.working_hours.filter((x) => x.weekday === weekday)) {
      const last = midnight + minutesOf(h.closes_at) * 60_000 - length;
      for (let at = midnight + minutesOf(h.opens_at) * 60_000; at <= last; at += SLOT_MINUTES * 60_000) {
        if (best && at >= best.at) break;
        if (at <= now) continue;
        const clash = taken.some((b) => Date.parse(b.starts_at) < at + length && at < Date.parse(b.ends_at));
        if (!clash) {
          best = { barber, at };
          break;
        }
      }
    }
  }
  return best ? { barber: best.barber, startsAt: new Date(best.at).toISOString() } : null;
}

/**
 * Whether a full day could still free up for a service: the barber picked
 * (or anyone) works a stretch that day ending late enough to fit it after
 * now. Late in the evening there is nothing left to wait for today.
 */
export function couldFreeUp(
  day: string,
  barbers: FitBarber[],
  barberId: string | null,
  durationMin: number,
  now: number,
  timeZone: string,
): boolean {
  const midnight = dayBounds(day, timeZone).start.getTime();
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return barbers.some(
    (b) =>
      b.is_active &&
      (barberId == null || b.id === barberId) &&
      b.working_hours.some(
        (h) => h.weekday === weekday && midnight + (minutesOf(h.closes_at) - durationMin) * 60_000 > now,
      ),
  );
}

/** "Haircut with Ali", or "Haircut, any barber". */
export function requestService(r: Pick<ShopWaiting, 'service_name' | 'barber_name'>): string {
  return r.barber_name
    ? t('{service} with {barber}', { service: r.service_name, barber: r.barber_name })
    : t('{service}, any barber', { service: r.service_name });
}

/**
 * The WhatsApp the shop sends someone waiting: the free time that fits, or,
 * with none, an opening to find one together.
 */
export function offerMessage({
  request,
  shop,
  day,
  link,
  free,
  timeZone,
}: {
  request: Pick<ShopWaiting, 'name' | 'service_name' | 'barber_name'>;
  shop: string;
  /** YYYY-MM-DD, the shop's own date. */
  day: string;
  /** The shop's booking link. */
  link: string;
  free: { barberName: string; startsAt: string } | null;
  timeZone: string;
}): string {
  const who = request.name || t('Customer');
  const dayText = formatDay(dayBounds(day, timeZone).start, timeZone);
  if (free) {
    const time = formatTime(free.startsAt, timeZone);
    const vars = { who, time, service: request.service_name, barber: free.barberName, day: dayText, shop, link };
    // "an 8:00 am", "an 11:30 am": said with a vowel.
    return /^(8|11)\D/.test(time)
      ? t('Hi {who}, an {time} {service} with {barber} just opened on {day} at {shop}. Want it? Reply here or book at {link}', vars)
      : t('Hi {who}, a {time} {service} with {barber} just opened on {day} at {shop}. Want it? Reply here or book at {link}', vars);
  }
  return t('Hi {who}, this is {shop} about the {service} you asked for on {day}. Reply here and we’ll sort out a time.', {
    who,
    shop,
    service: request.barber_name
      ? t('{service} with {barber}', { service: request.service_name, barber: request.barber_name })
      : request.service_name,
    day: dayText,
  });
}

/** Under a request on the shop's list: "Offered 3:05 pm" once someone has, else "Asked 2 hr ago". */
export function requestStatus(r: Pick<ShopWaiting, 'created_at' | 'offered_at'>, now: number, timeZone: string): string {
  if (r.offered_at) {
    const sameDay = localDateString(new Date(r.offered_at), timeZone) === localDateString(new Date(now), timeZone);
    return sameDay
      ? t('Offered {time}', { time: noBreak(formatTime(r.offered_at, timeZone)) })
      : t('Offered {when}', { when: whenText(r.offered_at, now, timeZone) });
  }
  return now - Date.parse(r.created_at) < 60_000 ? t('Asked just now') : t('Asked {ago}', { ago: ago(r.created_at, now) });
}

/**
 * The customer's requests still open: from today on by each shop's clock,
 * and none for a day they now have a booking at that shop. The server ends
 * both on its own; this keeps a list kept from last time from showing them.
 */
export function openRequests(
  list: MyWaiting[],
  bookings: Pick<Booking, 'shop_id' | 'starts_at' | 'status'>[],
  now: number,
): MyWaiting[] {
  return list.filter(
    (w) =>
      w.day >= localDateString(new Date(now), w.shop.time_zone) &&
      !bookings.some(
        (b) =>
          b.shop_id === w.shop_id &&
          b.status === 'confirmed' &&
          localDateString(new Date(b.starts_at), w.shop.time_zone) === w.day,
      ),
  );
}
