/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import { isDue, lastCutLine, whenLabel } from './my-shops.ts';

const TZ = 'Asia/Kuala_Lumpur';
// Tue 6 Oct, 9 am in Kajang.
const now = Date.parse('2026-10-06T09:00:00+08:00');
const daysAgo = (days: number, from = now) => new Date(from - days * 86_400_000).toISOString();

test('the next cut says today or tomorrow, and the day otherwise', () => {
  assert.equal(whenLabel('2026-10-06T16:30:00+08:00', now, TZ), 'Today, 4:30 pm');
  assert.equal(whenLabel('2026-10-07T16:30:00+08:00', now, TZ), 'Tomorrow, 4:30 pm');
  assert.equal(whenLabel('2026-10-10T10:00:00+08:00', now, TZ), 'Sat, 10 Oct, 10:00 am');
  // Just after midnight is tomorrow on the shop's clock, though still today in UTC.
  const lateNight = Date.parse('2026-10-06T23:30:00+08:00');
  assert.equal(whenLabel('2026-10-07T00:30:00+08:00', lateNight, TZ), 'Tomorrow, 12:30 am');
  // And early in the morning, yesterday's evening in UTC is today here.
  const early = Date.parse('2026-10-06T06:00:00+08:00');
  assert.equal(whenLabel('2026-10-06T07:30:00+08:00', early, TZ), 'Today, 7:30 am');
});

test('the last cut names the service, the barber and how long ago', () => {
  const shop = (days: number) => ({
    service_name: 'Fade',
    barber_name: 'Danial',
    last_visit_at: daysAgo(days),
    time_zone: TZ,
  });
  assert.equal(lastCutLine(shop(26), now), 'Fade with Danial, 4 weeks ago');
  assert.equal(lastCutLine(shop(0), now), 'Fade with Danial, today');
  assert.equal(lastCutLine(shop(1), now), 'Fade with Danial, yesterday');
  assert.equal(lastCutLine(shop(7), now), 'Fade with Danial, a week ago');
  assert.equal(lastCutLine(shop(12), now), 'Fade with Danial, 12 days ago');
  assert.equal(lastCutLine(shop(61), now), 'Fade with Danial, 2 months ago');
  assert.equal(lastCutLine(shop(400), now), 'Fade with Danial, over a year ago');
  // Late last night is yesterday, though it was only ten hours ago.
  assert.equal(lastCutLine({ ...shop(0), last_visit_at: '2026-10-05T23:00:00+08:00' }, now), 'Fade with Danial, yesterday');
});

test('due for a cut once the usual gap has passed since the last cut anywhere, with nothing booked', () => {
  const shop = (lastHere: number, gap: number) => ({ last_visit_at: daysAgo(lastHere), usual_gap_days: gap, time_zone: TZ });
  const due = (lastHere: number, gap: number, lastAnywhere = lastHere, booked = false) =>
    isDue(shop(lastHere, gap), daysAgo(lastAnywhere), booked, now);
  // Four weeks after a single visit, or their own usual gap.
  assert.equal(due(27, 28), false);
  assert.equal(due(28, 28), true);
  assert.equal(due(21, 21), true);
  assert.equal(due(20, 21), false);
  // Counted in days on the shop's clock, so a cut late at night is a whole day ago next morning.
  const weekly = (at: string) => isDue({ last_visit_at: at, usual_gap_days: 7, time_zone: TZ }, at, false, now);
  assert.equal(weekly('2026-09-29T23:00:00+08:00'), true);
  assert.equal(weekly('2026-09-30T08:00:00+08:00'), false);
  // Nothing is due while a cut is booked, anywhere.
  assert.equal(due(40, 28, 40, true), false);
  // A cut at another shop since means it isn't due here either.
  assert.equal(due(40, 28, 10), false);
  assert.equal(due(40, 28, 30), true);
  // Away three gaps, and at least 90 days, they have most likely moved on.
  assert.equal(due(89, 28), true);
  assert.equal(due(90, 28), false);
  assert.equal(due(104, 35), true);
  assert.equal(due(105, 35), false);
});

test('in Malay too', () => {
  setCurrentLang('ms');
  try {
    assert.equal(whenLabel('2026-10-07T16:30:00+08:00', now, TZ), 'Esok, 4.30 petang');
    assert.equal(whenLabel('2026-10-06T12:15:00+08:00', now, TZ), 'Hari ini, 12.15 tengah hari');
    assert.equal(whenLabel('2026-10-10T10:00:00+08:00', now, TZ), 'Sab, 10 Okt, 10.00 pagi');
    const shop = { service_name: 'Fade', barber_name: 'Danial', last_visit_at: daysAgo(26), time_zone: TZ };
    assert.equal(lastCutLine(shop, now), 'Fade bersama Danial, 4 minggu lalu');
    assert.equal(lastCutLine({ ...shop, last_visit_at: daysAgo(1) }, now), 'Fade bersama Danial, semalam');
    assert.equal(lastCutLine({ ...shop, last_visit_at: daysAgo(0) }, now), 'Fade bersama Danial, hari ini');
  } finally {
    setCurrentLang('en');
  }
});
