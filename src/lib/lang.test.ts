/// <reference types="node" />
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { formatClock, openStatus, summarizeWeek } from './hours.ts';
import { setCurrentLang, t } from './lang.ts';
import { ms } from './strings-ms.ts';
import { formatDay, formatDuration, formatTime, groupByPartOfDay, upcomingDays } from './time.ts';
import { WEEKDAYS } from './types.ts';

const SRC = path.resolve(import.meta.dirname, '..');

/** Every string literal passed straight to t(...) in src. */
function literalKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        const code = fs.readFileSync(file, 'utf8');
        for (const m of code.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
          keys.add(m[2].replace(/\\(.)/g, '$1'));
        }
      }
    }
  };
  walk(SRC);
  return keys;
}

// Text that reaches t() through a variable: weekday names, parts of the day,
// quick-add services and the database's error messages.
const DYNAMIC_KEYS = [
  ...WEEKDAYS,
  'Morning',
  'Midday',
  'Afternoon',
  'Evening',
  'Haircut',
  'Fade',
  'Beard trim',
  'Kids cut',
  'Add the customer\'s name.',
  'Barber not found.',
  'Booking not found.',
  'Closing time must be after opening time.',
  'Not signed in.',
  'Pick a service, or a length between 5 minutes and 12 hours (a whole day for blocks).',
  'Please keep your note under 280 characters.',
  'Please sign in to book.',
  'Service not found.',
  'Some of those hours overlap on the same day.',
  'Sorry, that time was just taken. Please pick another.',
  'That barber already has a booking at that time.',
  'That time has been booked by someone else since.',
  'This service is no longer available.',
  'You can mark this once the appointment has started.',
  'You can only cancel an upcoming booking.',
  'Set up your shop first.',
  'Pick between 1 and 31 days.',
  'Pick days from today up to 60 days ahead.',
  'There are bookings on those days. Cancel them first (and let the customers know), then close the shop.',
  'You can only change an upcoming booking.',
  'Invalid login credentials',
  'User already registered',
  'Email not confirmed',
  'New password should be different from the old password.',
  'Unable to validate email address: invalid format',
];

test('every piece of UI text has a Malay translation', () => {
  const keys = [...literalKeys(), ...DYNAMIC_KEYS];
  assert.ok(keys.length > 150, `only found ${keys.length} keys; is the scan broken?`);
  const missing = keys.filter((k) => !(k in ms));
  assert.deepEqual(missing, []);
});

test('translations keep the same placeholders', () => {
  for (const [en, my] of Object.entries(ms)) {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(my), names(en), `placeholders differ for "${en}"`);
  }
});

test('t fills placeholders and falls back to English', () => {
  setCurrentLang('en');
  assert.equal(t('{count} barbers', { count: 3 }), '3 barbers');
  setCurrentLang('ms');
  assert.equal(t('{count} barbers', { count: 3 }), '3 barber');
  assert.equal(t('Not a known sentence'), 'Not a known sentence');
  setCurrentLang('en');
});

test('dates, times and hours read naturally in Malay', () => {
  setCurrentLang('ms');
  try {
    const now = new Date('2026-10-05T20:00:00Z'); // Tue 6 Oct in Kajang
    assert.deepEqual(
      upcomingDays(3, 'Asia/Kuala_Lumpur', now).map((d) => `${d.label} ${d.dayOfMonth} ${d.month}`),
      ['Hari ini 6 Okt', 'Esok 7 Okt', 'Kha 8 Okt'],
    );
    assert.equal(formatDay('2026-10-06T02:00:00Z', 'Asia/Kuala_Lumpur'), 'Sel, 6 Okt');
    assert.equal(formatDuration(90), '1 jam 30 min');
    assert.equal(formatClock('20:00'), '8.00 malam');
    assert.equal(formatClock('13:30'), '1.30 tengah hari');
    assert.equal(formatClock('17:00'), '5.00 petang');
    assert.equal(formatTime('2026-10-06T01:15:00Z', 'Asia/Kuala_Lumpur'), '9.15 pagi');
    const week = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '10:00', closes_at: '20:00' }));
    assert.equal(summarizeWeek(week), 'Isn–Sab · 10.00 pagi–8.00 malam');
    const at = (clock: string) => new Date(`2026-10-06T${clock}:00+08:00`);
    assert.equal(openStatus('10:00:00', '20:00:00', at('08:30')).label, 'Buka jam 10.00 pagi');
    assert.equal(openStatus('10:00:00', '20:00:00', at('15:00')).label, 'Buka sekarang · hingga 8.00 malam');
    assert.equal(openStatus(null, null, at('15:00')).label, 'Tutup hari ini');
    const slots = ['2026-10-06T03:00:00Z', '2026-10-06T05:00:00Z', '2026-10-06T07:00:00Z', '2026-10-06T12:00:00Z'];
    assert.deepEqual(
      groupByPartOfDay(slots, 'Asia/Kuala_Lumpur').map(([part, [at]]) => `${t(part)}: ${formatTime(at, 'Asia/Kuala_Lumpur')}`),
      ['Pagi: 11.00 pagi', 'Tengah hari: 1.00 tengah hari', 'Petang: 3.00 petang', 'Malam: 8.00 malam'],
    );
  } finally {
    setCurrentLang('en');
  }
});
