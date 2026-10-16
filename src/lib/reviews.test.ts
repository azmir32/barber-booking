/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  canRate,
  firstName,
  rateUntil,
  ratingLabel,
  ratingAverage,
  ratingSummary,
  reviewAge,
  reviewCount,
  reviewName,
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

test('a review shows the name people go by, never a surname or their father’s name', () => {
  // The same names as review_first_name's test in booking_test.sql.
  const names: [string, string][] = [
    ['Hakim', 'Hakim'],
    ['  Ben   Lee ', 'Ben'],
    ['\tMohd. Ben bin Hassan', 'Ben'],
    ['MUHAMMAD Aiman', 'Aiman'],
    ['Muhammad', 'Muhammad'],
    ['Muhammad bin Abdullah', 'Muhammad'],
    ['Mohd bin Ali', 'Mohd'],
    ['Mohdzan Ali', 'Mohdzan'],
    ['Abdul Rahman bin Ismail', 'Abdul Rahman'],
    ['Muhammad Abd. Aziz', 'Abd. Aziz'],
    ['Nur Aisyah binti Ahmad', 'Nur'],
    ['Wan Faizal', 'Faizal'],
    ['Syed Ahmad bin Syed Ali', 'Ahmad'],
    ['Wan Abdul Rahman', 'Abdul Rahman'],
    ['Haji Mohd Ali b. Abu', 'Ali'],
    ["Dato' Rahim", 'Rahim'],
    ['Wan', 'Wan'],
    ['Ravi a/l Kumar', 'Ravi'],
    ['Kavitha A/P Raju', 'Kavitha'],
    ['Tan Wei Jie', 'Wei Jie'],
    ['Dr Lim Kit Siang', 'Kit Siang'],
    ['Daniel Tan', 'Daniel'],
    ['Daniel Tan Wei Jie', 'Daniel'],
    // No rule tells a given name from a surname here, so the form shows it.
    ['Wei Jie', 'Wei'],
    ['x'.repeat(50), 'x'.repeat(40)],
    ['\t', 'Customer'],
  ];
  assert.deepEqual(
    names.map(([full]) => [full, firstName(full)]),
    names,
  );
});

test('a name the customer types for their review is tidied and cut to 40 characters', () => {
  assert.equal(reviewName('  Benny \n Boy '), 'Benny Boy');
  assert.equal(reviewName('Ben '.repeat(15)), 'Ben '.repeat(10).trimEnd());
  assert.equal(reviewName(' \t '), null);
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
  // My shop says it for any number, one too.
  assert.equal(ratingLabel(5, 1), 'Rated 5.0 out of 5 from 1 review');
  assert.equal(ratingLabel(4.5, 2), 'Rated 4.5 out of 5 from 2 reviews');
  setCurrentLang('ms');
  try {
    assert.deepEqual(ratingSummary(4.8, 23), { text: '4.8 ★ (23)', label: 'Penilaian 4.8 daripada 5, dari 23 ulasan' });
    assert.equal(ratingLabel(5, 1), 'Penilaian 5.0 daripada 5, dari 1 ulasan');
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
