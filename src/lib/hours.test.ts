/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayPlanFrom, formatClock, rangesFromPlan, shopWeek, summarizeWeek } from './hours.ts';

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

test('summarizeWeek ignores breaks', () => {
  const withBreak = [1, 2, 3, 4, 5, 6].flatMap((d) =>
    d === 5 ? [range(d, '10:00', '13:00'), range(d, '14:30', '20:00')] : [range(d, '10:00', '20:00')],
  );
  assert.equal(summarizeWeek(withBreak), 'Mon–Sat · 10:00–20:00');
});

test('day plans round-trip with a break', () => {
  const plan = dayPlanFrom([
    { opens_at: '14:30:00', closes_at: '20:00:00' },
    { opens_at: '10:00:00', closes_at: '13:00:00' },
  ]);
  assert.deepEqual(plan, { open: true, opens: '10:00', closes: '20:00', hasBreak: true, breakFrom: '13:00', breakTo: '14:30' });
  assert.deepEqual(rangesFromPlan(plan), [
    { opens_at: '10:00', closes_at: '13:00' },
    { opens_at: '14:30', closes_at: '20:00' },
  ]);
  assert.deepEqual(rangesFromPlan({ ...plan, hasBreak: false }), [{ opens_at: '10:00', closes_at: '20:00' }]);
  assert.deepEqual(rangesFromPlan({ ...plan, open: false }), []);
  assert.equal(dayPlanFrom([]).open, false);
});

test('rangesFromPlan explains mistakes', () => {
  const base = { open: true, opens: '10:00', closes: '20:00', hasBreak: true, breakFrom: '13:00', breakTo: '14:00' };
  assert.equal(rangesFromPlan({ ...base, closes: '09:00' }), 'closing time must be after opening time.');
  assert.equal(rangesFromPlan({ ...base, breakFrom: '09:00' }), 'the break must sit inside opening hours.');
  assert.equal(rangesFromPlan({ ...base, opens: 'ten' }), 'use times like 09:00 or 21:30.');
  assert.equal(rangesFromPlan({ ...base, breakTo: '2pm' }), 'use times like 13:00 for the break.');
});
