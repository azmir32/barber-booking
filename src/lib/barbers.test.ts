/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { barberAbout, barberAverage, barberChipLabel, barberLabel, ownerStarsText, reviewFilters } from './barbers.ts';
import { setCurrentLang } from './lang.ts';

const ali = { name: 'Ali', about: 'Skin fades and beard trims', rating_count: 12, rating_sum: 58 };

test('a line about a barber is one line of plain text, up to 60 characters', () => {
  assert.equal(barberAbout('  Fades and   skin fades,\n8 years '), 'Fades and skin fades, 8 years');
  assert.equal(barberAbout('Kids’ cuts\tand first-timers'), 'Kids’ cuts and first-timers');
  assert.equal(barberAbout('   \n '), null);
  assert.equal(barberAbout(''), null);
  // Cut to 60, without a space left at the end.
  assert.equal(barberAbout('x'.repeat(70)), 'x'.repeat(60));
  assert.equal(barberAbout(`${'x'.repeat(59)} more`), 'x'.repeat(59));
  // Emoji count as one character each, as Postgres counts them.
  assert.equal([...barberAbout('✂️'.repeat(40))!].length, 60);
});

test('a barber’s stars, said for customers and for the owner', () => {
  assert.equal(barberAverage(ali), 4.8);
  assert.equal(barberAverage({ rating_count: 0, rating_sum: 0 }), null);
  setCurrentLang('en');
  assert.equal(barberLabel(ali), 'Ali. Skin fades and beard trims. Rated 4.8 out of 5 from 12 reviews');
  // A line ending in a full stop doesn't get two; one or two reviews show no stars.
  assert.equal(
    barberLabel({ ...ali, about: 'Kids’ cuts, patient with first-timers.', rating_count: 2, rating_sum: 10 }),
    'Ali. Kids’ cuts, patient with first-timers',
  );
  assert.equal(barberLabel({ ...ali, about: null, rating_count: 0, rating_sum: 0 }), 'Ali');
  assert.equal(barberLabel({ ...ali, about: null, rating_count: 3, rating_sum: 15 }), 'Ali. Rated 5.0 out of 5 from 3 reviews');

  // The owner sees every barber's, however few.
  assert.equal(ownerStarsText(ali), '4.8 ★ (12)');
  assert.equal(ownerStarsText({ rating_count: 1, rating_sum: 4 }), '4.0 ★ (1)');
  assert.equal(ownerStarsText({ rating_count: 1200, rating_sum: 5400 }), '4.5 ★ (1,200)');
  assert.equal(ownerStarsText({ rating_count: 0, rating_sum: 0 }), null);
  assert.equal(barberChipLabel(ali, true), 'Ali, rated 4.8 out of 5 from 12 reviews');
  assert.equal(barberChipLabel({ ...ali, rating_count: 1, rating_sum: 4 }, true), 'Ali, rated 4.0 out of 5 from 1 review');
  assert.equal(barberChipLabel(ali, false), 'Ali');
  setCurrentLang('ms');
  try {
    assert.equal(barberLabel(ali), 'Ali. Skin fades and beard trims. Penilaian 4.8 daripada 5, dari 12 ulasan');
    assert.equal(barberChipLabel(ali, true), 'Ali, penilaian 4.8 daripada 5, dari 12 ulasan');
  } finally {
    setCurrentLang('en');
  }
});

test('reviews can be narrowed to a barber once two or more have some', () => {
  const team = [
    { id: 'a', rating_count: 5, rating_sum: 24 },
    { id: 'b', rating_count: 0, rating_sum: 0 },
    { id: 'c', rating_count: 1, rating_sum: 5 },
  ];
  assert.deepEqual(
    reviewFilters(team).map((b) => b.id),
    ['a', 'c'],
  );
  // One barber with reviews is the same as everyone.
  assert.deepEqual(reviewFilters(team.slice(0, 2)), []);
  assert.deepEqual(reviewFilters([]), []);
});
