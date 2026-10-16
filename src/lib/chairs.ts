// The barber's day as chairs side by side (components/chairs.tsx): where each
// booking, block, break and free stretch sits, in minutes from the day's
// midnight on the shop's clock. The screen turns minutes into points.

import { t } from './lang.ts';
import { clockLabel, dayBounds, DEFAULT_TIME_ZONE } from './time.ts';
import type { Barber, Booking, WorkingHours } from './types.ts';

/** Free time is offered in quarter hours, the steps the booking screens use. */
export const SLOT_MINUTES = 15;
const DAY_MINUTES = 24 * 60;

/** A stretch of the day: minutes from midnight, `to` not included. */
export type Span = { from: number; to: number };

export type ChairBooking = Pick<Booking, 'id' | 'barber_id' | 'starts_at' | 'ends_at' | 'status' | 'is_block'>;
export type ChairBarber = Pick<Barber, 'id' | 'is_active'> & {
  working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[];
};

export type ChairItem<B> = Span & { booking: B };
export type Shade = Span & { kind: 'off' | 'break' };

export type Chair<Br, B> = {
  barber: Br;
  /** The barber's hours that day; none for one marked away who still has customers booked. */
  hours: Span[];
  /** Bookings and blocked time, by start. Cancelled ones are left out. */
  items: ChairItem<B>[];
  /** Time with nothing on it outside the barber's hours: before or after them (off), or between them (break). */
  shades: Shade[];
  /** Time with nothing on it inside the barber's hours. */
  gaps: Span[];
};

export type ChairsDay<Br, B> = {
  /** The time down the side, in whole hours: earliest opening to latest closing, stretched to fit every booking. */
  from: number;
  to: number;
  /** One per barber working that day, in the team's order, and any other barber with customers still booked. */
  chairs: Chair<Br, B>[];
  /** Barbers with the day off: no hours that weekday, or the whole day blocked. */
  off: Br[];
  /** Barbers marked away who would otherwise work that day. */
  away: Br[];
};

/** "10:30" or "10:30:00" to minutes from midnight. */
const clockMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/** Minutes from midnight to "HH:MM", the way new-booking takes a start time. */
export function clockOf(minutes: number): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes from midnight as read out: "4:30 pm", or "4.30 petang" in Malay. Midnight at the end of the day too. */
export function clockText(minutes: number): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return clockLabel(Math.floor(m / 60), m % 60);
}

/** Lays out one day. `bookings` are that day's, as the Bookings tab loads them. */
export function chairsDay<Br extends ChairBarber, B extends ChairBooking>(
  day: string,
  barbers: Br[],
  bookings: B[],
  timeZone = DEFAULT_TIME_ZONE,
): ChairsDay<Br, B> {
  const midnight = dayBounds(day, timeZone).start.getTime();
  const minuteOf = (at: string) => Math.round((Date.parse(at) - midnight) / 60_000);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const chairs: Chair<Br, B>[] = [];
  const off: Br[] = [];
  const away: Br[] = [];

  for (const barber of barbers) {
    const own = bookings.filter((b) => b.barber_id === barber.id && b.status !== 'cancelled');
    const wholeDay = own.some((b) => b.is_block && minuteOf(b.ends_at) - minuteOf(b.starts_at) >= DAY_MINUTES);
    const hours = barber.working_hours
      .filter((h) => h.weekday === weekday)
      .map((h) => ({ from: clockMinutes(h.opens_at), to: clockMinutes(h.closes_at) }))
      .sort((a, b) => a.from - b.from);
    const items = own
      .map((booking) => ({
        booking,
        from: Math.max(0, minuteOf(booking.starts_at)),
        to: Math.min(DAY_MINUTES, minuteOf(booking.ends_at)),
      }))
      // A whole day blocked is the day off, said above the chairs rather than drawn down one.
      .filter((i) => i.to > i.from && !(i.booking.is_block && i.to - i.from >= DAY_MINUTES))
      .sort((a, b) => a.from - b.from);
    const working = barber.is_active && hours.length > 0 && !wholeDay;
    // Someone away or off with customers still booked keeps a chair, so nobody is forgotten.
    if (working || items.some((i) => !i.booking.is_block)) {
      chairs.push({ barber, hours: working ? hours : [], items, shades: [], gaps: [] });
    } else if (!barber.is_active) {
      if (hours.length > 0) away.push(barber);
    } else {
      off.push(barber);
    }
  }

  const starts = chairs.flatMap((c) => [...c.hours, ...c.items].map((s) => s.from));
  const ends = chairs.flatMap((c) => [...c.hours, ...c.items].map((s) => s.to));
  if (starts.length === 0) return { from: 0, to: 0, chairs, off, away };
  const from = Math.floor(Math.min(...starts) / 60) * 60;
  const to = Math.min(DAY_MINUTES, Math.ceil(Math.max(...ends) / 60) * 60);
  for (const chair of chairs) Object.assign(chair, fill(chair.hours, chair.items, from, to));
  return { from, to, chairs, off, away };
}

/**
 * What is under each stretch of a chair with nothing booked on it: free in
 * its hours, a break between them, off before and after. A booking or block
 * covers whatever is under it, so a block over a break leaves no break showing.
 */
function fill(hours: Span[], items: Span[], from: number, to: number): { shades: Shade[]; gaps: Span[] } {
  const cuts = [...new Set([from, to, ...[...hours, ...items].flatMap((s) => [s.from, s.to])])]
    .filter((m) => m >= from && m <= to)
    .sort((a, b) => a - b);
  const first = hours[0]?.from ?? to;
  const last = hours.at(-1)?.to ?? from;
  const shades: Shade[] = [];
  const gaps: Span[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1];
    const b = cuts[i];
    const mid = (a + b) / 2;
    if (items.some((s) => s.from < mid && mid < s.to)) continue;
    if (hours.some((s) => s.from < mid && mid < s.to)) {
      const prev = gaps.at(-1);
      if (prev && prev.to === a) prev.to = b;
      else gaps.push({ from: a, to: b });
      continue;
    }
    const kind = mid > first && mid < last ? 'break' : 'off';
    const prev = shades.at(-1);
    if (prev && prev.to === a && prev.kind === kind) prev.to = b;
    else shades.push({ kind, from: a, to: b });
  }
  return { shades, gaps };
}

/** One quarter hour of free time to tap: the start it offers, and the stretch of the gap it covers. */
export type Slot = Span & { at: number };

/**
 * The quarter-hour starts a free stretch offers, from the quarter hour now is
 * in (`notBefore`, minutes from midnight; 0 for a day still to come). Odd
 * minutes at the top of the gap (a booking ending at 10:20) go with the first
 * start, unless they are already past.
 */
export function gapSlots(gap: Span, notBefore = 0): Slot[] {
  const earliest = Math.floor(notBefore / SLOT_MINUTES) * SLOT_MINUTES;
  const first = Math.max(Math.ceil(gap.from / SLOT_MINUTES) * SLOT_MINUTES, earliest);
  const slots: Slot[] = [];
  for (let at = first; at < gap.to; at += SLOT_MINUTES) {
    slots.push({ at, from: at, to: Math.min(at + SLOT_MINUTES, gap.to) });
  }
  if (slots.length && gap.from >= earliest) slots[0].from = gap.from;
  return slots;
}

/**
 * Minutes from the day's midnight to `now`, for the now line and for which
 * free times can still be offered: below 0 on a day still to come, past the
 * day's end on one gone by.
 */
export function minutesInto(day: string, now: number, timeZone = DEFAULT_TIME_ZONE): number {
  return Math.floor((now - dayBounds(day, timeZone).start.getTime()) / 60_000);
}

export type ChairStatus = 'block' | 'upcoming' | 'now' | 'toMark' | 'done' | 'noShow';

/** What a block in a chair is coloured by: still to come, in the chair now, waiting to be marked, done or a no-show. */
export function chairStatus(b: Pick<Booking, 'status' | 'is_block' | 'starts_at' | 'ends_at'>, now: number): ChairStatus {
  if (b.is_block) return 'block';
  if (b.status === 'completed') return 'done';
  if (b.status === 'no_show') return 'noShow';
  if (Date.parse(b.ends_at) <= now) return 'toMark';
  return Date.parse(b.starts_at) <= now ? 'now' : 'upcoming';
}

/** The word a block says beside its time, so its colour isn't the only clue; none for one still to come. */
export function statusWord(status: ChairStatus): string | null {
  switch (status) {
    case 'now':
      return t('Now');
    case 'toMark':
      return t('Mark done?');
    case 'done':
      return t('Done');
    case 'noShow':
      return t('No-show');
    default:
      return null;
  }
}
