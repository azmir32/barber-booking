/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  barberWithoutHours,
  goLiveGap,
  nextStep,
  parseMemory,
  progressText,
  readyCardShows,
  readyKey,
  readyProgress,
  readySteps,
  type ShopSetup,
} from './ready.ts';

const nothing: ShopSetup = { services: 0, barbers: [] };
const firstChair: ShopSetup = { services: 0, barbers: [{ id: 'b1', name: 'Hafiz', has_hours: false }] };
const bookable: ShopSetup = {
  services: 3,
  barbers: [
    { id: 'b1', name: 'Hafiz', has_hours: false },
    { id: 'b2', name: 'Danial', has_hours: true },
  ],
};
const newShop = { latitude: null, is_published: false, published_at: null };

const doneIds = (steps: ReturnType<typeof readySteps>) => steps.filter((s) => s.done).map((s) => s.id);

test('a shop just made has every step still to do, in order', () => {
  const steps = readySteps(newShop, firstChair, {});
  assert.deepEqual(
    steps.map((s) => s.id),
    ['services', 'barbers', 'location', 'live', 'share'],
  );
  assert.deepEqual(doneIds(steps), []);
  assert.deepEqual(readyProgress(steps), { done: 0, total: 4, ready: false });
  assert.equal(nextStep(steps), 'services');
});

test('each step ticks from what the shop has, and where it is never counts', () => {
  const services = { ...firstChair, services: 1 };
  assert.deepEqual(doneIds(readySteps(newShop, services, {})), ['services']);
  assert.equal(nextStep(readySteps(newShop, services, {})), 'barbers');
  // A barber counts once they work a day a week; a chair with no hours doesn't.
  const steps = readySteps({ ...newShop, latitude: 2.98 }, bookable, {});
  assert.deepEqual(doneIds(steps), ['services', 'barbers', 'location']);
  assert.deepEqual(readyProgress(steps), { done: 2, total: 4, ready: false });
  // Skipping the location doesn't hold anything up.
  assert.equal(nextStep(readySteps(newShop, bookable, {})), 'live');
  const live = readySteps({ ...newShop, is_published: true }, bookable, {});
  assert.equal(nextStep(live), 'share');
  assert.deepEqual(readyProgress(live), { done: 3, total: 4, ready: false });
  const shared = readySteps({ ...newShop, is_published: true }, bookable, { shared: true });
  assert.deepEqual(readyProgress(shared), { done: 4, total: 4, ready: true });
  assert.equal(nextStep(shared), null);
  // Paused again: not ready, as customers can't book.
  assert.equal(readyProgress(readySteps(newShop, bookable, { shared: true })).ready, false);
});

test('the card shows for a shop never live, stays through going live on this phone, and goes once closed', () => {
  assert.equal(readyCardShows({ published_at: null }, {}), true);
  // Set up before the card existed, or live before this phone saw the card: never.
  assert.equal(readyCardShows({ published_at: '2026-09-01T02:00:00Z' }, {}), false);
  assert.equal(readyCardShows({ published_at: '2026-09-01T02:00:00Z' }, { shared: true }), false);
  // Gone live with the card showing here: it stays for the last step.
  assert.equal(readyCardShows({ published_at: '2026-10-16T02:00:00Z' }, { started: true }), true);
  // Hidden early, or said it is ready: gone for good.
  assert.equal(readyCardShows({ published_at: null }, { closed: true }), false);
  assert.equal(readyCardShows({ published_at: '2026-10-16T02:00:00Z' }, { started: true, closed: true }), false);
});

test('the barbers step opens the hours of the first barber without any, until one has them', () => {
  assert.deepEqual(barberWithoutHours(firstChair), { id: 'b1', name: 'Hafiz' });
  assert.equal(barberWithoutHours(nothing), null);
  assert.equal(barberWithoutHours(bookable), null);
});

test('Go live says what is missing, as the database checks it', () => {
  assert.equal(goLiveGap(nothing), 'both');
  assert.equal(goLiveGap(firstChair), 'both');
  assert.equal(goLiveGap({ ...firstChair, services: 2 }), 'hours');
  assert.equal(goLiveGap({ services: 0, barbers: [{ id: 'b2', name: 'Danial', has_hours: true }] }), 'services');
  assert.equal(goLiveGap(bookable), null);
});

test('what the phone remembers is read safely', () => {
  assert.deepEqual(parseMemory(JSON.stringify({ started: true, shared: true })), {
    started: true,
    shared: true,
    closed: false,
  });
  assert.deepEqual(parseMemory(null), {});
  assert.deepEqual(parseMemory('not json'), {});
  assert.deepEqual(parseMemory('"closed"'), {});
  assert.deepEqual(parseMemory(JSON.stringify({ closed: 'yes' })), { started: false, shared: false, closed: false });
  assert.equal(readyKey('s1'), 'potongku.shopReady.s1');
});

test('progress reads in both languages', () => {
  assert.equal(progressText({ done: 2, total: 4 }), '2 of 4 done');
  setCurrentLang('ms');
  try {
    assert.equal(progressText({ done: 2, total: 4 }), '2 daripada 4 selesai');
  } finally {
    setCurrentLang('en');
  }
});
