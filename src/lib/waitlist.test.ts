/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import type { Booking } from './types.ts';
import {
  couldFreeUp,
  freeTimeFor,
  offerMessage,
  openRequests,
  requestService,
  requestStatus,
  type MyWaiting,
  type ShopWaiting,
} from './waitlist.ts';

const TZ = 'Asia/Kuala_Lumpur';
const DAY = '2026-10-24'; // a Saturday
const kajang = (at: string) => new Date(`${at}+08:00`).toISOString();
// The Wednesday before, 3:05 pm in Kajang.
const now = Date.parse('2026-10-21T15:05:00+08:00');

const saturday = (opens: string, closes: string) => [{ weekday: 6, opens_at: opens, closes_at: closes }];
const ali = { id: 'ali', name: 'Ali', is_active: true, working_hours: saturday('10:00', '20:00') };
// Friday prayers aren't on a Saturday, but a break works the same way any day.
const danial = {
  id: 'danial',
  name: 'Danial',
  is_active: true,
  working_hours: [
    { weekday: 6, opens_at: '11:00', closes_at: '13:00' },
    { weekday: 6, opens_at: '14:00', closes_at: '21:00' },
  ],
};
const team = [ali, danial];

type Taken = Pick<Booking, 'barber_id' | 'starts_at' | 'ends_at' | 'status'>;
const booked = (barber: string, from: string, to: string, status: Booking['status'] = 'confirmed'): Taken => ({
  barber_id: barber,
  starts_at: kajang(`${DAY}T${from}:00`),
  ends_at: kajang(`${DAY}T${to}:00`),
  status,
});
/** Each barber's whole day booked, but for the times given. */
const fullDay = (gaps: Record<string, [string, string][]> = {}): Taken[] =>
  team.flatMap((b) => {
    const [opens, closes] = b.id === 'ali' ? ['10:00', '20:00'] : ['11:00', '21:00'];
    const edges = [opens, ...(gaps[b.id] ?? []).flat(), closes];
    const out: Taken[] = [];
    for (let i = 0; i < edges.length; i += 2) if (edges[i] < edges[i + 1]) out.push(booked(b.id, edges[i], edges[i + 1]));
    return out;
  });

const request = (more: Partial<ShopWaiting> = {}): ShopWaiting => ({
  id: 'w1',
  name: 'Hakim',
  phone: '011-2233 4455',
  service_id: 's1',
  service_name: 'Haircut',
  duration_min: 30,
  barber_id: null,
  barber_name: null,
  created_at: kajang('2026-10-21T13:05:00'),
  offered_at: null,
  ...more,
});

const fits = (r: ShopWaiting, bookings: Taken[], at = now) => {
  const free = freeTimeFor(r, DAY, team, bookings, at, TZ);
  return free && [free.barber.id, new Date(free.startsAt).toLocaleTimeString('en-GB', { timeZone: TZ }).slice(0, 5)];
};

/** Without the non-breaking spaces that keep a day or a time on one line. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

const inMalay = (check: () => void) => {
  setCurrentLang('ms');
  try {
    check();
  } finally {
    setCurrentLang('en');
  }
};

test('a full day has no time for anyone waiting', () => {
  assert.equal(fits(request(), fullDay()), null);
  assert.equal(fits(request({ duration_min: 15 }), fullDay()), null);
  assert.equal(fits(request({ barber_id: 'ali' }), fullDay()), null);
});

test('a cancelled time fits a request that is short enough, with the barber asked for', () => {
  // Ali's 5:30 cut is cancelled: the list has it as cancelled, not gone.
  const cancelled = [...fullDay({ ali: [['17:30', '18:00']] }), booked('ali', '17:30', '18:00', 'cancelled')];
  assert.deepEqual(fits(request(), cancelled), ['ali', '17:30']);
  assert.deepEqual(fits(request({ barber_id: 'ali', barber_name: 'Ali' }), cancelled), ['ali', '17:30']);
  // Not with Danial, nor for a 45-minute fade.
  assert.equal(fits(request({ barber_id: 'danial' }), cancelled), null);
  assert.equal(fits(request({ duration_min: 45 }), cancelled), null);
  // Half an hour in quarter hours: a beard trim fits at either.
  assert.deepEqual(fits(request({ duration_min: 15 }), cancelled), ['ali', '17:30']);
});

test('with any barber, the earliest time anyone has, the team’s order breaking a tie', () => {
  const two = fullDay({ ali: [['18:00', '18:30']], danial: [['16:00', '16:30']] });
  assert.deepEqual(fits(request(), two), ['danial', '16:00']);
  const same = fullDay({ ali: [['16:00', '16:30']], danial: [['16:00', '16:30']] });
  assert.deepEqual(fits(request(), same), ['ali', '16:00']);
});

test('only working hours, never a break, a barber away or a time gone by', () => {
  // Danial's break from 1 to 2 is not free time, though nothing is booked in it.
  assert.deepEqual(fits(request({ barber_id: 'danial' }), fullDay({ danial: [['14:00', '14:30']] })), ['danial', '14:00']);
  const open = fullDay({ danial: [['12:30', '13:00'], ['14:00', '15:00']] });
  assert.deepEqual(fits(request({ duration_min: 45, barber_id: 'danial' }), open), ['danial', '14:00']);
  // Starts on the quarter hours from opening, and finishes by closing.
  assert.deepEqual(fits(request({ barber_id: 'danial' }), fullDay({ danial: [['20:35', '21:00']] })), null);
  assert.deepEqual(fits(request({ barber_id: 'danial' }), fullDay({ danial: [['20:15', '21:00']] })), ['danial', '20:15']);
  // Away: no time with them.
  const away = freeTimeFor(request(), DAY, [{ ...ali, is_active: false }, danial], fullDay({ ali: [['17:30', '18:00']] }), now, TZ);
  assert.equal(away, null);
  // On the day itself at 5:40 pm, 5:30 has gone; 6:30 is still to come.
  const later = fullDay({ ali: [['17:30', '18:00'], ['18:30', '19:00']] });
  assert.deepEqual(fits(request(), later, Date.parse(`${DAY}T17:40:00+08:00`)), ['ali', '18:30']);
  // A whole day blocked off has nothing free.
  const off = [booked('ali', '00:00', '23:59')];
  assert.equal(fits(request({ barber_id: 'ali' }), off), null);
  // Nobody works Sundays here.
  assert.equal(freeTimeFor(request(), '2026-10-25', team, [], now, TZ), null);
});

test('a day can still free up while someone works long enough to fit the service', () => {
  const at = (clock: string) => Date.parse(`${DAY}T${clock}:00+08:00`);
  assert.equal(couldFreeUp(DAY, team, null, 30, now, TZ), true);
  // At 8:20 pm Ali has gone home, but Danial cuts until 9.
  assert.equal(couldFreeUp(DAY, team, null, 30, at('20:20'), TZ), true);
  assert.equal(couldFreeUp(DAY, team, 'ali', 30, at('20:20'), TZ), false);
  assert.equal(couldFreeUp(DAY, team, null, 45, at('20:20'), TZ), false);
  assert.equal(couldFreeUp(DAY, team, null, 30, at('21:05'), TZ), false);
  // Nobody works Sundays, and a barber away counts for nothing.
  assert.equal(couldFreeUp('2026-10-25', team, null, 30, now, TZ), false);
  assert.equal(couldFreeUp(DAY, [{ ...ali, is_active: false }], null, 30, now, TZ), false);
});

test('the WhatsApp offers the time that fits, or else asks them to reply', () => {
  const vars = { shop: 'Ali Barber Sungai Chua', day: DAY, link: 'https://potongku.my/shop/ali-barber', timeZone: TZ };
  assert.equal(
    plain(offerMessage({ ...vars, request: request(), free: { barberName: 'Ali', startsAt: kajang(`${DAY}T17:30:00`) } })),
    'Hi Hakim, a 5:30 pm Haircut with Ali just opened on Sat, 24 Oct at Ali Barber Sungai Chua. Want it? ' +
      'Reply here or book at https://potongku.my/shop/ali-barber',
  );
  // Eight and eleven take "an".
  assert.match(
    plain(offerMessage({ ...vars, request: request(), free: { barberName: 'Ali', startsAt: kajang(`${DAY}T11:30:00`) } })),
    /^Hi Hakim, an 11:30 am Haircut with Ali just opened on /,
  );
  assert.match(
    plain(offerMessage({ ...vars, request: request(), free: { barberName: 'Ali', startsAt: kajang(`${DAY}T20:00:00`) } })),
    /^Hi Hakim, an 8:00 pm Haircut /,
  );
  assert.match(
    plain(offerMessage({ ...vars, request: request(), free: { barberName: 'Ali', startsAt: kajang(`${DAY}T13:00:00`) } })),
    /^Hi Hakim, a 1:00 pm Haircut /,
  );
  assert.equal(
    plain(offerMessage({ ...vars, request: request(), free: null })),
    'Hi Hakim, this is Ali Barber Sungai Chua about the Haircut you asked for on Sat, 24 Oct. Reply here and we’ll sort out a time.',
  );
  assert.equal(
    plain(offerMessage({ ...vars, request: request({ barber_name: 'Danial', service_name: 'Skin fade' }), free: null })),
    'Hi Hakim, this is Ali Barber Sungai Chua about the Skin fade with Danial you asked for on Sat, 24 Oct. Reply here and we’ll sort out a time.',
  );
  inMalay(() => {
    assert.equal(
      plain(offerMessage({ ...vars, request: request(), free: { barberName: 'Ali', startsAt: kajang(`${DAY}T17:30:00`) } })),
      'Hai Hakim, slot Haircut bersama Ali jam 5.30 petang pada Sab, 24 Okt baru kosong di Ali Barber Sungai Chua. ' +
        'Nak ambil? Balas di sini atau tempah di https://potongku.my/shop/ali-barber',
    );
  });
});

test('each request says what it is for, and when it was asked or offered', () => {
  assert.equal(requestService(request()), 'Haircut, any barber');
  assert.equal(requestService(request({ barber_name: 'Ali' })), 'Haircut with Ali');
  assert.equal(requestStatus(request(), now, TZ), 'Asked 2 hr ago');
  assert.equal(requestStatus(request({ created_at: new Date(now - 20_000).toISOString() }), now, TZ), 'Asked just now');
  assert.equal(plain(requestStatus(request({ offered_at: kajang('2026-10-21T15:05:00') }), now, TZ)), 'Offered 3:05 pm');
  assert.equal(
    plain(requestStatus(request({ offered_at: kajang('2026-10-20T18:10:00') }), now, TZ)),
    'Offered yesterday at 6:10 pm',
  );
  inMalay(() => {
    assert.equal(requestService(request()), 'Haircut, mana-mana barber');
    assert.equal(plain(requestStatus(request({ offered_at: kajang('2026-10-21T15:05:00') }), now, TZ)), 'Ditawarkan 3.05 petang');
  });
});

test('My bookings leaves out requests for days gone by, and days the customer has since booked', () => {
  const mine = (id: string, day: string, shop = 'shop-a'): MyWaiting => ({
    id,
    shop_id: shop,
    day,
    service_id: 's1',
    service_name: 'Haircut',
    barber_id: null,
    barber_name: null,
    created_at: kajang('2026-10-19T09:00:00'),
    shop: { name: 'Ali Barber Sungai Chua', slug: 'ali-barber', time_zone: TZ },
  });
  const list = [mine('yesterday', '2026-10-20'), mine('today', '2026-10-21'), mine('sat', DAY), mine('elsewhere', DAY, 'shop-b')];
  assert.deepEqual(
    openRequests(list, [], now).map((w) => w.id),
    ['today', 'sat', 'elsewhere'],
  );
  // Booked at Ali's that Saturday: that request has ended, not the one at another shop.
  const bookings = [{ shop_id: 'shop-a', starts_at: kajang(`${DAY}T17:30:00`), status: 'confirmed' as const }];
  assert.deepEqual(
    openRequests(list, bookings, now).map((w) => w.id),
    ['today', 'elsewhere'],
  );
  // A cancelled booking doesn't end it.
  assert.deepEqual(
    openRequests(list, [{ ...bookings[0], status: 'cancelled' }], now).map((w) => w.id),
    ['today', 'sat', 'elsewhere'],
  );
  // Just after midnight in Kajang, the 21st has gone too, though it is still the 21st in London.
  assert.deepEqual(
    openRequests(list, [], Date.parse('2026-10-22T00:30:00+08:00')).map((w) => w.id),
    ['sat', 'elsewhere'],
  );
});
