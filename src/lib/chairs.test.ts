/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockText,
  chairsDay,
  chairStatus,
  clockOf,
  clockText,
  gapSlots,
  isWholeDay,
  minutesInto,
  slotAt,
  statusWord,
} from './chairs.ts';
import { setCurrentLang } from './lang.ts';

const TZ = 'Asia/Kuala_Lumpur';
// A Friday: Ali works 10 am to 8 pm with a break for Friday prayers.
const DAY = '2026-10-16';
const FRIDAY = 5;

const at = (clock: string, day = DAY) => new Date(`${day}T${clock}:00+08:00`).toISOString();
const hours = (weekday: number, ...ranges: [string, string][]) =>
  ranges.map(([opens_at, closes_at]) => ({ weekday, opens_at: `${opens_at}:00`, closes_at: `${closes_at}:00` }));
const barber = (id: string, working_hours: ReturnType<typeof hours>, is_active = true) => ({
  id,
  name: id,
  is_active,
  working_hours,
});
let n = 0;
const booking = (
  barberId: string,
  from: string,
  to: string,
  more: Partial<{ status: 'confirmed' | 'cancelled' | 'completed' | 'no_show'; is_block: boolean; ends_at: string }> = {},
) => ({
  id: `b${++n}`,
  barber_id: barberId,
  starts_at: at(from),
  ends_at: at(to),
  status: 'confirmed' as const,
  is_block: false,
  ...more,
});
const spans = (list: { from: number; to: number }[]) => list.map((s) => `${clockOf(s.from)}-${clockOf(s.to)}`);

const ali = barber('ali', hours(FRIDAY, ['10:00', '12:45'], ['14:30', '20:00']));
const danial = barber('danial', hours(FRIDAY, ['11:00', '12:45'], ['14:30', '21:00']));

test('bookings sit where their times are, sized by their length, and the free time between them is a gap', () => {
  const day = chairsDay(DAY, [ali], [booking('ali', '10:30', '11:00'), booking('ali', '15:00', '15:45')], TZ);
  assert.equal(clockOf(day.from), '10:00');
  assert.equal(clockOf(day.to), '20:00');
  const [chair] = day.chairs;
  assert.deepEqual(spans(chair.items), ['10:30-11:00', '15:00-15:45']);
  assert.equal(chair.items[1].to - chair.items[1].from, 45);
  assert.deepEqual(spans(chair.gaps), ['10:00-10:30', '11:00-12:45', '14:30-15:00', '15:45-20:00']);
  assert.deepEqual(
    chair.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`),
    ['break 12:45-14:30'],
  );
});

test('the time line runs from the earliest opening to the latest closing, with each barber off outside their hours', () => {
  const day = chairsDay(DAY, [ali, danial], [], TZ);
  assert.deepEqual([clockOf(day.from), clockOf(day.to)], ['10:00', '21:00']);
  const [a, d] = day.chairs;
  assert.deepEqual(
    a.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`),
    ['break 12:45-14:30', 'off 20:00-21:00'],
  );
  assert.deepEqual(
    d.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`),
    ['off 10:00-11:00', 'break 12:45-14:30'],
  );
  // Hours that don't start on the hour still get a whole hour at the top.
  const late = barber('late', hours(FRIDAY, ['10:30', '19:15']));
  const odd = chairsDay(DAY, [late], [], TZ);
  assert.deepEqual([clockOf(odd.from), clockOf(odd.to)], ['10:00', '20:00']);
  assert.deepEqual(odd.chairs[0].shades.map((s) => s.kind), ['off', 'off']);
});

test('a block over a break covers it, and a block or booking takes its time out of the gaps', () => {
  const day = chairsDay(
    DAY,
    [ali],
    [
      // Blocked from noon to 2 pm, across the start of the break.
      booking('ali', '12:00', '14:00', { is_block: true }),
      // A booking made before the hours changed, now in the break.
      booking('ali', '14:00', '14:45'),
    ],
    TZ,
  );
  const [chair] = day.chairs;
  assert.deepEqual(spans(chair.items), ['12:00-14:00', '14:00-14:45']);
  assert.deepEqual(chair.shades, [], 'nothing of the break is left showing');
  assert.deepEqual(spans(chair.gaps), ['10:00-12:00', '14:45-20:00']);

  // A block inside the break leaves the break showing on either side of it.
  const inside = chairsDay(DAY, [ali], [booking('ali', '13:00', '13:30', { is_block: true })], TZ).chairs[0];
  assert.deepEqual(
    inside.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`),
    ['break 12:45-13:00', 'break 13:30-14:30'],
  );
});

test('a booking that runs past closing stretches the day, and sits over the time the barber is off', () => {
  const day = chairsDay(DAY, [ali], [booking('ali', '19:45', '20:30')], TZ);
  assert.equal(clockOf(day.to), '21:00');
  const [chair] = day.chairs;
  assert.deepEqual(spans(chair.items), ['19:45-20:30']);
  assert.deepEqual(
    chair.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`),
    ['break 12:45-14:30', 'off 20:30-21:00'],
  );
  assert.equal(spans(chair.gaps).at(-1), '14:30-19:45');
  // One that starts before opening stretches the top the same way.
  const early = chairsDay(DAY, [ali], [booking('ali', '09:15', '10:00')], TZ);
  assert.equal(clockOf(early.from), '09:00');
  assert.deepEqual(early.chairs[0].shades[0], { kind: 'off', from: 9 * 60, to: 9 * 60 + 15 });
});

test('cancelled bookings are left out; a whole day blocked is named with its block, to open and take off', () => {
  const wholeDay = booking('danial', '00:00', '00:00', { is_block: true, ends_at: at('00:00', '2026-10-17') });
  const day = chairsDay(DAY, [ali, danial], [booking('ali', '11:00', '11:30', { status: 'cancelled' }), wholeDay], TZ);
  assert.deepEqual(day.chairs.map((c) => c.barber.id), ['ali']);
  assert.deepEqual(day.chairs[0].items, []);
  assert.deepEqual(
    day.blocked.map((b) => [b.barber.id, b.booking.id]),
    [['danial', wholeDay.id]],
  );
  assert.deepEqual(day.off, [], 'blocked says more than off');
  assert.deepEqual(day.away, []);
  assert.ok(isWholeDay(wholeDay));
  assert.ok(!isWholeDay(booking('ali', '00:00', '23:45', { is_block: true })));

  // Customers still booked on a day blocked whole keep the chair, and the block is still there to open.
  const kept = booking('danial', '15:00', '15:30');
  const both = chairsDay(DAY, [ali, danial], [wholeDay, kept], TZ);
  assert.deepEqual(both.chairs.map((c) => c.barber.id), ['ali', 'danial']);
  assert.deepEqual(both.chairs[1].items.map((i) => i.booking.id), [kept.id]);
  assert.deepEqual(both.chairs[1].gaps, [], 'nothing to offer on a day blocked');
  assert.deepEqual(both.blocked.map((b) => b.booking.id), [wholeDay.id]);

  // A barber off that weekday who also has it blocked: the block is what can be acted on.
  const sunday = '2026-10-18';
  const sundayBlock = { ...wholeDay, starts_at: at('00:00', sunday), ends_at: at('00:00', '2026-10-19') };
  const offToo = chairsDay(sunday, [ali, danial], [sundayBlock], TZ);
  assert.deepEqual(offToo.off.map((b) => b.id), ['ali']);
  assert.deepEqual(offToo.blocked.map((b) => b.barber.id), ['danial']);
  assert.deepEqual(offToo.chairs, []);
});

test('a booking shorter than a quarter hour is drawn a quarter hour tall, but not past the end of the time line', () => {
  const day = chairsDay(
    DAY,
    [ali],
    [booking('ali', '11:00', '11:05'), booking('ali', '11:05', '11:15'), booking('ali', '16:00', '16:45'), booking('ali', '19:50', '20:00')],
    TZ,
  );
  const [chair] = day.chairs;
  assert.deepEqual(
    chair.items.map((i) => `${clockOf(i.from)}-${clockOf(i.end)}`),
    ['11:00-11:15', '11:05-11:20', '16:00-16:45', '19:50-20:00'],
  );
  // What is free is worked out from the real times: the gap after the second starts at 11:15.
  assert.ok(spans(chair.gaps).includes('11:15-12:45'));
});

test('barbers off that day, or away, are named instead of given a chair, unless customers are still booked with them', () => {
  const monday = '2026-10-19';
  const mon = (clock: string) => at(clock, monday);
  const aliMon = barber('ali', hours(1, ['10:00', '20:00']));
  const danialOff = barber('danial', hours(2, ['11:00', '21:00']));
  const faizAway = barber('faiz', hours(1, ['10:00', '20:00']), false);
  // Left long ago, with no hours: not worth a mention every day.
  const gone = barber('gone', [], false);
  const day = chairsDay(monday, [aliMon, danialOff, faizAway, gone], [], TZ);
  assert.deepEqual(day.chairs.map((c) => c.barber.id), ['ali']);
  assert.deepEqual(day.off.map((b) => b.id), ['danial']);
  assert.deepEqual(day.away.map((b) => b.id), ['faiz']);

  // Faiz still has a customer: his chair stays, all of it off, so the booking isn't forgotten.
  const kept = {
    id: 'k',
    barber_id: 'faiz',
    starts_at: mon('15:00'),
    ends_at: mon('15:30'),
    status: 'confirmed' as const,
    is_block: false,
  };
  const withCustomer = chairsDay(monday, [aliMon, danialOff, faizAway], [kept], TZ);
  assert.deepEqual(withCustomer.chairs.map((c) => c.barber.id), ['ali', 'faiz']);
  const faiz = withCustomer.chairs[1];
  assert.deepEqual(faiz.hours, []);
  assert.deepEqual(faiz.gaps, [], 'nothing to offer in an away barber’s chair');
  assert.deepEqual(faiz.shades.map((s) => `${s.kind} ${clockOf(s.from)}-${clockOf(s.to)}`), [
    'off 10:00-15:00',
    'off 15:30-20:00',
  ]);
  assert.deepEqual(withCustomer.away, []);
  // A block alone doesn't keep a chair for someone off.
  const blockOnly = { ...kept, id: 'blk', barber_id: 'danial', is_block: true };
  assert.deepEqual(chairsDay(monday, [aliMon, danialOff], [blockOnly], TZ).off.map((b) => b.id), ['danial']);
});

test('nobody working gives no time line', () => {
  const day = chairsDay('2026-10-18', [ali], [], TZ);
  assert.deepEqual(day.chairs, []);
  assert.deepEqual([day.from, day.to], [0, 0]);
  assert.deepEqual(day.off.map((b) => b.id), ['ali']);
});

test('a gap offers its quarter hours, from the one now is in, with odd minutes at its top going to the first', () => {
  const m = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const show = (slots: ReturnType<typeof gapSlots>) => slots.map((s) => `${clockOf(s.at)} ${clockOf(s.from)}-${clockOf(s.to)}`);
  assert.deepEqual(show(gapSlots({ from: m('17:00'), to: m('18:00') })), [
    '17:00 17:00-17:15',
    '17:15 17:15-17:30',
    '17:30 17:30-17:45',
    '17:45 17:45-18:00',
  ]);
  // After a booking that ended at 10:20, the first start is 10:30 and takes the ten minutes above it.
  assert.deepEqual(show(gapSlots({ from: m('10:20'), to: m('11:00') })), ['10:30 10:20-10:45', '10:45 10:45-11:00']);
  // Ten minutes is too short to start anything on the quarter hour.
  assert.deepEqual(gapSlots({ from: m('10:20'), to: m('10:30') }), []);
  // The last start keeps whatever is left before the next booking.
  assert.deepEqual(show(gapSlots({ from: m('16:00'), to: m('16:20') })), ['16:00 16:00-16:15', '16:15 16:15-16:20']);
  // At 4:07 pm, 4 pm is still offered (a walk-in now); what is before it is past.
  assert.deepEqual(show(gapSlots({ from: m('15:00'), to: m('16:30') }, m('16:07'))), [
    '16:00 16:00-16:15',
    '16:15 16:15-16:30',
  ]);
  // A day gone by offers nothing.
  assert.deepEqual(gapSlots({ from: m('15:00'), to: m('16:30') }, 24 * 60 + 600), []);
});

test('a press in a gap opens the quarter hour under it, or the nearest one at either end', () => {
  const m = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  // After a booking that ended at 5:10 pm: 5:15 takes the five minutes above it.
  const slots = gapSlots({ from: m('17:10'), to: m('18:00') });
  const pick = (clock: string) => clockOf(slotAt(slots, m(clock)).at);
  assert.equal(pick('17:10'), '17:15');
  assert.equal(pick('17:29'), '17:15');
  assert.equal(pick('17:30'), '17:30');
  assert.equal(pick('17:59'), '17:45');
  // A press on the very edge, or a little outside it, still finds a time.
  assert.equal(pick('17:00'), '17:15');
  assert.equal(pick('18:00'), '17:45');
  assert.equal(clockOf(slotAt(slots, m('17:37') + 0.6).at), '17:30', 'minutes need not be whole');
});

test('minutes into the day, on the shop’s clock, whatever the phone’s zone', () => {
  const now = Date.parse('2026-10-16T16:07:00+08:00');
  assert.equal(minutesInto(DAY, now, TZ), 16 * 60 + 7);
  assert.ok(minutesInto('2026-10-17', now, TZ) < 0, 'tomorrow has not started');
  assert.ok(minutesInto('2026-10-15', now, TZ) >= 24 * 60, 'yesterday is over');
});

test('times read the way the rest of the app writes them', () => {
  assert.equal(clockOf(9 * 60 + 5), '09:05');
  assert.equal(clockOf(24 * 60), '00:00');
  assert.equal(clockText(16 * 60 + 30), '4:30 pm');
  assert.equal(clockText(24 * 60), '12:00 am');
  setCurrentLang('ms');
  try {
    assert.equal(clockText(13 * 60), '1.00 tengah hari');
  } finally {
    setCurrentLang('en');
  }
});

test('each booking is coloured by where it is in its day, and says so in words unless it is still to come', () => {
  const b = (from: string, to: string, status: 'confirmed' | 'completed' | 'no_show' = 'confirmed', is_block = false) => ({
    starts_at: at(from),
    ends_at: at(to),
    status,
    is_block,
  });
  const now = Date.parse(at('16:10'));
  assert.equal(chairStatus(b('17:00', '17:30'), now), 'upcoming');
  assert.equal(chairStatus(b('16:00', '16:30'), now), 'now');
  assert.equal(chairStatus(b('15:00', '15:30'), now), 'toMark');
  assert.equal(chairStatus(b('15:00', '15:30', 'completed'), now), 'done');
  assert.equal(chairStatus(b('15:00', '15:30', 'no_show'), now), 'noShow');
  assert.equal(chairStatus(b('16:00', '16:30', 'confirmed', true), now), 'block');
  assert.equal(statusWord('upcoming'), null);
  assert.deepEqual(
    (['now', 'toMark', 'done', 'noShow'] as const).map(statusWord),
    ['Now', 'Mark done?', 'Done', 'No-show'],
  );
});

test('a block says as much as fits, and never ends a line with a time cut short', () => {
  const p = { name: 'Amir', detail: 'Beard trim', clock: '10:00', word: 'No-show' };
  const still = { ...p, word: null };
  assert.deepEqual(blockText(0, p), { title: null, rows: [] });
  assert.deepEqual(blockText(1, p), { title: 'Amir · No-show', rows: [] });
  // A quarter hour has two lines: how it went, or the clock and the service when it is still to come.
  assert.deepEqual(blockText(2, p), { title: 'Amir', rows: ['No-show'] });
  assert.deepEqual(blockText(2, still), { title: 'Amir', rows: ['10:00 · Beard trim'] });
  assert.deepEqual(blockText(2, { ...still, detail: null }), { title: 'Amir', rows: ['10:00'] });
  assert.deepEqual(blockText(3, p), { title: 'Amir', rows: ['Beard trim', 'No-show'] });
  assert.deepEqual(blockText(3, still), { title: 'Amir', rows: ['Beard trim', '10:00'] });
  assert.deepEqual(blockText(4, p), { title: 'Amir', rows: ['Beard trim', '10:00', 'No-show'] });
  assert.deepEqual(blockText(6, { ...still, detail: null }), { title: 'Amir', rows: ['10:00'] });
  // No line has a status word followed by a time, where a narrow chair would cut the time off.
  for (let lines = 0; lines < 6; lines++) {
    for (const row of blockText(lines, p).rows) assert.doesNotMatch(row, /No-show · /);
  }
});
