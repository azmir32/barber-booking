/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CACHE_MAX_AGE_MS,
  CACHE_MAX_ENTRIES,
  CACHE_VERSION,
  cacheKey,
  createCache,
  GUEST,
  type KeyValueStore,
} from './cache.ts';

/** AsyncStorage as a Map, with a clock the test moves. */
function phone() {
  const saved = new Map<string, string>();
  const store: KeyValueStore = {
    setItem: async (k, v) => void saved.set(k, v),
    getAllKeys: async () => [...saved.keys()],
    multiGet: async (keys) => keys.map((k) => [k, saved.get(k) ?? null] as const),
    multiRemove: async (keys) => keys.forEach((k) => saved.delete(k)),
  };
  let now = Date.parse('2026-10-11T09:00:00+08:00');
  const clock = { now: () => now, wait: (ms: number) => (now += ms) };
  return { saved, store, clock, cache: () => createCache(store, clock.now) };
}

const HAKIM = 'u-hakim';
const ALI = 'u-ali';

test('an answer comes back at once in the same visit, and from the phone when the app opens again', async () => {
  const { store, clock, cache } = phone();
  const first = cache();
  first.setUser(HAKIM);
  const key = cacheKey(HAKIM, 'my-bookings');
  assert.equal(first.peek(key), null);
  await first.write(key, [{ id: 'b1' }]);
  assert.deepEqual(first.peek(key), { data: [{ id: 'b1' }], at: clock.now() });

  // The app opened again: nothing in memory until the account's answers are read from the phone.
  clock.wait(60_000);
  const reopened = createCache(store, clock.now);
  assert.equal(reopened.peek(key), null);
  await reopened.load(HAKIM);
  assert.deepEqual(reopened.peek(key), { data: [{ id: 'b1' }], at: clock.now() - 60_000 });
});

test('an answer more than a day old is never shown, and goes from the phone', async () => {
  const { saved, store, clock, cache } = phone();
  const c = cache();
  c.setUser(HAKIM);
  const key = cacheKey(HAKIM, 'my-bookings');
  await c.write(key, ['old']);
  clock.wait(CACHE_MAX_AGE_MS - 1000);
  assert.deepEqual(c.peek(key)?.data, ['old']);
  clock.wait(1000);
  assert.equal(c.peek(key), null);

  const reopened = createCache(store, clock.now);
  await reopened.load(HAKIM);
  assert.equal(reopened.peek(key), null);
  assert.equal(saved.has(key), false);
});

test('each account only ever gets its own answers', async () => {
  const { saved, store, clock, cache } = phone();
  const c = cache();
  c.setUser(HAKIM);
  await c.write(cacheKey(HAKIM, 'my-bookings'), ['hakim’s']);
  // Keys differ by account, so Ali's screen can't find Hakim's bookings.
  assert.notEqual(cacheKey(HAKIM, 'my-bookings'), cacheKey(ALI, 'my-bookings'));
  assert.equal(c.peek(cacheKey(ALI, 'my-bookings')), null);

  // Hakim's slow answer landing after Ali signed in is not kept for anyone.
  c.setUser(ALI);
  await c.write(cacheKey(HAKIM, 'my-shops'), ['late']);
  assert.equal(c.peek(cacheKey(HAKIM, 'my-shops')), null);
  assert.equal(saved.has(cacheKey(HAKIM, 'my-shops')), false);
  await c.write(cacheKey(ALI, 'day', 'shop1', '2026-10-11'), ['ali’s']);

  // Opening the app as Ali reads only Ali's answers into memory.
  const reopened = createCache(store, clock.now);
  await reopened.load(ALI);
  assert.deepEqual(reopened.peek(cacheKey(ALI, 'day', 'shop1', '2026-10-11'))?.data, ['ali’s']);
  assert.equal(reopened.peek(cacheKey(HAKIM, 'my-bookings')), null);

  // Signed out, only the public list is kept, under no account.
  c.setUser(null);
  await c.write(cacheKey(GUEST, 'find', '', ''), ['shops']);
  assert.deepEqual(c.peek(cacheKey(GUEST, 'find', '', ''))?.data, ['shops']);
});

test('after an update that changes what is kept, last version’s answers are ignored', async () => {
  const { saved, store, clock } = phone();
  const key = cacheKey(HAKIM, 'my-bookings');
  saved.set(key, JSON.stringify({ v: CACHE_VERSION - 1, at: clock.now(), data: { old: 'shape' } }));
  saved.set(cacheKey(HAKIM, 'broken'), '{not json');
  const c = createCache(store, clock.now);
  await c.load(HAKIM);
  assert.equal(c.peek(key), null);
  assert.deepEqual([...saved.keys()], []);
});

test('searches last the visit but are not written to the phone', async () => {
  const { saved, cache } = phone();
  const c = cache();
  c.setUser(HAKIM);
  const key = cacheKey(HAKIM, 'find', 'fade', '');
  await c.write(key, ['The Fade Room'], false);
  assert.deepEqual(c.peek(key)?.data, ['The Fade Room']);
  assert.equal(saved.has(key), false);
});

test('only the newest answers are kept on the phone', async () => {
  const { saved, store, clock, cache } = phone();
  const c = cache();
  c.setUser(ALI);
  const day = (i: number) => cacheKey(ALI, 'day', 'shop1', String(i));
  for (let i = 0; i < CACHE_MAX_ENTRIES + 5; i++) {
    await c.write(day(i), [i]);
    clock.wait(1000);
  }
  const reopened = createCache(store, clock.now);
  await reopened.load(ALI);
  assert.equal(saved.size, CACHE_MAX_ENTRIES);
  assert.equal(reopened.peek(day(0)), null);
  assert.deepEqual(reopened.peek(day(CACHE_MAX_ENTRIES + 4))?.data, [CACHE_MAX_ENTRIES + 4]);
});

test('signing out forgets everything, in memory and on the phone', async () => {
  const { saved, store, clock, cache } = phone();
  const c = cache();
  c.setUser(HAKIM);
  await c.write(cacheKey(HAKIM, 'my-bookings'), ['b1']);
  await c.write(cacheKey(HAKIM, 'find', '', ''), ['shops']);
  saved.set('potongku.language', 'ms');
  await c.clear();
  assert.equal(c.peek(cacheKey(HAKIM, 'my-bookings')), null);
  // Other settings on the phone stay.
  assert.deepEqual([...saved.keys()], ['potongku.language']);
  // And nothing more is kept for the account that signed out.
  await c.write(cacheKey(HAKIM, 'my-bookings'), ['late']);
  assert.equal(c.peek(cacheKey(HAKIM, 'my-bookings')), null);
  const reopened = createCache(store, clock.now);
  await reopened.load(HAKIM);
  assert.equal(reopened.peek(cacheKey(HAKIM, 'my-bookings')), null);
});

test('a phone whose storage fails still works, just without last time’s answers', async () => {
  const failing: KeyValueStore = {
    setItem: () => Promise.reject(new Error('full')),
    getAllKeys: () => Promise.reject(new Error('blocked')),
    multiGet: () => Promise.reject(new Error('blocked')),
    multiRemove: () => Promise.reject(new Error('blocked')),
  };
  const c = createCache(failing);
  c.setUser(HAKIM);
  await c.load(HAKIM);
  await c.write(cacheKey(HAKIM, 'my-bookings'), ['b1']);
  assert.deepEqual(c.peek(cacheKey(HAKIM, 'my-bookings'))?.data, ['b1']);
  await c.clear();
  assert.equal(c.peek(cacheKey(HAKIM, 'my-bookings')), null);
});
