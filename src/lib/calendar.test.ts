/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bookingEvent,
  escapeText,
  foldLine,
  googleCalendarUrl,
  icsFile,
  icsFileName,
  opensIcsFiles,
  utcStamp,
  type CalendarEvent,
} from './calendar.ts';
import { setCurrentLang } from './lang.ts';

const LINK = 'https://potongku.my/shop/kemas-barber-kajang';
const SHOP = {
  name: 'Kemas Barber',
  address: '23, Jalan Mendaling, 43000 Kajang',
  area: 'Kajang town',
  time_zone: 'Asia/Kuala_Lumpur',
};
const BOOKING = {
  id: '6f1c2a9e-3b7d-4e21-9c55-0a8b7e6d5f43',
  service_name: 'Haircut',
  price: 20,
  // 10:00 to 10:30 am in Kajang.
  starts_at: '2026-10-09T02:00:00+00:00',
  ends_at: '2026-10-09T02:30:00+00:00',
};
const event = (over: Partial<Parameters<typeof bookingEvent>[0]> = {}) =>
  bookingEvent({ booking: BOOKING, shop: SHOP, barber: 'Ali', link: LINK, app: 'PotongKu', ...over });

/** The file's content lines with folding undone, as a calendar reads them. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

test('utcStamp writes the instant in UTC, whatever offset it came with', () => {
  assert.equal(utcStamp('2026-10-09T02:00:00Z'), '20261009T020000Z');
  assert.equal(utcStamp('2026-10-09T10:00:00+08:00'), '20261009T020000Z');
  assert.equal(utcStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678))), '20260102T030405Z');
});

test('bookingEvent says what, where and who, and how to change it', () => {
  const e = event();
  assert.equal(e.uid, BOOKING.id);
  assert.equal(e.title, 'Haircut at Kemas Barber');
  assert.equal(e.location, '23, Jalan Mendaling, 43000 Kajang, Kajang town');
  assert.equal(
    e.description,
    [
      'Barber: Ali',
      'RM20 · Pay at the shop.',
      `Shop page: ${LINK}`,
      'To change or cancel, go to My bookings in PotongKu.',
    ].join('\n'),
  );
  assert.equal(e.url, LINK);
  assert.equal(e.timeZone, 'Asia/Kuala_Lumpur');
});

test('bookingEvent leaves out what it does not know', () => {
  assert.ok(!event({ barber: null }).description.includes('Barber'));
  // The area isn't repeated when the address already has it, and stands in for a missing address.
  const sungaiChua = { ...SHOP, address: 'No. 12, Jalan Sungai Chua 3/1, 43000 Kajang', area: 'Sungai Chua' };
  assert.equal(event({ shop: sungaiChua }).location, sungaiChua.address);
  assert.equal(event({ shop: { ...SHOP, address: null } }).location, 'Kajang town');
  assert.equal(event({ shop: { ...SHOP, address: '  ' } }).location, 'Kajang town');
});

test('bookingEvent is in the app language', () => {
  try {
    setCurrentLang('ms');
    const e = event();
    assert.equal(e.title, 'Haircut di Kemas Barber');
    assert.ok(e.description.includes('RM20 · Bayar di kedai.'));
    assert.ok(e.description.includes('Tempahan saya'));
  } finally {
    setCurrentLang('en');
  }
});

test('googleCalendarUrl fills in Google’s add-event page, encoded', () => {
  const e = event({
    booking: { ...BOOKING, service_name: 'Cut & wash + beard #1' },
    shop: { ...SHOP, name: 'Ah Seng’s 50% "Best"?', address: 'Lot 5/6, Jalan Besar; Kajang' },
  });
  const url = googleCalendarUrl(e);
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text='));
  assert.ok(!/[\s"#’]/.test(url), url);
  assert.ok(url.includes('&dates=20261009T020000Z/20261009T023000Z&'));
  assert.ok(url.includes('Cut%20%26%20wash%20%2B%20beard%20%231'));
  assert.ok(url.endsWith('&ctz=Asia%2FKuala_Lumpur'));
  // Read back, each value is exactly what was put in.
  const params = new URL(url).searchParams;
  assert.equal(params.get('action'), 'TEMPLATE');
  assert.equal(params.get('text'), e.title);
  assert.equal(params.get('details'), e.description);
  assert.equal(params.get('location'), 'Lot 5/6, Jalan Besar; Kajang, Kajang town');
  assert.equal(params.get('ctz'), 'Asia/Kuala_Lumpur');
  assert.ok(params.get('details')!.includes('\n'));
});

test('escapeText escapes what RFC 5545 TEXT needs, backslash first', () => {
  assert.equal(escapeText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
  assert.equal(escapeText('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  // Colons and quotes need nothing.
  assert.equal(escapeText('10:00 "Ali"'), '10:00 "Ali"');
  // An escaped backslash before an n is not read as a line break.
  assert.equal(escapeText('C:\\new'), 'C:\\\\new');
});

test('foldLine keeps every line to 75 bytes and unfolds to the same text', () => {
  const short = 'SUMMARY:Haircut';
  assert.equal(foldLine(short), short);
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75));
  assert.equal(foldLine('x'.repeat(76)), `${'x'.repeat(75)}\r\n x`);
  // The leading space counts, so later lines hold 74 bytes of text.
  assert.equal(foldLine('x'.repeat(75 + 74 + 1)), `${'x'.repeat(75)}\r\n ${'x'.repeat(74)}\r\n x`);

  for (const text of [
    'DESCRIPTION:' + 'é'.repeat(80), // 2 bytes each
    'SUMMARY:' + 'Gunting 理发店 '.repeat(12), // 3-byte Chinese
    'LOCATION:' + '💈✂️'.repeat(30), // 4-byte emoji, and a variation selector
    'DESCRIPTION:a' + '€'.repeat(40), // 3 bytes, lands across the 75 mark
  ]) {
    const folded = foldLine(text);
    const lines = folded.split('\r\n');
    assert.ok(lines.length > 1, text);
    lines.forEach((line, i) => {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line ${i} is ${Buffer.byteLength(line, 'utf8')} bytes`);
      if (i > 0) assert.equal(line[0], ' ');
      // A character split across lines would come back as U+FFFD.
      assert.ok(!Buffer.from(line, 'utf8').toString('utf8').includes('\uFFFD'));
      assert.ok(!/[\uD800-\uDBFF]$/.test(line), 'an emoji was split');
    });
    assert.equal(folded.replace(/\r\n /g, ''), text);
  }
});

test('icsFile is a valid calendar with a reminder an hour before', () => {
  const now = new Date('2026-10-08T09:15:30.250Z');
  const ics = icsFile(event(), 'PotongKu', now);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  // Lines end in CRLF only.
  assert.ok(!/[^\r]\n/.test(ics) && !/\r(?!\n)/.test(ics));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);

  const lines = unfold(ics);
  for (const line of [
    'VERSION:2.0',
    'PRODID:-//PotongKu//Bookings//EN',
    'METHOD:PUBLISH',
    `UID:${BOOKING.id}`,
    'DTSTAMP:20261008T091530Z',
    'DTSTART:20261009T020000Z',
    'DTEND:20261009T023000Z',
    'SUMMARY:Haircut at Kemas Barber',
    'LOCATION:23\\, Jalan Mendaling\\, 43000 Kajang\\, Kajang town',
    `DESCRIPTION:Barber: Ali\\nRM20 · Pay at the shop.\\nShop page: ${LINK}\\nTo change or cancel\\, go to My bookings in PotongKu.`,
    `URL:${LINK}`,
  ]) {
    assert.ok(lines.includes(line), line);
  }
  // The alarm sits inside the event.
  const alarm = lines.slice(lines.indexOf('BEGIN:VALARM'), lines.indexOf('END:VALARM') + 1);
  assert.deepEqual(alarm, [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Haircut at Kemas Barber',
    'TRIGGER:-PT1H',
    'END:VALARM',
  ]);
  assert.ok(lines.indexOf('BEGIN:VEVENT') < lines.indexOf('BEGIN:VALARM'));
  assert.ok(lines.indexOf('END:VALARM') < lines.indexOf('END:VEVENT'));
  // The same booking gets the same UID every time.
  assert.ok(unfold(icsFile(event(), 'PotongKu')).includes(`UID:${BOOKING.id}`));
});

test('icsFile escapes what the barber typed and leaves out a link that isn’t a web address', () => {
  const e: CalendarEvent = {
    ...event(),
    title: 'Fade; beard, \\ wash',
    location: 'Lot 1,\nKajang',
    url: 'exp://192.168.1.5:8081/--/shop/kemas',
  };
  const lines = unfold(icsFile(e, 'PotongKu'));
  assert.ok(lines.includes('SUMMARY:Fade\\; beard\\, \\\\ wash'));
  assert.ok(lines.includes('LOCATION:Lot 1\\,\\nKajang'));
  assert.ok(!lines.some((l) => l.startsWith('URL:')));
});

test('a booking near midnight in Kuala Lumpur keeps its UTC day', () => {
  // 11:45 pm on Fri 9 Oct to 12:30 am on Sat 10 Oct in Kajang (UTC+8).
  const late = event({
    booking: { ...BOOKING, starts_at: '2026-10-09T15:45:00Z', ends_at: '2026-10-09T16:30:00Z' },
  });
  const lines = unfold(icsFile(late, 'PotongKu'));
  assert.ok(lines.includes('DTSTART:20261009T154500Z'));
  assert.ok(lines.includes('DTEND:20261009T163000Z'));
  // 12:15 am on Sat 10 Oct in Kajang is still Friday in UTC.
  const early = event({
    booking: { ...BOOKING, starts_at: '2026-10-09T16:15:00Z', ends_at: '2026-10-09T16:45:00Z' },
  });
  assert.ok(googleCalendarUrl(early).includes('&dates=20261009T161500Z/20261009T164500Z&'));
  assert.ok(googleCalendarUrl(early).endsWith('&ctz=Asia%2FKuala_Lumpur'));
});

test('icsFileName is made from the title', () => {
  assert.equal(icsFileName(event()), 'haircut-at-kemas-barber.ics');
  assert.equal(icsFileName({ ...event(), title: '理发' }), 'booking.ics');
});

test('opensIcsFiles is true for Safari on Apple devices only', () => {
  const ua = {
    iPhoneSafari:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    // iPads ask for the Mac site, so this is Safari on a Mac or an iPad.
    macOrIPadSafari:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    iPhoneChrome:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
    iPhoneInstagram:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0',
    iPhoneFacebook:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0]',
    macChrome:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
    androidChrome:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    windowsEdge:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  };
  const yes = Object.entries(ua)
    .filter(([, agent]) => opensIcsFiles(agent))
    .map(([name]) => name);
  assert.deepEqual(yes, ['iPhoneSafari', 'macOrIPadSafari']);
});
