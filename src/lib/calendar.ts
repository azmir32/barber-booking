// A booking as a calendar entry, so the customer's own phone reminds them
// without the app sending anything: a Google Calendar link, and an iCalendar
// (.ics) file that Safari hands to Apple's Calendar. add-to-calendar.ts
// picks one for the platform.

import { t } from './lang.ts';
import { formatPrice, slugify } from './time.ts';
import type { Booking, Shop } from './types.ts';

export type CalendarEvent = {
  /** The booking's id, so a calendar can tell it is the same booking if it is added again. */
  uid: string;
  title: string;
  /** UTC instants, as bookings store them. */
  startsAt: string;
  endsAt: string;
  location: string;
  description: string;
  /** The shop's booking page. */
  url: string;
  /** The shop's IANA zone, which Google shows the times in. */
  timeZone: string;
};

export function bookingEvent({
  booking,
  shop,
  barber,
  link,
  app,
}: {
  booking: Pick<Booking, 'id' | 'service_name' | 'price' | 'starts_at' | 'ends_at'>;
  shop: Pick<Shop, 'name' | 'address' | 'area' | 'time_zone'>;
  /** Left out when it isn't known, e.g. a barber who has since left. */
  barber?: string | null;
  /** bookingLink(shop.slug), so the customer can find the shop again. */
  link: string;
  /** The app's name, to say where to change or cancel. */
  app: string;
}): CalendarEvent {
  const lines = [
    barber ? t('Barber: {name}', { name: barber }) : null,
    `${formatPrice(booking.price)} · ${t('Pay at the shop.')}`,
    t('Shop page: {link}', { link }),
    t('To change or cancel, go to My bookings in {app}.', { app }),
  ];
  return {
    uid: booking.id,
    title: t('{service} at {shop}', { service: booking.service_name, shop: shop.name }),
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    location: place(shop),
    description: lines.filter(Boolean).join('\n'),
    url: link,
    timeZone: shop.time_zone,
  };
}

/** The address with the area after it, unless the address already says it. */
function place(shop: Pick<Shop, 'address' | 'area'>): string {
  const address = shop.address?.trim();
  if (!address) return shop.area;
  return address.toLowerCase().includes(shop.area.trim().toLowerCase()) ? address : `${address}, ${shop.area}`;
}

/** "20261009T020000Z": an instant in UTC, the way both formats write it. */
export function utcStamp(at: string | Date): string {
  return new Date(at)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** Google Calendar's "add event" page, filled in. Android opens it in the Calendar app. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const q = encodeURIComponent;
  return (
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${q(event.title)}` +
    `&dates=${utcStamp(event.startsAt)}/${utcStamp(event.endsAt)}` +
    `&details=${q(event.description)}` +
    `&location=${q(event.location)}` +
    `&ctz=${q(event.timeZone)}`
  );
}

/** RFC 5545 TEXT: backslashes, semicolons and commas are escaped, and line breaks become \n. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const utf8Length = (char: string) => {
  const code = char.codePointAt(0)!;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/**
 * Folds a content line at 75 bytes of UTF-8, as RFC 5545 asks, never inside a
 * character; each line after the first starts with a space.
 */
export function foldLine(line: string): string {
  const lines: string[] = [];
  let current = '';
  let bytes = 0;
  // for...of walks whole characters, so an emoji's two halves stay together.
  for (const char of line) {
    const size = utf8Length(char);
    // The leading space counts toward a folded line's 75.
    if (bytes + size > (lines.length === 0 ? 75 : 74)) {
      lines.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  lines.push(current);
  return lines.join('\r\n ');
}

/** The event as an .ics file, with a reminder an hour before. */
export function icsFile(event: CalendarEvent, app: string, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escapeText(app)}//Bookings//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(event.startsAt)}`,
    `DTEND:${utcStamp(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `LOCATION:${escapeText(event.location)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    // A URL is not TEXT, so it is not escaped; anything but a plain web link is left to the description.
    ...(/^https?:\/\/[^\s"<>\\]+$/.test(event.url) ? [`URL:${event.url}`] : []),
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(event.title)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** "haircut-at-kemas-barber.ics", or "booking.ics" for a name with no Latin letters. */
export function icsFileName(event: CalendarEvent): string {
  return `${slugify(event.title) || 'booking'}.ics`;
}

/**
 * Whether the browser opens a downloaded .ics file in Apple's Calendar:
 * Safari on an iPhone, iPad or Mac (iPads ask for the Mac site). Other
 * browsers, and in-app ones like Instagram's that can't download, get the
 * Google Calendar link instead.
 */
export function opensIcsFiles(userAgent: string): boolean {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(userAgent);
  // Chrome, Firefox and Edge on Apple devices also say Safari; in-app browsers don't.
  const safari = /Safari\//.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR|OPiOS|GSA\//.test(userAgent);
  return apple && safari;
}
