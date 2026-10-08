/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createClient } from '@supabase/supabase-js';

import { addDays, dayBounds, localDateString } from '../lib/time.ts';
import { reloadTables, setClock, tables } from './db.ts';
import {
  DEMO_ANON_KEY,
  DEMO_BARBER_EMAIL,
  DEMO_CUSTOMER_EMAIL,
  DEMO_PASSWORD,
  DEMO_RESET_CODE,
  DEMO_URL,
  demoFetch,
  resetDemo,
} from './server.ts';

// The demo backend answers the real Supabase client the way Supabase does.

const TZ = 'Asia/Kuala_Lumpur';
const today = () => localDateString(new Date(), TZ);

function client() {
  return createClient(DEMO_URL, DEMO_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: demoFetch },
  });
}

async function signedIn(email: string, password = DEMO_PASSWORD) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null);
  return c;
}

async function shopBySlug(c: ReturnType<typeof client>, slug: string) {
  const { data, error } = await c.from('shops').select('*').eq('slug', slug).single();
  assert.equal(error, null);
  return data;
}

beforeEach(() => resetDemo());

test('guests browse live shops with their services, barbers and free times', async () => {
  const c = client();
  const { data: shops, error } = await c.rpc('find_shops', { p_search: null, p_area: null, p_limit: 21, p_offset: 0 });
  assert.equal(error, null);
  assert.deepEqual(
    shops!.map((s: { name: string }) => s.name),
    ['Ali Barber Sungai Chua', 'Gunting Pak Mat', 'Kemas Barber Kajang', 'The Fade Room'],
  );
  assert.equal(shops![0].from_price, 12);
  assert.equal(shops![0].barber_count, 2);
  // Search looks in the name, area and address; areas match whatever the case.
  const search = async (args: Record<string, unknown>) =>
    ((await c.rpc('find_shops', args)).data as { slug: string }[]).map((s) => s.slug);
  assert.deepEqual(await search({ p_search: '  FADE ' }), ['the-fade-room']);
  assert.deepEqual(await search({ p_area: 'sungai chua' }), ['ali-barber']);
  assert.deepEqual(await search({ p_search: 'zzz' }), []);
  assert.equal((await search({ p_limit: 2, p_offset: 3 })).length, 1);
  const { data: areas } = await c.rpc('shop_areas');
  assert.equal(areas.length, 4);
  assert.deepEqual(areas[0], { area: 'Kajang town', shops: 1 });

  const shop = await shopBySlug(c, 'ali-barber');
  const { data: services } = await c
    .from('services')
    .select('*')
    .eq('shop_id', shop.id)
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  assert.equal(services![0].name, 'Haircut');
  assert.equal(services![0].price, 20);

  const { data: slots, error: slotError } = await c.rpc('available_slots', {
    p_service_id: services![0].id,
    p_day: addDays(today(), 1),
    p_barber_id: null,
  });
  assert.equal(slotError, null);
  assert.ok(slots.length > 10, 'tomorrow should have free times');
  for (const slot of slots) assert.ok(Date.parse(slot.starts_at) > Date.now());

  // Nobody else's bookings or profiles leak to a guest.
  assert.deepEqual((await c.from('bookings').select('*')).data, []);
  assert.deepEqual((await c.from('profiles').select('*')).data, []);
  const missing = await c.from('shops').select('*').eq('slug', 'nope').maybeSingle();
  assert.equal(missing.data, null);
  assert.equal(missing.error, null);
});

test('a customer books, sees and cancels, and the same time cannot be taken twice', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const mine = await hakim
    .from('bookings')
    .select('*, shops(name, slug, address, phone, time_zone), barbers(name)')
    .order('starts_at', { ascending: false })
    .limit(100);
  assert.equal(mine.error, null);
  assert.ok(mine.data!.length >= 2);
  assert.ok(mine.data!.every((b) => b.customer_id !== null && b.shops && b.barbers));

  const shop = await shopBySlug(hakim, 'the-fade-room');
  const { data: services } = await hakim.from('services').select('*').eq('shop_id', shop.id);
  const fade = services!.find((s) => s.name === 'Skin fade')!;
  // Find a day with a free time (the shop is closed on Sundays).
  let slot: { barber_id: string; starts_at: string } | undefined;
  for (let d = 1; !slot && d < 7; d++) {
    const { data } = await hakim.rpc('available_slots', { p_service_id: fade.id, p_day: addDays(today(), d) });
    slot = data?.[0];
  }
  assert.ok(slot);

  const booked = await hakim.rpc('book_appointment', {
    p_service_id: fade.id,
    p_starts_at: slot.starts_at,
    p_barber_id: null,
    p_note: '  low fade  ',
  });
  assert.equal(booked.error, null);
  assert.equal(booked.data.customer_note, 'low fade');
  assert.equal(booked.data.price, 30);

  const ravi = await signedIn('ravi@demo.potongku.my');
  const again = await ravi.rpc('book_appointment', { p_service_id: fade.id, p_starts_at: slot.starts_at });
  assert.equal(again.error?.message, 'Sorry, that time was just taken. Please pick another.');

  const cancelled = await hakim.rpc('set_booking_status', { p_booking_id: booked.data.id, p_status: 'cancelled' });
  assert.equal(cancelled.data.status, 'cancelled');
  const twice = await hakim.rpc('set_booking_status', { p_booking_id: booked.data.id, p_status: 'cancelled' });
  assert.equal(twice.error?.message, 'You can only cancel an upcoming booking.');
  const notTheirs = await ravi.rpc('set_booking_status', { p_booking_id: booked.data.id, p_status: 'cancelled' });
  assert.equal(notTheirs.error?.message, 'Booking not found.');

  // After a cancel the time is free again.
  const retry = await ravi.rpc('book_appointment', { p_service_id: fade.id, p_starts_at: slot.starts_at });
  assert.equal(retry.error, null);
});

test('customers move their own booking to another free time, and so can the shop', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const shop = await shopBySlug(hakim, 'gunting-pak-mat');
  const { data: services } = await hakim.from('services').select('*').eq('shop_id', shop.id).order('sort_order');
  const cut = services![0]; // 20 minutes
  const { data: barbers } = await hakim.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const [mat, faizal] = barbers!;
  // A day both barbers work: Faizal is off on Fridays.
  let day = addDays(today(), 3);
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 5) day = addDays(day, 1);
  const at = (clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return new Date(dayBounds(day, TZ).start.getTime() + (h * 60 + m) * 60_000).toISOString();
  };
  const freeFor = async (c: ReturnType<typeof client>, ignore: string | null) =>
    ((await c.rpc('available_slots', { p_service_id: cut.id, p_day: day, p_barber_id: mat.id, p_ignore_booking: ignore }))
      .data as { starts_at: string }[]).map((s) => Date.parse(s.starts_at));

  const booked = await hakim.rpc('book_appointment', {
    p_service_id: cut.id,
    p_starts_at: at('10:00'),
    p_barber_id: mat.id,
    p_note: 'Pendek sikit',
  });
  assert.equal(booked.error, null);
  const id = booked.data.id;

  // Its own time is free to Hakim when moving it, but stays taken for everyone else.
  assert.ok(!(await freeFor(hakim, null)).includes(Date.parse(at('10:15'))));
  assert.ok((await freeFor(hakim, id)).includes(Date.parse(at('10:15'))));
  const ravi = await signedIn('ravi@demo.potongku.my');
  assert.ok(!(await freeFor(ravi, id)).includes(Date.parse(at('10:15'))));

  // 15 minutes later overlaps the old time, and keeps the barber, note and price.
  const later = await hakim.rpc('reschedule_booking', { p_booking_id: id, p_starts_at: at('10:15') });
  assert.equal(later.error, null);
  assert.equal(later.data.id, id);
  assert.equal(later.data.barber_id, mat.id);
  assert.equal(Date.parse(later.data.starts_at), Date.parse(at('10:15')));
  assert.equal(Date.parse(later.data.ends_at), Date.parse(at('10:35')));
  assert.equal(later.data.customer_note, 'Pendek sikit');
  assert.equal(later.data.price, 12);
  assert.ok((await freeFor(hakim, null)).includes(Date.parse(at('09:45'))), 'the old time is free again');

  // The shop adds a WhatsApp customer at 11:00 and blocks 12:00 for Pak Mat.
  const owner = await signedIn('mat@demo.potongku.my');
  const guest = await owner.rpc('add_shop_booking', {
    p_barber_id: mat.id,
    p_day: day,
    p_time: '11:00',
    p_service_id: cut.id,
    p_guest_name: 'Pak Long',
  });
  assert.equal(guest.error, null);
  const block = await owner.rpc('add_shop_booking', {
    p_barber_id: mat.id,
    p_day: day,
    p_time: '12:00',
    p_duration_min: 30,
    p_is_block: true,
  });
  assert.equal(block.error, null);
  const move = (c: ReturnType<typeof client>, args: Record<string, unknown>) =>
    c.rpc('reschedule_booking', { p_booking_id: id, ...args });
  for (const clock of ['11:00', '12:00']) {
    const taken = await move(hakim, { p_starts_at: at(clock), p_barber_id: mat.id });
    assert.equal(taken.error?.message, 'Sorry, that time was just taken. Please pick another.');
  }
  // With any barber, a time Pak Mat can't do goes to Faizal.
  const other = await move(hakim, { p_starts_at: at('11:00') });
  assert.equal(other.data.barber_id, faizal.id);

  assert.equal((await move(ravi, { p_starts_at: at('09:00') })).error?.message, 'Booking not found.');
  assert.equal((await move(client(), { p_starts_at: at('09:00') })).error?.code, '42501');

  // The owner can move it, but not blocked time.
  const back = await move(owner, { p_starts_at: at('10:00'), p_barber_id: mat.id });
  assert.equal(back.error, null);
  assert.equal(back.data.barber_id, mat.id);
  const blockMove = await owner.rpc('reschedule_booking', { p_booking_id: block.data.id, p_starts_at: at('15:00') });
  assert.equal(blockMove.error?.message, 'Booking not found.');

  // Once it has started, or once cancelled, Hakim can't move it.
  setClock(() => Date.parse(at('10:05')));
  try {
    const started = await move(hakim, { p_starts_at: at('15:00') });
    assert.equal(started.error?.message, 'You can only change an upcoming booking.');
  } finally {
    setClock(() => Date.now());
  }
  await hakim.rpc('set_booking_status', { p_booking_id: id, p_status: 'cancelled' });
  const cancelled = await move(hakim, { p_starts_at: at('15:00') });
  assert.equal(cancelled.error?.message, 'You can only change an upcoming booking.');
});

test('one customer can hold at most four upcoming bookings at a shop', async () => {
  const jason = await signedIn('jason@demo.potongku.my');
  const shop = await shopBySlug(jason, 'gunting-pak-mat');
  const { data: services } = await jason.from('services').select('*').eq('shop_id', shop.id);
  const { data: slots } = await jason.rpc('available_slots', {
    p_service_id: services![0].id,
    p_day: addDays(today(), 3),
  });
  // An hour apart, so one barber could take them all.
  const times = [...new Set((slots as { starts_at: string }[]).map((s) => s.starts_at))].filter((_, i) => i % 4 === 0);
  for (const at of times.slice(0, 4)) {
    const { error } = await jason.rpc('book_appointment', { p_service_id: services![0].id, p_starts_at: at });
    assert.equal(error, null);
  }
  const fifth = await jason.rpc('book_appointment', { p_service_id: services![0].id, p_starts_at: times[4] });
  assert.equal(fifth.error?.message, 'You already have 4 upcoming bookings here. Cancel one to book another.');
});

test('guests cannot book or change anything', async () => {
  const c = client();
  const shop = await shopBySlug(c, 'ali-barber');
  const book = await c.rpc('book_appointment', { p_service_id: shop.id, p_starts_at: new Date().toISOString() });
  assert.equal(book.error?.code, '42501');
  const update = await c.from('shops').update({ name: 'Hacked' }).eq('id', shop.id);
  assert.equal(update.error?.code, '42501');
  assert.equal((await shopBySlug(c, 'ali-barber')).name, 'Ali Barber Sungai Chua');
});

test('the barber sees the day with customer details and runs the diary', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const { data: shop } = await ali.from('shops').select('*').eq('owner_id', (await ali.auth.getUser()).data.user!.id).maybeSingle();
  assert.equal(shop!.slug, 'ali-barber');

  const start = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const list = await ali
    .from('bookings')
    .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
    .eq('shop_id', shop!.id)
    .gte('starts_at', start)
    .lt('starts_at', end)
    .order('starts_at');
  assert.equal(list.error, null);
  const online = list.data!.filter((b) => b.customer_id);
  assert.ok(online.length > 0);
  assert.ok(online.every((b) => b.customer?.full_name && b.barbers?.name));
  const sorted = [...list.data!].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  assert.deepEqual(list.data, sorted);

  const counts = await Promise.all([
    ali.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', shop!.id).eq('is_active', true),
    ali.from('working_hours').select('id, barbers!inner(shop_id)', { count: 'exact', head: true }).eq('barbers.shop_id', shop!.id),
  ]);
  assert.equal(counts[0].count, 5);
  assert.ok((counts[1].count ?? 0) >= 12);

  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop!.id).order('sort_order');
  const day = addDays(today(), 5);
  const walkIn = await ali.rpc('add_shop_booking', {
    p_barber_id: barbers![0].id,
    p_day: day,
    p_time: '09:00',
    p_duration_min: 30,
    p_guest_name: '  Pak Abu ',
    p_note: 'WhatsApp',
  });
  assert.equal(walkIn.error, null);
  assert.equal(walkIn.data.guest_name, 'Pak Abu');
  assert.equal(walkIn.data.service_name, 'Appointment');

  const wholeDay = await ali.rpc('add_shop_booking', {
    p_barber_id: barbers![0].id,
    p_day: day,
    p_time: '00:00',
    p_duration_min: 1440,
    p_is_block: true,
  });
  assert.equal(wholeDay.error?.message, 'That barber already has a booking at that time.');
  const noName = await ali.rpc('add_shop_booking', { p_barber_id: barbers![0].id, p_day: day, p_time: '12:00', p_duration_min: 30 });
  assert.equal(noName.error?.message, 'Add the customer\'s name.');

  const future = list.data!.find((b) => Date.parse(b.starts_at) > Date.now() && b.status === 'confirmed' && !b.is_block);
  if (future) {
    const early = await ali.rpc('set_booking_status', { p_booking_id: future.id, p_status: 'completed' });
    assert.equal(early.error?.message, 'You can mark this once the appointment has started.');
  }

  // Hours are saved all at once, or not at all.
  const before = (await ali.from('working_hours').select('*').eq('barber_id', barbers![0].id)).data!.length;
  const overlap = await ali.rpc('set_barber_hours', {
    p_barber_id: barbers![0].id,
    p_hours: [
      { weekday: 1, opens_at: '10:00', closes_at: '14:00' },
      { weekday: 1, opens_at: '13:00', closes_at: '18:00' },
    ],
  });
  assert.equal(overlap.error?.message, 'Some of those hours overlap on the same day.');
  const backwards = await ali.rpc('set_barber_hours', {
    p_barber_id: barbers![0].id,
    p_hours: [{ weekday: 2, opens_at: '18:00', closes_at: '10:00' }],
  });
  assert.equal(backwards.error?.message, 'Closing time must be after opening time.');
  assert.equal((await ali.from('working_hours').select('*').eq('barber_id', barbers![0].id)).data!.length, before);

  // Billing fields are off limits, and so is everyone else's shop.
  const billing = await ali.from('shops').update({ subscription_status: 'active' }).eq('id', shop!.id);
  assert.equal(billing.error?.code, '42501');
  const other = await shopBySlug(ali, 'kemas-barber-kajang');
  const theirs = await ali.from('shops').update({ name: 'Mine now' }).eq('id', other.id).select();
  assert.deepEqual(theirs.data, []);
  const taken = await ali.from('shops').update({ slug: 'kemas-barber-kajang' }).eq('id', shop!.id);
  assert.equal(taken.error?.code, '23505');
});

test('a new barber signs up, sets up a shop and goes live', async () => {
  const c = client();
  const signUp = await c.auth.signUp({
    email: 'new@shop.my',
    password: 'password123',
    options: { data: { role: 'barber', full_name: 'Zack', phone: '012-111 2222' } },
  });
  assert.equal(signUp.error, null);
  assert.ok(signUp.data.session);
  const { data: profile } = await c.from('profiles').select('id, role, full_name, phone').eq('id', signUp.data.user!.id).maybeSingle();
  assert.deepEqual(profile, { id: signUp.data.user!.id, role: 'barber', full_name: 'Zack', phone: '012-111 2222' });

  const created = await c
    .from('shops')
    .insert({ name: 'Zack Cuts', slug: 'zack-cuts', area: 'Kajang', owner_id: signUp.data.user!.id })
    .select()
    .single();
  assert.equal(created.error, null);
  assert.equal(created.data.is_published, false);
  assert.equal(created.data.subscription_status, 'trialing');

  const barber = await c.from('barbers').insert({ shop_id: created.data.id, name: 'Zack', sort_order: 0 }).select().single();
  assert.equal(barber.error, null);
  const hours = await c.from('working_hours').insert(
    [1, 2, 3, 4, 5, 6].map((weekday) => ({ barber_id: barber.data.id, weekday, opens_at: '10:00', closes_at: '20:00' })),
  );
  assert.equal(hours.error, null);
  const service = await c.from('services').insert({ shop_id: created.data.id, name: 'Haircut', duration_min: 30, price: 20, sort_order: 0 });
  assert.equal(service.error, null);

  // Not live yet: guests can't see it.
  assert.equal((await client().from('shops').select('*').eq('slug', 'zack-cuts').maybeSingle()).data, null);
  await c.from('shops').update({ is_published: true }).eq('id', created.data.id);
  assert.equal((await client().from('shops').select('*').eq('slug', 'zack-cuts').maybeSingle()).data?.name, 'Zack Cuts');

  const dup = await c.auth.signUp({ email: 'NEW@shop.my', password: 'password123' });
  assert.equal(dup.error?.message, 'User already registered');

  // Customers can't open a shop.
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const sneaky = await hakim
    .from('shops')
    .insert({ name: 'Hakim', slug: 'hakim-cuts', owner_id: (await hakim.auth.getUser()).data.user!.id });
  assert.equal(sneaky.error?.code, '42501');
});

test('password reset by code, wrong passwords and deleting an account', async () => {
  const c = client();
  const wrong = await c.auth.signInWithPassword({ email: DEMO_CUSTOMER_EMAIL, password: 'nope' });
  assert.equal(wrong.error?.message, 'Invalid login credentials');

  assert.equal((await c.auth.resetPasswordForEmail(DEMO_CUSTOMER_EMAIL)).error, null);
  const bad = await c.auth.verifyOtp({ email: DEMO_CUSTOMER_EMAIL, token: '000000', type: 'recovery' });
  assert.ok(bad.error);
  const good = await c.auth.verifyOtp({ email: DEMO_CUSTOMER_EMAIL, token: DEMO_RESET_CODE, type: 'recovery' });
  assert.equal(good.error, null);
  assert.equal((await c.auth.updateUser({ password: 'newpass123' })).error, null);
  await signedIn(DEMO_CUSTOMER_EMAIL, 'newpass123');

  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL, 'newpass123');
  const hakimId = (await hakim.auth.getUser()).data.user!.id;
  const upcoming = tables().bookings.filter((b) => b.customer_id === hakimId && Date.parse(String(b.starts_at)) > Date.now());
  assert.ok(upcoming.length > 0);
  const deleted = await hakim.rpc('delete_my_account');
  assert.equal(deleted.error, null);
  for (const b of upcoming) {
    const row = tables().bookings.find((x) => x.id === b.id)!;
    assert.equal(row.status, 'cancelled');
    assert.equal(row.customer_id, null);
    assert.equal(row.guest_name, 'Deleted account');
  }
  const gone = await c.auth.signInWithPassword({ email: DEMO_CUSTOMER_EMAIL, password: 'newpass123' });
  assert.equal(gone.error?.message, 'Invalid login credentials');

  // An owner takes their shop with them.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  assert.equal((await ali.rpc('delete_my_account')).error, null);
  assert.equal((await client().from('shops').select('*').eq('slug', 'ali-barber').maybeSingle()).data, null);
  assert.equal(tables().barbers.filter((b) => b.name === 'Danial').length, 0);
});

test('opened on a later day, the sample week moves forward with it', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    const before = tables().bookings.map((b) => Date.parse(String(b.starts_at)));
    const trialBefore = Date.parse(String(tables().shops[0].trial_ends_at));

    const later = Date.now() + 3 * 86_400_000;
    setClock(() => later);
    reloadTables();
    const after = tables().bookings.map((b) => Date.parse(String(b.starts_at)));
    assert.deepEqual(after, before.map((t) => t + 3 * 86_400_000));
    assert.equal(Date.parse(String(tables().shops[0].trial_ends_at)), trialBefore + 3 * 86_400_000);

    // Once moved, opening again the same day changes nothing.
    reloadTables();
    assert.deepEqual(tables().bookings.map((b) => Date.parse(String(b.starts_at))), after);
  } finally {
    setClock(() => Date.now());
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

test('ids stay unique and rows that others point at keep theirs', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const kemas = await shopBySlug(ali, 'kemas-barber-kajang');
  const theirChair = tables().barbers.find((b) => b.shop_id === kemas.id)!;
  const mine = await shopBySlug(ali, 'ali-barber');
  const copy = await ali.from('barbers').insert({ id: theirChair.id, shop_id: mine.id, name: 'Copy' });
  assert.equal(copy.error?.code, '23505');
  const myChair = tables().barbers.find((b) => b.shop_id === mine.id)!;
  const moved = await ali.from('barbers').update({ id: '00000000-0000-4000-8000-000000000999' }).eq('id', myChair.id);
  assert.equal(moved.error?.code, '23503');
});
