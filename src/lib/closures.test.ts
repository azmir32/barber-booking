/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dateRange, groupClosures, stripToAsk } from './closures.ts';
import { upcomingDays } from './time.ts';

test('groupClosures joins back-to-back days with the same reason', () => {
  const raya = (day: string) => ({ day, reason: 'Hari Raya' });
  assert.deepEqual(groupClosures([raya('2027-03-11'), raya('2027-03-10'), raya('2027-03-12'), raya('2027-03-20')]), [
    { from: '2027-03-10', to: '2027-03-12', days: 3, reason: 'Hari Raya' },
    { from: '2027-03-20', to: '2027-03-20', days: 1, reason: 'Hari Raya' },
  ]);
  // Next to each other but for different reasons: two closures.
  assert.deepEqual(
    groupClosures([raya('2027-03-10'), { day: '2027-03-11', reason: 'Kenduri' }]).map((c) => c.reason),
    ['Hari Raya', 'Kenduri'],
  );
  // Across a month end.
  assert.equal(groupClosures([raya('2027-03-31'), raya('2027-04-01')]).length, 1);
  assert.deepEqual(groupClosures([]), []);
});

test('dateRange reads like the rest of the app', () => {
  assert.equal(dateRange('2027-03-10', '2027-03-10'), 'Wed, 10 Mar');
  assert.equal(dateRange('2027-03-10', '2027-03-12'), 'Wed, 10 Mar – Fri, 12 Mar');
});

test('stripToAsk asks again only for a phone whose date isn’t the server’s', () => {
  const strip = (phone: string) => upcomingDays(14, 'Asia/Kuala_Lumpur', new Date(phone));
  // Any ordinary visit: the page's one answer covers the strip.
  assert.equal(stripToAsk('2027-03-10', strip('2027-03-10T14:00:00+08:00')), null);
  assert.equal(stripToAsk('2027-03-10', strip('2027-03-10T23:59:00+08:00')), null);
  // Three minutes fast at 23:58: the strip runs a day past the answer's 14.
  assert.deepEqual(stripToAsk('2027-03-10', strip('2027-03-11T00:01:00+08:00')), { from: '2027-03-11', to: '2027-03-24' });
  // Three minutes slow at 00:01: the strip starts on the phone's today, a day before the answer's.
  assert.deepEqual(stripToAsk('2027-03-11', strip('2027-03-10T23:58:00+08:00')), { from: '2027-03-10', to: '2027-03-23' });
  // Across a month end, and with no strip at all.
  assert.deepEqual(stripToAsk('2027-03-31', strip('2027-04-01T00:02:00+08:00')), { from: '2027-04-01', to: '2027-04-14' });
  assert.equal(stripToAsk('2027-03-10', []), null);
});
