// Reminders the customer's own phone schedules for itself before each
// booking, the evening before and an hour before, to cut no-shows with no
// server or push account. This works out which reminders should exist from
// the bookings, the customer's settings and the time; reminder-scheduler.ts
// makes the phone's scheduled notifications match.

import { t } from './lang.ts';
import { addDays, DEFAULT_TIME_ZONE, formatTime, localDateString, localInstant } from './time.ts';

/** A booking still to come, as my_upcoming_bookings and my_shops give it (My bookings maps its own list to this). */
export type ReminderBooking = {
  id: string;
  starts_at: string;
  service_name: string;
  shop_name: string;
  /** The shop's: its clock decides which evening is the evening before. */
  time_zone: string | null;
  /** Only confirmed bookings are reminded of; my_upcoming_bookings sends nothing else. */
  status?: string;
};

export type ReminderKind = 'evening' | 'hour';
export type ReminderSettings = Record<ReminderKind, boolean>;
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { evening: true, hour: true };

export type PlannedReminder = {
  /**
   * The notification's identifier on the phone. It covers everything the
   * reminder says and when, so a booking moved, renamed by the shop or read
   * in another language gets a new one in place of the old.
   */
  id: string;
  bookingId: string;
  kind: ReminderKind;
  /** When it goes off, in ms. */
  at: number;
  /** The shop's name. */
  title: string;
  body: string;
  service: string;
  timeZone: string;
};

/** Every reminder's identifier starts with this, so nothing else the phone has scheduled is touched. */
export const REMINDER_ID_PREFIX = 'potongku-reminder-';
/** iOS keeps at most 64 notifications waiting for an app, and drops the rest. */
export const MAX_REMINDERS = 60;
/** As many bookings as my_upcoming_bookings gives, so every screen plans from the same ones. */
export const MAX_REMINDED_BOOKINGS = 30;
/** When the evening reminder goes, on the shop's clock. */
export const EVENING_CLOCK = '20:00';
const HOUR_MS = 60 * 60_000;

/** A short fingerprint of what a reminder says and when, for its identifier. */
function fingerprint(text: string): string {
  // FNV-1a: tiny and plenty for telling a handful of reminders apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The reminders that should be waiting on the phone now: for each confirmed
 * booking still to come (the soonest 30), one at 8 pm the evening before on
 * the shop's clock and one an hour before, as the settings allow, leaving
 * out any whose time has passed (a booking made after 8 pm the evening
 * before, or within the hour). Soonest first, at most 60. In the app's
 * language at the time.
 */
export function plannedReminders(bookings: ReminderBooking[], settings: ReminderSettings, now: number): PlannedReminder[] {
  const coming = bookings
    .filter((b) => (b.status ?? 'confirmed') === 'confirmed' && Date.parse(b.starts_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_REMINDED_BOOKINGS);

  const planned: PlannedReminder[] = [];
  for (const b of coming) {
    const timeZone = b.time_zone || DEFAULT_TIME_ZONE;
    const startsAt = Date.parse(b.starts_at);
    const vars = { service: b.service_name, time: formatTime(b.starts_at, timeZone) };
    const add = (kind: ReminderKind, at: number, body: string) => {
      if (at <= now) return;
      const title = b.shop_name;
      const id = `${REMINDER_ID_PREFIX}${kind}-${b.id}-${fingerprint(`${at}|${title}|${body}`)}`;
      planned.push({ id, bookingId: b.id, kind, at, title, body, service: b.service_name, timeZone });
    };
    if (settings.evening) {
      const dayBefore = addDays(localDateString(new Date(startsAt), timeZone), -1);
      add(
        'evening',
        localInstant(dayBefore, EVENING_CLOCK, timeZone).getTime(),
        `${t('Your {service} is tomorrow at {time}.', vars)} ${t('Can’t make it? Cancel from My bookings so someone else can take the slot.')}`,
      );
    }
    if (settings.hour) add('hour', startsAt - HOUR_MS, t('Your {service} is in an hour, at {time}.', vars));
  }
  return planned.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(0, MAX_REMINDERS);
}

/**
 * What to change on the phone: the reminders scheduled there that are no
 * longer wanted (a booking moved, cancelled or done, a setting turned off),
 * and the wanted ones not there yet. Notifications that aren't reminders are
 * left alone.
 */
export function reminderChanges(
  wanted: PlannedReminder[],
  scheduledIds: string[],
): { cancel: string[]; schedule: PlannedReminder[] } {
  const want = new Set(wanted.map((r) => r.id));
  const have = new Set(scheduledIds);
  return {
    cancel: scheduledIds.filter((id) => id.startsWith(REMINDER_ID_PREFIX) && !want.has(id)),
    schedule: wanted.filter((r) => !have.has(r.id)),
  };
}

/** The reminder of a kind is turned off: its identifiers, among those scheduled, whatever booking they are for. */
export function remindersOfKind(kind: ReminderKind, scheduledIds: string[]): string[] {
  return scheduledIds.filter((id) => id.startsWith(`${REMINDER_ID_PREFIX}${kind}-`));
}

/** What the booking confirmation says will come, from the reminders planned for that booking; null for none. */
export function remindersLine(kinds: ReminderKind[]): string | null {
  const evening = kinds.includes('evening');
  const hour = kinds.includes('hour');
  if (evening && hour) return t('We’ll remind you the evening before and an hour before.');
  if (evening) return t('We’ll remind you the evening before.');
  if (hour) return t('We’ll remind you an hour before.');
  return null;
}

/** The settings and whether the booking confirmation has asked, as kept on the phone (anything unreadable is the default). */
export function parseReminderPrefs(raw: string | null): { settings: ReminderSettings; asked: boolean } {
  try {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      settings: {
        evening: typeof v.evening === 'boolean' ? v.evening : DEFAULT_REMINDER_SETTINGS.evening,
        hour: typeof v.hour === 'boolean' ? v.hour : DEFAULT_REMINDER_SETTINGS.hour,
      },
      asked: v.asked === true,
    };
  } catch {
    return { settings: DEFAULT_REMINDER_SETTINGS, asked: false };
  }
}
