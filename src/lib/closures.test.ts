/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dateRange, groupClosures } from './closures.ts';

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
