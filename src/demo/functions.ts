// The booking rules: line-by-line ports of the SQL functions in
// supabase/migrations, with the same checks, messages and error codes.
// Like the originals they run with full access (security definer) and
// decide for themselves what the caller may do.

import { kmBetween, shopPoint } from '../lib/distance.ts';
import { toWhatsAppNumber } from '../lib/phone.ts';
import { queueEstimate } from '../lib/queue.ts';
import { firstName, REVIEW_WINDOW_DAYS, reviewName } from '../lib/reviews.ts';
import { addDays, dayBounds, localClock, localDateString } from '../lib/time.ts';
import {
  COLUMNS,
  deleteRows,
  findById,
  insertRow,
  now,
  ownsShop,
  parseTime,
  PgError,
  pgTrim,
  shopIsLive,
  tables,
  toColumnValue,
  updateRows,
  type Row,
} from './db.ts';
import { handleRest, type Caller } from './postgrest.ts';

const BOOKING_HORIZON_DAYS = 60;
const MAX_UPCOMING_PER_SHOP = 4;
const ms = (v: unknown) => Date.parse(String(v));

function parseDate(value: unknown): string {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || addDays(text, 0) !== text) {
    throw new PgError('22007', `invalid input syntax for type date: "${text}"`, 400);
  }
  return text;
}

/** `(day + time) at time zone tz`: the instant a local wall-clock time happens. */
function localInstant(day: string, time: string, tz: string): number {
  const [h, m, s] = time.split(':').map(Number);
  return dayBounds(day, tz).start.getTime() + ((h * 60 + m) * 60 + (s || 0)) * 1000;
}

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const trimmed = (v: unknown) => (v == null ? null : pgTrim(String(v)) || null);
const clash = (bk: Row, barberId: unknown, start: number, end: number) =>
  bk.barber_id === barberId && bk.status !== 'cancelled' && ms(bk.starts_at) < end && start < ms(bk.ends_at);

const WHOLE_DAY_MS = 24 * 60 * 60_000;
/** A day off: a block of a whole day or more. */
const isWholeDayBlock = (b: Row) => b.is_block === true && ms(b.ends_at) - ms(b.starts_at) >= WHOLE_DAY_MS;

/** Runs an insert or update, turning a double booking into the function's own message. */
function guarded<T>(fn: () => T, overlapMessage: string, checkMessage?: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PgError && e.code === '23P01') throw new PgError('P0001', overlapMessage, 400);
    if (checkMessage && e instanceof PgError && e.code === '23514') throw new PgError('P0001', checkMessage, 400);
    throw e;
  }
}

// Finding a barber ------------------------------------------------------------

const blank = (v: unknown) => v == null || pgTrim(String(v)) === '';
const sortKey = (v: unknown) => String(v).toLowerCase();

/** A double precision argument, as PostgREST reads it: null, or a number. */
function float(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new PgError('22P02', `invalid input syntax for type double precision: "${String(value)}"`, 400);
  }
  return n;
}

/**
 * Live shops matching the search and area, a page at a time. Given the
 * customer's position (both halves, on the map), nearest first with each
 * one's distance, and those without a location after the rest by name.
 */
export function findShops(args: Record<string, unknown>) {
  const search = blank(args.p_search) ? null : pgTrim(String(args.p_search)).toLowerCase();
  const area = blank(args.p_area) ? null : pgTrim(String(args.p_area)).toLowerCase();
  const limit = Math.min(Math.max(Number(args.p_limit ?? 20), 1), 50);
  const offset = Math.max(Number(args.p_offset ?? 0), 0);
  const [lat, lng] = [float(args.p_lat), float(args.p_lng)];
  const here =
    lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      ? { latitude: lat, longitude: lng }
      : null;
  const distance = (s: Row) => {
    const point = here && shopPoint(s as { latitude: number | null; longitude: number | null });
    return here && point ? kmBetween(here, point) : null;
  };
  return tables()
    .shops.filter(
      (s) =>
        shopIsLive(s) &&
        (area == null || sortKey(s.area) === area) &&
        (search == null || `${s.name} ${s.area} ${s.address ?? ''}`.toLowerCase().includes(search)),
    )
    .map((s) => ({ s, km: distance(s) }))
    .sort(
      (a, b) =>
        Number(a.km == null) - Number(b.km == null) ||
        (a.km ?? 0) - (b.km ?? 0) ||
        (sortKey(a.s.name) < sortKey(b.s.name) ? -1 : sortKey(a.s.name) > sortKey(b.s.name) ? 1 : 0) ||
        (String(a.s.id) < String(b.s.id) ? -1 : 1),
    )
    .slice(offset, offset + limit)
    .map(({ s, km }) => {
      const prices = tables()
        .services.filter((v) => v.shop_id === s.id && v.is_active)
        .map((v) => Number(v.price));
      const barbers = tables().barbers.filter((b) => b.shop_id === s.id && b.is_active);
      return {
        id: s.id,
        name: s.name,
        slug: s.slug,
        area: s.area,
        address: s.address,
        about: s.about,
        from_price: prices.length ? Math.min(...prices) : null,
        barber_count: barbers.length,
        ...hoursToday(s),
        next_free_at: shopNextFree(s),
        rating_count: s.rating_count,
        // round(sum / count, 1), null without any.
        rating_avg: s.rating_count ? Math.round(((s.rating_sum as number) * 10) / (s.rating_count as number)) / 10 : null,
        distance_km: km,
        latitude: s.latitude ?? null,
        longitude: s.longitude ?? null,
        queue_waiting: s.queue_enabled === true ? waitingAt(s.id, queueToday(s)).length : null,
        photo_thumb: firstPhoto(s.id)?.thumb_path ?? null,
      };
    });
}

/** A shop's first photo, in the order its page shows them. */
function firstPhoto(shopId: unknown): Row | undefined {
  return tables()
    .shop_photos.filter((p) => p.shop_id === shopId)
    .sort(
      (a, b) =>
        Number(a.sort_order) - Number(b.sort_order) ||
        ms(a.created_at) - ms(b.created_at) ||
        (String(a.id) < String(b.id) ? -1 : 1),
    )[0];
}

/**
 * The earliest free start for the shop's shortest service with any barber,
 * today by its own clock or else tomorrow; null when neither has one, or the
 * shop is hidden from the caller.
 */
function shopNextFree(shop: Row, caller: Caller = { uid: null }): string | null {
  const [service] = tables()
    .services.filter((v) => v.shop_id === shop.id && v.is_active)
    .sort(
      (a, b) =>
        Number(a.duration_min) - Number(b.duration_min) ||
        Number(a.sort_order) - Number(b.sort_order) ||
        (String(a.id) < String(b.id) ? -1 : 1),
    );
  if (!service) return null;
  const today = localDateString(new Date(now()), String(shop.time_zone));
  // Tomorrow is only worked out when today has nothing left.
  for (const day of [today, addDays(today, 1)]) {
    const [first] = availableSlots(caller, service.id, day);
    if (first) return first.starts_at;
  }
  return null;
}

/**
 * A shop's hours today by its own clock: the first barber in to the last one
 * out, leaving out barbers with the whole day off. Nulls when nobody is in,
 * or the shop is closed for the day.
 */
function hoursToday(shop: Row): { opens_today: string | null; closes_today: string | null } {
  const tz = String(shop.time_zone);
  const date = localDateString(new Date(now()), tz);
  const { start, end } = dayBounds(date, tz);
  const closed = tables().shop_closures.some((c) => c.shop_id === shop.id && c.day === date);
  const dayOff = (barberId: unknown) =>
    tables().bookings.some(
      (bk) =>
        bk.shop_id === shop.id &&
        bk.barber_id === barberId &&
        bk.status === 'confirmed' &&
        isWholeDayBlock(bk) &&
        ms(bk.starts_at) >= start.getTime() &&
        ms(bk.starts_at) < end.getTime(),
    );
  const weekday = weekdayOf(date);
  const team = new Set(tables().barbers.filter((b) => b.shop_id === shop.id && b.is_active).map((b) => b.id));
  const hours = closed
    ? []
    : tables().working_hours.filter((wh) => wh.weekday === weekday && team.has(wh.barber_id) && !dayOff(wh.barber_id));
  return {
    opens_today: hours.length ? hours.map((wh) => String(wh.opens_at)).sort()[0] : null,
    closes_today: hours.length ? hours.map((wh) => String(wh.closes_at)).sort().at(-1)! : null,
  };
}

export function shopHoursToday(c: Caller, shopId: unknown) {
  const shop = findById('shops', shopId);
  const visible = shop != null && (shopIsLive(shop) || (c.uid != null && shop.owner_id === c.uid));
  return [visible ? hoursToday(shop) : { opens_today: null, closes_today: null }];
}

/** A booking link's shop even when it is hidden, so the page can say it isn't live. */
export function shopPublicStatus(slug: unknown) {
  return tables()
    .shops.filter((s) => slug != null && s.slug === String(slug))
    .map((s) => ({ name: s.name, phone: s.phone, is_live: shopIsLive(s) }));
}

export function shopAreas() {
  const groups = new Map<string, Map<string, number>>();
  for (const s of tables().shops.filter(shopIsLive)) {
    const spellings = groups.get(sortKey(s.area)) ?? new Map<string, number>();
    spellings.set(String(s.area), (spellings.get(String(s.area)) ?? 0) + 1);
    groups.set(sortKey(s.area), spellings);
  }
  return [...groups.entries()]
    .map(([key, spellings]) => {
      // mode(): the most common spelling, the first in order on a tie.
      const [area] = [...spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      return { key, area, shops: [...spellings.values()].reduce((n, c) => n + c, 0) };
    })
    .sort((a, b) => b.shops - a.shops || (a.key < b.key ? -1 : 1))
    .map(({ area, shops }) => ({ area, shops }));
}

// Booking ----------------------------------------------------------------------

const TAKEN = 'Sorry, that time was just taken. Please pick another.';

/** How many bookings a barber has on a local day, so "any barber" shares work across chairs. */
const busyThatDay = (day: string, tz: string) => {
  const { start, end } = dayBounds(day, tz);
  return (barberId: string) =>
    tables().bookings.filter(
      (bk) =>
        bk.barber_id === barberId &&
        bk.status !== 'cancelled' &&
        ms(bk.starts_at) < end.getTime() &&
        start.getTime() < ms(bk.ends_at),
    ).length;
};

export function availableSlots(
  c: Caller,
  serviceId: unknown,
  dayArg: unknown,
  barberId: unknown = null,
  ignoreBooking: unknown = null,
) {
  if (dayArg == null) return [];
  const day = parseDate(dayArg);
  const service = findById('services', serviceId);
  const shop = service && findById('shops', service.shop_id);
  if (!service || !shop || !service.is_active) return [];
  if (!(shopIsLive(shop) || (c.uid != null && shop.owner_id === c.uid))) return [];
  const tz = String(shop.time_zone);
  if (day > addDays(localDateString(new Date(now()), tz), BOOKING_HORIZON_DAYS)) return [];
  if (tables().shop_closures.some((cl) => cl.shop_id === shop.id && cl.day === day)) return [];
  // Only the caller's own booking, or one at their shop, can be left out.
  const ignored = findById('bookings', ignoreBooking);
  const ignoredId =
    ignored && ((c.uid != null && ignored.customer_id === c.uid) || ownsShop(ignored.shop_id, c.uid)) ? ignored.id : null;

  const duration = Number(service.duration_min) * 60_000;
  const weekday = weekdayOf(day);
  const seen = new Set<string>();
  const slots: { barber_id: string; starts_at: string; at: number }[] = [];
  for (const barber of tables().barbers) {
    if (barber.shop_id !== shop.id || !barber.is_active) continue;
    if (barberId != null && barber.id !== barberId) continue;
    for (const wh of tables().working_hours) {
      if (wh.barber_id !== barber.id || wh.weekday !== weekday) continue;
      const last = localInstant(day, String(wh.closes_at), tz) - duration;
      for (let at = localInstant(day, String(wh.opens_at), tz); at <= last; at += 15 * 60_000) {
        const key = `${barber.id}@${at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (at <= now()) continue;
        if (tables().bookings.some((bk) => bk.id !== ignoredId && clash(bk, barber.id, at, at + duration))) continue;
        slots.push({ barber_id: String(barber.id), starts_at: new Date(at).toISOString(), at });
      }
    }
  }
  return slots
    .sort((a, b) => a.at - b.at || (a.barber_id < b.barber_id ? -1 : a.barber_id > b.barber_id ? 1 : 0))
    .map(({ barber_id, starts_at }) => ({ barber_id, starts_at }));
}

export function bookAppointment(c: Caller, serviceId: unknown, startsAt: unknown, barberId: unknown = null, note: unknown = null) {
  if (c.uid == null) throw new PgError('28000', 'Please sign in to book.', 403);
  const service = findById('services', serviceId);
  if (!service) throw new PgError('P0002', 'This service is no longer available.', 500);
  if (note != null && [...String(note)].length > 280) {
    throw new PgError('22001', 'Please keep your note under 280 characters.', 400);
  }
  const upcoming = tables().bookings.filter(
    (b) => b.customer_id === c.uid && b.shop_id === service.shop_id && b.status === 'confirmed' && ms(b.starts_at) > now(),
  ).length;
  if (upcoming >= MAX_UPCOMING_PER_SHOP) {
    throw new PgError(
      'P0001',
      `You already have ${MAX_UPCOMING_PER_SHOP} upcoming bookings here. Cancel one to book another.`,
      400,
    );
  }
  const tz = String(findById('shops', service.shop_id)!.time_zone);
  if (startsAt == null) throw new PgError('P0001', TAKEN, 400);
  const at = ms(toColumnValue('bookings', 'starts_at', startsAt));
  const day = localDateString(new Date(at), tz);
  const busy = busyThatDay(day, tz);
  const free = availableSlots(c, serviceId, day, barberId)
    .filter((s) => ms(s.starts_at) === at)
    .sort((a, b) => busy(a.barber_id) - busy(b.barber_id) || (a.barber_id < b.barber_id ? -1 : 1));
  if (free.length === 0) throw new PgError('P0001', TAKEN, 400);

  const booking = guarded(
    () =>
      insertRow('bookings', {
        shop_id: service.shop_id,
        barber_id: free[0].barber_id,
        service_id: service.id,
        customer_id: c.uid,
        service_name: service.name,
        price: service.price,
        starts_at: new Date(at).toISOString(),
        ends_at: new Date(at + Number(service.duration_min) * 60_000).toISOString(),
        customer_note: trimmed(note),
        customer_changed_at: new Date(now()).toISOString(),
        customer_change: 'booked',
      }),
    TAKEN,
  );
  // They have their time that day, so they are no longer waiting for one.
  stopWaiting(c.uid, service.shop_id, day);
  leaveQueueFor(c.uid, service.shop_id, day);
  return booking;
}

export function rescheduleBooking(c: Caller, bookingId: unknown, startsAt: unknown, barberId: unknown = null) {
  const booking = findById('bookings', bookingId);
  if (!booking || booking.is_block) throw new PgError('P0002', 'Booking not found.', 500);
  // The customer's own, or any of the shop's for its owner.
  if (c.uid == null || (booking.customer_id !== c.uid && !ownsShop(booking.shop_id, c.uid))) {
    throw new PgError('P0002', 'Booking not found.', 500);
  }
  // As in setBookingStatus, the owner counts as the shop.
  const byCustomer = !ownsShop(booking.shop_id, c.uid);
  if (booking.status !== 'confirmed' || ms(booking.starts_at) <= now()) {
    throw new PgError('42501', 'You can only change an upcoming booking.', 403);
  }
  const service = findById('services', booking.service_id);
  if (!service || !service.is_active) throw new PgError('P0002', 'This service is no longer available.', 500);

  const tz = String(findById('shops', booking.shop_id)!.time_zone);
  if (startsAt == null) throw new PgError('P0001', TAKEN, 400);
  const at = ms(toColumnValue('bookings', 'starts_at', startsAt));
  const day = localDateString(new Date(at), tz);
  const busy = busyThatDay(day, tz);
  const stays = (id: string) => (id === booking.barber_id ? 0 : 1);
  const free = availableSlots(c, service.id, day, barberId, booking.id)
    .filter((s) => ms(s.starts_at) === at)
    .sort(
      (a, b) =>
        stays(a.barber_id) - stays(b.barber_id) ||
        busy(a.barber_id) - busy(b.barber_id) ||
        (a.barber_id < b.barber_id ? -1 : 1),
    );
  if (free.length === 0) throw new PgError('P0001', TAKEN, 400);

  const moved = guarded(
    () =>
      updateRows('bookings', [booking], {
        barber_id: free[0].barber_id,
        starts_at: new Date(at).toISOString(),
        ends_at: new Date(at + Number(service.duration_min) * 60_000).toISOString(),
        // Any reminder named the old time.
        reminded_at: null,
        ...(byCustomer ? { customer_changed_at: new Date(now()).toISOString(), customer_change: 'moved' } : {}),
      })[0],
    TAKEN,
  );
  // Moved into a day they were waiting on: as good as booking it.
  stopWaiting(booking.customer_id, booking.shop_id, day);
  leaveQueueFor(booking.customer_id, booking.shop_id, day);
  return moved;
}

export function markBookingReminded(c: Caller, bookingId: unknown, startsAt: unknown, reminded: unknown = true) {
  const named = toColumnValue('bookings', 'starts_at', startsAt);
  const booking = findById('bookings', bookingId);
  if (!booking || booking.is_block || !ownsShop(booking.shop_id, c.uid)) {
    throw new PgError('P0002', 'Booking not found.', 500);
  }
  if (booking.status !== 'confirmed' || ms(booking.starts_at) <= now()) {
    throw new PgError('42501', 'You can only remind a customer about an upcoming booking.', 403);
  }
  // The message named this time; a booking moved since still needs one for its new time.
  if (named == null || ms(named) !== ms(booking.starts_at)) {
    throw new PgError('42501', 'This booking has changed. Check the new time.', 403);
  }
  const set = reminded === true || reminded === 'true';
  return updateRows('bookings', [booking], { reminded_at: set ? new Date(now()).toISOString() : null })[0];
}

export function setBookingStatus(c: Caller, bookingId: unknown, status: unknown) {
  const booking = findById('bookings', bookingId);
  if (!booking) throw new PgError('P0002', 'Booking not found.', 500);
  const next = toColumnValue('bookings', 'status', status);
  let byCustomer = false;
  if (ownsShop(booking.shop_id, c.uid)) {
    if ((next === 'completed' || next === 'no_show') && ms(booking.starts_at) > now()) {
      throw new PgError('42501', 'You can mark this once the appointment has started.', 403);
    }
  } else if (c.uid != null && booking.customer_id === c.uid) {
    if (next !== 'cancelled' || booking.status !== 'confirmed' || ms(booking.starts_at) <= now()) {
      throw new PgError('42501', 'You can only cancel an upcoming booking.', 403);
    }
    byCustomer = true;
  } else {
    throw new PgError('P0002', 'Booking not found.', 500);
  }
  return guarded(
    () =>
      updateRows('bookings', [booking], {
        status: next,
        ...(byCustomer ? { customer_changed_at: new Date(now()).toISOString(), customer_change: 'cancelled' } : {}),
      })[0],
    'That time has been booked by someone else since.',
  );
}

/**
 * my_bookings, as {bookings, waitlist, queue}: the caller's own bookings,
 * newest first, each with its shop and barber even when the shop is hidden
 * (paused, or its trial ended), whether it is live, and the caller's rating
 * of the cut with the shop's reply, or null; the days they are waiting on, as
 * my_waitlist has them; and their place in a walk-in queue, as my_queue has
 * it; so My bookings is one request.
 */
export function myBookings(c: Caller, limitArg: unknown = 100) {
  return { bookings: myBookingList(c, limitArg), waitlist: myWaitlist(c), queue: myQueue(c) };
}

function myBookingList(c: Caller, limitArg: unknown) {
  const limit = Math.min(Math.max(Number(limitArg ?? 100), 1), 200);
  return tables()
    .bookings.filter((b) => c.uid != null && b.customer_id === c.uid)
    .sort((a, b) => ms(b.starts_at) - ms(a.starts_at) || (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, limit)
    .flatMap((b) => {
      const shop = findById('shops', b.shop_id);
      const barber = findById('barbers', b.barber_id);
      if (!shop || !barber) return [];
      const booking = Object.fromEntries(Object.keys(COLUMNS.bookings).map((k) => [k, b[k]]));
      const { name, slug, address, area, latitude, longitude, phone, time_zone } = shop;
      const r = tables().reviews.find((x) => x.booking_id === b.id);
      return [
        {
          ...booking,
          shops: { name, slug, address, area, latitude, longitude, phone, time_zone, is_live: shopIsLive(shop) },
          barbers: { name: barber.name },
          review: r
            ? {
                rating: r.rating,
                comment: r.comment,
                first_name: r.first_name,
                reply: r.reply,
                replied_at: r.replied_at,
                created_at: r.created_at,
                updated_at: r.updated_at,
              }
            : null,
        },
      ];
    });
}

/**
 * my_upcoming_bookings: the caller's next 30 confirmed bookings that haven't
 * started, soonest first, each with its shop's name and time zone (a paused
 * shop's too), for the phone's own reminders.
 */
export function myUpcomingBookings(c: Caller) {
  return tables()
    .bookings.filter(
      (b) => c.uid != null && b.customer_id === c.uid && b.status === 'confirmed' && ms(b.starts_at) > now(),
    )
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, 30)
    .flatMap((b) => {
      const shop = findById('shops', b.shop_id);
      if (!shop) return [];
      return [
        { id: b.id, starts_at: b.starts_at, service_name: b.service_name, shop_name: shop.name, time_zone: shop.time_zone },
      ];
    });
}

/**
 * my_shops: Find a barber's cards for a returning customer. Their soonest
 * upcoming booking and how many they have, and up to three shops they had
 * cuts at in the last two years, most recent first, each with the last cut
 * there, their visits and usual gap (as shopCustomers works them out), and
 * today's hours and next free time as the shop list has them; and the
 * bookings to remind of, as my_upcoming_bookings gives them.
 */
export function myShops(c: Caller) {
  const from = yearsFromNow(-2);
  const mine = tables().bookings.filter(
    (b) =>
      c.uid != null &&
      b.customer_id === c.uid &&
      ms(b.starts_at) >= from &&
      (b.status === 'confirmed' || b.status === 'completed'),
  );
  // A cut marked done, or still confirmed once it started.
  const visits = mine.filter((b) => b.status === 'completed' || ms(b.starts_at) <= now());
  const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : 1);
  const lastCuts = new Map<unknown, Row>();
  for (const b of [...visits].sort((a, b) => ms(b.starts_at) - ms(a.starts_at) || byId(a, b))) {
    if (!lastCuts.has(b.shop_id)) lastCuts.set(b.shop_id, b);
  }
  const recent = [...lastCuts.values()]
    .sort((a, b) => ms(b.starts_at) - ms(a.starts_at) || (String(a.shop_id) < String(b.shop_id) ? -1 : 1))
    .slice(0, 3);
  const upcoming = mine
    .filter((b) => b.status === 'confirmed' && ms(b.starts_at) > now())
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || byId(a, b));
  const next = upcoming[0];
  const nextShop = next && findById('shops', next.shop_id);

  return {
    next:
      next && nextShop
        ? {
            id: next.id,
            starts_at: next.starts_at,
            service_name: next.service_name,
            barber_name: findById('barbers', next.barber_id)?.name ?? null,
            shop_name: nextShop.name,
            time_zone: nextShop.time_zone,
          }
        : null,
    upcoming: upcoming.length,
    upcoming_bookings: myUpcomingBookings(c),
    shops: recent.flatMap((cut) => {
      const shop = findById('shops', cut.shop_id);
      const barber = findById('barbers', cut.barber_id);
      if (!shop || !barber) return [];
      const tz = String(shop.time_zone);
      // A visit is a day they had a cut, however many bookings it took.
      const days = [
        ...new Set(
          visits.filter((v) => v.shop_id === shop.id).map((v) => localDateString(new Date(ms(v.starts_at)), tz)),
        ),
      ].sort();
      const visible = shopIsLive(shop) || shop.owner_id === c.uid;
      return [
        {
          shop_id: shop.id,
          name: shop.name,
          slug: shop.slug,
          time_zone: shop.time_zone,
          is_live: shopIsLive(shop),
          ...(visible ? hoursToday(shop) : { opens_today: null, closes_today: null }),
          next_free_at: visible ? shopNextFree(shop, c) : null,
          last_visit_at: cut.starts_at,
          service_id: cut.service_id,
          service_name: cut.service_name,
          barber_id: barber.id,
          barber_name: barber.name,
          visits: days.length,
          usual_gap_days: usualGapDays(days),
        },
      ];
    }),
  };
}

export function setBarberHours(c: Caller, barberId: unknown, hours: unknown) {
  const barber = findById('barbers', barberId);
  if (!barber || !ownsShop(barber.shop_id, c.uid)) throw new PgError('P0002', 'Barber not found.', 500);
  if (hours != null && !Array.isArray(hours)) {
    throw new PgError(
      '22023',
      typeof hours === 'object' ? 'cannot extract elements from an object' : 'cannot extract elements from a scalar',
      400,
    );
  }

  deleteRows(
    'working_hours',
    tables().working_hours.filter((h) => h.barber_id === barber.id),
  );
  const list = Array.isArray(hours) ? (hours as Row[]) : [];
  for (const h of list) {
    const value = (key: string) => (h?.[key] == null ? null : h[key]);
    const weekday = value('weekday') == null ? null : toColumnValue('working_hours', 'weekday', String(value('weekday')));
    const time = (key: string) => {
      const v = value(key);
      if (v == null) return null;
      if (!parseTime(v)) throw new PgError('22007', `invalid input syntax for type time: "${String(v)}"`, 400);
      return v;
    };
    guarded(
      () =>
        insertRow('working_hours', {
          barber_id: barber.id,
          weekday,
          opens_at: time('opens_at'),
          closes_at: time('closes_at'),
        }),
      'Some of those hours overlap on the same day.',
      'Closing time must be after opening time.',
    );
  }
  return tables()
    .working_hours.filter((h) => h.barber_id === barber.id)
    .sort((a, b) => Number(a.weekday) - Number(b.weekday) || String(a.opens_at).localeCompare(String(b.opens_at)));
}

type ShopBookingArgs = {
  p_barber_id?: unknown;
  p_day?: unknown;
  p_time?: unknown;
  p_duration_min?: unknown;
  p_service_id?: unknown;
  p_guest_name?: unknown;
  p_guest_phone?: unknown;
  p_note?: unknown;
  p_is_block?: unknown;
};

export function addShopBooking(c: Caller, args: ShopBookingArgs) {
  const isBlock = args.p_is_block == null ? false : toColumnValue('bookings', 'is_block', args.p_is_block);
  const barber = findById('barbers', args.p_barber_id);
  const shop = barber && findById('shops', barber.shop_id);
  if (!barber || !shop || c.uid == null || shop.owner_id !== c.uid) {
    throw new PgError('P0002', 'Barber not found.', 500);
  }
  let service: Row | undefined;
  if (args.p_service_id != null) {
    service = tables().services.find((s) => s.id === args.p_service_id && s.shop_id === shop.id);
    if (!service) throw new PgError('P0002', 'Service not found.', 500);
  }
  const minutes =
    args.p_duration_min != null
      ? (toColumnValue('services', 'duration_min', args.p_duration_min) as number)
      : ((service?.duration_min as number | undefined) ?? null);
  if (minutes == null || minutes < 5 || minutes > (isBlock ? 1440 : 720)) {
    throw new PgError(
      '22023',
      'Pick a service, or a length between 5 minutes and 12 hours (a whole day for blocks).',
      400,
    );
  }
  if (!isBlock && trimmed(args.p_guest_name) == null) {
    throw new PgError('22023', 'Add the customer\'s name.', 400);
  }
  const day = parseDate(args.p_day);
  const time = parseTime(args.p_time);
  if (!time) throw new PgError('22007', `invalid input syntax for type time: "${String(args.p_time)}"`, 400);
  const starts = localInstant(day, time, String(shop.time_zone));
  const note = trimmed(args.p_note);

  const booking = guarded(
    () =>
      insertRow('bookings', {
        shop_id: shop.id,
        barber_id: barber.id,
        service_id: service?.id ?? null,
        guest_name: isBlock ? null : trimmed(args.p_guest_name),
        guest_phone: isBlock ? null : trimmed(args.p_guest_phone),
        is_block: isBlock,
        service_name: isBlock ? (note == null ? 'Blocked' : [...note].slice(0, 80).join('')) : (service?.name ?? 'Appointment'),
        price: isBlock ? 0 : (service?.price ?? 0),
        starts_at: new Date(starts).toISOString(),
        ends_at: new Date(starts + minutes * 60_000).toISOString(),
        customer_note: isBlock ? null : note,
      }),
    'That barber already has a booking at that time.',
  );
  // Someone waiting for a time that day, put in by hand after a WhatsApp: their number finds them.
  const number = phoneKey(booking.guest_phone);
  if (number) {
    deleteRows(
      'waitlist',
      tables().waitlist.filter(
        (w) => w.shop_id === shop.id && w.day === day && phoneKey(findById('profiles', w.customer_id)?.phone) === number,
      ),
    );
  }
  return booking;
}

// Closing the shop for a few days ---------------------------------------------

function myShop(c: Caller): Row {
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  if (!shop) throw new PgError('P0002', 'Set up your shop first.', 500);
  return shop;
}

export function closeShopDays(c: Caller, fromArg: unknown, daysArg: unknown, reasonArg: unknown = null) {
  const shop = myShop(c);
  const days = daysArg == null ? null : Number(daysArg);
  if (days == null || !Number.isInteger(days) || days < 1 || days > 31) {
    throw new PgError('22023', 'Pick between 1 and 31 days.', 400);
  }
  const tz = String(shop.time_zone);
  const today = localDateString(new Date(now()), tz);
  const from = fromArg == null ? null : parseDate(fromArg);
  if (from == null || from < today || addDays(from, days - 1) > addDays(today, BOOKING_HORIZON_DAYS)) {
    throw new PgError('22023', 'Pick days from today up to 60 days ahead.', 400);
  }
  const start = dayBounds(from, tz).start.getTime();
  const end = dayBounds(addDays(from, days), tz).start.getTime();
  // Customers already served today don't count, only those still to come.
  const toCome = tables().bookings.filter(
    (b) =>
      b.shop_id === shop.id &&
      !b.is_block &&
      b.status === 'confirmed' &&
      ms(b.ends_at) > now() &&
      ms(b.starts_at) < end &&
      start < ms(b.ends_at),
  );
  if (toCome.length > 0) {
    // How many and the first day (on the shop's clock), which the app puts in its own words.
    const first = Math.max(start, Math.min(...toCome.map((b) => ms(b.starts_at))));
    throw new PgError(
      'P0001',
      `There are bookings on those days (${toCome.length}, the first on ${localDateString(new Date(first), tz)}). Cancel them first (and let the customers know), then close the shop.`,
      400,
    );
  }
  const reasonText = trimmed(reasonArg);
  const reason = reasonText == null ? null : [...reasonText].slice(0, 80).join('');
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const existing = tables().shop_closures.find((cl) => cl.shop_id === shop.id && cl.day === day);
    if (existing) updateRows('shop_closures', [existing], { reason });
    else insertRow('shop_closures', { shop_id: shop.id, day, reason });
  }
  return days;
}

export function reopenShopDays(c: Caller, fromArg: unknown, daysArg: unknown) {
  const shop = myShop(c);
  if (fromArg == null) return 0;
  const from = parseDate(fromArg);
  const until = addDays(from, Math.max(daysArg == null ? 0 : Number(daysArg) || 0, 0));
  const open = tables().shop_closures.filter(
    (cl) => cl.shop_id === shop.id && String(cl.day) >= from && String(cl.day) < until,
  );
  deleteRows('shop_closures', open);
  return open.length;
}

type ClosedDayRow = { day: string; reason: string | null; is_closure: boolean; barber_id: unknown };

export function shopClosedDays(c: Caller, shopId: unknown, fromArg: unknown, toArg: unknown): ClosedDayRow[] {
  const shop = findById('shops', shopId);
  const mine = shop != null && c.uid != null && shop.owner_id === c.uid;
  if (!shop || !(shopIsLive(shop) || mine) || fromArg == null) return [];
  const tz = String(shop.time_zone);
  const from = parseDate(fromArg);
  const to = toArg == null ? null : parseDate(toArg);
  const last = to != null && to < addDays(from, 90) ? to : addDays(from, 90);
  const closures = tables()
    .shop_closures.filter((cl) => cl.shop_id === shop.id && String(cl.day) >= from && String(cl.day) <= last)
    .map((cl): ClosedDayRow => ({
      day: String(cl.day),
      reason: mine ? (cl.reason as string | null) : null,
      is_closure: true,
      barber_id: null,
    }));
  const closed = new Set(tables().shop_closures.filter((cl) => cl.shop_id === shop.id).map((cl) => cl.day));

  // Each active barber's whole days off, on days the shop isn't closed.
  const team = tables().barbers.filter((b) => b.shop_id === shop.id && b.is_active);
  const start = dayBounds(from, tz).start.getTime();
  const end = dayBounds(addDays(last, 1), tz).start.getTime();
  const byDay = new Map<string, Map<unknown, string[]>>();
  for (const b of tables().bookings) {
    if (b.shop_id !== shop.id || b.status !== 'confirmed' || !isWholeDayBlock(b)) continue;
    if (!team.some((x) => x.id === b.barber_id) || ms(b.starts_at) < start || ms(b.starts_at) >= end) continue;
    const day = localDateString(new Date(ms(b.starts_at)), tz);
    if (closed.has(day)) continue;
    const off = byDay.get(day) ?? new Map<unknown, string[]>();
    off.set(b.barber_id, [...(off.get(b.barber_id) ?? []), String(b.service_name)]);
    byDay.set(day, off);
  }
  // A day nobody who works that weekday is in reads as closed; otherwise each barber off is listed.
  const offDays = [...byDay.entries()].flatMap(([day, off]): ClosedDayRow[] => {
    const working = team.filter((b) =>
      tables().working_hours.some((wh) => wh.barber_id === b.id && wh.weekday === weekdayOf(day)),
    );
    const first = (reasons: string[]) => (mine ? [...reasons].sort()[0] : null);
    return working.every((b) => off.has(b.id))
      ? [{ day, reason: first([...off.values()].flat()), is_closure: false, barber_id: null }]
      : [...off.entries()].map(([barberId, reasons]) => ({ day, reason: first(reasons), is_closure: false, barber_id: barberId }));
  });
  const key = (r: ClosedDayRow) => `${r.day}|${r.barber_id ?? ''}`;
  return [...closures, ...offDays].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// Takings --------------------------------------------------------------------

const money = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * The usual days between visits, from the days of each visit in order: the
 * median gap, rounded (halves up) and at least a week, or four weeks after
 * a single visit.
 */
function usualGapDays(days: string[]): number {
  if (days.length < 2) return 28;
  const gaps = days
    .slice(1)
    .map((day, i) => daysBetween(days[i], day))
    .sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(Math.round(median), 7);
}

/** shop_summary: the owner's takings for p_from to p_to on the shop's clock, and the period before. */
export function shopSummary(c: Caller, fromArg: unknown, toArg: unknown) {
  const shop = myShop(c);
  const from = fromArg == null ? null : parseDate(fromArg);
  const to = toArg == null ? null : parseDate(toArg);
  const days = from == null || to == null ? null : daysBetween(from, to) + 1;
  if (from == null || to == null || days == null || days < 1 || days > 93) {
    throw new PgError('22023', 'Pick a period of up to 93 days.', 400);
  }
  const tz = String(shop.time_zone);
  // A whole month compares with the whole month before; anything else with the same number of days.
  const [y, m] = from.split('-').map(Number);
  const firstOf = (month: number) => new Date(Date.UTC(y, month, 1)).toISOString().slice(0, 10);
  const wholeMonth = from === firstOf(m - 1) && addDays(to, 1) === firstOf(m);
  const prevFrom = wholeMonth ? firstOf(m - 2) : addDays(from, -days);
  const start = dayBounds(from, tz).start.getTime();
  const end = dayBounds(addDays(to, 1), tz).start.getTime();
  const prevStart = dayBounds(prevFrom, tz).start.getTime();
  // As far into the period before as now is into this one, by the shop's clock.
  const today = localDateString(new Date(now()), tz);
  const sinceMidnight = now() - dayBounds(today, tz).start.getTime();
  const prevUntil = Math.min(start, dayBounds(addDays(prevFrom, daysBetween(from, today)), tz).start.getTime() + sinceMidnight);

  const rows = tables().bookings.filter((b) => {
    const at = ms(b.starts_at);
    return b.shop_id === shop.id && !b.is_block && at >= prevStart && at < end && (at >= start || at < prevUntil);
  });
  const current = rows.filter((b) => ms(b.starts_at) >= start);
  const before = rows.filter((b) => ms(b.starts_at) < start);
  const count = (list: Row[], status: string) => list.filter((b) => b.status === status).length;
  const sum = (list: Row[], keep: (b: Row) => boolean = () => true) =>
    money(list.filter(keep).reduce((n, b) => n + Number(b.price), 0));
  const is = (status: string) => (b: Row) => b.status === status;
  const toCome = (b: Row) => b.status === 'confirmed' && ms(b.ends_at) > now();
  const unmarked = (b: Row) => b.status === 'confirmed' && ms(b.ends_at) <= now();
  const taken = current.filter((b) => b.status !== 'cancelled');
  // Each booking's day and start hour by the shop's clock, with one formatter: a new one per booking is slow.
  const clock = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  const local = new Map(
    current.map((b) => {
      const p = Object.fromEntries(clock.formatToParts(new Date(ms(b.starts_at))).map((x) => [x.type, x.value]));
      return [b, { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) }];
    }),
  );
  const totals = (list: Row[]) => ({
    done: count(list, 'completed'),
    takings: sum(list, is('completed')),
    no_shows: count(list, 'no_show'),
    no_show_value: sum(list, is('no_show')),
    cancelled: count(list, 'cancelled'),
  });

  const hours = new Map<number, number>();
  for (const b of taken) hours.set(local.get(b)!.hour, (hours.get(local.get(b)!.hour) ?? 0) + 1);
  // Every barber working here now, even one with nothing booked, and anyone since marked away who had bookings.
  const barbers = tables()
    .barbers.filter((barber) => barber.shop_id === shop.id)
    .map((barber) => {
      const theirs = current.filter((b) => b.barber_id === barber.id);
      return {
        barber,
        row: {
          barber_id: barber.id,
          name: barber.name,
          bookings: theirs.filter((b) => b.status !== 'cancelled').length,
          done: count(theirs, 'completed'),
          takings: sum(theirs, is('completed')),
          no_shows: count(theirs, 'no_show'),
        },
      };
    })
    .filter(({ barber, row }) => barber.is_active || row.bookings > 0)
    .sort(
      (a, b) =>
        b.row.takings - a.row.takings ||
        b.row.done - a.row.done ||
        Number(a.barber.sort_order) - Number(b.barber.sort_order) ||
        ms(a.barber.created_at) - ms(b.barber.created_at) ||
        (String(a.barber.id) < String(b.barber.id) ? -1 : 1),
    )
    .map(({ row }) => row);
  const services = new Map<string, { name: string; done: number; takings: number }>();
  for (const b of current.filter(is('completed'))) {
    const s = services.get(String(b.service_name)) ?? { name: String(b.service_name), done: 0, takings: 0 };
    services.set(s.name, { ...s, done: s.done + 1, takings: money(s.takings + Number(b.price)) });
  }

  return {
    from,
    to,
    totals: {
      ...totals(current),
      // Still to come, or in the chair now; and over, but nobody marked them.
      to_come: current.filter(toCome).length,
      to_come_value: sum(current, toCome),
      unmarked: current.filter(unmarked).length,
      unmarked_value: sum(current, unmarked),
    },
    previous: { from: prevFrom, to: addDays(from, -1), until: new Date(prevUntil).toISOString(), ...totals(before) },
    days: Array.from({ length: days }, (_, i) => {
      const day = addDays(from, i);
      const that = current.filter((b) => local.get(b)!.day === day);
      return {
        day,
        bookings: that.filter((b) => b.status !== 'cancelled').length,
        done: count(that, 'completed'),
        takings: sum(that, is('completed')),
      };
    }),
    hours: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, bookings]) => ({ hour, bookings })),
    barbers,
    // The five most done, by the name they were booked under.
    services: [...services.values()]
      .sort((a, b) => b.done - a.done || b.takings - a.takings || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 5),
  };
}

// The shop's customers --------------------------------------------------------

/** Digits only, with a leading 0 written as 60, as WhatsApp wants it. */
const phoneKey = (phone: unknown) => toWhatsAppNumber(String(phone ?? ''));
/** `now() + interval 'n years'`. */
const yearsFromNow = (years: number) => {
  const at = new Date(now());
  at.setUTCFullYear(at.getUTCFullYear() + years);
  return at.getTime();
};
/** What barber/new-booking.tsx saves for a walk-in added without a name. */
const isUnnamed = (b: Row) => b.customer_id == null && pgTrim(String(b.guest_name ?? '')).toLowerCase() === 'walk-in';
const descNullsLast = (a: number | null, b: number | null) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : b - a);
const ascNullsLast = (a: string | null, b: string | null) =>
  a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1;

/**
 * Everyone shop_customers finds at the shop for a search (lower case and
 * trimmed, or null for everyone), unsorted, with what it sorts them by.
 */
function customersOf(shop: Row, search: string | null) {
  const tz = String(shop.time_zone);
  const today = localDateString(new Date(now()), tz);
  // Only something typed like a number looks at phone numbers, so "Ali 2"
  // doesn't find everyone with a 2 in theirs.
  const digits = search != null && /^[0-9 +()-]+$/.test(search) ? search.replace(/\D/g, '') || null : null;

  // Each person's bookings in date order: online customers by account,
  // guests by phone number, or by name when there is none.
  const from = yearsFromNow(-2);
  const until = yearsFromNow(1);
  const people = new Map<string, Row[]>();
  const booked = tables()
    .bookings.filter(
      (b) =>
        b.shop_id === shop.id &&
        ms(b.starts_at) >= from &&
        ms(b.starts_at) < until &&
        !b.is_block &&
        b.status !== 'cancelled' &&
        // What delete_my_account leaves behind: history, but nobody to contact.
        (b.customer_id != null || b.guest_name !== 'Deleted account') &&
        // With no name and no number, every such walk-in would add up to one
        // made-up regular.
        !(isUnnamed(b) && !phoneKey(b.guest_phone)),
    )
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  // A guest added under the number on one of the shop's online customers'
  // profiles is that customer, unless two of them share the number.
  const owners = new Map<string, string | null>();
  for (const id of new Set(booked.flatMap((b) => (b.customer_id == null ? [] : [String(b.customer_id)])))) {
    const number = phoneKey(findById('profiles', id)?.phone);
    if (number) owners.set(number, owners.has(number) ? null : id);
  }
  for (const b of booked) {
    const account = b.customer_id ?? (phoneKey(b.guest_phone) ? owners.get(phoneKey(b.guest_phone)) : null);
    const key =
      account != null
        ? `c:${account}`
        : phoneKey(b.guest_phone)
          ? `p:${phoneKey(b.guest_phone)}`
          : `n:${pgTrim(String(b.guest_name)).replace(/\s+/g, ' ').toLowerCase()}`;
    people.set(key, [...(people.get(key) ?? []), b]);
  }

  const found = [...people.entries()].flatMap(([key, bookings]) => {
    const visited = bookings.filter((b) => b.status === 'completed' || (b.status === 'confirmed' && ms(b.starts_at) <= now()));
    // A visit is a day they had a cut, however many bookings it took.
    const days = [...new Set(visited.map((b) => localDateString(new Date(ms(b.starts_at)), tz)))];
    const gap = usualGapDays(days);
    const upcoming = bookings.filter((b) => b.status === 'confirmed' && ms(b.starts_at) > now());

    // The name a guest last gave (not 'Walk-in') and their number as last typed.
    const customerId = key.startsWith('c:') ? key.slice(2) : null;
    const profile = customerId == null ? undefined : findById('profiles', customerId);
    const named = bookings.filter((b) => b.customer_id == null && !isUnnamed(b)).at(-1);
    const name = trimmed(profile?.full_name) ?? (named ? String(named.guest_name) : null);
    const phone =
      customerId == null
        ? key.startsWith('p:')
          ? String(bookings.at(-1)!.guest_phone)
          : null
        : ((profile?.phone as string | null | undefined) ?? null);
    const matches =
      search == null || name?.toLowerCase().includes(search) || (digits != null && phoneKey(phone).includes(digits));
    if (!matches) return [];

    const since = days.length ? daysBetween(days.at(-1)!, today) : null;
    const due = since != null && upcoming.length === 0 && since >= gap && since < Math.max(3 * gap, 90);
    return [
      {
        row: {
          customer_key: key,
          customer_id: customerId,
          name,
          phone,
          visits: days.length,
          no_shows: bookings.filter((b) => b.status === 'no_show').length,
          last_visit_at: visited.length ? String(visited.at(-1)!.starts_at) : null,
          next_booking_at: upcoming.length ? String(upcoming[0].starts_at) : null,
          usual_gap_days: gap,
          is_due: due,
        },
        overdue: due ? since! - gap : null,
        lastVisit: visited.length ? ms(visited.at(-1)!.starts_at) : null,
      },
    ];
  });
  return found;
}

export function shopCustomers(c: Caller, args: Record<string, unknown>) {
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  if (!shop) return [];
  const found = customersOf(shop, blank(args.p_search) ? null : pgTrim(String(args.p_search)).toLowerCase());

  // Due first, longest overdue first, then everyone by their last visit.
  found.sort(
    (a, b) =>
      Number(b.row.is_due) - Number(a.row.is_due) ||
      descNullsLast(a.overdue, b.overdue) ||
      descNullsLast(a.lastVisit, b.lastVisit) ||
      ascNullsLast(a.row.name?.toLowerCase() ?? null, b.row.name?.toLowerCase() ?? null) ||
      ascNullsLast(a.row.customer_key, b.row.customer_key),
  );
  const limit = Math.min(Math.max(Number(args.p_limit ?? 30), 1), 50);
  const offset = Math.max(Number(args.p_offset ?? 0), 0);
  const dueCount = found.filter((f) => f.row.is_due).length;
  return found
    .slice(offset, offset + limit)
    .map(({ row }) => ({ ...row, total_count: found.length, due_count: dueCount }));
}

// My shop's cards -------------------------------------------------------------

/**
 * shop_cards: everything My shop's cards show, in one answer: shop_summary's
 * totals for p_from to p_to, how many customers shop_customers lists and how
 * many of them are due, the shop's review count and sum with its newest
 * comment, and the days closed from today to 60 days ahead.
 */
export function shopCards(c: Caller, fromArg: unknown, toArg: unknown) {
  const shop = myShop(c);
  const { totals } = shopSummary(c, fromArg, toArg);
  const customers = customersOf(shop, null);
  const newest = tables()
    .reviews.filter((r) => r.shop_id === shop.id && r.comment != null)
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
  const today = localDateString(new Date(now()), String(shop.time_zone));
  const last = addDays(today, 60);
  return {
    takings: totals,
    customers: { total: customers.length, due: customers.filter((f) => f.row.is_due).length },
    reviews: {
      count: shop.rating_count,
      sum: shop.rating_sum,
      newest: newest ? { rating: newest.rating, comment: newest.comment, first_name: newest.first_name } : null,
    },
    closures: tables()
      .shop_closures.filter((cl) => cl.shop_id === shop.id && String(cl.day) >= today && String(cl.day) <= last)
      .map((cl) => ({ day: String(cl.day), reason: (cl.reason as string | null) ?? null }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
  };
}

// What customers changed ------------------------------------------------------

const HOUR = 3_600_000;

/**
 * shop_changes: what customers booked, moved or cancelled at the caller's
 * shop since p_since (the last day for a phone that never looked, a week at
 * most), for bookings that end today or later on the shop's clock. A booking
 * the shop has since cancelled, or taken back after the customer cancelled,
 * is left out.
 */
export function shopChanges(c: Caller, sinceArg: unknown = null, limitArg: unknown = 5) {
  const asked = sinceArg == null ? now() - 24 * HOUR : ms(toColumnValue('bookings', 'customer_changed_at', sinceArg));
  const since = Math.max(asked, now() - 7 * 24 * HOUR);
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  const sinceIso = new Date(since).toISOString();
  if (!shop) return { since: sinceIso, count: 0, latest: null, changes: [] };
  const tz = String(shop.time_zone);
  const today = dayBounds(localDateString(new Date(now()), tz), tz).start.getTime();
  const changed = tables()
    .bookings.filter(
      (b) =>
        b.shop_id === shop.id &&
        b.customer_changed_at != null &&
        ms(b.customer_changed_at) > since &&
        ms(b.ends_at) > today &&
        (b.status === 'cancelled') === (b.customer_change === 'cancelled'),
    )
    .sort((a, b) => ms(b.customer_changed_at) - ms(a.customer_changed_at) || (String(a.id) < String(b.id) ? -1 : 1));
  const limit = Math.min(Math.max(limitArg == null ? 5 : Number(limitArg), 0), 20);
  return {
    since: sinceIso,
    count: changed.length,
    latest: changed.length ? changed[0].customer_changed_at : null,
    changes: changed.slice(0, limit).map((b) => ({
      booking_id: b.id,
      barber_id: b.barber_id,
      barber_name: findById('barbers', b.barber_id)?.name ?? null,
      // A deleted account's name is gone; deleteMyAccount leaves 'Deleted account'.
      customer_name: (b.customer_id == null ? null : findById('profiles', b.customer_id)?.full_name) ?? b.guest_name,
      service_name: b.service_name,
      starts_at: b.starts_at,
      change: b.customer_change,
      changed_at: b.customer_changed_at,
      chair_free:
        b.customer_change === 'cancelled' &&
        ms(b.starts_at) > now() &&
        !tables().bookings.some((x) => clash(x, b.barber_id, ms(b.starts_at), ms(b.ends_at))),
      waiting:
        b.customer_change === 'cancelled' && ms(b.starts_at) > now()
          ? tables().waitlist.filter(
              (w) => w.shop_id === shop.id && w.day === localDateString(new Date(ms(b.starts_at)), tz),
            ).length
          : 0,
    })),
  };
}

// Waiting list ------------------------------------------------------------------

/** How many days one customer can wait on at a time, across every shop. */
const MAX_WAITING_PER_CUSTOMER = 3;

/** A customer with a time at the shop that day is no longer waiting for one. */
function stopWaiting(customerId: unknown, shopId: unknown, day: string) {
  if (customerId == null) return;
  deleteRows(
    'waitlist',
    tables().waitlist.filter((w) => w.customer_id === customerId && w.shop_id === shopId && w.day === day),
  );
}

/**
 * join_waitlist: a signed-in customer asks to hear if a time frees up on a
 * day they could book, for a service with a barber (null: any). Once a day
 * per shop, and on at most three days at a time; days gone by don't count.
 */
export function joinWaitlist(c: Caller, serviceId: unknown, dayArg: unknown, barberId: unknown = null) {
  if (c.uid == null) throw new PgError('28000', 'Please sign in to join the waiting list.', 403);
  const service = findById('services', serviceId);
  const shop = service?.is_active ? findById('shops', service.shop_id) : undefined;
  if (!service || !shop || !shopIsLive(shop)) throw new PgError('P0002', 'This service is no longer available.', 500);
  if (
    barberId != null &&
    !tables().barbers.some((b) => b.id === barberId && b.shop_id === shop.id && b.is_active)
  ) {
    throw new PgError('P0002', 'Barber not found.', 500);
  }
  const tz = String(shop.time_zone);
  const today = localDateString(new Date(now()), tz);
  const day = dayArg == null ? null : parseDate(dayArg);
  if (day == null || day < today || day > addDays(today, BOOKING_HORIZON_DAYS)) {
    throw new PgError('22023', 'Pick a day from today up to 60 days ahead.', 400);
  }

  // Who is in that day: working it and without the whole day blocked off. The booking page
  // shows such days as closed, or off for that barber, so these only catch a day that changed.
  const { start, end } = dayBounds(day, tz);
  const weekday = weekdayOf(day);
  const isIn = tables().barbers.filter(
    (b) =>
      b.shop_id === shop.id &&
      b.is_active &&
      tables().working_hours.some((wh) => wh.barber_id === b.id && wh.weekday === weekday) &&
      !tables().bookings.some(
        (bk) =>
          bk.barber_id === b.id &&
          bk.status === 'confirmed' &&
          ms(bk.starts_at) <= start.getTime() &&
          ms(bk.ends_at) >= end.getTime(),
      ),
  );
  if (tables().shop_closures.some((cl) => cl.shop_id === shop.id && cl.day === day) || isIn.length === 0) {
    throw new PgError('22023', 'The shop isn\'t taking bookings that day.', 400);
  }
  if (barberId != null && !isIn.some((b) => b.id === barberId)) {
    throw new PgError('22023', 'That barber is off that day. Try any barber.', 400);
  }

  if (
    tables().bookings.some(
      (b) =>
        b.customer_id === c.uid &&
        b.shop_id === shop.id &&
        b.status === 'confirmed' &&
        ms(b.starts_at) >= start.getTime() &&
        ms(b.starts_at) < end.getTime(),
    )
  ) {
    throw new PgError('P0001', 'You already have a booking here that day.', 400);
  }
  if (tables().waitlist.some((w) => w.customer_id === c.uid && w.day === day && w.shop_id === shop.id)) {
    throw new PgError('P0001', 'You\'re already on the waiting list for that day.', 400);
  }

  // Days gone by don't count, and nothing clears them on a timer.
  deleteRows(
    'waitlist',
    tables().waitlist.filter((w) => {
      const theirs = findById('shops', w.shop_id);
      return w.customer_id === c.uid && theirs != null && String(w.day) < localDateString(new Date(now()), String(theirs.time_zone));
    }),
  );
  if (tables().waitlist.filter((w) => w.customer_id === c.uid).length >= MAX_WAITING_PER_CUSTOMER) {
    throw new PgError(
      'P0001',
      `You can be on ${MAX_WAITING_PER_CUSTOMER} waiting lists at a time. Leave one to join another.`,
      400,
    );
  }
  return insertRow('waitlist', {
    shop_id: shop.id,
    customer_id: c.uid,
    day,
    service_id: service.id,
    barber_id: barberId,
  });
}

/** The customer leaves a waiting list, or the shop takes them off its own. Already gone is fine. */
export function leaveWaitlist(c: Caller, id: unknown) {
  const key = toColumnValue('waitlist', 'id', id);
  deleteRows(
    'waitlist',
    tables().waitlist.filter((w) => w.id === key && c.uid != null && (w.customer_id === c.uid || ownsShop(w.shop_id, c.uid))),
  );
}

/** The shop WhatsApped someone on its waiting list, so every phone in the shop sees it was done and when. */
export function markWaitlistOffered(c: Caller, id: unknown) {
  const key = toColumnValue('waitlist', 'id', id);
  const row = tables().waitlist.find((w) => w.id === key && ownsShop(w.shop_id, c.uid));
  if (!row) throw new PgError('P0002', 'They\'re no longer on the waiting list.', 500);
  return updateRows('waitlist', [row], { offered_at: new Date(now()).toISOString() })[0];
}

const byCreated = (a: Row, b: Row) => ms(a.created_at) - ms(b.created_at) || (String(a.id) < String(b.id) ? -1 : 1);

/**
 * shop_waitlist: the owner's waiting list for one day, oldest request first,
 * with each customer's name and number as the customer list shows them.
 * Empty for a day gone by.
 */
export function shopWaitlist(c: Caller, dayArg: unknown) {
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  if (!shop || dayArg == null) return [];
  const day = parseDate(dayArg);
  if (day < localDateString(new Date(now()), String(shop.time_zone))) return [];
  return tables()
    .waitlist.filter((w) => w.shop_id === shop.id && w.day === day)
    .sort(byCreated)
    .flatMap((w) => {
      const profile = findById('profiles', w.customer_id);
      const service = findById('services', w.service_id);
      if (!profile || !service) return [];
      return [
        {
          id: w.id,
          name: trimmed(profile.full_name),
          phone: profile.phone ?? null,
          service_id: service.id,
          service_name: service.name,
          duration_min: service.duration_min,
          barber_id: w.barber_id ?? null,
          barber_name: w.barber_id == null ? null : (findById('barbers', w.barber_id)?.name ?? null),
          created_at: w.created_at,
          offered_at: w.offered_at ?? null,
        },
      ];
    });
}

/** my_waitlist: the caller's own requests still to come, soonest day first, each with its shop, service and barber. */
export function myWaitlist(c: Caller) {
  return tables()
    .waitlist.filter((w) => c.uid != null && w.customer_id === c.uid)
    .flatMap((w) => {
      const shop = findById('shops', w.shop_id);
      const service = findById('services', w.service_id);
      if (!shop || !service || String(w.day) < localDateString(new Date(now()), String(shop.time_zone))) return [];
      return [{ w, shop, service }];
    })
    .sort((a, b) => String(a.w.day).localeCompare(String(b.w.day)) || byCreated(a.w, b.w))
    .map(({ w, shop, service }) => ({
      id: w.id,
      shop_id: w.shop_id,
      day: w.day,
      service_id: w.service_id,
      service_name: service.name,
      barber_id: w.barber_id ?? null,
      barber_name: w.barber_id == null ? null : (findById('barbers', w.barber_id)?.name ?? null),
      created_at: w.created_at,
      shop: { name: shop.name, slug: shop.slug, time_zone: shop.time_zone },
    }));
}

// Walk-in queue -----------------------------------------------------------------

/** How many can wait in one shop's queue at once. */
const MAX_QUEUE_WAITING = 30;
/** How many times one customer can join one shop's queue in a day. */
const MAX_QUEUE_JOINS_A_DAY = 5;
/** How long a customer the shop took off is told so. */
const QUEUE_TAKEN_OFF_SHOWN_MS = 60 * 60_000;
const QUEUE_GONE = 'They\'re no longer in the queue.';
const QUEUE_FULL = 'The queue is full for now. Try booking a time instead.';

const byTeamOrder = (a: Row, b: Row) =>
  Number(a.sort_order) - Number(b.sort_order) || ms(a.created_at) - ms(b.created_at) || (String(a.id) < String(b.id) ? -1 : 1);

/**
 * barbers_in_now: the shop's barbers in right now by its own clock, in the
 * team's order: active, inside one of today's working ranges, and without
 * the whole day off, while the shop isn't closed today. With wholeDay,
 * everyone working today, in now or not.
 */
function barbersInNow(shop: Row, wholeDay = false): Row[] {
  const tz = String(shop.time_zone);
  const date = localDateString(new Date(now()), tz);
  if (tables().shop_closures.some((c) => c.shop_id === shop.id && c.day === date)) return [];
  const { start, end } = dayBounds(date, tz);
  const weekday = weekdayOf(date);
  return tables()
    .barbers.filter(
      (b) =>
        b.shop_id === shop.id &&
        b.is_active &&
        tables().working_hours.some(
          (wh) =>
            wh.barber_id === b.id &&
            wh.weekday === weekday &&
            (wholeDay ||
              (localInstant(date, String(wh.opens_at), tz) <= now() && now() < localInstant(date, String(wh.closes_at), tz))),
        ) &&
        !tables().bookings.some(
          (bk) =>
            bk.shop_id === shop.id &&
            bk.barber_id === b.id &&
            bk.status === 'confirmed' &&
            isWholeDayBlock(bk) &&
            ms(bk.starts_at) >= start.getTime() &&
            ms(bk.starts_at) < end.getTime(),
        ),
    )
    .sort(byTeamOrder);
}

/** lower(to_char(at, 'FMHH12:MI AM')) in the shop's zone: "4:30 pm". */
function clockInEnglish(at: unknown, tz: string): string {
  const [h, m] = localClock(String(at), tz).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

const queueToday = (shop: Row) => localDateString(new Date(now()), String(shop.time_zone));
const waitingAt = (shopId: unknown, day: string) =>
  tables().queue_entries.filter((e) => e.shop_id === shopId && e.day === day && e.state === 'waiting');
/** A customer with a time at the shop later today is out of its queue (see join_queue). */
function leaveQueueFor(customerId: unknown, shopId: unknown, day: string) {
  const shop = findById('shops', shopId);
  if (customerId == null || !shop || day !== queueToday(shop)) return;
  updateRows(
    'queue_entries',
    tables().queue_entries.filter(
      (e) => e.customer_id === customerId && e.shop_id === shop.id && e.day === day && e.state !== 'gone',
    ),
    { state: 'gone', gone_reason: 'left', gone_at: new Date(now()).toISOString() },
  );
}
/**
 * The caller's place at a shop today: their latest entry there, while it is
 * open, or gone in the last hour because the shop took them off.
 */
function myPlaceAt(c: Caller, shop: Row): Row | undefined {
  if (c.uid == null) return undefined;
  const day = queueToday(shop);
  const latest = tables()
    .queue_entries.filter((e) => e.customer_id === c.uid && e.day === day && e.shop_id === shop.id)
    .sort(byCreated)
    .at(-1);
  if (!latest || latest.state !== 'gone') return latest;
  const takenOff = latest.gone_reason === 'removed' || latest.gone_reason === 'not_here';
  return takenOff && ms(latest.gone_at) > now() - QUEUE_TAKEN_OFF_SHOWN_MS ? latest : undefined;
}
/** clock_timestamp() under the shop's diary lock: after everyone already in its queue, even within a millisecond. */
const joinedAt = (shopId: unknown) =>
  new Date(
    Math.max(now(), ...tables().queue_entries.filter((e) => e.shop_id === shopId).map((e) => ms(e.created_at) + 1)),
  ).toISOString();

/**
 * queue_status: whether the shop's queue is open now, how many are waiting,
 * about how long someone joining now would wait, and the caller's own place
 * today with the wait ahead of them (or, gone, that the shop took them off
 * in the last hour). A waiting entry with no service counts as the shop's
 * shortest one.
 */
export function queueStatus(c: Caller, shopId: unknown) {
  const shop = findById('shops', shopId);
  if (!shop) return { open: false, waiting: 0, estimate_min: 0, barbers_in: 0, mine: null };
  const day = queueToday(shop);
  const inNow = barbersInNow(shop).length;
  const lengths = tables()
    .services.filter((v) => v.shop_id === shop.id && v.is_active)
    .map((v) => Number(v.duration_min));
  const shortest = lengths.length ? Math.min(...lengths) : 30;
  const minutes = (list: Row[]) =>
    list.reduce((sum, e) => sum + Number(findById('services', e.service_id)?.duration_min ?? shortest), 0);
  const mine = myPlaceAt(c, shop);
  const waiting = waitingAt(shop.id, day);
  const ahead = mine ? waiting.filter((e) => byCreated(e, mine) < 0) : [];
  return {
    open: shopIsLive(shop) && shop.queue_enabled === true && inNow > 0,
    waiting: waiting.length,
    estimate_min: queueEstimate(minutes(waiting), inNow),
    barbers_in: inNow,
    mine: mine
      ? {
          id: mine.id,
          state: mine.state,
          gone_reason: mine.gone_reason ?? null,
          called_at: mine.called_at ?? null,
          service_id: mine.service_id ?? null,
          barber_id: mine.barber_id ?? null,
          created_at: mine.created_at,
          place: mine.state === 'waiting' ? ahead.length + 1 : null,
          estimate_min: mine.state === 'waiting' ? queueEstimate(minutes(ahead), inNow) : null,
        }
      : null,
  };
}

/**
 * join_queue: a signed-in customer joins a shop's queue for today while it is
 * open, with a barber who is in (or any). One place at a time across every
 * shop, none where they have a booking still to come today, no more than
 * thirty waiting, and five times a day at one shop.
 */
export function joinQueue(c: Caller, serviceId: unknown, barberId: unknown = null) {
  if (c.uid == null) throw new PgError('28000', 'Please sign in to join the queue.', 403);
  const service = findById('services', serviceId);
  const shop = service?.is_active ? findById('shops', service.shop_id) : undefined;
  if (!service || !shop || !shopIsLive(shop)) throw new PgError('P0002', 'This service is no longer available.', 500);
  if (barberId != null && !tables().barbers.some((b) => b.id === barberId && b.shop_id === shop.id && b.is_active)) {
    throw new PgError('P0002', 'Barber not found.', 500);
  }
  const inNow = barbersInNow(shop);
  if (shop.queue_enabled !== true || inNow.length === 0) {
    throw new PgError('P0001', 'The queue isn\'t open right now.', 400);
  }
  if (barberId != null && !inNow.some((b) => b.id === barberId)) {
    throw new PgError('P0001', 'That barber isn\'t in right now. Try any barber.', 400);
  }
  const day = queueToday(shop);
  const { start, end } = dayBounds(day, String(shop.time_zone));
  if (
    tables().bookings.some(
      (b) =>
        b.customer_id === c.uid &&
        b.shop_id === shop.id &&
        b.status === 'confirmed' &&
        ms(b.starts_at) >= start.getTime() &&
        ms(b.starts_at) < end.getTime() &&
        ms(b.ends_at) > now(),
    )
  ) {
    throw new PgError('P0001', 'You already have a booking here today.', 400);
  }
  const other = tables().queue_entries.find((e) => {
    const theirs = findById('shops', e.shop_id);
    return e.customer_id === c.uid && e.state !== 'gone' && theirs != null && e.day === queueToday(theirs);
  });
  if (other?.shop_id === shop.id) throw new PgError('P0001', 'You\'re already in this queue.', 400);
  if (other) throw new PgError('P0001', 'You\'re already in another shop\'s queue. Leave it to join this one.', 400);
  const joins = tables().queue_entries.filter((e) => e.customer_id === c.uid && e.day === day && e.shop_id === shop.id);
  if (joins.length >= MAX_QUEUE_JOINS_A_DAY) {
    throw new PgError('P0001', `You can join this queue ${MAX_QUEUE_JOINS_A_DAY} times a day. Book a time instead.`, 400);
  }
  if (waitingAt(shop.id, day).length >= MAX_QUEUE_WAITING) throw new PgError('P0001', QUEUE_FULL, 400);
  return insertRow('queue_entries', {
    shop_id: shop.id,
    day,
    customer_id: c.uid,
    service_id: service.id,
    barber_id: barberId,
    created_at: joinedAt(shop.id),
  });
}

/** leave_queue: the customer leaves the queue. Already gone is fine. */
export function leaveQueue(c: Caller, id: unknown) {
  const key = toColumnValue('queue_entries', 'id', id);
  updateRows(
    'queue_entries',
    tables().queue_entries.filter((e) => e.id === key && c.uid != null && e.customer_id === c.uid && e.state !== 'gone'),
    { state: 'gone', gone_reason: 'left', gone_at: new Date(now()).toISOString() },
  );
}

/** add_to_queue: the shop adds someone who walked in, by name, whenever its queue is on. */
export function addToQueue(c: Caller, args: Record<string, unknown>) {
  const shop = myShop(c);
  if (shop.queue_enabled !== true) throw new PgError('P0001', 'Turn on the walk-in queue in My shop first.', 400);
  const name = trimmed(args.p_name);
  if (name == null) throw new PgError('22023', 'Add the customer\'s name.', 400);
  const serviceId = args.p_service_id ?? null;
  const barberId = args.p_barber_id ?? null;
  if (serviceId != null && !tables().services.some((v) => v.id === serviceId && v.shop_id === shop.id)) {
    throw new PgError('P0002', 'Service not found.', 500);
  }
  if (barberId != null && !tables().barbers.some((b) => b.id === barberId && b.shop_id === shop.id)) {
    throw new PgError('P0002', 'Barber not found.', 500);
  }
  const day = queueToday(shop);
  if (waitingAt(shop.id, day).length >= MAX_QUEUE_WAITING) throw new PgError('P0001', QUEUE_FULL, 400);
  return insertRow('queue_entries', {
    shop_id: shop.id,
    day,
    guest_name: name,
    guest_phone: trimmed(args.p_phone),
    service_id: serviceId,
    barber_id: barberId,
    created_at: joinedAt(shop.id),
  });
}

/** call_from_queue: it's their turn; calling again notes the new time. */
export function callFromQueue(c: Caller, id: unknown) {
  const key = toColumnValue('queue_entries', 'id', id);
  const row = tables().queue_entries.find((e) => {
    const shop = findById('shops', e.shop_id);
    return e.id === key && shop != null && ownsShop(shop.id, c.uid) && e.day === queueToday(shop) && e.state !== 'gone';
  });
  if (!row) throw new PgError('P0002', QUEUE_GONE, 500);
  return updateRows('queue_entries', [row], { state: 'called', called_at: new Date(now()).toISOString() })[0];
}

/** remove_from_queue: not here when called, or taken off while waiting. Already gone is fine. */
export function removeFromQueue(c: Caller, id: unknown) {
  const key = toColumnValue('queue_entries', 'id', id);
  for (const e of tables().queue_entries.filter((e) => e.id === key && ownsShop(e.shop_id, c.uid) && e.state !== 'gone')) {
    updateRows('queue_entries', [e], {
      state: 'gone',
      gone_reason: e.state === 'called' ? 'not_here' : 'removed',
      gone_at: new Date(now()).toISOString(),
    });
  }
}

/**
 * start_from_queue: their cut becomes an ordinary booking from now (to the
 * minute) with a barber working today (in now or not, as past closing time
 * the shop still serves who is left) and free until it would end. A booking
 * in the way is named, with its time as the error's detail.
 */
export function startFromQueue(c: Caller, id: unknown, barberId: unknown, serviceId: unknown = null) {
  const shop = myShop(c);
  const tz = String(shop.time_zone);
  const key = toColumnValue('queue_entries', 'id', id);
  const entry = tables().queue_entries.find(
    (e) => e.id === key && e.shop_id === shop.id && e.state !== 'gone' && e.day === queueToday(shop),
  );
  if (!entry) throw new PgError('P0002', QUEUE_GONE, 500);
  const service = tables().services.find((v) => v.id === (serviceId ?? entry.service_id) && v.shop_id === shop.id);
  if (!service) throw new PgError('22023', 'Pick a service for their cut.', 400);
  if (!tables().barbers.some((b) => b.id === barberId && b.shop_id === shop.id)) {
    throw new PgError('P0002', 'Barber not found.', 500);
  }
  const barber = barbersInNow(shop, true).find((b) => b.id === barberId);
  if (!barber) throw new PgError('P0001', 'That barber isn\'t working today. Pick another barber.', 400);

  const start = Math.floor(now() / 60_000) * 60_000;
  const end = start + Number(service.duration_min) * 60_000;
  const [first] = tables()
    .bookings.filter((bk) => clash(bk, barber.id, start, end))
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  if (first && ms(first.starts_at) <= start) {
    throw new PgError(
      'P0001',
      `${String(barber.name)} is busy until ${clockInEnglish(first.ends_at, tz)}. Pick another barber.`,
      400,
      String(first.ends_at),
    );
  }
  if (first) {
    const clock = clockInEnglish(first.starts_at, tz);
    throw new PgError(
      'P0001',
      `${String(barber.name)} has ${/^(8|11):/.test(clock) ? 'an' : 'a'} ${clock} booking before this cut would finish. Pick another barber.`,
      400,
      String(first.starts_at),
    );
  }
  const booking = guarded(
    () =>
      insertRow('bookings', {
        shop_id: shop.id,
        barber_id: barber.id,
        service_id: service.id,
        customer_id: entry.customer_id ?? null,
        guest_name: entry.customer_id == null ? entry.guest_name : null,
        guest_phone: entry.customer_id == null ? (entry.guest_phone ?? null) : null,
        service_name: service.name,
        price: service.price,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
      }),
    'That barber already has a booking at that time.',
  );
  updateRows('queue_entries', [entry], {
    state: 'gone',
    gone_reason: 'served',
    gone_at: new Date(now()).toISOString(),
    booking_id: booking.id,
  });
  return booking;
}

/**
 * shop_queue: the owner's queue today in order, with each one's name and
 * number as the customer list shows them, and what they asked for.
 */
export function shopQueue(c: Caller) {
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  if (!shop) return [];
  const day = queueToday(shop);
  return tables()
    .queue_entries.filter((e) => e.shop_id === shop.id && e.day === day && e.state !== 'gone')
    .sort(byCreated)
    .map((e) => {
      const profile = e.customer_id == null ? undefined : findById('profiles', e.customer_id);
      const service = e.service_id == null ? undefined : findById('services', e.service_id);
      return {
        id: e.id,
        name: trimmed(profile?.full_name) ?? e.guest_name ?? null,
        phone: e.customer_id == null ? (e.guest_phone ?? null) : (profile?.phone ?? null),
        online: e.customer_id != null,
        service_id: e.service_id ?? null,
        service_name: service?.name ?? null,
        duration_min: service?.duration_min ?? null,
        barber_id: e.barber_id ?? null,
        barber_name: e.barber_id == null ? null : (findById('barbers', e.barber_id)?.name ?? null),
        state: e.state,
        called_at: e.called_at ?? null,
        created_at: e.created_at,
      };
    });
}

/**
 * my_queue: the caller's place in a queue today, with its shop and what they
 * asked for, and a place the shop took off in the last hour, as queue_status
 * gives them.
 */
export function myQueue(c: Caller) {
  if (c.uid == null) return [];
  const shopIds = new Set(tables().queue_entries.filter((e) => e.customer_id === c.uid).map((e) => e.shop_id));
  return [...shopIds]
    .map((id) => findById('shops', id))
    .flatMap((shop) => {
      const mine = shop ? myPlaceAt(c, shop) : undefined;
      return shop && mine ? [{ shop, mine }] : [];
    })
    .sort((a, b) => byCreated(a.mine, b.mine))
    .map(({ shop, mine }) => ({
      ...queueStatus(c, shop.id).mine,
      shop_id: shop.id,
      service_name: mine.service_id == null ? null : (findById('services', mine.service_id)?.name ?? null),
      barber_name: mine.barber_id == null ? null : (findById('barbers', mine.barber_id)?.name ?? null),
      shop: {
        name: shop.name,
        slug: shop.slug,
        time_zone: shop.time_zone,
        phone: shop.phone ?? null,
        address: shop.address ?? null,
        area: shop.area,
        latitude: shop.latitude ?? null,
        longitude: shop.longitude ?? null,
      },
    }));
}

// Reviews -------------------------------------------------------------------

const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 86_400_000;
/** btrim(text, E' \t\r\n'), null when nothing is left. */
const trimmedText = (v: unknown) => (v == null ? null : String(v).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') || null);

/**
 * The booking's own customer rates their cut, 1 to 5 stars with an optional
 * comment, once the shop has marked it done and for 14 days after it started.
 * Rating again in that time changes the same review. nameArg is the name it
 * shows; without one a new review takes firstName and a changed one keeps its name.
 */
export function rateBooking(
  c: Caller,
  bookingId: unknown,
  ratingArg: unknown,
  commentArg: unknown = null,
  nameArg: unknown = null,
) {
  const booking = findById('bookings', toColumnValue('bookings', 'id', bookingId));
  if (!booking || c.uid == null || booking.customer_id !== c.uid) {
    throw new PgError('P0002', 'Booking not found.', 500);
  }
  if (ownsShop(booking.shop_id, c.uid)) throw new PgError('42501', 'You can\'t rate your own shop.', 403);
  if (booking.status !== 'completed' || now() >= ms(booking.starts_at) + REVIEW_WINDOW_MS) {
    throw new PgError('42501', 'You can rate a cut once the shop marks it done, until 14 days after it.', 403);
  }
  const rating = ratingArg == null ? null : Number(toColumnValue('reviews', 'rating', ratingArg));
  if (rating == null || rating < 1 || rating > 5) throw new PgError('22023', 'Pick from 1 to 5 stars.', 400);
  const comment = trimmedText(commentArg);
  if (comment != null && [...comment].length > 280) {
    throw new PgError('22001', 'Please keep your comment under 280 characters.', 400);
  }
  const name = nameArg == null ? null : reviewName(String(nameArg));

  const existing = tables().reviews.find((r) => r.booking_id === booking.id);
  if (existing) {
    return updateRows('reviews', [existing], {
      rating,
      comment,
      first_name: name ?? existing.first_name,
      updated_at: new Date(now()).toISOString(),
    })[0];
  }
  return insertRow('reviews', {
    booking_id: booking.id,
    shop_id: booking.shop_id,
    barber_id: booking.barber_id,
    customer_id: booking.customer_id,
    rating,
    comment,
    first_name: name ?? firstName(String(findById('profiles', c.uid)?.full_name ?? '')),
  });
}

/** The shop's owner replies under a review, or changes their reply. An empty reply takes it away. */
export function replyToReview(c: Caller, bookingId: unknown, replyArg: unknown) {
  const id = toColumnValue('reviews', 'booking_id', bookingId);
  const review = tables().reviews.find((r) => r.booking_id === id);
  if (!review || !ownsShop(review.shop_id, c.uid)) throw new PgError('P0002', 'Review not found.', 500);
  const reply = trimmedText(replyArg);
  if (reply != null && [...reply].length > 280) {
    throw new PgError('22001', 'Please keep your reply under 280 characters.', 400);
  }
  return updateRows('reviews', [review], {
    reply,
    replied_at: reply != null ? new Date(now()).toISOString() : null,
  })[0];
}

export function deleteMyAccount(c: Caller) {
  if (c.uid == null) throw new PgError('42501', 'Not signed in.', 401);
  const mine = tables().bookings.filter((b) => b.customer_id === c.uid);
  for (const b of mine) {
    // Cancelling the upcoming ones is the customer's change, so their shops see it.
    const cancels = b.status === 'confirmed' && ms(b.starts_at) > now();
    updateRows('bookings', [b], {
      status: cancels ? 'cancelled' : b.status,
      ...(cancels ? { customer_changed_at: new Date(now()).toISOString(), customer_change: 'cancelled' } : {}),
      customer_id: null,
      guest_name: 'Deleted account',
      guest_phone: null,
      customer_note: null,
    });
  }
  const user = tables().users.find((u) => u.id === c.uid);
  if (user) deleteRows('users', [user]);
}

/**
 * What My shop's set-up card and Go live need: how many services customers
 * can book, and the active barbers in the team's order with whether each
 * works at least one day a week. Only the caller's own shop; null without one.
 */
export function shopSetup(c: Caller) {
  const shop = c.uid == null ? undefined : tables().shops.find((s) => s.owner_id === c.uid);
  if (!shop) return null;
  const withHours = new Set(tables().working_hours.map((h) => h.barber_id));
  return {
    services: tables().services.filter((v) => v.shop_id === shop.id && v.is_active === true).length,
    barbers: tables()
      .barbers.filter((b) => b.shop_id === shop.id && b.is_active === true)
      .sort(
        (a, b) =>
          Number(a.sort_order) - Number(b.sort_order) ||
          ms(a.created_at) - ms(b.created_at) ||
          (String(a.id) < String(b.id) ? -1 : 1),
      )
      .map((b) => ({ id: b.id, name: b.name, has_hours: withHours.has(b.id) })),
  };
}

/** A barber account with no shop yet turns into a customer one (signed up as a barber by mistake). */
export function becomeCustomer(c: Caller) {
  if (c.uid == null) throw new PgError('42501', 'Not signed in.', 401);
  if (tables().shops.some((s) => s.owner_id === c.uid)) {
    throw new PgError('P0001', 'You have a shop, so this account stays a barber account.', 400);
  }
  const profile = findById('profiles', c.uid);
  if (profile) updateRows('profiles', [profile], { role: 'customer' });
}

// Whole screens in one request ---------------------------------------------------

/** What a select the app sends gives this caller, through the same pretend PostgREST and its policies. */
function selectAs(c: Caller, table: string, query: Record<string, string | string[]>): Row[] {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) for (const one of [value].flat()) params.append(key, one);
  return handleRest('GET', table, params, new Headers(), undefined, c).body as Row[];
}

/**
 * shop_page: everything a shop's page shows when it opens, part for part
 * what its separate requests give the caller. A shop they can't see gives
 * only shop_public_status's answer, and an unknown link neither. To add a
 * part, add a line to the answer.
 */
export function shopPage(c: Caller, slug: unknown) {
  const [shop] = slug == null ? [] : selectAs(c, 'shops', { select: '*', slug: `eq.${String(slug)}` });
  if (!shop) return { shop: null, status: shopPublicStatus(slug)[0] ?? null };
  const today = localDateString(new Date(now()), String(shop.time_zone));
  const forShop = { shop_id: `eq.${String(shop.id)}` };
  // One more than the page shows, to know whether there are more.
  const reviews = selectAs(c, 'reviews', {
    select: 'booking_id,rating,comment,first_name,reply,replied_at,created_at,barbers(name)',
    ...forShop,
    order: 'created_at.desc,booking_id',
    limit: '4',
  });
  return {
    shop,
    services: selectAs(c, 'services', { select: '*', ...forShop, is_active: 'eq.true', order: 'sort_order,name,id' }),
    barbers: selectAs(c, 'barbers', {
      select: '*,working_hours(weekday,opens_at,closes_at)',
      ...forShop,
      is_active: 'eq.true',
      order: 'sort_order,name,id',
      'working_hours.order': 'weekday,opens_at',
    }),
    today,
    closed_days: shopClosedDays(c, shop.id, today, addDays(today, 13)),
    hours_today: shopHoursToday(c, shop.id)[0],
    queue: shop.queue_enabled ? queueStatus(c, shop.id) : null,
    photos: selectAs(c, 'shop_photos', {
      select: 'id,barber_id,caption,path,thumb_path,width,height,sort_order',
      ...forShop,
      order: 'sort_order,created_at,id',
      limit: '24',
    }),
    reviews: reviews.slice(0, 3),
    more_reviews: reviews.length > 3,
  };
}

/**
 * shop_day: everything the Bookings tab asks for on a day, part for part what
 * its separate requests give the owner: the day's bookings, how many services
 * customers can book, every barber with their hours, the strip's closed days,
 * on today tomorrow's bookings still to remind and today's queue, the day's
 * waiting list, and what customers changed since p_since.
 */
export function shopDay(c: Caller, dayArg: unknown, sinceArg: unknown = null, limitArg: unknown = 5) {
  const shop = myShop(c);
  const tz = String(shop.time_zone);
  const today = localDateString(new Date(now()), tz);
  const day = dayArg == null ? null : parseDate(dayArg);
  const forShop = { shop_id: `eq.${String(shop.id)}` };
  const during = (date: string) => [
    `gte.${dayBounds(date, tz).start.toISOString()}`,
    `lt.${dayBounds(addDays(date, 1), tz).start.toISOString()}`,
  ];
  const strip = [addDays(today, -1), addDays(today, 13)];
  return {
    bookings: day
      ? selectAs(c, 'bookings', {
          select: '*,barbers(name),customer:profiles!bookings_customer_id_fkey(full_name,phone)',
          ...forShop,
          starts_at: during(day),
          order: 'starts_at,id',
        })
      : [],
    services: tables().services.filter((v) => v.shop_id === shop.id && v.is_active === true).length,
    barbers: selectAs(c, 'barbers', {
      select: '*,working_hours(*)',
      ...forShop,
      order: 'sort_order,created_at,id',
      'working_hours.order': 'weekday,opens_at',
    }),
    closed: shopClosedDays(
      c,
      shop.id,
      day && day < strip[0] ? day : strip[0],
      day && day > strip[1] ? day : strip[1],
    ),
    tomorrow:
      day === today
        ? selectAs(c, 'bookings', {
            select:
              'id,barber_id,status,is_block,starts_at,reminded_at,guest_phone,created_at,customer:profiles!bookings_customer_id_fkey(phone)',
            ...forShop,
            status: 'eq.confirmed',
            is_block: 'eq.false',
            reminded_at: 'is.null',
            starts_at: during(addDays(today, 1)),
            order: 'starts_at,id',
          })
        : [],
    waiting: day ? shopWaitlist(c, day) : [],
    queue: day === today ? shopQueue(c) : [],
    changes: shopChanges(c, sinceArg, limitArg),
  };
}

/** Who may call what: the migration revokes these from anonymous callers. */
const SIGNED_IN_ONLY = new Set([
  'book_appointment',
  'set_booking_status',
  'mark_booking_reminded',
  'reschedule_booking',
  'set_barber_hours',
  'add_shop_booking',
  'delete_my_account',
  'become_customer',
  'close_shop_days',
  'reopen_shop_days',
  'shop_summary',
  'shop_customers',
  'shop_cards',
  'shop_changes',
  'shop_setup',
  'my_bookings',
  'rate_booking',
  'reply_to_review',
  'my_shops',
  'my_upcoming_bookings',
  'join_waitlist',
  'leave_waitlist',
  'mark_waitlist_offered',
  'shop_waitlist',
  'my_waitlist',
  'join_queue',
  'leave_queue',
  'add_to_queue',
  'call_from_queue',
  'remove_from_queue',
  'start_from_queue',
  'shop_queue',
  'my_queue',
  'shop_day',
]);

export function callFunction(name: string, args: Record<string, unknown>, c: Caller): { status: number; body?: unknown } {
  if (SIGNED_IN_ONLY.has(name) && c.uid == null) {
    throw new PgError('42501', `permission denied for function ${name}`, 401);
  }
  switch (name) {
    case 'find_shops':
      return { status: 200, body: findShops(args) };
    case 'shop_hours_today':
      return { status: 200, body: shopHoursToday(c, args.p_shop_id) };
    case 'shop_areas':
      return { status: 200, body: shopAreas() };
    case 'shop_public_status':
      return { status: 200, body: shopPublicStatus(args.p_slug) };
    case 'available_slots':
      return {
        status: 200,
        body: availableSlots(c, args.p_service_id, args.p_day, args.p_barber_id ?? null, args.p_ignore_booking ?? null),
      };
    case 'book_appointment':
      return {
        status: 200,
        body: bookAppointment(c, args.p_service_id, args.p_starts_at, args.p_barber_id ?? null, args.p_note ?? null),
      };
    case 'set_booking_status':
      return { status: 200, body: setBookingStatus(c, args.p_booking_id, args.p_status) };
    case 'mark_booking_reminded':
      return { status: 200, body: markBookingReminded(c, args.p_booking_id, args.p_starts_at, args.p_reminded) };
    case 'reschedule_booking':
      return {
        status: 200,
        body: rescheduleBooking(c, args.p_booking_id, args.p_starts_at, args.p_barber_id ?? null),
      };
    case 'set_barber_hours':
      return { status: 200, body: setBarberHours(c, args.p_barber_id, args.p_hours) };
    case 'add_shop_booking':
      return { status: 200, body: addShopBooking(c, args) };
    case 'close_shop_days':
      return { status: 200, body: closeShopDays(c, args.p_from, args.p_days, args.p_reason ?? null) };
    case 'reopen_shop_days':
      return { status: 200, body: reopenShopDays(c, args.p_from, args.p_days) };
    case 'shop_closed_days':
      return { status: 200, body: shopClosedDays(c, args.p_shop_id, args.p_from, args.p_to) };
    case 'shop_summary':
      return { status: 200, body: shopSummary(c, args.p_from, args.p_to) };
    case 'shop_customers':
      return { status: 200, body: shopCustomers(c, args) };
    case 'shop_cards':
      return { status: 200, body: shopCards(c, args.p_from, args.p_to) };
    case 'shop_changes':
      return { status: 200, body: shopChanges(c, args.p_since ?? null, args.p_limit ?? 5) };
    case 'shop_setup':
      return { status: 200, body: shopSetup(c) };
    case 'my_bookings':
      return { status: 200, body: myBookings(c, args.p_limit) };
    case 'rate_booking':
      return {
        status: 200,
        body: rateBooking(c, args.p_booking_id, args.p_rating, args.p_comment ?? null, args.p_name ?? null),
      };
    case 'reply_to_review':
      return { status: 200, body: replyToReview(c, args.p_booking_id, args.p_reply) };
    case 'my_shops':
      return { status: 200, body: myShops(c) };
    case 'my_upcoming_bookings':
      return { status: 200, body: myUpcomingBookings(c) };
    case 'join_waitlist':
      return { status: 200, body: joinWaitlist(c, args.p_service_id, args.p_day, args.p_barber_id ?? null) };
    case 'leave_waitlist':
      leaveWaitlist(c, args.p_id);
      return { status: 204 };
    case 'mark_waitlist_offered':
      return { status: 200, body: markWaitlistOffered(c, args.p_id) };
    case 'shop_waitlist':
      return { status: 200, body: shopWaitlist(c, args.p_day) };
    case 'my_waitlist':
      return { status: 200, body: myWaitlist(c) };
    case 'queue_status':
      return { status: 200, body: queueStatus(c, args.p_shop_id) };
    case 'join_queue':
      return { status: 200, body: joinQueue(c, args.p_service_id, args.p_barber_id ?? null) };
    case 'leave_queue':
      leaveQueue(c, args.p_id);
      return { status: 204 };
    case 'add_to_queue':
      return { status: 200, body: addToQueue(c, args) };
    case 'call_from_queue':
      return { status: 200, body: callFromQueue(c, args.p_id) };
    case 'remove_from_queue':
      removeFromQueue(c, args.p_id);
      return { status: 204 };
    case 'start_from_queue':
      return { status: 200, body: startFromQueue(c, args.p_id, args.p_barber_id, args.p_service_id ?? null) };
    case 'shop_queue':
      return { status: 200, body: shopQueue(c) };
    case 'my_queue':
      return { status: 200, body: myQueue(c) };
    case 'shop_page':
      return { status: 200, body: shopPage(c, args.p_slug) };
    case 'shop_day':
      return { status: 200, body: shopDay(c, args.p_day, args.p_since ?? null, args.p_limit ?? 5) };
    case 'delete_my_account':
      deleteMyAccount(c);
      return { status: 204 };
    case 'become_customer':
      becomeCustomer(c);
      return { status: 204 };
    default:
      throw new PgError('PGRST202', `Could not find the function public.${name} in the schema cache`, 404);
  }
}
