/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import { canRemind, needsReminder, reminderMessage } from './reminders.ts';

const TZ = 'Asia/Kuala_Lumpur';
// Tue 6 Oct, 9 pm in Kajang.
const now = Date.parse('2026-10-06T21:00:00+08:00');
const booking = (
  startsAt: string,
  more: Partial<{ status: 'confirmed' | 'cancelled'; is_block: boolean; reminded_at: string; created_at: string }> = {},
) => ({
  status: 'confirmed' as const,
  is_block: false,
  reminded_at: null as string | null,
  starts_at: new Date(startsAt).toISOString(),
  // Booked on Sunday, well before the reminder is due.
  created_at: '2026-10-04T12:00:00+08:00',
  ...more,
});
const phone = '012-345 6789';

test('bookings from now to the end of tomorrow, on the shop’s clock, can be reminded', () => {
  assert.equal(canRemind(booking('2026-10-06T21:30:00+08:00'), phone, now, TZ), true, 'later today');
  assert.equal(canRemind(booking('2026-10-07T10:00:00+08:00'), phone, now, TZ), true, 'tomorrow');
  assert.equal(canRemind(booking('2026-10-07T23:45:00+08:00'), phone, now, TZ), true, 'late tomorrow');
  assert.equal(canRemind(booking('2026-10-08T00:00:00+08:00'), phone, now, TZ), false, 'the day after');
  assert.equal(canRemind(booking('2026-10-06T20:30:00+08:00'), phone, now, TZ), false, 'already started');
  assert.equal(canRemind(booking('2026-10-06T21:00:00+08:00'), phone, now, TZ), false, 'starting now');
  // At 9 pm in Kajang it is already Wednesday in Kiritimati, so its "tomorrow" is Thursday.
  assert.equal(canRemind(booking('2026-10-08T10:00:00+14:00'), phone, now, 'Pacific/Kiritimati'), true);
});

test('only confirmed bookings with a phone, never blocks', () => {
  const tomorrow = '2026-10-07T10:00:00+08:00';
  assert.equal(canRemind(booking(tomorrow), null, now, TZ), false, 'no phone');
  assert.equal(canRemind(booking(tomorrow), '', now, TZ), false, 'empty phone');
  assert.equal(canRemind(booking(tomorrow, { status: 'cancelled' }), phone, now, TZ), false, 'cancelled');
  assert.equal(canRemind(booking(tomorrow, { is_block: true }), phone, now, TZ), false, 'blocked time');
});

test('a booking someone already reminded no longer needs one, but can have another', () => {
  const reminded = booking('2026-10-07T10:00:00+08:00', { reminded_at: '2026-10-06T12:00:00Z' });
  assert.equal(needsReminder(reminded, phone, now, TZ), false);
  assert.equal(canRemind(reminded, phone, now, TZ), true);
  assert.equal(needsReminder(booking('2026-10-07T10:00:00+08:00'), phone, now, TZ), true);
});

test('only tomorrow’s bookings made before today need one; the rest can still have one', () => {
  const both = (b: ReturnType<typeof booking>) => [needsReminder(b, phone, now, TZ), canRemind(b, phone, now, TZ)];
  assert.deepEqual(both(booking('2026-10-07T23:45:00+08:00', { created_at: '2026-10-05T23:30:00+08:00' })), [true, true]);
  assert.deepEqual(both(booking('2026-10-06T21:30:00+08:00')), [false, true], 'later today');
  assert.deepEqual(both(booking('2026-10-07T10:00:00+08:00', { created_at: '2026-10-06T20:30:00+08:00' })), [false, true], 'booked tonight');
  // Just after midnight in Kajang is still the day before in UTC.
  assert.deepEqual(both(booking('2026-10-07T10:00:00+08:00', { created_at: '2026-10-06T00:30:00+08:00' })), [false, true], 'booked today');
  assert.deepEqual(both(booking('2026-10-07T10:00:00+08:00', { status: 'cancelled' })), [false, false]);
  assert.equal(needsReminder(booking('2026-10-07T10:00:00+08:00'), null, now, TZ), false, 'no phone');
});

test('the message says today or tomorrow when it can, else the day', () => {
  const vars = { who: 'Hakim', shop: 'Ali Barber', service: 'Skin fade', day: 'Thu, 8 Oct', time: '4:30 pm' };
  assert.equal(
    reminderMessage(vars, '2026-10-07T16:30:00+08:00', now, TZ),
    'Hi Hakim, a reminder from Ali Barber: your Skin fade is tomorrow at 4:30 pm. Can’t make it? Just reply here so we can give the slot to someone else.',
  );
  assert.match(reminderMessage(vars, '2026-10-06T22:00:00+08:00', now, TZ), /your Skin fade is today at 4:30 pm\./);
  assert.match(reminderMessage(vars, '2026-10-08T16:30:00+08:00', now, TZ), /your Skin fade is on Thu, 8 Oct at 4:30 pm\./);
  // 7 am tomorrow in Kajang is still today in UTC.
  assert.match(reminderMessage(vars, '2026-10-07T07:00:00+08:00', now, TZ), /is tomorrow at/);

  setCurrentLang('ms');
  try {
    assert.equal(
      reminderMessage({ ...vars, time: '4.30 petang' }, '2026-10-07T16:30:00+08:00', now, TZ),
      'Hai Hakim, peringatan daripada Ali Barber: Skin fade anda esok jam 4.30 petang. Tidak dapat datang? Balas sahaja di sini supaya kami boleh beri slot itu kepada orang lain.',
    );
  } finally {
    setCurrentLang('en');
  }
});
