/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayPlanFrom, formatClock, openStatus, rangesFromPlan, shopWeek, summarizeWeek } from './hours.ts';

const range = (weekday: number, opens_at: string, closes_at: string) => ({ weekday, opens_at, closes_at });

test('formatClock', () => {
  assert.equal(formatClock('00:30'), '12:30 am');
  assert.equal(formatClock('10:00:00'), '10:00 am');
  assert.equal(formatClock('12:00'), '12:00 pm');
  assert.equal(formatClock('20:15'), '8:15 pm');
});

test('summarizeWeek reads Monday first, in am/pm', () => {
  const monSat = [1, 2, 3, 4, 5, 6].map((d) => range(d, '10:00', '20:00'));
  assert.equal(summarizeWeek(monSat), 'Mon–Sat · 10:00 am–8:00 pm');
  assert.equal(summarizeWeek([...monSat, range(0, '10:00', '20:00')]), 'Every day · 10:00 am–8:00 pm');
  // Friday off: not a run any more.
  const noFri = monSat.filter((h) => h.weekday !== 5);
  assert.equal(summarizeWeek(noFri), 'Mon, Tue, Wed, Thu, Sat · 10:00 am–8:00 pm');
  // Thu to Sun wraps over the weekend.
  const thuSun = [4, 5, 6, 0].map((d) => range(d, '09:00:00', '18:00:00'));
  assert.equal(summarizeWeek(thuSun), 'Thu–Sun · 9:00 am–6:00 pm');
  assert.equal(summarizeWeek([...noFri, range(5, '09:00', '18:00')]), 'Mon–Sat · varied hours');
  assert.equal(summarizeWeek([]), 'No hours set, so not bookable');
});

test('shopWeek spans all barbers per day', () => {
  const week = shopWeek([range(1, '10:00:00', '18:00:00'), range(1, '09:30:00', '20:00:00'), range(2, '11:00', '15:00')]);
  assert.deepEqual(week[1], { opens: '09:30', closes: '20:00' });
  assert.deepEqual(week[2], { opens: '11:00', closes: '15:00' });
  assert.equal(week[0], null);
});

test('openStatus reads the shop\'s own clock', () => {
  // Tue 6 Oct in Kajang (UTC+8), at the given local time.
  const at = (clock: string) => new Date(`2026-10-06T${clock}:00+08:00`);
  const status = (clock: string, opens: string | null = '10:00:00', closes: string | null = '20:00:00') =>
    openStatus(opens, closes, at(clock), 'Asia/Kuala_Lumpur');
  assert.deepEqual(status('09:59'), { state: 'later', label: 'Opens 10:00 am' });
  assert.deepEqual(status('10:00'), { state: 'open', label: 'Open now · until 8:00 pm' });
  assert.deepEqual(status('19:59'), { state: 'open', label: 'Open now · until 8:00 pm' });
  assert.deepEqual(status('20:00'), { state: 'closed', label: 'Closed today' });
  assert.deepEqual(status('12:00', null, null), { state: 'closed', label: 'Closed today' });
  assert.equal(status('21:00', '09:30', '21:15').label, 'Open now · until 9:15 pm');
  // 1 am in Kajang is still the evening before in London.
  assert.equal(openStatus('10:00', '20:00', at('01:00'), 'Europe/London').label, 'Open now · until 8:00 pm');
  assert.equal(openStatus('10:00', '20:00', at('01:00').getTime()).label, 'Opens 10:00 am');
});

test('summarizeWeek shows breaks', () => {
  // Ali breaks for Friday prayers only.
  const friBreak = [1, 2, 3, 4, 5, 6].flatMap((d) =>
    d === 5 ? [range(d, '14:30', '20:00'), range(d, '10:00', '12:45')] : [range(d, '10:00', '20:00')],
  );
  assert.equal(summarizeWeek(friBreak), 'Mon–Sat · 10:00 am–8:00 pm · Fri break 12:45 pm–2:30 pm');
  // The same lunch break every day needs no day names.
  const lunch = [1, 2, 3, 4, 5, 6].flatMap((d) => [range(d, '10:00', '13:00'), range(d, '14:00', '20:00')]);
  assert.equal(summarizeWeek(lunch), 'Mon–Sat · 10:00 am–8:00 pm · break 1:00 pm–2:00 pm');
  // Lunch Mon–Thu, prayers on Friday, no break on Saturday.
  const mixed = [1, 2, 3, 4, 5, 6].flatMap((d) =>
    d === 6
      ? [range(d, '10:00', '20:00')]
      : d === 5
        ? [range(d, '10:00', '12:45'), range(d, '14:30', '20:00')]
        : [range(d, '10:00', '13:00'), range(d, '14:00', '20:00')],
  );
  assert.equal(
    summarizeWeek(mixed),
    'Mon–Sat · 10:00 am–8:00 pm · Mon–Thu break 1:00 pm–2:00 pm · Fri break 12:45 pm–2:30 pm',
  );
  // Ranges that touch are not a break.
  assert.equal(summarizeWeek([range(1, '10:00', '13:00'), range(1, '13:00', '20:00')]), 'Mon · 10:00 am–8:00 pm');
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
  assert.equal(rangesFromPlan({ ...base, breakTo: 'after lunch' }), 'use times like 13:00 for the break.');
});
