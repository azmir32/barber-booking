/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  customerCounts,
  daysSince,
  inviteMessage,
  lastCutLabel,
  noShowsLabel,
  timeSpan,
  usualGapLabel,
  visitsLabel,
} from './customers.ts';
import { setCurrentLang } from './lang.ts';

const TZ = 'Asia/Kuala_Lumpur';
// Tue 6 Oct, 9 am in Kajang.
const now = Date.parse('2026-10-06T09:00:00+08:00');

test('days since a cut count calendar days on the shop’s clock', () => {
  assert.equal(daysSince('2026-10-06T08:30:00+08:00', now, TZ), 0);
  // Late last night is yesterday, though it was only ten hours ago.
  assert.equal(daysSince('2026-10-05T23:00:00+08:00', now, TZ), 1);
  // And still yesterday in Kajang when it was the day before in UTC.
  assert.equal(daysSince('2026-10-05T00:30:00+08:00', now, TZ), 1);
  assert.equal(daysSince('2026-08-23T18:00:00+08:00', now, TZ), 44);
});

test('how long ago reads the way people say it', () => {
  const ago = (days: number) => lastCutLabel(new Date(now - days * 86_400_000).toISOString(), now, TZ);
  assert.equal(lastCutLabel(null, now, TZ), 'No visits yet');
  assert.equal(ago(0), 'Last cut today');
  assert.equal(ago(1), 'Last cut yesterday');
  assert.equal(ago(5), 'Last cut 5 days ago');
  assert.equal(ago(7), 'Last cut a week ago');
  assert.equal(ago(13), 'Last cut a week ago');
  assert.equal(ago(14), 'Last cut 2 weeks ago');
  assert.equal(ago(44), 'Last cut 6 weeks ago');
  assert.equal(ago(59), 'Last cut 8 weeks ago');
  assert.equal(ago(60), 'Last cut 2 months ago');
  assert.equal(ago(150), 'Last cut 5 months ago');
  assert.equal(ago(364), 'Last cut 12 months ago');
  assert.equal(ago(365), 'Last cut over a year ago');
  assert.equal(timeSpan(1), '1 day');
});

test('the counts leave out "due" when nobody is', () => {
  assert.equal(customerCounts(14, 4), '14 customers · 4 due for a cut');
  assert.equal(customerCounts(1, 1), '1 customer · 1 due for a cut');
  assert.equal(customerCounts(9, 0), '9 customers');
});

test('visits, no-shows and how often someone comes', () => {
  assert.equal(visitsLabel(1), '1 visit');
  assert.equal(visitsLabel(8), '8 visits');
  assert.equal(noShowsLabel(1), '1 no-show');
  assert.equal(noShowsLabel(3), '3 no-shows');
  assert.equal(usualGapLabel(7), 'Comes about once a week');
  assert.equal(usualGapLabel(10), 'Comes about every 10 days');
  assert.equal(usualGapLabel(14), 'Comes about every 2 weeks');
  assert.equal(usualGapLabel(23), 'Comes about every 3 weeks');
  assert.equal(usualGapLabel(75), 'Comes about every 2 months');
});

test('the invite says how many weeks, and has the booking link when it is a web link', () => {
  const vars = { name: 'Daniel Tan', shop: 'Ali Barber Sungai Chua', link: 'https://potongku.my/shop/ali-barber' };
  const sixWeeks = '2026-08-23T18:00:00+08:00';
  assert.equal(
    inviteMessage(vars, sixWeeks, now, TZ),
    'Hi Daniel Tan, it’s been 6 weeks since your last cut at Ali Barber Sungai Chua. Want to book a time? ' +
      'https://potongku.my/shop/ali-barber',
  );
  assert.equal(
    inviteMessage({ ...vars, link: 'potongku://shop/ali-barber' }, '2026-09-26T10:00:00+08:00', now, TZ),
    'Hi Daniel Tan, it’s been a week since your last cut at Ali Barber Sungai Chua. Want to book a time?',
  );
});

test('in Malay too', () => {
  setCurrentLang('ms');
  try {
    const ago = (days: number) => lastCutLabel(new Date(now - days * 86_400_000).toISOString(), now, TZ);
    assert.equal(ago(1), 'Potong terakhir semalam');
    assert.equal(ago(7), 'Potong terakhir seminggu lalu');
    assert.equal(ago(44), 'Potong terakhir 6 minggu lalu');
    assert.equal(ago(400), 'Potong terakhir lebih setahun lalu');
    assert.equal(lastCutLabel(null, now, TZ), 'Belum pernah datang');
    assert.equal(visitsLabel(8), 'Datang 8 kali');
    assert.equal(usualGapLabel(21), 'Datang lebih kurang setiap 3 minggu');
    assert.equal(
      inviteMessage(
        { name: 'Encik Kamal', shop: 'Ali Barber Sungai Chua', link: 'https://potongku.my/shop/ali-barber' },
        '2026-09-03T16:00:00+08:00',
        now,
        TZ,
      ),
      'Hai Encik Kamal, sudah 4 minggu sejak kali terakhir anda potong rambut di Ali Barber Sungai Chua. ' +
        'Nak tempah masa? https://potongku.my/shop/ali-barber',
    );
  } finally {
    setCurrentLang('en');
  }
});
