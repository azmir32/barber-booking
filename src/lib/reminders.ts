// Day-before reminders the shop sends on WhatsApp, to cut no-shows.

import { t } from './lang.ts';
import { addDays, dayBounds, localDateString } from './time.ts';
import type { Booking } from './types.ts';

type Remindable = Pick<Booking, 'status' | 'is_block' | 'starts_at' | 'reminded_at'>;

/**
 * Whether the shop can send a reminder now: a confirmed booking still to come,
 * by the end of tomorrow on the shop's clock, with a phone to send it to.
 */
export function canRemind(b: Remindable, phone: string | null, now: number, timeZone: string): boolean {
  const at = Date.parse(b.starts_at);
  const endOfTomorrow = dayBounds(addDays(localDateString(new Date(now), timeZone), 1), timeZone).end.getTime();
  return !b.is_block && b.status === 'confirmed' && Boolean(phone) && at > now && at < endOfTomorrow;
}

/**
 * A booking due its day-before reminder that nobody in the shop has sent:
 * tomorrow on the shop's clock, and booked before today. Someone who booked
 * today has only just agreed the time, often with the barber on WhatsApp.
 */
export function needsReminder(
  b: Remindable & Pick<Booking, 'created_at'>,
  phone: string | null,
  now: number,
  timeZone: string,
): boolean {
  const today = localDateString(new Date(now), timeZone);
  return (
    !b.reminded_at &&
    canRemind(b, phone, now, timeZone) &&
    localDateString(new Date(b.starts_at), timeZone) === addDays(today, 1) &&
    localDateString(new Date(b.created_at), timeZone) < today
  );
}

/** The WhatsApp message, saying "today" or "tomorrow" when it is. */
export function reminderMessage(
  vars: { who: string; shop: string; service: string; day: string; time: string },
  startsAt: string,
  now: number,
  timeZone: string,
): string {
  const today = localDateString(new Date(now), timeZone);
  const day = localDateString(new Date(startsAt), timeZone);
  if (day === today) {
    return t(
      'Hi {who}, a reminder from {shop}: your {service} is today at {time}. Can’t make it? Just reply here so we can give the slot to someone else.',
      vars,
    );
  }
  if (day === addDays(today, 1)) {
    return t(
      'Hi {who}, a reminder from {shop}: your {service} is tomorrow at {time}. Can’t make it? Just reply here so we can give the slot to someone else.',
      vars,
    );
  }
  return t(
    'Hi {who}, a reminder from {shop}: your {service} is on {day} at {time}. Can’t make it? Just reply here so we can give the slot to someone else.',
    vars,
  );
}
