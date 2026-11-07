/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  DEFAULT_REMINDER_SETTINGS,
  MAX_REMINDERS,
  parseReminderPrefs,
  plannedReminders,
  REMINDER_ID_PREFIX,
  reminderChanges,
  remindersLine,
  remindersOfKind,
  type ReminderBooking,
} from './phone-reminders.ts';

const KL = 'Asia/Kuala_Lumpur';
const both = DEFAULT_REMINDER_SETTINGS;
const at = (iso: string) => Date.parse(iso);
const booking = (startsAt: string, more: Partial<ReminderBooking> = {}): ReminderBooking => ({
  id: `b-${startsAt}`,
  starts_at: new Date(startsAt).toISOString(),
  service_name: 'Skin fade',
  shop_name: 'Ali Barber Sungai Chua',
  time_zone: KL,
  status: 'confirmed',
  ...more,
});
/** When each planned reminder goes, as ISO in UTC, with its kind. */
const plan = (bookings: ReminderBooking[], now: number, settings = both) =>
  plannedReminders(bookings, settings, now).map((r) => [r.kind, new Date(r.at).toISOString()]);

test('a booking gets one at 8 pm the evening before and one an hour before, saying the shop, service and time', () => {
  setCurrentLang('en');
  // Tue 6 Oct, 10 am in Kajang; the cut is Thu 8 Oct at 4:30 pm.
  const now = at('2026-10-06T10:00:00+08:00');
  const [evening, hour] = plannedReminders([booking('2026-10-08T16:30:00+08:00', { id: 'b1' })], both, now);
  assert.deepEqual(
    { ...evening, id: undefined },
    {
      id: undefined,
      bookingId: 'b1',
      kind: 'evening',
      at: at('2026-10-07T20:00:00+08:00'),
      title: 'Ali Barber Sungai Chua',
      body: 'Your Skin fade is tomorrow at 4:30 pm. Can’t make it? Cancel from My bookings so someone else can take the slot.',
      service: 'Skin fade',
      timeZone: KL,
    },
  );
  assert.deepEqual(
    [hour.kind, hour.at, hour.title, hour.body],
    ['hour', at('2026-10-08T15:30:00+08:00'), 'Ali Barber Sungai Chua', 'Your Skin fade is in an hour, at 4:30 pm.'],
  );
  assert.ok(evening.id.startsWith(`${REMINDER_ID_PREFIX}evening-b1-`) && hour.id.startsWith(`${REMINDER_ID_PREFIX}hour-b1-`));
});

test('the evening one is left out once 8 pm the evening before has passed, as for a booking made after it', () => {
  const cut = [booking('2026-10-08T11:00:00+08:00')];
  assert.deepEqual(
    plan(cut, at('2026-10-07T19:59:59+08:00')).map(([kind]) => kind),
    ['evening', 'hour'],
    'a second before 8 pm',
  );
  assert.deepEqual(plan(cut, at('2026-10-07T20:00:00+08:00')), [['hour', '2026-10-08T02:00:00.000Z']], 'at 8 pm');
  assert.deepEqual(plan(cut, at('2026-10-07T21:15:00+08:00')), [['hour', '2026-10-08T02:00:00.000Z']], 'booked at 9:15 pm');
  // Booked in the morning for that evening: the evening before is long gone, the hour before is still to come.
  assert.deepEqual(plan([booking('2026-10-07T19:00:00+08:00')], at('2026-10-07T09:00:00+08:00')), [
    ['hour', '2026-10-07T10:00:00.000Z'],
  ]);
});

test('a booking within the hour, one that has started and one gone by get none', () => {
  const now = at('2026-10-07T14:00:00+08:00');
  assert.deepEqual(plan([booking('2026-10-07T14:45:00+08:00')], now), [], 'in 45 minutes');
  assert.deepEqual(plan([booking('2026-10-07T15:00:00+08:00')], now), [], 'in exactly an hour');
  assert.deepEqual(plan([booking('2026-10-07T15:01:00+08:00')], now), [['hour', '2026-10-07T06:01:00.000Z']]);
  assert.deepEqual(plan([booking('2026-10-07T13:50:00+08:00')], now), [], 'started ten minutes ago');
  assert.deepEqual(plan([booking('2026-10-01T10:00:00+08:00')], now), [], 'last week');
});

test('only confirmed bookings: cancelled, no-show and done ones get none', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  for (const status of ['cancelled', 'no_show', 'completed']) {
    assert.deepEqual(plan([booking('2026-10-08T16:30:00+08:00', { status })], now), [], status);
  }
  // my_upcoming_bookings sends only confirmed ones, without a status.
  assert.equal(plan([booking('2026-10-08T16:30:00+08:00', { status: undefined })], now).length, 2);
});

test('the shop’s clock decides the evening and the time, whatever the phone’s', () => {
  // At 10 am in Kajang. A shop in Jakarta, an hour behind: 9 am there on Thursday is 10 am in Kajang,
  // and its evening before is 8 pm in Jakarta, 9 pm in Kajang.
  const now = at('2026-10-06T10:00:00+08:00');
  const jakarta = plannedReminders([booking('2026-10-08T09:00:00+07:00', { time_zone: 'Asia/Jakarta' })], both, now);
  assert.deepEqual(
    jakarta.map((r) => [r.at, r.body]),
    [
      [at('2026-10-07T20:00:00+07:00'), 'Your Skin fade is tomorrow at 9:00 am. Can’t make it? Cancel from My bookings so someone else can take the slot.'],
      [at('2026-10-08T08:00:00+07:00'), 'Your Skin fade is in an hour, at 9:00 am.'],
    ],
  );
  // At 9 pm in Kajang it is already 3 am on Wednesday in Kiritimati: a cut there at 10 am today (its
  // Wednesday) had its evening before at 8 pm Tuesday, Kiritimati time, long gone.
  assert.deepEqual(
    plan([booking('2026-10-07T10:00:00+14:00', { time_zone: 'Pacific/Kiritimati' })], at('2026-10-06T21:00:00+08:00')),
    [['hour', '2026-10-06T19:00:00.000Z']],
  );
  // On the night New York's clocks go back, 8 pm is in standard time (UTC-5), not summer time.
  assert.deepEqual(
    plan([booking('2026-11-02T09:00:00-05:00', { time_zone: 'America/New_York' })], at('2026-10-30T12:00:00Z')),
    [
      ['evening', '2026-11-02T01:00:00.000Z'],
      ['hour', '2026-11-02T13:00:00.000Z'],
    ],
  );
  // No zone given: Kajang's.
  assert.equal(plan([booking('2026-10-08T16:30:00+08:00', { time_zone: null })], now)[0][1], '2026-10-07T12:00:00.000Z');
});

test('around midnight: a cut just after it is reminded the evening before and late that night', () => {
  setCurrentLang('en');
  const now = at('2026-10-06T10:00:00+08:00');
  const reminders = plannedReminders([booking('2026-10-09T00:15:00+08:00')], both, now);
  assert.deepEqual(
    reminders.map((r) => [r.kind, new Date(r.at).toISOString(), r.body.split('.')[0]]),
    [
      ['evening', '2026-10-08T12:00:00.000Z', 'Your Skin fade is tomorrow at 12:15 am'],
      ['hour', '2026-10-08T15:15:00.000Z', 'Your Skin fade is in an hour, at 12:15 am'],
    ],
  );
  // At ten to midnight, a cut at half past: too late for either.
  assert.deepEqual(plan([booking('2026-10-09T00:30:00+08:00')], at('2026-10-08T23:50:00+08:00')), []);
  // A cut at 11:45 pm is reminded at 8 pm the evening before, not that evening.
  assert.equal(plan([booking('2026-10-08T23:45:00+08:00')], now)[0][1], '2026-10-07T12:00:00.000Z');
});

test('each setting turns its own reminder off', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  const cut = [booking('2026-10-08T16:30:00+08:00')];
  assert.deepEqual(plan(cut, now, { evening: false, hour: true }).map(([k]) => k), ['hour']);
  assert.deepEqual(plan(cut, now, { evening: true, hour: false }).map(([k]) => k), ['evening']);
  assert.deepEqual(plan(cut, now, { evening: false, hour: false }), []);
});

test('several bookings come soonest first, the soonest 30 at most, and never more than iOS keeps', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  const two = plan([booking('2026-10-10T11:00:00+08:00'), booking('2026-10-08T16:30:00+08:00')], now);
  assert.deepEqual(
    two.map(([, when]) => when),
    ['2026-10-07T12:00:00.000Z', '2026-10-08T07:30:00.000Z', '2026-10-09T12:00:00.000Z', '2026-10-10T02:00:00.000Z'],
  );
  const many = Array.from({ length: 35 }, (_, i) => booking(new Date(now + (i + 2) * 86_400_000).toISOString()));
  const planned = plannedReminders(many.reverse(), both, now);
  assert.equal(planned.length, MAX_REMINDERS);
  assert.equal(new Set(planned.map((r) => r.bookingId)).size, 30);
  assert.ok(planned.every((r, i) => i === 0 || r.at >= planned[i - 1].at));
});

test('a moved booking swaps its reminders; the others stay as they are, and other notifications are left alone', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  const before = plannedReminders(
    [booking('2026-10-08T16:30:00+08:00', { id: 'moved' }), booking('2026-10-09T11:00:00+08:00', { id: 'same' })],
    both,
    now,
  );
  const after = plannedReminders(
    [booking('2026-10-10T12:00:00+08:00', { id: 'moved' }), booking('2026-10-09T11:00:00+08:00', { id: 'same' })],
    both,
    now,
  );
  const scheduled = [...before.map((r) => r.id), 'someone-elses'];
  const { cancel, schedule } = reminderChanges(after, scheduled);
  assert.deepEqual(cancel.sort(), before.filter((r) => r.bookingId === 'moved').map((r) => r.id).sort());
  assert.deepEqual(
    schedule.map((r) => [r.bookingId, r.kind, new Date(r.at).toISOString()]),
    [
      ['moved', 'evening', '2026-10-09T12:00:00.000Z'],
      ['moved', 'hour', '2026-10-10T03:00:00.000Z'],
    ],
  );
  // Nothing to do when nothing changed; everything of ours goes when nothing is wanted.
  assert.deepEqual(reminderChanges(after, after.map((r) => r.id)), { cancel: [], schedule: [] });
  assert.deepEqual(reminderChanges([], scheduled).cancel, before.map((r) => r.id));
  // Cancelled: its two go, by the same diff.
  const cancelled = plannedReminders([booking('2026-10-09T11:00:00+08:00', { id: 'same' })], both, now);
  assert.deepEqual(reminderChanges(cancelled, after.map((r) => r.id)).cancel.length, 2);
  // Turning one kind off takes those, whatever booking they are for.
  assert.deepEqual(remindersOfKind('evening', scheduled).length, 2);
});

test('on Android every wanted reminder is scheduled again, as a force stop can drop its alarm but not its entry', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  const before = plannedReminders(
    [booking('2026-10-08T16:30:00+08:00', { id: 'moved' }), booking('2026-10-09T11:00:00+08:00', { id: 'same' })],
    both,
    now,
  );
  const after = plannedReminders(
    [booking('2026-10-10T12:00:00+08:00', { id: 'moved' }), booking('2026-10-09T11:00:00+08:00', { id: 'same' })],
    both,
    now,
  );
  const scheduled = [...before.map((r) => r.id), 'someone-elses'];
  const android = reminderChanges(after, scheduled, { again: true });
  // The same ones go as on iOS, and all four wanted are scheduled, under the identifiers they had.
  assert.deepEqual(android.cancel, reminderChanges(after, scheduled).cancel);
  assert.deepEqual(android.schedule, after);
  const same = before.filter((r) => r.bookingId === 'same').map((r) => r.id);
  assert.deepEqual(
    android.schedule.filter((r) => r.bookingId === 'same').map((r) => r.id),
    same,
  );
  // Nothing changed: nothing goes, and every one is set up again all the same.
  assert.deepEqual(reminderChanges(after, after.map((r) => r.id), { again: true }), { cancel: [], schedule: after });
  // Nothing wanted: nothing to schedule.
  assert.deepEqual(reminderChanges([], scheduled, { again: true }).schedule, []);
});

test('in Malay, with Malay times, and a new identifier so a language change replaces them', () => {
  const now = at('2026-10-06T10:00:00+08:00');
  const cut = [booking('2026-10-08T16:30:00+08:00', { id: 'b1', service_name: 'Potong rambut' })];
  setCurrentLang('en');
  const english = plannedReminders(cut, both, now);
  setCurrentLang('ms');
  try {
    const malay = plannedReminders(cut, both, now);
    assert.deepEqual(
      malay.map((r) => r.body),
      [
        'Potong rambut anda esok jam 4.30 petang. Tak dapat datang? Batalkan di Tempahan saya supaya orang lain boleh ambil slot itu.',
        'Potong rambut anda sejam lagi, jam 4.30 petang.',
      ],
    );
    assert.deepEqual(
      malay.map((r) => r.at),
      english.map((r) => r.at),
    );
    assert.ok(malay.every((r, i) => r.id !== english[i].id));
    const [late] = plannedReminders([booking('2026-10-09T00:15:00+08:00')], both, now);
    assert.ok(late.body.startsWith('Skin fade anda esok jam 12.15 pagi. '), late.body);
    assert.equal(remindersLine(['evening', 'hour']), 'Kami akan ingatkan anda pada malam sebelumnya dan sejam sebelumnya.');
  } finally {
    setCurrentLang('en');
  }
});

test('the booking confirmation says which reminders will come', () => {
  setCurrentLang('en');
  assert.equal(remindersLine(['evening', 'hour']), 'We’ll remind you the evening before and an hour before.');
  assert.equal(remindersLine(['hour']), 'We’ll remind you an hour before.');
  assert.equal(remindersLine(['evening']), 'We’ll remind you the evening before.');
  assert.equal(remindersLine([]), null);
});

test('the settings kept on the phone: both on and not asked yet, unless saved otherwise', () => {
  assert.deepEqual(parseReminderPrefs(null), { settings: { evening: true, hour: true }, asked: false });
  assert.deepEqual(parseReminderPrefs('not json'), { settings: { evening: true, hour: true }, asked: false });
  assert.deepEqual(parseReminderPrefs('{"evening":false,"asked":true}'), {
    settings: { evening: false, hour: true },
    asked: true,
  });
  assert.deepEqual(parseReminderPrefs('{"evening":"no","hour":false}'), { settings: { evening: true, hour: false }, asked: false });
});
