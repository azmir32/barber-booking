/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  canRate,
  firstName,
  rateUntil,
  ratingAverage,
  ratingSummary,
  reviewAge,
  reviewCount,
  starsLabel,
} from './reviews.ts';

const TZ = 'Asia/Kuala_Lumpur';
const DAY = 86_400_000;
// Tue 6 Oct, 9 am in Kajang.
const now = Date.parse('2026-10-06T09:00:00+08:00');

test('a cut can be rated once it is marked done, for 14 days after it started', () => {
  const cut = (status: string, startedAgo: number) => ({
    status,
    starts_at: new Date(now - startedAgo).toISOString(),
  });
  assert.equal(canRate(cut('completed', 2 * 3_600_000), now), true);
  assert.equal(canRate(cut('completed', 14 * DAY - 60_000), now), true);
  // The same moment rate_booking stops taking it.
  assert.equal(canRate(cut('completed', 14 * DAY), now), false);
  assert.equal(canRate(cut('confirmed', DAY), now), false);
  assert.equal(canRate(cut('no_show', DAY), now), false);
  assert.equal(canRate(cut('cancelled', DAY), now), false);
  assert.equal(rateUntil('2026-10-01T02:00:00Z').toISOString(), '2026-10-15T02:00:00.000Z');
});

test('a review shows the name people go by, never a surname', () => {
  assert.equal(firstName('Hakim'), 'Hakim');
  assert.equal(firstName('  Daniel   Tan '), 'Daniel');
  assert.equal(firstName('Mohd Hakim bin Ali'), 'Hakim');
  assert.equal(firstName('MUHAMMAD Aiman'), 'Aiman');
  assert.equal(firstName('Mohd. Faiz'), 'Faiz');
  assert.equal(firstName('\tMd Rizal\n'), 'Rizal');
  // Someone named only Muhammad, or whose name only starts the same, keeps it.
  assert.equal(firstName('Muhammad'), 'Muhammad');
  assert.equal(firstName('Mohdzan Ali'), 'Mohdzan');
  assert.equal(firstName('x'.repeat(50)), 'x'.repeat(40));
  assert.equal(firstName('\t'), 'Customer');
});

test('a shop shows its stars once it has three reviews', () => {
  assert.equal(ratingAverage(0, 0), null);
  assert.equal(ratingAverage(31, 7), 4.4);
  assert.equal(ratingAverage(14, 3), 4.7);
  assert.equal(ratingSummary(null, 0), null);
  assert.equal(ratingSummary(5, 2), null);
  assert.deepEqual(ratingSummary(4.8, 23), { text: '4.8 ★ (23)', label: 'Rated 4.8 out of 5 from 23 reviews' });
  // A whole number still has its decimal, so the list lines up.
  assert.equal(ratingSummary(5, 3)?.text, '5.0 ★ (3)');
  assert.equal(ratingSummary(4.1, 1250)?.text, '4.1 ★ (1,250)');
  setCurrentLang('ms');
  try {
    assert.deepEqual(ratingSummary(4.8, 23), { text: '4.8 ★ (23)', label: 'Penilaian 4.8 daripada 5, dari 23 ulasan' });
    assert.equal(starsLabel(4), '4 bintang');
    assert.equal(reviewCount(1), '1 ulasan');
  } finally {
    setCurrentLang('en');
  }
});

test('stars and counts read naturally', () => {
  assert.equal(starsLabel(1), '1 star');
  assert.equal(starsLabel(4), '4 stars');
  assert.equal(reviewCount(1), '1 review');
  assert.equal(reviewCount(23), '23 reviews');
  assert.equal(reviewCount(1250), '1,250 reviews');
});

test('how long ago a review was left counts days on the shop’s clock', () => {
  const ago = (at: string) => reviewAge(at, now, TZ);
  assert.equal(ago('2026-10-06T08:00:00+08:00'), 'Today');
  // Late last night is yesterday, though it was only ten hours ago.
  assert.equal(ago('2026-10-05T23:00:00+08:00'), 'Yesterday');
  assert.equal(ago('2026-10-01T12:00:00+08:00'), '5 days ago');
  assert.equal(ago('2026-09-29T12:00:00+08:00'), 'a week ago');
  assert.equal(ago('2026-09-08T12:00:00+08:00'), '4 weeks ago');
  assert.equal(ago('2026-06-06T12:00:00+08:00'), '4 months ago');
  setCurrentLang('ms');
  try {
    assert.equal(ago('2026-10-01T12:00:00+08:00'), '5 hari lalu');
    assert.equal(ago('2026-10-05T23:00:00+08:00'), 'Semalam');
  } finally {
    setCurrentLang('en');
  }
});
