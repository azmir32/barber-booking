// The booking rules: line-by-line ports of the SQL functions in
// supabase/migrations, with the same checks, messages and error codes.
// Like the originals they run with full access (security definer) and
// decide for themselves what the caller may do.

import { addDays, dayBounds, localDateString } from '../lib/time.ts';
import {
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
import type { Caller } from './postgrest.ts';

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

export function findShops(args: Record<string, unknown>) {
  const search = blank(args.p_search) ? null : pgTrim(String(args.p_search)).toLowerCase();
  const area = blank(args.p_area) ? null : pgTrim(String(args.p_area)).toLowerCase();
  const limit = Math.min(Math.max(Number(args.p_limit ?? 20), 1), 50);
  const offset = Math.max(Number(args.p_offset ?? 0), 0);
  return tables()
    .shops.filter(
      (s) =>
        shopIsLive(s) &&
        (area == null || sortKey(s.area) === area) &&
        (search == null || `${s.name} ${s.area} ${s.address ?? ''}`.toLowerCase().includes(search)),
    )
    .sort((a, b) =>
      sortKey(a.name) !== sortKey(b.name)
        ? sortKey(a.name) < sortKey(b.name) ? -1 : 1
        : String(a.id) < String(b.id) ? -1 : 1,
    )
    .slice(offset, offset + limit)
    .map((s) => {
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
      };
    });
}

/**
 * The earliest free start for the shop's shortest service with any barber,
 * today by its own clock or else tomorrow; null when neither has one.
 */
function shopNextFree(shop: Row): string | null {
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
  // Only live shops are listed, so it is the same whoever asks.
  const anyone: Caller = { uid: null };
  // Tomorrow is only worked out when today has nothing left.
  for (const day of [today, addDays(today, 1)]) {
    const [first] = availableSlots(anyone, service.id, day);
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

  return guarded(
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
      }),
    TAKEN,
  );
}

export function rescheduleBooking(c: Caller, bookingId: unknown, startsAt: unknown, barberId: unknown = null) {
  const booking = findById('bookings', bookingId);
  if (!booking || booking.is_block) throw new PgError('P0002', 'Booking not found.', 500);
  if (c.uid == null || booking.customer_id !== c.uid) throw new PgError('P0002', 'Booking not found.', 500);
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

  return guarded(
    () =>
      updateRows('bookings', [booking], {
        barber_id: free[0].barber_id,
        starts_at: new Date(at).toISOString(),
        ends_at: new Date(at + Number(service.duration_min) * 60_000).toISOString(),
      })[0],
    TAKEN,
  );
}

export function setBookingStatus(c: Caller, bookingId: unknown, status: unknown) {
  const booking = findById('bookings', bookingId);
  if (!booking) throw new PgError('P0002', 'Booking not found.', 500);
  const next = toColumnValue('bookings', 'status', status);
  if (ownsShop(booking.shop_id, c.uid)) {
    if ((next === 'completed' || next === 'no_show') && ms(booking.starts_at) > now()) {
      throw new PgError('42501', 'You can mark this once the appointment has started.', 403);
    }
  } else if (c.uid != null && booking.customer_id === c.uid) {
    if (next !== 'cancelled' || booking.status !== 'confirmed' || ms(booking.starts_at) <= now()) {
      throw new PgError('42501', 'You can only cancel an upcoming booking.', 403);
    }
  } else {
    throw new PgError('P0002', 'Booking not found.', 500);
  }
  return guarded(
    () => updateRows('bookings', [booking], { status: next })[0],
    'That time has been booked by someone else since.',
  );
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

  return guarded(
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
  const toCome = tables().bookings.some(
    (b) =>
      b.shop_id === shop.id &&
      !b.is_block &&
      b.status === 'confirmed' &&
      ms(b.ends_at) > now() &&
      ms(b.starts_at) < end &&
      start < ms(b.ends_at),
  );
  if (toCome) {
    throw new PgError(
      'P0001',
      'There are bookings on those days. Cancel them first (and let the customers know), then close the shop.',
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

export function shopClosedDays(c: Caller, shopId: unknown, fromArg: unknown, toArg: unknown) {
  const shop = findById('shops', shopId);
  const mine = shop != null && c.uid != null && shop.owner_id === c.uid;
  if (!shop || !(shopIsLive(shop) || mine) || fromArg == null) return [];
  const tz = String(shop.time_zone);
  const from = parseDate(fromArg);
  const to = toArg == null ? null : parseDate(toArg);
  const last = to != null && to < addDays(from, 90) ? to : addDays(from, 90);
  const closures = tables()
    .shop_closures.filter((cl) => cl.shop_id === shop.id && String(cl.day) >= from && String(cl.day) <= last)
    .map((cl) => ({ day: String(cl.day), reason: mine ? (cl.reason as string | null) : null, is_closure: true }));
  const closed = new Set(tables().shop_closures.filter((cl) => cl.shop_id === shop.id).map((cl) => cl.day));

  // Days every barber has the whole day off.
  const team = new Set(tables().barbers.filter((b) => b.shop_id === shop.id && b.is_active).map((b) => b.id));
  const start = dayBounds(from, tz).start.getTime();
  const end = dayBounds(addDays(last, 1), tz).start.getTime();
  const byDay = new Map<string, { barbers: Set<unknown>; reasons: string[] }>();
  for (const b of tables().bookings) {
    if (b.shop_id !== shop.id || b.status !== 'confirmed' || !isWholeDayBlock(b) || !team.has(b.barber_id)) continue;
    if (ms(b.starts_at) < start || ms(b.starts_at) >= end) continue;
    const day = localDateString(new Date(ms(b.starts_at)), tz);
    const entry = byDay.get(day) ?? { barbers: new Set(), reasons: [] };
    entry.barbers.add(b.barber_id);
    entry.reasons.push(String(b.service_name));
    byDay.set(day, entry);
  }
  const allOff = [...byDay.entries()]
    .filter(([day, e]) => team.size > 0 && e.barbers.size === team.size && !closed.has(day))
    .map(([day, e]) => ({ day, reason: mine ? e.reasons.sort()[0] : null, is_closure: false }));
  return [...closures, ...allOff].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function deleteMyAccount(c: Caller) {
  if (c.uid == null) throw new PgError('42501', 'Not signed in.', 401);
  const mine = tables().bookings.filter((b) => b.customer_id === c.uid);
  for (const b of mine) {
    updateRows('bookings', [b], {
      status: b.status === 'confirmed' && ms(b.starts_at) > now() ? 'cancelled' : b.status,
      customer_id: null,
      guest_name: 'Deleted account',
      guest_phone: null,
      customer_note: null,
    });
  }
  const user = tables().users.find((u) => u.id === c.uid);
  if (user) deleteRows('users', [user]);
}

/** Who may call what: the migration revokes these from anonymous callers. */
const SIGNED_IN_ONLY = new Set([
  'book_appointment',
  'set_booking_status',
  'reschedule_booking',
  'set_barber_hours',
  'add_shop_booking',
  'delete_my_account',
  'close_shop_days',
  'reopen_shop_days',
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
    case 'delete_my_account':
      deleteMyAccount(c);
      return { status: 204 };
    default:
      throw new PgError('PGRST202', `Could not find the function public.${name} in the schema cache`, 404);
  }
}
