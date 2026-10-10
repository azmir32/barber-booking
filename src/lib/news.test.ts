/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  ago,
  badgeText,
  changeLine,
  changesLabel,
  changeTag,
  isAfter,
  micros,
  moreText,
  nextSeen,
  seenMark,
  whenText,
  type ShopChange,
} from './news.ts';

const TZ = 'Asia/Kuala_Lumpur';
// Sat 10 Oct, 2 pm in Kajang.
const now = Date.parse('2026-10-10T14:00:00+08:00');
const kajang = (at: string) => new Date(`${at}+08:00`).toISOString();

const change = (more: Partial<ShopChange> = {}): ShopChange => ({
  booking_id: 'b1',
  barber_id: 'r1',
  barber_name: 'Danial',
  customer_name: 'Hakim',
  service_name: 'Fade',
  starts_at: kajang('2026-10-11T16:30:00'),
  change: 'booked',
  changed_at: kajang('2026-10-10T12:30:00'),
  chair_free: false,
  ...more,
});

/** Without the non-breaking spaces that keep a day or a time on one line. */
const plain = (text: string) => text.replace(/ /g, ' ');
const line = (more: Partial<ShopChange>, showBarber = true) => plain(changeLine(change(more), now, TZ, showBarber));

const inMalay = (check: () => void) => {
  setCurrentLang('ms');
  try {
    check();
  } finally {
    setCurrentLang('en');
  }
};

test('the tab shows no number without news, and never more than 9+', () => {
  assert.equal(badgeText(0), undefined);
  assert.equal(badgeText(-1), undefined);
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(badgeText(250), '9+');
  assert.equal(changesLabel(1), '1 change since you last looked');
  assert.equal(changesLabel(12), '12 changes since you last looked');
  inMalay(() => assert.equal(changesLabel(3), '3 perubahan sejak kali terakhir anda lihat'));
});

test('each change reads as one sentence: who, what, when and whose chair', () => {
  assert.equal(line({}), 'Hakim booked Fade for tomorrow at 4:30 pm with Danial');
  assert.equal(line({}, false), 'Hakim booked Fade for tomorrow at 4:30 pm');
  assert.equal(
    line({ customer_name: 'Wei Jie', barber_name: 'Ali', change: 'cancelled', starts_at: kajang('2026-10-10T17:30:00'), chair_free: true }),
    'Wei Jie cancelled today at 5:30 pm with Ali, so that chair is free',
  );
  assert.equal(
    line({ change: 'cancelled', starts_at: kajang('2026-10-10T17:30:00'), chair_free: true }, false),
    'Hakim cancelled today at 5:30 pm, so that chair is free',
  );
  // Someone has taken the time since, or it has passed: no chair to fill.
  assert.equal(
    line({ change: 'cancelled', starts_at: kajang('2026-10-10T17:30:00') }),
    'Hakim cancelled today at 5:30 pm with Danial',
  );
  assert.equal(
    line({ change: 'cancelled', starts_at: kajang('2026-10-10T13:30:00'), chair_free: true }, false),
    'Hakim cancelled today at 1:30 pm',
  );
  assert.equal(
    line({ customer_name: 'Aiman', change: 'moved', starts_at: kajang('2026-10-13T11:00:00') }, false),
    'Aiman moved to Tue, 13 Oct at 11:00 am',
  );
  assert.equal(line({ change: 'moved' }), 'Hakim moved to tomorrow at 4:30 pm with Danial');
  assert.equal(line({ customer_name: 'Deleted account', change: 'cancelled' }), 'Deleted account cancelled tomorrow at 4:30 pm with Danial');
  assert.equal(line({ customer_name: null }, false), 'Customer booked Fade for tomorrow at 4:30 pm');
  // The day and the time each stay on one line.
  assert.match(changeLine(change({ change: 'moved', starts_at: kajang('2026-10-13T11:00:00') }), now, TZ, false), /Tue, 13 Oct at 11:00 am$/);

  inMalay(() => {
    assert.equal(line({}), 'Hakim menempah Fade untuk esok jam 4.30 petang dengan Danial');
    assert.equal(
      line({ change: 'cancelled', starts_at: kajang('2026-10-10T19:30:00'), chair_free: true }),
      'Hakim membatalkan tempahan hari ini jam 7.30 malam dengan Danial, jadi kerusi itu kosong',
    );
    assert.equal(line({ change: 'moved', starts_at: kajang('2026-10-14T11:30:00') }, false), 'Hakim menukar masa ke Rab, 14 Okt jam 11.30 pagi');
    assert.equal(line({ customer_name: 'Deleted account', change: 'cancelled' }, false), 'Akaun dipadam membatalkan tempahan esok jam 4.30 petang');
  });
});

test('today and tomorrow follow the shop’s clock, not UTC', () => {
  const when = (at: string, from = now) => plain(whenText(kajang(at), from, TZ));
  assert.equal(when('2026-10-10T23:45:00'), 'today at 11:45 pm');
  // Just after midnight in Kajang is still the day before in UTC.
  assert.equal(when('2026-10-11T00:15:00'), 'tomorrow at 12:15 am');
  assert.equal(when('2026-10-12T00:15:00'), 'Mon, 12 Oct at 12:15 am');
  // A cut that started before midnight and runs past it.
  assert.equal(when('2026-10-09T23:45:00'), 'yesterday at 11:45 pm');
  // Seen from 11:30 pm, a cut at half past midnight is tomorrow; from 12:30 am, it is today.
  assert.equal(when('2026-10-11T00:30:00', Date.parse('2026-10-10T23:30:00+08:00')), 'tomorrow at 12:30 am');
  assert.equal(when('2026-10-11T00:30:00', Date.parse('2026-10-11T00:10:00+08:00')), 'today at 12:30 am');
  // Across the end of a month.
  assert.equal(when('2026-11-01T10:00:00', Date.parse('2026-10-31T21:00:00+08:00')), 'tomorrow at 10:00 am');
  inMalay(() => assert.equal(plain(whenText(kajang('2026-10-10T12:00:00'), now, TZ)), 'hari ini jam 12.00 tengah hari'));
});

test('times compare to the microsecond, whatever the zone they are written in', () => {
  const seen = '2026-10-10T04:30:00.123456+00:00';
  assert.equal(isAfter('2026-10-10T04:30:00.123457+00:00', seen), true, 'a microsecond later');
  assert.equal(isAfter(seen, seen), false, 'the one seen');
  assert.equal(isAfter('2026-10-10T04:30:00.123+00:00', seen), false, 'the same millisecond, earlier');
  assert.equal(isAfter('2026-10-10T12:30:00.1235+08:00', seen), true, 'written in Kajang time');
  // The demo writes Date's own form.
  assert.equal(isAfter('2026-10-10T04:30:01.000Z', seen), true);
  assert.equal(isAfter('2026-10-10T04:30:00Z', seen), false);
  assert.equal(micros('2026-10-10T04:30:00Z'), Date.parse('2026-10-10T04:30:00Z') * 1000);
  assert.equal(micros('2026-10-10T04:30:00.5+00:00'), Date.parse('2026-10-10T04:30:00.500Z') * 1000);
});

test('Got it keeps the newest change the server sent, and never goes back', () => {
  const older = '2026-10-10T01:00:00.000001+00:00';
  const newer = '2026-10-10T04:30:00.123456+00:00';
  assert.equal(nextSeen(null, { latest: newer }), newer, 'first look');
  assert.equal(nextSeen(older, { latest: newer }), newer);
  assert.equal(nextSeen(newer, { latest: older }), newer, 'an old answer');
  assert.equal(nextSeen(older, { latest: null }), older, 'nothing new');
  assert.equal(nextSeen(null, null), null, 'no answer yet');
});

test('cards count as new after where the server started counting', () => {
  const since = '2026-10-09T06:00:00.5+00:00';
  const seen = '2026-10-02T06:00:00+00:00';
  // Never looked, or a week away: the server's bound, so cards agree with the badge.
  assert.equal(seenMark(null, { since }), since);
  assert.equal(seenMark(seen, { since }), since);
  assert.equal(seenMark(seen, null), seen, 'before the first answer');
  assert.equal(seenMark(null, null), null);

  const card = (customer_change: ShopChange['change'] | null, at: string | null, status = 'confirmed') => ({
    customer_change,
    customer_changed_at: at,
    status,
  });
  const after = '2026-10-10T04:30:00+00:00';
  assert.deepEqual(changeTag(card('booked', after), since), { kind: 'new', label: 'New' });
  assert.deepEqual(changeTag(card('moved', after), since), { kind: 'moved', label: 'Moved' });
  assert.equal(changeTag(card('booked', since), since), null, 'the change seen last');
  assert.equal(changeTag(card('booked', '2026-10-09T05:00:00+00:00'), since), null, 'before');
  assert.equal(changeTag(card('booked', after, 'cancelled'), since), null, 'cancelled since');
  assert.equal(changeTag(card('cancelled', after, 'cancelled'), since), null);
  assert.equal(changeTag(card(null, null), since), null, 'added by the shop');
  assert.equal(changeTag(card('booked', after), null), null, 'nothing to count from yet');
  inMalay(() => assert.equal(changeTag(card('booked', after), since)?.label, 'Baharu'));
});

test('how long ago, rounded down', () => {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(ago(at(0.5), now), 'Just now');
  assert.equal(ago(new Date(now + 30_000).toISOString(), now), 'Just now', 'a server clock a little ahead');
  assert.equal(ago(at(1), now), '1 min ago');
  assert.equal(ago(at(59), now), '59 min ago');
  assert.equal(ago(at(60), now), '1 hr ago');
  assert.equal(ago(at(24 * 60 - 1), now), '23 hr ago');
  assert.equal(ago(at(24 * 60), now), '1 day ago');
  assert.equal(ago(at(6 * 24 * 60 + 600), now), '6 days ago');
  inMalay(() => assert.equal(ago(at(150), now), '2 jam lalu'));
});

test('the card says how many more it has no room for', () => {
  assert.equal(moreText(8, 5), 'And 3 more');
  assert.equal(moreText(5, 5), null);
  assert.equal(moreText(0, 0), null);
  inMalay(() => assert.equal(moreText(6, 5), 'Dan 1 lagi'));
});
