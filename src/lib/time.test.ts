/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  dayBounds,
  formatCount,
  formatDuration,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localClock,
  localDateString,
  normalizeTime,
  slugify,
  suggestSlug,
  upcomingDays,
} from './time.ts';

test('localDateString uses the shop zone, not UTC', () => {
  // 20:00 UTC on 5 Oct is 04:00 on 6 Oct in Kajang.
  assert.equal(localDateString(new Date('2026-10-05T20:00:00Z')), '2026-10-06');
});

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('upcomingDays labels today and tomorrow', () => {
  const days = upcomingDays(3, 'Asia/Kuala_Lumpur', new Date('2026-10-05T20:00:00Z'));
  assert.deepEqual(
    days.map((d) => [d.date, d.label]),
    [
      ['2026-10-06', 'Today'],
      ['2026-10-07', 'Tomorrow'],
      ['2026-10-08', 'Thu'],
    ],
  );
});

test('upcomingDays can start from yesterday', () => {
  const days = upcomingDays(3, 'Asia/Kuala_Lumpur', new Date('2026-10-05T20:00:00Z'), -1);
  assert.deepEqual(
    days.map((d) => d.label),
    ['Yesterday', 'Today', 'Tomorrow'],
  );
});

test('dayBounds gives the local midnight instants', () => {
  const { start, end } = dayBounds('2026-10-06');
  assert.equal(start.toISOString(), '2026-10-05T16:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-06T16:00:00.000Z');
});

test('formatTime shows shop-local time', () => {
  assert.match(formatTime('2026-10-06T02:00:00Z'), /^10:00\s?am$/i);
});

test('formatPrice, formatCount and formatDuration', () => {
  assert.equal(formatPrice(25), 'RM25');
  assert.equal(formatPrice('25.5'), 'RM25.50');
  assert.equal(formatPrice(1240), 'RM1,240');
  assert.equal(formatPrice('12480.5'), 'RM12,480.50');
  assert.equal(formatPrice(999), 'RM999');
  assert.equal(formatCount(1250), '1,250');
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(12.5), '12.5');
  assert.equal(formatCount(1012.3), '1,012.3');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 hr');
  assert.equal(formatDuration(75), '1 hr 15 min');
});

test('normalizeTime reads 24-hour times', () => {
  assert.equal(normalizeTime('9:00'), '09:00');
  assert.equal(normalizeTime('17.30'), '17:30');
  assert.equal(normalizeTime('1430'), '14:30');
  assert.equal(normalizeTime('930'), '09:30');
  // Without am/pm it is 24-hour time, as before.
  assert.equal(normalizeTime('2.30'), '02:30');
  assert.equal(normalizeTime('24:00'), null);
  assert.equal(normalizeTime('9:75'), null);
  assert.equal(normalizeTime('noon'), null);
  // A bare hour could be morning or afternoon.
  assert.equal(normalizeTime('2'), null);
});

test('normalizeTime reads am/pm in English and Malay', () => {
  assert.equal(normalizeTime('2pm'), '14:00');
  assert.equal(normalizeTime('2.30pm'), '14:30');
  assert.equal(normalizeTime('2:30 pm'), '14:30');
  assert.equal(normalizeTime(' 2:30 P.M. '), '14:30');
  assert.equal(normalizeTime('9 am'), '09:00');
  assert.equal(normalizeTime('12pm'), '12:00');
  assert.equal(normalizeTime('12am'), '00:00');
  assert.equal(normalizeTime('2.30 ptg'), '14:30');
  assert.equal(normalizeTime('3 petang'), '15:00');
  assert.equal(normalizeTime('9 pagi'), '09:00');
  assert.equal(normalizeTime('10.15 PG'), '10:15');
  assert.equal(normalizeTime('13pm'), null);
  assert.equal(normalizeTime('0am'), null);
});

test('localClock gives the shop-local 24-hour time, rounded down', () => {
  // 06:07Z is 2:07 pm in Kajang; 16:03Z is just after midnight.
  assert.equal(localClock('2026-10-06T06:07:00Z'), '14:07');
  assert.equal(localClock('2026-10-06T06:07:00Z', 'Asia/Kuala_Lumpur', 5), '14:05');
  assert.equal(localClock(new Date('2026-10-05T16:03:00Z'), 'Asia/Kuala_Lumpur', 5), '00:00');
});

test('slugify', () => {
  assert.equal(slugify("Ali's Cuts!"), 'alis-cuts');
  assert.equal(slugify('  Kemas  Barber Kajang '), 'kemas-barber-kajang');
});

test('suggestSlug offers a link to try when one is taken', () => {
  assert.equal(suggestSlug('ali-barber', 'Kajang'), 'ali-barber-kajang');
  assert.equal(suggestSlug('ali-barber', 'Sungai Chua, Kajang'), 'ali-barber-sungai-chua-kajang');
  assert.equal(suggestSlug('ali-barber-kajang', 'Kajang'), 'ali-barber-kajang-2');
  assert.equal(suggestSlug('ali-barber-kajang-2', 'Kajang'), 'ali-barber-kajang-3');
  assert.equal(suggestSlug('ali-barber', ''), 'ali-barber-2');
  const long = 'a'.repeat(36) + '-cut';
  assert.equal(suggestSlug(long, 'Kajang'), `${'a'.repeat(33)}-kajang`);
  assert.ok(suggestSlug(long, 'Kajang').length <= 40);
});

test('groupByPartOfDay uses shop-local hours', () => {
  // 02:00Z = 10am, 05:00Z = 1pm, 10:00Z = 6pm in Kajang.
  const groups = groupByPartOfDay(['2026-10-06T02:00:00Z', '2026-10-06T05:00:00Z', '2026-10-06T10:00:00Z']);
  assert.deepEqual(
    groups.map(([name, list]) => [name, list.length]),
    [
      ['Morning', 1],
      ['Afternoon', 1],
      ['Evening', 1],
    ],
  );
  assert.deepEqual(groupByPartOfDay([]), []);
});
