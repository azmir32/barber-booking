/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  aboutText,
  barbersInNow,
  callMessage,
  clashFor,
  firstFree,
  freeText,
  nextInToday,
  placeText,
  placeWords,
  queueCount,
  queuedFor,
  queuedStatus,
  queueEstimate,
  queueLine,
  startError,
} from './queue.ts';

const TZ = 'Asia/Kuala_Lumpur';
// Tue 6 Oct, 3:20 pm in Kajang.
const now = Date.parse('2026-10-06T15:20:00+08:00');
const kajang = (clock: string) => new Date(`2026-10-06T${clock}:00+08:00`).toISOString();

function inMalay(fn: () => void) {
  setCurrentLang('ms');
  try {
    fn();
  } finally {
    setCurrentLang('en');
  }
}

test('places read 1st, 2nd, 3rd in English and ke-2 in Malay', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(placeWords),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'],
  );
  assert.equal(placeText(2), 'You’re 2nd in the queue');
  assert.equal(placeText(1), 'You’re next in the queue');
  inMalay(() => {
    assert.deepEqual([1, 2, 12].map(placeWords), ['pertama', 'ke-2', 'ke-12']);
    assert.equal(placeText(2), 'Anda orang ke-2 dalam barisan');
    assert.equal(placeText(1), 'Anda yang seterusnya dalam barisan');
  });
});

test('the estimate shares the waiting cuts among the barbers in, rounded up to 5 minutes', () => {
  assert.equal(queueEstimate(0, 2), 0, 'nobody waiting');
  assert.equal(queueEstimate(75, 2), 40, '37.5 rounds up');
  assert.equal(queueEstimate(30, 1), 30);
  assert.equal(queueEstimate(31, 1), 35);
  assert.equal(queueEstimate(105, 2), 55);
  assert.equal(queueEstimate(45, 0), 45, 'nobody in counts as one chair');
  assert.equal(queueLine({ waiting: 3, estimate_min: 40 }), '3 waiting, about 40\u00a0min');
  assert.equal(queueLine({ waiting: 4, estimate_min: 75 }), '4 waiting, about 1\u00a0hr\u00a015\u00a0min');
  assert.equal(queueLine({ waiting: 0, estimate_min: 0 }), 'No one waiting');
  assert.equal(aboutText(0), 'no wait');
  assert.deepEqual([queueCount(3), queueCount(0)], ['3 waiting', 'No queue']);
  inMalay(() => {
    assert.equal(queueLine({ waiting: 3, estimate_min: 40 }), '3 menunggu, lebih kurang 40\u00a0min');
    assert.deepEqual([queueCount(3), queueCount(0)], ['3 menunggu', 'Tiada barisan']);
  });
});

test('the WhatsApp to someone called says it is their turn', () => {
  assert.equal(
    callMessage('Hakim', 'Ali Barber Sungai Chua'),
    'Hi Hakim, it’s your turn at Ali Barber Sungai Chua. See you in a few minutes!',
  );
  assert.equal(callMessage(null, 'Ali Barber'), 'Hi Customer, it’s your turn at Ali Barber. See you in a few minutes!');
  inMalay(() =>
    assert.equal(
      callMessage('Hakim', 'Ali Barber Sungai Chua'),
      'Hai Hakim, sekarang giliran anda di Ali Barber Sungai Chua. Jumpa dalam beberapa minit lagi!',
    ),
  );
});

test('each one on the shop’s list says how long they have waited, or when they were called', () => {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  assert.equal(queuedStatus({ state: 'waiting', created_at: at(0.5), called_at: null }, now, TZ), 'Just joined');
  assert.equal(queuedStatus({ state: 'waiting', created_at: at(12), called_at: null }, now, TZ), 'Waiting 12 min');
  assert.equal(queuedStatus({ state: 'waiting', created_at: at(65), called_at: null }, now, TZ), 'Waiting 1 hr 5 min');
  assert.equal(queuedStatus({ state: 'called', created_at: at(30), called_at: at(5) }, now, TZ), 'Called 3:15 pm');
  assert.equal(queuedFor({ service_name: 'Haircut', barber_name: 'Ali' }), 'Haircut with Ali');
  assert.equal(queuedFor({ service_name: 'Haircut', barber_name: null }), 'Haircut, any barber');
  assert.equal(queuedFor({ service_name: null, barber_name: 'Ali' }), 'With Ali');
  assert.equal(queuedFor({ service_name: null, barber_name: null }), 'Any barber');
});

const hours = (opens: string, closes: string) => [{ weekday: 2, opens_at: opens, closes_at: closes }];
const ali = { id: 'ali', is_active: true, working_hours: hours('10:00', '20:00') };
const danial = {
  id: 'danial',
  is_active: true,
  working_hours: [
    { weekday: 2, opens_at: '11:00', closes_at: '15:00' },
    { weekday: 2, opens_at: '15:30', closes_at: '21:00' },
  ],
};
const away = { id: 'away', is_active: false, working_hours: hours('00:00', '24:00') };
const booked = (barber: string, from: string, to: string, more: { status?: 'confirmed' | 'cancelled'; is_block?: boolean } = {}) => ({
  barber_id: barber,
  starts_at: kajang(from),
  ends_at: kajang(to),
  status: more.status ?? ('confirmed' as const),
  is_block: more.is_block ?? false,
});

test('barbers in now are inside a working range today, active and without the day off', () => {
  const team = [ali, danial, away];
  assert.deepEqual(barbersInNow(team, [], now, TZ).map((b) => b.id), ['ali'], 'Danial is on his break');
  const later = Date.parse('2026-10-06T15:30:00+08:00');
  assert.deepEqual(barbersInNow(team, [], later, TZ).map((b) => b.id), ['ali', 'danial']);
  const dayOff = { ...booked('ali', '00:00', '00:00'), ends_at: new Date(Date.parse(kajang('00:00')) + 86_400_000).toISOString(), is_block: true };
  assert.deepEqual(barbersInNow(team, [dayOff], later, TZ).map((b) => b.id), ['danial']);
  assert.deepEqual(barbersInNow(team, [], later, TZ, true), [], 'a closed day has nobody in');
  assert.deepEqual(barbersInNow(team, [], Date.parse('2026-10-07T15:30:00+08:00'), TZ), [], 'nobody works Wednesdays here');
});

test('Start can take anyone working today, in now or not: on a break, before starting, or past closing', () => {
  const team = [ali, danial, away];
  const whole = (at: number, bookings: Parameters<typeof barbersInNow>[1] = []) =>
    barbersInNow(team, bookings, at, TZ, false, true).map((b) => b.id);
  assert.deepEqual(whole(now), ['ali', 'danial'], 'Danial is on his break, but works today');
  assert.deepEqual(whole(Date.parse('2026-10-06T09:30:00+08:00')), ['ali', 'danial'], 'before opening');
  assert.deepEqual(whole(Date.parse('2026-10-06T21:30:00+08:00')), ['ali', 'danial'], 'past closing');
  const dayOff = { ...booked('danial', '00:00', '00:00'), ends_at: new Date(Date.parse(kajang('00:00')) + 86_400_000).toISOString(), is_block: true };
  assert.deepEqual(whole(now, [dayOff]), ['ali'], 'not with the day off');
  assert.deepEqual(barbersInNow(team, [], now, TZ, true, true), [], 'nor on a closed day');
  assert.deepEqual(whole(Date.parse('2026-10-07T15:30:00+08:00')), [], 'nor on a day they don’t work');
});

test('when someone is next in today: the end of a break, or a later start', () => {
  // 3:20 pm: Danial is on his break until 3:30.
  assert.deepEqual(nextInToday([ali, danial], now, TZ), { at: Date.parse('2026-10-06T15:30:00+08:00'), time: '3:30 pm' });
  assert.deepEqual(nextInToday([danial], Date.parse('2026-10-06T09:00:00+08:00'), TZ)?.time, '11:00 am');
  assert.equal(nextInToday([ali, danial], Date.parse('2026-10-06T15:30:00+08:00'), TZ), null, 'nobody starts again today');
  assert.equal(nextInToday([{ ...danial, is_active: false }], now, TZ), null);
  inMalay(() => assert.equal(nextInToday([danial], now, TZ)?.time, '3.30 petang'));
});

test('Start offers the barber asked for, else the first one free until the cut would end', () => {
  const later = Date.parse('2026-10-06T15:30:00+08:00');
  const team = [ali, danial];
  assert.equal(firstFree(team, 'danial', 30, [], later)?.id, 'danial');
  assert.equal(firstFree(team, null, 30, [], later)?.id, 'ali');
  const aliBusy = [booked('ali', '15:00', '15:45')];
  assert.equal(firstFree(team, null, 30, aliBusy, later)?.id, 'danial');
  assert.equal(firstFree(team, null, 30, [booked('ali', '15:00', '15:45', { status: 'cancelled' })], later)?.id, 'ali');
  // Ali's next booking starts before a 45-minute cut would end.
  assert.equal(firstFree(team, null, 45, [booked('ali', '16:00', '16:30')], later)?.id, 'danial');
  // Nobody free: still someone to start with, and the server says why not.
  assert.equal(firstFree(team, null, 30, [...aliBusy, booked('danial', '15:00', '16:00')], later)?.id, 'ali');
  assert.equal(firstFree(team, 'away', 30, [], later)?.id, 'ali', 'asked for someone who isn’t in');
  assert.equal(firstFree([], null, 30, [], later), null);
});

test('beside each barber Start can pick: free, busy until, or booked later', () => {
  const later = Date.parse('2026-10-06T15:30:00+08:00');
  const list = [booked('ali', '15:00', '15:45'), booked('danial', '16:00', '16:30'), booked('ali', '16:00', '16:30')];
  assert.equal(freeText(clashFor('ali', 30, list, later), later, TZ), 'Busy until 3:45\u00a0pm');
  assert.equal(freeText(clashFor('danial', 45, list, later), later, TZ), 'Booked 4:00\u00a0pm');
  assert.equal(freeText(clashFor('danial', 30, list, later), later, TZ), 'Free', 'done at 4:00, as the next one starts');
  assert.equal(clashFor('ali', 30, [booked('ali', '15:00', '15:45', { status: 'cancelled' })], later), null);
  inMalay(() => assert.equal(freeText(clashFor('ali', 30, list, later), later, TZ), 'Sibuk hingga 3.45\u00a0petang'));
});

test('Start’s refusals are said in the customer’s language and clock', () => {
  const busy = { message: 'Ali is busy until 3:45 pm. Pick another barber.', details: kajang('15:45') };
  const before = { message: 'Danial has a 4:00 pm booking before this cut would finish. Pick another barber.', details: kajang('16:00') };
  const eleven = { message: 'Ali has an 11:30 am booking before this cut would finish. Pick another barber.', details: kajang('11:30') };
  assert.equal(startError(busy, TZ), 'Ali is busy until 3:45 pm. Pick another barber.');
  assert.equal(startError(before, TZ), 'Danial has a 4:00 pm booking before this cut would finish. Pick another barber.');
  assert.equal(startError(eleven, TZ), 'Ali has an 11:30 am booking before this cut would finish. Pick another barber.');
  assert.equal(startError({ message: 'Barber not found.', details: null }, TZ), null);
  inMalay(() => {
    assert.equal(startError(busy, TZ), 'Ali sibuk hingga 3.45 petang. Pilih barber lain.');
    assert.equal(startError(eleven, TZ), 'Ali ada tempahan jam 11.30 pagi sebelum potongan ini siap. Pilih barber lain.');
  });
});
