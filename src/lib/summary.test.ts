/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import { addDays } from './time.ts';
import {
  busiest,
  busiestDays,
  byWeekday,
  canCompare,
  countChange,
  hasBookings,
  hourMark,
  hourRange,
  joinAnd,
  moneyChange,
  noComparison,
  peakRanges,
  periodDays,
  periodTitle,
  weekdayName,
  weekLine,
  weekStart,
  type Summary,
} from './summary.ts';

const TZ = 'Asia/Kuala_Lumpur';
const at = (iso: string) => Date.parse(iso);

test('weeks start on Monday', () => {
  assert.equal(weekStart('2026-10-05'), '2026-10-05', 'a Monday is its own start');
  assert.equal(weekStart('2026-10-09'), '2026-10-05', 'Friday');
  assert.equal(weekStart('2026-10-11'), '2026-10-05', 'Sunday ends the week');
  assert.equal(weekStart('2026-11-01'), '2026-10-26', 'across a month end');
  assert.equal(weekStart('2027-01-02'), '2026-12-28', 'across a year end');
});

test('this week, last week and this month, on the shop’s clock', () => {
  // Fri 9 Oct, 2 pm in Kajang.
  const friday = at('2026-10-09T14:00:00+08:00');
  assert.deepEqual(periodDays('week', friday, TZ), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(periodDays('last-week', friday, TZ), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(periodDays('month', friday, TZ), { from: '2026-10-01', to: '2026-10-31' });

  // 7 am on Monday 12 Oct in Kajang is still Sunday in UTC, and in Pago Pago.
  const monday = at('2026-10-12T07:00:00+08:00');
  assert.deepEqual(periodDays('week', monday, TZ), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(periodDays('week', monday, 'Pacific/Pago_Pago'), { from: '2026-10-05', to: '2026-10-11' });

  // Just after midnight on 1 November in Kajang it is a new month there, but not in UTC.
  const november = at('2026-11-01T00:30:00+08:00');
  assert.deepEqual(periodDays('month', november, TZ), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(periodDays('month', november, 'UTC'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(periodDays('month', at('2028-02-10T12:00:00+08:00'), TZ), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodDays('last-week', at('2027-01-01T12:00:00+08:00'), TZ), { from: '2026-12-21', to: '2026-12-27' });
});

test('the comparison says more, less or the same, and against what', () => {
  assert.deepEqual(moneyChange(1240, 1120, 'week'), { direction: 'up', label: 'RM120 more than this time last week' });
  assert.deepEqual(moneyChange(80.5, 100, 'last-week'), { direction: 'down', label: 'RM19.50 less than the week before' });
  assert.deepEqual(moneyChange(0, 0, 'month'), { direction: 'same', label: 'Same as this time last month' });
  // Cents that only differ in floating point are the same money.
  assert.equal(moneyChange(0.1 + 0.2, 0.3, 'week').direction, 'same');
  assert.deepEqual(moneyChange(2500, 0, 'week'), { direction: 'up', label: 'RM2,500 more than this time last week' });
  assert.deepEqual(countChange(42, 36, 'week'), { direction: 'up', label: '6 more than this time last week' });
  assert.deepEqual(countChange(3, 5, 'last-week'), { direction: 'down', label: '2 fewer than the week before' });
  assert.deepEqual(countChange(7, 7, 'month'), { direction: 'same', label: 'Same as this time last month' });
  // A busy shop's month: counts are grouped like the money beside them.
  assert.equal(countChange(1250, 200, 'month').label, '1,050 more than this time last month');

  setCurrentLang('ms');
  try {
    assert.equal(moneyChange(1240, 1120, 'week').label, 'RM120 lebih berbanding masa yang sama minggu lepas');
    assert.equal(countChange(3, 5, 'last-week').label, '2 kurang berbanding minggu sebelumnya');
    assert.equal(moneyChange(5, 5, 'month').label, 'Sama seperti masa yang sama bulan lepas');
  } finally {
    setCurrentLang('en');
  }
});

test('busiest days compare the average day, over the days the period has reached', () => {
  const month = (from: string, length: number, bookings: (day: string, i: number) => number) =>
    Array.from({ length }, (_, i) => {
      const day = addDays(from, i);
      return { day, bookings: bookings(day, i), done: 0, takings: 0 };
    });
  // October 2026 starts on a Thursday, so it has five Thursdays, Fridays and
  // Saturdays and four of every other day. Ten a day is the same every day.
  const october = month('2026-10-01', 31, () => 10);
  assert.deepEqual(byWeekday(october, '2026-11-15'), [10, 10, 10, 10, 10, 10, 10]);
  assert.deepEqual(busiestDays(byWeekday(october, '2026-11-15')), [0, 1, 2, 3, 4, 5, 6], 'all the same');

  // On Friday 9 October, Thursday and Friday have come round twice and the
  // rest once; from Saturday 10th on there are only advance bookings.
  const running = month('2026-10-01', 31, (day) => (day <= '2026-10-09' ? 10 : 2));
  assert.deepEqual(byWeekday(running, '2026-10-09'), [10, 10, 10, 10, 10, 10, 10]);

  // On a Tuesday, only Monday and Tuesday have happened: no busiest day yet.
  const week = month('2026-10-05', 7, (_, i) => [12, 8, 3, 3, 3, 3, 3][i]);
  assert.deepEqual(byWeekday(week, '2026-10-06'), [12, 8, null, null, null, null, null]);
  assert.deepEqual(busiestDays(byWeekday(week, '2026-10-06')), []);
  assert.deepEqual(busiestDays(byWeekday(week, '2026-10-11')), [0], 'once Sunday is here, Monday can win');

  // Averages to one decimal place; two Saturdays of 9 and 14 beat Fridays of 11.
  const busy: Record<string, number> = { '2026-10-09': 11, '2026-10-16': 11, '2026-10-10': 9, '2026-10-17': 14 };
  const weeks = month('2026-10-05', 14, (day) => busy[day] ?? 1);
  assert.deepEqual(byWeekday(weeks, '2026-10-18'), [1, 1, 1, 1, 11, 11.5, 1]);
  assert.deepEqual(busiestDays(byWeekday(weeks, '2026-10-18')), [5]);
  assert.deepEqual(byWeekday(month('2026-10-05', 21, (day) => (day === '2026-10-05' ? 10 : 0)), '2026-10-31')[0], 3.3);

  assert.deepEqual(busiest([3, 7, 1, 7]), [1, 3], 'a tie has two busiest days');
  assert.deepEqual(busiest([0, 0, 0]), [], 'nothing booked');
  assert.deepEqual(busiest([]), []);
  assert.equal(weekdayName(5), 'Saturday');
  setCurrentLang('ms');
  try {
    assert.equal(weekdayName(5), 'Sabtu');
    assert.equal(weekdayName(0), 'Isnin');
  } finally {
    setCurrentLang('en');
  }
});

test('a shop is only compared with a period it was already on the app for', () => {
  // The week before this one starts on Monday 28 September, midnight in Kajang (16:00 UTC the day before).
  assert.equal(canCompare('2026-09-28', '2026-08-01T03:00:00Z', TZ), true);
  assert.equal(canCompare('2026-09-28', '2026-09-27T15:59:00Z', TZ), true, 'joined late on Sunday');
  assert.equal(canCompare('2026-09-28', '2026-09-27T16:30:00Z', TZ), false, 'joined just after midnight on Monday');
  assert.equal(canCompare('2026-09-28', '2026-10-07T04:00:00Z', TZ), false, 'joined this week');
  assert.equal(canCompare('2026-09-28', '2026-09-27T16:30:00Z', 'UTC'), true, 'on a shop clock in UTC, still Sunday');
  assert.deepEqual(noComparison(), { direction: 'same', label: 'Nothing to compare with yet' });
  setCurrentLang('ms');
  try {
    assert.equal(noComparison().label, 'Belum ada yang boleh dibandingkan');
  } finally {
    setCurrentLang('en');
  }
});

test('busiest hours run from the first booked hour to the last', () => {
  assert.deepEqual(
    hourRange([
      { hour: 17, bookings: 6 },
      { hour: 10, bookings: 2 },
      { hour: 13, bookings: 1 },
    ]).map((h) => h.bookings),
    [2, 0, 0, 1, 0, 0, 0, 6],
  );
  assert.equal(hourRange([{ hour: 10, bookings: 2 }]).length, 1);
  assert.deepEqual(hourRange([]), []);
  assert.deepEqual([0, 9, 12, 13, 23].map(hourMark), ['12', '9', '12', '1', '11']);
});

test('the busiest hours side by side make one stretch', () => {
  const hours = (counts: number[]) => counts.map((bookings, i) => ({ hour: 10 + i, bookings }));
  assert.deepEqual(peakRanges(hours([2, 5, 1, 3])), [[11, 12]]);
  assert.deepEqual(peakRanges(hours([2, 5, 5, 5, 1])), [[11, 14]], '11 am to 2 pm');
  assert.deepEqual(peakRanges(hours([4, 1, 4, 4])), [
    [10, 11],
    [12, 14],
  ]);
  assert.deepEqual(peakRanges([{ hour: 23, bookings: 1 }]), [[23, 24]]);
  assert.deepEqual(peakRanges(hours([0, 0])), []);
});

test('lists read naturally', () => {
  assert.equal(joinAnd([]), '');
  assert.equal(joinAnd(['Friday']), 'Friday');
  assert.equal(joinAnd(['Friday', 'Saturday']), 'Friday and Saturday');
  assert.equal(joinAnd(['Monday', 'Friday', 'Saturday']), 'Monday, Friday and Saturday');
  setCurrentLang('ms');
  try {
    assert.equal(joinAnd(['Jumaat', 'Sabtu']), 'Jumaat dan Sabtu');
  } finally {
    setCurrentLang('en');
  }
});

test('the period is named by its dates, or its month', () => {
  assert.equal(periodTitle('week', '2026-10-05', '2026-10-11'), 'Mon, 5 Oct – Sun, 11 Oct');
  assert.equal(periodTitle('month', '2026-10-01', '2026-10-31'), 'October 2026');
  setCurrentLang('ms');
  try {
    assert.equal(periodTitle('month', '2026-10-01', '2026-10-31'), 'Oktober 2026');
  } finally {
    setCurrentLang('en');
  }
});

test('My shop sums up the week in one line', () => {
  assert.equal(weekLine({ done: 42, takings: 1240 }), 'This week: RM1,240 from 42 cuts');
  assert.equal(weekLine({ done: 1, takings: 25 }), 'This week: RM25 from 1 cut');
  assert.equal(weekLine({ done: 0, takings: 0 }), 'This week: no cuts marked done yet');
  assert.equal(weekLine({ done: 1250, takings: 31250 }), 'This week: RM31,250 from 1,250 cuts');
  setCurrentLang('ms');
  try {
    assert.equal(weekLine({ done: 42, takings: 1240 }), 'Minggu ini: RM1,240 daripada 42 potongan');
  } finally {
    setCurrentLang('en');
  }
});

test('a period counts as empty only when nobody booked at all', () => {
  const quiet: Summary = {
    from: '2026-10-05',
    to: '2026-10-11',
    totals: {
      done: 0,
      takings: 0,
      no_shows: 0,
      no_show_value: 0,
      cancelled: 0,
      to_come: 0,
      to_come_value: 0,
      unmarked: 0,
      unmarked_value: 0,
    },
    previous: { from: '2026-09-28', to: '2026-10-04', until: '2026-10-04T16:00:00Z', done: 3, takings: 60, no_shows: 0, no_show_value: 0, cancelled: 0 },
    days: [{ day: '2026-10-05', bookings: 0, done: 0, takings: 0 }],
    hours: [],
    barbers: [],
    services: [],
  };
  assert.equal(hasBookings(quiet), false, 'the week before doesn’t count');
  assert.equal(hasBookings({ ...quiet, totals: { ...quiet.totals, cancelled: 1 } }), true);
  assert.equal(hasBookings({ ...quiet, days: [{ day: '2026-10-05', bookings: 2, done: 0, takings: 0 }] }), true);
});
