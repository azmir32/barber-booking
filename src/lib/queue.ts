// The walk-in queue: at a shop that takes walk-ins in turn, customers join
// today's queue from its page and the shop calls them in order, then starts
// their cut as a booking. The server keeps the queue (join_queue and the
// rest in supabase/migrations); this is the wording, the estimate, and which
// barber can take someone now.

import { getLang, t } from './lang.ts';
import { clockLabel, dayBounds, formatDuration, formatTime, localDateString, noBreak } from './time.ts';
import type { Barber, Booking, WorkingHours } from './types.ts';

/** How often a waiting customer's screen asks for their place. */
export const QUEUE_POLL_MS = 30_000;

/** The customer's own place in a shop's queue today. */
export type MyPlace = {
  id: string;
  /** Gone: the shop took them off in the last hour, so they are told. */
  state: 'waiting' | 'called' | 'gone';
  /** Why it went: not here when called, or taken off while waiting. */
  gone_reason: 'not_here' | 'removed' | null;
  called_at: string | null;
  service_id: string | null;
  barber_id: string | null;
  created_at: string;
  /** 1 for next; null once called or gone. */
  place: number | null;
  /** About how many minutes until their turn; null once called or gone. */
  estimate_min: number | null;
};

/** What queue_status says about a shop's queue. */
export type QueueStatus = {
  /** The shop is live, its queue is on, and someone is in now. */
  open: boolean;
  waiting: number;
  /** About how long someone joining now would wait, in minutes. */
  estimate_min: number;
  barbers_in: number;
  mine: MyPlace | null;
};

/** The customer's place with its shop, from my_queue. */
export type MyQueue = MyPlace & {
  shop_id: string;
  service_name: string | null;
  barber_name: string | null;
  shop: {
    name: string;
    slug: string;
    time_zone: string;
    phone: string | null;
    address: string | null;
    /** With address and the point the owner set, for Directions. */
    area: string;
    latitude: number | null;
    longitude: number | null;
  };
};

/** Someone in the shop's queue today, from shop_queue, in order. */
export type Queued = {
  id: string;
  /** The name and number the shop's customer list shows. */
  name: string | null;
  phone: string | null;
  /** Joined from the shop's page, rather than added by the shop. */
  online: boolean;
  service_id: string | null;
  service_name: string | null;
  duration_min: number | null;
  /** Null: any barber. */
  barber_id: string | null;
  barber_name: string | null;
  state: 'waiting' | 'called';
  called_at: string | null;
  created_at: string;
};

/**
 * About how long the cuts waiting take, shared among the barbers in, rounded
 * up to 5 minutes. The same sum as queue_estimate in the migration, which
 * the demo's backend uses too.
 */
export function queueEstimate(minutes: number, barbersIn: number): number {
  if (!(minutes > 0)) return 0;
  return Math.ceil(minutes / Math.max(barbersIn, 1) / 5) * 5;
}

/** "1st", "2nd", "23rd", "11th"; in Malay "pertama", "ke-2". */
export function placeWords(place: number): string {
  if (getLang() === 'ms') return place === 1 ? 'pertama' : `ke-${place}`;
  const tens = place % 100;
  const ones = place % 10;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th';
  return `${place}${suffix}`;
}

/** "You're 2nd in the queue", or next. */
export function placeText(place: number): string {
  return place <= 1 ? t('You’re next in the queue') : t('You’re {place} in the queue', { place: placeWords(place) });
}

/** "You're 2nd in the queue · about 15 min", or next. */
export function placeLine(place: Pick<MyPlace, 'place' | 'estimate_min'>): string {
  const n = place.place ?? 1;
  return n > 1 && place.estimate_min ? `${placeText(n)} · ${aboutText(place.estimate_min)}` : placeText(n);
}

/** "about 40 min", or "no wait". */
export function aboutText(minutes: number): string {
  return minutes > 0 ? t('about {time}', { time: noBreak(formatDuration(minutes)) }) : t('no wait');
}

/** The shop page's line: "3 waiting, about 40 min", or "No one waiting". */
export function queueLine(status: Pick<QueueStatus, 'waiting' | 'estimate_min'>): string {
  return status.waiting > 0
    ? t('{count} waiting, {about}', { count: status.waiting, about: aboutText(status.estimate_min) })
    : t('No one waiting');
}

/** Find a barber's word by a queue shop's open-now line. */
export function queueCount(waiting: number): string {
  return waiting > 0 ? t('{count} waiting', { count: waiting }) : t('No queue');
}

/** The WhatsApp the shop sends someone it calls. */
export function callMessage(name: string | null, shop: string): string {
  return t('Hi {who}, it’s your turn at {shop}. See you in a few minutes!', { who: name || t('Customer'), shop });
}

/** Under someone on the shop's list: "Waiting 12 min", or "Called 3:05 pm". */
export function queuedStatus(q: Pick<Queued, 'state' | 'created_at' | 'called_at'>, now: number, timeZone: string): string {
  if (q.state === 'called' && q.called_at) {
    return t('Called {time}', { time: noBreak(formatTime(q.called_at, timeZone)) });
  }
  const minutes = Math.floor((now - Date.parse(q.created_at)) / 60_000);
  return minutes < 1 ? t('Just joined') : t('Waiting {time}', { time: noBreak(formatDuration(minutes)) });
}

/** "Haircut with Ali", "Haircut, any barber", or "Any barber" when they haven't said. */
export function queuedFor(q: Pick<Queued, 'service_name' | 'barber_name'>): string {
  if (q.service_name) {
    return q.barber_name
      ? t('{service} with {barber}', { service: q.service_name, barber: q.barber_name })
      : t('{service}, any barber', { service: q.service_name });
  }
  return q.barber_name ? t('With {barber}', { barber: q.barber_name }) : t('Any barber');
}

type InBarber = Pick<Barber, 'id' | 'is_active'> & {
  working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[];
};
type InBooking = Pick<Booking, 'barber_id' | 'starts_at' | 'ends_at' | 'status' | 'is_block'>;

const minutesOf = (clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};

/** Today's weekday and the minute of the day now, by the shop's clock. */
function clockNow(now: number, timeZone: string) {
  const today = localDateString(new Date(now), timeZone);
  const midnight = dayBounds(today, timeZone).start.getTime();
  return { weekday: new Date(`${today}T00:00:00Z`).getUTCDay(), midnight, minute: Math.floor((now - midnight) / 60_000) };
}

/**
 * The barbers in now, in the team's order, as barbers_in_now has them:
 * active, inside one of today's working ranges, and without the whole day
 * off. With wholeDay, everyone working today, in now or not, as Start can
 * take them. `bookings` are today's; a closed day has nobody in.
 */
export function barbersInNow<B extends InBarber>(
  barbers: B[],
  bookings: InBooking[],
  now: number,
  timeZone: string,
  closed = false,
  wholeDay = false,
): B[] {
  if (closed) return [];
  const { weekday, minute } = clockNow(now, timeZone);
  return barbers.filter(
    (b) =>
      b.is_active &&
      b.working_hours.some(
        (h) =>
          h.weekday === weekday &&
          (wholeDay || (minutesOf(h.opens_at) <= minute && minute < minutesOf(h.closes_at))),
      ) &&
      !bookings.some(
        (x) =>
          x.barber_id === b.id &&
          x.is_block &&
          x.status === 'confirmed' &&
          Date.parse(x.ends_at) - Date.parse(x.starts_at) >= 24 * 60 * 60_000,
      ),
  );
}

/**
 * When the first of these barbers is next in today, after now: the end of a
 * break, or a later start. Null when none of them is in again today. Breaks
 * only: like barbersInNow, it doesn't look at days off or bookings.
 */
export function nextInToday(
  barbers: InBarber[],
  now: number,
  timeZone: string,
): { at: number; time: string } | null {
  const { weekday, midnight, minute } = clockNow(now, timeZone);
  const starts = barbers
    .filter((b) => b.is_active)
    .flatMap((b) => b.working_hours)
    .filter((h) => h.weekday === weekday && minutesOf(h.opens_at) > minute)
    .map((h) => minutesOf(h.opens_at));
  if (starts.length === 0) return null;
  const first = Math.min(...starts);
  return { at: midnight + first * 60_000, time: clockLabel(Math.floor(first / 60), first % 60) };
}

/**
 * Who Start offers first, from those it can pick (the barbers in now, or
 * past closing everyone working today): the barber they asked for, else the
 * first one with nothing booked from now until the cut would end. Null when
 * there is nobody to pick.
 */
export function firstFree<B extends Pick<Barber, 'id'>>(
  inNow: B[],
  askedFor: string | null,
  minutes: number,
  bookings: InBooking[],
  now: number,
): B | null {
  const asked = inNow.find((b) => b.id === askedFor);
  if (asked) return asked;
  return inNow.find((b) => !clashFor(b.id, minutes, bookings, now)) ?? inNow[0] ?? null;
}

/**
 * The first of a barber's bookings (or blocks) in the way of a cut started
 * now, the minute as start_from_queue takes it; null when they are free.
 */
export function clashFor<X extends InBooking>(barberId: string, minutes: number, bookings: X[], now: number): X | null {
  const start = Math.floor(now / 60_000) * 60_000;
  const end = start + minutes * 60_000;
  const clashes = bookings.filter(
    (x) =>
      x.barber_id === barberId &&
      x.status !== 'cancelled' &&
      Date.parse(x.starts_at) < end &&
      start < Date.parse(x.ends_at),
  );
  return clashes.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] ?? null;
}

/** Beside a barber Start can pick: "Free", "Busy until 3:45 pm" or "Booked 4:00 pm". */
export function freeText(clash: InBooking | null, now: number, timeZone: string): string {
  if (!clash) return t('Free');
  return Date.parse(clash.starts_at) <= Math.floor(now / 60_000) * 60_000
    ? t('Busy until {time}', { time: noBreak(formatTime(clash.ends_at, timeZone)) })
    : t('Booked {time}', { time: noBreak(formatTime(clash.starts_at, timeZone)) });
}

/**
 * Start's refusal in the customer's language and clock: the server names the
 * barber and the time in English, and gives the time itself as the detail.
 */
export function startError(error: { message: string; details?: string | null }, timeZone: string): string | null {
  const at = error.details && !Number.isNaN(Date.parse(error.details)) ? error.details : null;
  if (!at) return null;
  const time = noBreak(formatTime(at, timeZone));
  const busy = /^(.+) is busy until .+\. Pick another barber\.$/.exec(error.message);
  if (busy) return t('{barber} is busy until {time}. Pick another barber.', { barber: busy[1], time });
  const before = /^(.+) has an? .+ booking before this cut would finish\. Pick another barber\.$/.exec(error.message);
  if (before) {
    const vars = { barber: before[1], time };
    // "an 8:00 am", "an 11:30 am": said with a vowel.
    return /^(8|11)\D/.test(time)
      ? t('{barber} has an {time} booking before this cut would finish. Pick another barber.', vars)
      : t('{barber} has a {time} booking before this cut would finish. Pick another barber.', vars);
  }
  return null;
}
