/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  dayBounds,
  formatDuration,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localDateString,
  normalizeTime,
  slugify,
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

test('formatPrice and formatDuration', () => {
  assert.equal(formatPrice(25), 'RM25');
  assert.equal(formatPrice('25.5'), 'RM25.50');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 hr');
  assert.equal(formatDuration(75), '1 hr 15 min');
});

test('normalizeTime', () => {
  assert.equal(normalizeTime('9:00'), '09:00');
  assert.equal(normalizeTime('17.30'), '17:30');
  assert.equal(normalizeTime('24:00'), null);
  assert.equal(normalizeTime('noon'), null);
});

test('slugify', () => {
  assert.equal(slugify("Ali's Cuts!"), 'alis-cuts');
  assert.equal(slugify('  Kemas  Barber Kajang '), 'kemas-barber-kajang');
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
