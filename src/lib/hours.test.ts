/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatClock, shopWeek, summarizeWeek } from './hours.ts';

const range = (weekday: number, opens_at: string, closes_at: string) => ({ weekday, opens_at, closes_at });

test('formatClock', () => {
  assert.equal(formatClock('00:30'), '12:30 am');
  assert.equal(formatClock('10:00:00'), '10:00 am');
  assert.equal(formatClock('12:00'), '12:00 pm');
  assert.equal(formatClock('20:15'), '8:15 pm');
});

test('summarizeWeek reads Monday first', () => {
  const monSat = [1, 2, 3, 4, 5, 6].map((d) => range(d, '10:00', '20:00'));
  assert.equal(summarizeWeek(monSat), 'Mon–Sat · 10:00–20:00');
  assert.equal(summarizeWeek([...monSat, range(0, '10:00', '20:00')]), 'Every day · 10:00–20:00');
  // Friday off: not a run any more.
  const noFri = monSat.filter((h) => h.weekday !== 5);
  assert.equal(summarizeWeek(noFri), 'Mon, Tue, Wed, Thu, Sat · 10:00–20:00');
  // Thu to Sun wraps over the weekend.
  const thuSun = [4, 5, 6, 0].map((d) => range(d, '09:00', '18:00'));
  assert.equal(summarizeWeek(thuSun), 'Thu–Sun · 09:00–18:00');
  assert.equal(summarizeWeek([]), 'No hours set, so not bookable');
});

test('shopWeek spans all barbers per day', () => {
  const week = shopWeek([range(1, '10:00:00', '18:00:00'), range(1, '09:30:00', '20:00:00'), range(2, '11:00', '15:00')]);
  assert.deepEqual(week[1], { opens: '09:30', closes: '20:00' });
  assert.deepEqual(week[2], { opens: '11:00', closes: '15:00' });
  assert.equal(week[0], null);
});
