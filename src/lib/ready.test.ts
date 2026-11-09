/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setCurrentLang } from './lang.ts';
import {
  barberWithoutHours,
  goLiveGap,
  nextStep,
  paidUp,
  parseMemory,
  progressText,
  readyCardShows,
  readyKey,
  readyProgress,
  readySteps,
  takesBookings,
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
// A fixed moment, so nothing here depends on the time of day the tests run.
const now = Date.parse('2026-10-16T04:00:00Z');
const newShop = {
  latitude: null,
  is_published: false,
  published_at: null,
  subscription_status: 'trialing' as const,
  // A month's free trial from when it was made.
  trial_ends_at: '2026-11-15T04:00:00Z',
};

const doneIds = (steps: ReturnType<typeof readySteps>) => steps.filter((s) => s.done).map((s) => s.id);

test('a shop just made has every step still to do, in order', () => {
  const steps = readySteps(newShop, firstChair, {}, now);
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
  assert.deepEqual(doneIds(readySteps(newShop, services, {}, now)), ['services']);
  assert.equal(nextStep(readySteps(newShop, services, {}, now)), 'barbers');
  // A barber counts once they work a day a week; a chair with no hours doesn't.
  const steps = readySteps({ ...newShop, latitude: 2.98 }, bookable, {}, now);
  assert.deepEqual(doneIds(steps), ['services', 'barbers', 'location']);
  assert.deepEqual(readyProgress(steps), { done: 2, total: 4, ready: false });
  // Skipping the location doesn't hold anything up.
  assert.equal(nextStep(readySteps(newShop, bookable, {}, now)), 'live');
  const live = readySteps({ ...newShop, is_published: true }, bookable, {}, now);
  assert.equal(nextStep(live), 'share');
  assert.deepEqual(readyProgress(live), { done: 3, total: 4, ready: false });
  const shared = readySteps({ ...newShop, is_published: true }, bookable, { shared: true }, now);
  assert.deepEqual(readyProgress(shared), { done: 4, total: 4, ready: true });
  assert.equal(nextStep(shared), null);
  // Paused again: not ready, as customers can't book.
  assert.equal(readyProgress(readySteps(newShop, bookable, { shared: true }, now)).ready, false);
});

test('going live only counts while customers can book: paid, or still in the free month', () => {
  const live = { ...newShop, is_published: true };
  assert.equal(takesBookings(live, now), true);
  assert.equal(takesBookings(newShop, now), false);
  // Live on day one, the free month over with nothing paid: hidden from customers, so not ready.
  const unpaid = { ...live, trial_ends_at: '2026-10-15T04:00:00Z' };
  assert.equal(takesBookings(unpaid, now), false);
  const steps = readySteps(unpaid, bookable, { shared: true }, now);
  assert.deepEqual(doneIds(steps), ['services', 'barbers', 'share']);
  assert.deepEqual(readyProgress(steps), { done: 3, total: 4, ready: false });
  assert.equal(nextStep(steps), 'live');
  // Ends to the second.
  assert.equal(takesBookings({ ...live, trial_ends_at: new Date(now).toISOString() }, now), false);
  assert.equal(takesBookings({ ...live, trial_ends_at: new Date(now + 1000).toISOString() }, now), true);
  // Subscribed: the trial's end no longer matters. Behind on paying, or cancelled: hidden.
  const subscribed = { ...unpaid, subscription_status: 'active' as const };
  assert.equal(takesBookings(subscribed, now), true);
  assert.equal(readyProgress(readySteps(subscribed, bookable, { shared: true }, now)).ready, true);
  assert.equal(takesBookings({ ...live, subscription_status: 'past_due' }, now), false);
  assert.equal(takesBookings({ ...live, subscription_status: 'cancelled' }, now), false);
  assert.equal(takesBookings({ ...newShop, subscription_status: 'active' }, now), false);
  // Paying is apart from being live: a new shop in its free month is paid up.
  assert.equal(paidUp(newShop, now), true);
  assert.equal(paidUp(unpaid, now), false);
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
