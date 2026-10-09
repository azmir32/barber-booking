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

/** A booking nobody in the shop has reminded yet. */
export function needsReminder(b: Remindable, phone: string | null, now: number, timeZone: string): boolean {
  return !b.reminded_at && canRemind(b, phone, now, timeZone);
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
