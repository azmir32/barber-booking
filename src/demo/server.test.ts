/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createClient } from '@supabase/supabase-js';

import { addDays, dayBounds, localDateString } from '../lib/time.ts';
import { insertRow, reloadTables, save, setClock, tables, type Row } from './db.ts';
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
  // Today's hours: Pak Mat's chairs work 8 to 6 every day (the Friday prayers
  // break doesn't count), and The Fade Room is shut on Sundays.
  const hoursOf = (slug: string) => {
    const s = shops!.find((x: { slug: string }) => x.slug === slug);
    return [s.opens_today, s.closes_today];
  };
  assert.deepEqual(hoursOf('gunting-pak-mat'), ['08:00:00', '18:00:00']);
  const sunday = new Date(`${today()}T00:00:00Z`).getUTCDay() === 0;
  assert.deepEqual(hoursOf('the-fade-room'), sunday ? [null, null] : ['12:00:00', '22:00:00']);
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

test('today\'s hours leave out barbers who are away and follow the shop\'s clock', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const listed = async () => {
    const { data } = await client().rpc('find_shops', { p_search: 'Ali Barber' });
    return [data[0].opens_today, data[0].closes_today];
  };
  const everyDay = (opens: string, closes: string) =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: opens, closes_at: closes }));
  await ali.rpc('set_barber_hours', { p_barber_id: barbers![0].id, p_hours: everyDay('09:00', '13:00') });
  await ali.rpc('set_barber_hours', { p_barber_id: barbers![1].id, p_hours: everyDay('11:00', '21:30') });
  assert.deepEqual(await listed(), ['09:00:00', '21:30:00']);
  await ali.from('barbers').update({ is_active: false }).eq('id', barbers![1].id);
  assert.deepEqual(await listed(), ['09:00:00', '13:00:00']);
  // Nor is a barber with the whole day off.
  await ali.from('barbers').update({ is_active: true }).eq('id', barbers![1].id);
  for (const b of tables().bookings) if (b.barber_id === barbers![1].id) b.status = 'cancelled';
  const off = await ali.rpc('add_shop_booking', {
    p_barber_id: barbers![1].id,
    p_day: today(),
    p_time: '00:00',
    p_duration_min: 1440,
    p_is_block: true,
  });
  assert.equal(off.error, null);
  assert.deepEqual(await listed(), ['09:00:00', '13:00:00']);

  // Kiritimati and Pago Pago are 25 hours apart, so never on the same day. The
  // second barber's day off is Kajang's today, which in the evening is already
  // over in Kiritimati, so only the first barber counts from here.
  await ali.from('barbers').update({ is_active: false }).eq('id', barbers![1].id);
  const weekdayIn = (tz: string) => new Date(`${localDateString(new Date(), tz)}T00:00:00Z`).getUTCDay();
  await ali.rpc('set_barber_hours', {
    p_barber_id: barbers![0].id,
    p_hours: [{ weekday: weekdayIn('Pacific/Kiritimati'), opens_at: '09:00', closes_at: '12:00' }],
  });
  const row = tables().shops.find((s) => s.id === shop.id)!;
  row.time_zone = 'Pacific/Kiritimati';
  assert.deepEqual(await listed(), ['09:00:00', '12:00:00']);
  row.time_zone = 'Pacific/Pago_Pago';
  assert.deepEqual(await listed(), [null, null]);
});

test('the shop list shows when a shop is next free, today or else tomorrow', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '10:00', closes_at: '20:00' }));
  for (const b of barbers!) await ali.rpc('set_barber_hours', { p_barber_id: b.id, p_hours: everyDay });
  for (const b of tables().bookings) if (b.shop_id === shop.id) b.status = 'cancelled';
  const day = today();
  const tomorrow = addDays(day, 1);
  const at = (date: string, clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return dayBounds(date, TZ).start.getTime() + (h * 60 + m) * 60_000;
  };
  const nextFree = async () => {
    const { data, error } = await client().rpc('find_shops', { p_search: 'Ali Barber' });
    assert.equal(error, null);
    return data[0].next_free_at == null ? null : Date.parse(data[0].next_free_at);
  };
  try {
    // The shortest service is a 15-minute beard trim, so 3:07 pm is free from 3:15.
    setClock(() => at(day, '15:07'));
    assert.equal(await nextFree(), at(day, '15:15'));
    // At 7:40 pm a beard trim still fits before closing; a haircut doesn't.
    setClock(() => at(day, '19:40'));
    assert.equal(await nextFree(), at(day, '19:45'));
    await ali.from('services').update({ is_active: false }).eq('shop_id', shop.id).eq('name', 'Beard trim');
    assert.equal(await nextFree(), at(tomorrow, '10:00'));

    // A shop closed today is next free tomorrow; closed tomorrow too, it has no free time.
    setClock(() => at(day, '15:07'));
    assert.equal((await ali.rpc('close_shop_days', { p_from: day, p_days: 1 })).error, null);
    assert.equal(await nextFree(), at(tomorrow, '10:00'));
    assert.equal((await ali.rpc('close_shop_days', { p_from: tomorrow, p_days: 1 })).error, null);
    assert.equal(await nextFree(), null);
  } finally {
    setClock(() => Date.now());
  }
});

test('a paused shop\'s link still says whose shop it is', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const guest = client();
  assert.deepEqual((await guest.rpc('shop_public_status', { p_slug: 'ali-barber' })).data, [
    { name: 'Ali Barber Sungai Chua', phone: '012-345 6789', is_live: true },
  ]);

  await ali.from('shops').update({ is_published: false }).eq('id', shop.id);
  assert.equal((await guest.from('shops').select('*').eq('slug', 'ali-barber').maybeSingle()).data, null);
  const paused = await guest.rpc('shop_public_status', { p_slug: 'ali-barber' });
  assert.equal(paused.error, null);
  assert.deepEqual(paused.data, [{ name: 'Ali Barber Sungai Chua', phone: '012-345 6789', is_live: false }]);
  // The owner still sees their own shop.
  assert.equal((await shopBySlug(ali, 'ali-barber')).name, 'Ali Barber Sungai Chua');

  assert.deepEqual((await guest.rpc('shop_public_status', { p_slug: 'nope' })).data, []);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  assert.equal((await hakim.rpc('shop_public_status', { p_slug: 'ali-barber' })).data[0].is_live, false);
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

test('customers move their own booking to another free time, and nobody else can', async () => {
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

  // Only Hakim moves it: not the shop, and never blocked time.
  assert.equal((await move(owner, { p_starts_at: at('10:00') })).error?.message, 'Booking not found.');
  const blockMove = await owner.rpc('reschedule_booking', { p_booking_id: block.data.id, p_starts_at: at('15:00') });
  assert.equal(blockMove.error?.message, 'Booking not found.');
  const back = await move(hakim, { p_starts_at: at('10:00'), p_barber_id: mat.id });
  assert.equal(back.error, null);
  assert.equal(back.data.barber_id, mat.id);

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

test('the shop records who it reminded on WhatsApp, for the time it named, and a move clears it', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const tomorrow = dayBounds(addDays(today(), 1), TZ);
  // What the bookings tab loads for its "Remind tomorrow's customers" card.
  const toRemind = async () => {
    const { data, error } = await ali
      .from('bookings')
      .select('id, barber_id, status, is_block, starts_at, reminded_at, guest_phone, customer:profiles!bookings_customer_id_fkey(phone)')
      .eq('shop_id', shop.id)
      .eq('status', 'confirmed')
      .eq('is_block', false)
      .is('reminded_at', null)
      .gte('starts_at', tomorrow.start.toISOString())
      .lt('starts_at', tomorrow.end.toISOString());
    assert.equal(error, null);
    type Row = { guest_phone: string | null; customer: { phone: string | null } | null };
    return (data as unknown as Row[]).filter((b) => b.customer?.phone ?? b.guest_phone);
  };
  // The sample day always has Hakim and a WhatsApp customer to remind.
  const before = await toRemind();
  assert.ok(before.length >= 2);

  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const hakimId = (await hakim.auth.getUser()).data.user!.id;
  const mine = tables().bookings.find(
    (b) => b.customer_id === hakimId && b.shop_id === shop.id && Date.parse(String(b.starts_at)) > Date.now(),
  )!;
  assert.equal(mine.reminded_at, null);
  const remind = (c: ReturnType<typeof client>, id: unknown, startsAt: unknown = mine.starts_at, reminded?: boolean) =>
    c.rpc('mark_booking_reminded', { p_booking_id: id, p_starts_at: startsAt, ...(reminded === undefined ? {} : { p_reminded: reminded }) });
  const marked = await remind(ali, mine.id);
  assert.equal(marked.error, null);
  assert.ok(Math.abs(Date.parse(marked.data.reminded_at) - Date.now()) < 5000);
  // Every phone in the shop sees it, and it drops off the list still to remind.
  const seen = await ali.from('bookings').select('reminded_at').eq('id', mine.id).single();
  assert.equal(seen.data!.reminded_at, marked.data.reminded_at);
  assert.equal((await toRemind()).length, before.length - 1);

  // A message that never went out can be taken back, and marked again.
  const cleared = await remind(ali, mine.id, mine.starts_at, false);
  assert.equal(cleared.error, null);
  assert.equal(cleared.data.reminded_at, null);
  assert.equal((await toRemind()).length, before.length);
  assert.equal((await remind(ali, mine.id)).error, null);

  // Only the shop's owner: not the customer, another shop's owner or a guest.
  assert.equal((await remind(hakim, mine.id)).error?.message, 'Booking not found.');
  const rahman = await signedIn('rahman@demo.potongku.my');
  assert.equal((await remind(rahman, mine.id, mine.starts_at, false)).error?.message, 'Booking not found.');
  assert.equal((await remind(client(), mine.id)).error?.code, '42501');

  // Not blocked time, a cancelled booking or one that has started.
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const later = addDays(today(), 5);
  const block = await ali.rpc('add_shop_booking', {
    p_barber_id: barbers![0].id,
    p_day: later,
    p_time: '09:00',
    p_duration_min: 30,
    p_is_block: true,
  });
  assert.equal((await remind(ali, block.data.id, block.data.starts_at)).error?.message, 'Booking not found.');
  const walkIn = await ali.rpc('add_shop_booking', {
    p_barber_id: barbers![0].id,
    p_day: later,
    p_time: '10:00',
    p_duration_min: 30,
    p_guest_name: 'Pak Abu',
    p_guest_phone: '019-111 2222',
  });
  await ali.rpc('set_booking_status', { p_booking_id: walkIn.data.id, p_status: 'cancelled' });
  const cancelled = await remind(ali, walkIn.data.id, walkIn.data.starts_at);
  assert.equal(cancelled.error?.code, '42501');
  assert.equal(cancelled.error?.message, 'You can only remind a customer about an upcoming booking.');
  setClock(() => Date.parse(String(mine.starts_at)) + 60_000);
  try {
    assert.equal((await remind(ali, mine.id)).error?.code, '42501');
    assert.equal((await remind(ali, mine.id, mine.starts_at, false)).error?.code, '42501');
  } finally {
    setClock(() => Date.now());
  }

  // The reminder named the old time, so moving the booking clears it.
  const { data: slots } = await hakim.rpc('available_slots', {
    p_service_id: mine.service_id,
    p_day: addDays(today(), 3),
    p_barber_id: null,
    p_ignore_booking: mine.id,
  });
  const moved = await hakim.rpc('reschedule_booking', { p_booking_id: mine.id, p_starts_at: slots[0].starts_at });
  assert.equal(moved.error, null);
  assert.equal(moved.data.reminded_at, null);

  // A phone still showing the old time sends a reminder for it: that one doesn't
  // count, so the new time still gets its own.
  const stale = await remind(ali, mine.id, mine.starts_at);
  assert.equal(stale.error?.code, '42501');
  assert.equal(stale.error?.message, 'This booking has changed. Check the new time.');
  assert.equal(tables().bookings.find((b) => b.id === mine.id)!.reminded_at, null);
  assert.equal((await remind(ali, mine.id, null)).error?.message, 'This booking has changed. Check the new time.');
  assert.equal((await remind(ali, mine.id, 'soon')).error?.code, '22P02');
  const fresh = await remind(ali, mine.id, moved.data.starts_at);
  assert.equal(fresh.error, null);
  assert.ok(fresh.data.reminded_at);
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
    tables().shop_closures.push({ shop_id: tables().shops[0].id, day: addDays(today(), 5), reason: null });
    save();
    const before = tables().bookings.map((b) => Date.parse(String(b.starts_at)));
    const trialBefore = Date.parse(String(tables().shops[0].trial_ends_at));
    const closedBefore = String(tables().shop_closures[0].day);

    const later = Date.now() + 3 * 86_400_000;
    setClock(() => later);
    reloadTables();
    const after = tables().bookings.map((b) => Date.parse(String(b.starts_at)));
    assert.deepEqual(after, before.map((t) => t + 3 * 86_400_000));
    assert.equal(Date.parse(String(tables().shops[0].trial_ends_at)), trialBefore + 3 * 86_400_000);
    assert.equal(tables().shop_closures[0].day, addDays(closedBefore, 3));

    // Once moved, opening again the same day changes nothing.
    reloadTables();
    assert.deepEqual(tables().bookings.map((b) => Date.parse(String(b.starts_at))), after);

    // A demo saved before shops could close for the day still opens.
    const [key, json] = [...saved.entries()][0];
    const old = JSON.parse(json);
    delete old.tables.shop_closures;
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.deepEqual(tables().shop_closures, []);
    assert.equal(tables().bookings.length, after.length);

    // And one saved before bookings had reminders opens with none sent.
    for (const b of old.tables.bookings) delete b.reminded_at;
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.ok(tables().bookings.every((b) => b.reminded_at === null));
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

test('a barber closes the shop for Hari Raya, customers see it, and it reopens', async () => {
  const barber = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(barber, 'ali-barber');
  const { data: barbers } = await barber.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const from = addDays(today(), 40);
  const closed = async (c: ReturnType<typeof client>, to = addDays(from, 5)) =>
    (await c.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: from, p_to: to })).data as {
      day: string;
      reason: string | null;
      is_closure: boolean;
    }[];

  // One barber's own day off doesn't close the shop, and closing leaves it alone.
  const off = await barber.rpc('add_shop_booking', {
    p_barber_id: barbers![1].id,
    p_day: addDays(from, 1),
    p_time: '00:00',
    p_duration_min: 1440,
    p_note: 'Day off',
    p_is_block: true,
  });
  assert.equal(off.error, null);
  assert.deepEqual(await closed(barber), []);

  const close = await barber.rpc('close_shop_days', { p_from: from, p_days: 3, p_reason: '  Hari Raya ' });
  assert.equal(close.error, null);
  assert.equal(close.data, 3);
  const days = [0, 1, 2].map((i) => addDays(from, i));
  assert.deepEqual(await closed(barber), days.map((day) => ({ day, reason: 'Hari Raya', is_closure: true })));
  assert.equal(tables().bookings.find((b) => b.id === off.data.id)!.status, 'confirmed');
  // Closing again changes the reason, not the days.
  await barber.rpc('close_shop_days', { p_from: from, p_days: 3, p_reason: 'Hari Raya Aidilfitri' });
  assert.deepEqual((await closed(barber)).map((d) => d.reason), ['Hari Raya Aidilfitri', 'Hari Raya Aidilfitri', 'Hari Raya Aidilfitri']);

  // Guests see the days, not the reason, and no free times on them.
  const guest = client();
  assert.deepEqual(await closed(guest), days.map((day) => ({ day, reason: null, is_closure: true })));
  const { data: service } = await guest.from('services').select('id').eq('shop_id', shop.id).limit(1).single();
  const slots = await guest.rpc('available_slots', { p_service_id: service!.id, p_day: addDays(from, 1) });
  assert.deepEqual(slots.data, []);
  const denied = await guest.rpc('close_shop_days', { p_from: from, p_days: 1 });
  assert.equal(denied.error?.code, '42501');
  // Closures are only read and written through the functions.
  assert.deepEqual((await barber.from('shop_closures').select('*')).data, []);
  const direct = await barber.from('shop_closures').insert({ shop_id: shop.id, day: addDays(from, 10) });
  assert.equal(direct.error?.code, '42501');

  // A barber who joins later is closed on those days too.
  const hakim = await barber.from('barbers').insert({ shop_id: shop.id, name: 'Hakim' }).select().single();
  assert.equal(hakim.error, null);
  const weekday = new Date(`${addDays(from, 1)}T00:00:00Z`).getUTCDay();
  await barber.rpc('set_barber_hours', {
    p_barber_id: hakim.data.id,
    p_hours: [{ weekday, opens_at: '14:00', closes_at: '18:00' }],
  });
  const newChair = await guest.rpc('available_slots', { p_service_id: service!.id, p_day: addDays(from, 1), p_barber_id: hakim.data.id });
  assert.deepEqual(newChair.data, []);

  // A customer's booking stops the shop closing over it.
  const customer = await signedIn(DEMO_CUSTOMER_EMAIL);
  const next = await customer.rpc('available_slots', { p_service_id: service!.id, p_day: addDays(from, 4) });
  const booked = await customer.rpc('book_appointment', { p_service_id: service!.id, p_starts_at: next.data[0].starts_at });
  assert.equal(booked.error, null);
  const refused = await barber.rpc('close_shop_days', { p_from: addDays(from, 3), p_days: 2, p_reason: 'Kenduri' });
  assert.equal(refused.error?.code, 'P0001');
  assert.match(refused.error!.message, /^There are bookings on those days/);
  assert.equal(tables().shop_closures.filter((c) => c.reason === 'Kenduri').length, 0);
  const notMine = await customer.rpc('close_shop_days', { p_from: from, p_days: 1 });
  assert.equal(notMine.error?.message, 'Set up your shop first.');
  const tooMany = await barber.rpc('close_shop_days', { p_from: from, p_days: 32 });
  assert.equal(tooMany.error?.code, '22023');
  const noStart = await barber.rpc('close_shop_days', { p_from: null, p_days: 3 });
  assert.equal(noStart.error?.message, 'Pick days from today up to 60 days ahead.');

  const reopen = await barber.rpc('reopen_shop_days', { p_from: from, p_days: 3 });
  assert.equal(reopen.error, null);
  assert.equal(reopen.data, 3);
  assert.deepEqual(await closed(guest), []);
  assert.equal(tables().bookings.find((b) => b.id === off.data.id)!.status, 'confirmed');
  assert.notDeepEqual((await guest.rpc('available_slots', { p_service_id: service!.id, p_day: from })).data, []);
});

test('a day every barber is off reads as closed, and closing today works once customers are done', async () => {
  const barber = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(barber, 'ali-barber');
  const { data: barbers } = await barber.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const day = addDays(today(), 41);
  for (const b of barbers!) {
    const off = await barber.rpc('add_shop_booking', {
      p_barber_id: b.id,
      p_day: day,
      p_time: '00:00',
      p_duration_min: 1440,
      p_note: 'Kursus',
      p_is_block: true,
    });
    assert.equal(off.error, null);
  }
  const allOff = await barber.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: day, p_to: day });
  assert.deepEqual(allOff.data, [{ day, reason: 'Kursus', is_closure: false }]);
  assert.equal((await barber.rpc('reopen_shop_days', { p_from: day, p_days: 1 })).data, 0);

  // Today: a customer already seen doesn't stop the shop closing for the rest of the day.
  const hours = async () => (await client().rpc('shop_hours_today', { p_shop_id: shop.id })).data[0];
  const listed = async () => {
    const { data } = await client().rpc('find_shops', { p_search: 'Ali Barber' });
    return [data[0].opens_today, data[0].closes_today];
  };
  for (const b of tables().bookings) {
    if (b.shop_id === shop.id && Date.parse(String(b.ends_at)) > Date.now() && !b.is_block) b.status = 'cancelled';
  }
  tables().bookings.push({
    ...tables().bookings.find((b) => b.shop_id === shop.id && !b.is_block)!,
    id: '00000000-0000-4000-8000-0000000000aa',
    status: 'completed',
    starts_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ends_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const weekday = new Date(`${today()}T00:00:00Z`).getUTCDay();
  const works = tables().working_hours.some((wh) => wh.weekday === weekday && barbers!.some((b) => b.id === wh.barber_id));
  assert.deepEqual(await listed(), [(await hours()).opens_today, (await hours()).closes_today]);
  assert.equal((await hours()).opens_today != null, works);

  const close = await barber.rpc('close_shop_days', { p_from: today(), p_days: 1 });
  assert.equal(close.error, null);
  assert.deepEqual((await barber.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: today(), p_to: today() })).data, [
    { day: today(), reason: null, is_closure: true },
  ]);
  assert.deepEqual(await hours(), { opens_today: null, closes_today: null });
  assert.deepEqual(await listed(), [null, null]);
});

type Customer = {
  customer_key: string;
  customer_id: string | null;
  name: string;
  phone: string | null;
  visits: number;
  no_shows: number;
  last_visit_at: string | null;
  next_booking_at: string | null;
  usual_gap_days: number;
  is_due: boolean;
  total_count: number;
  due_count: number;
};

async function customers(c: ReturnType<typeof client>, search: string | null = null, limit: number | null = 30, offset: number | null = 0) {
  const { data, error } = await c.rpc('shop_customers', { p_search: search, p_limit: limit, p_offset: offset });
  assert.equal(error, null);
  return data as Customer[];
}

/** An instant at a Kajang clock time, days from today. */
const kajang = (days: number, clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return new Date(dayBounds(addDays(today(), days), TZ).start.getTime() + (h * 60 + m) * 60_000).toISOString();
};

test('the customer list works out visits, usual gaps and who is due, as the database does', async () => {
  // The same diary as supabase/tests/booking_test.sql, in Ali's shop.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const chair = tables().barbers.find((b) => b.shop_id === shop.id)!;
  const profile = (email: string) => {
    const user = tables().users.find((u) => u.email === email)!;
    return tables().profiles.find((p) => p.id === user.id)!;
  };
  const ben = Object.assign(profile(DEMO_CUSTOMER_EMAIL), { full_name: 'Ben', phone: null });
  const chong = Object.assign(profile('ravi@demo.potongku.my'), { full_name: 'Chong', phone: '013-222 3333' });
  tables().bookings.splice(0);
  const diary: [Row | null, string | null, string | null, boolean, number, string, string][] = [
    [ben, null, null, false, -70, '09:00', 'completed'],
    [ben, null, null, false, -49, '09:00', 'completed'],
    [ben, null, null, false, -49, '09:30', 'completed'],
    [ben, null, null, false, -28, '09:00', 'completed'],
    [ben, null, null, false, -14, '09:00', 'no_show'],
    [chong, null, null, false, -40, '10:00', 'cancelled'],
    [chong, null, null, false, -20, '10:00', 'completed'],
    [chong, null, null, false, 3, '10:00', 'confirmed'],
    [null, 'Pak Abu', '019-111 2222', false, -60, '10:30', 'completed'],
    [null, 'Abu', '+60 19-111 2222', false, -30, '10:30', 'completed'],
    [null, 'Kamal', '012-555 0000', false, -50, '11:00', 'completed'],
    [null, 'Kamal', '012-555 0000', false, -25, '11:00', 'completed'],
    [null, 'Kamal', '012-555 0000', false, 5, '11:00', 'confirmed'],
    [null, 'Uncle Lim', null, false, -10, '11:30', 'completed'],
    [null, 'uncle  LIM', null, false, -3, '11:30', 'completed'],
    [null, 'Zaki', '011-1234 5678', false, -40, '12:00', 'completed'],
    [null, 'Old Timer', '017-000 1111', false, -200, '12:30', 'completed'],
    [null, 'Median', '016-000 2222', false, -130, '13:00', 'completed'],
    [null, 'Median', '016-000 2222', false, -120, '13:00', 'completed'],
    [null, 'Median', '016-000 2222', false, -100, '13:00', 'completed'],
    [null, 'Median', '016-000 2222', false, -70, '13:00', 'completed'],
    [null, 'Median', '016-000 2222', false, -45, '13:00', 'completed'],
    [null, 'Kumar', '016-210 3398', false, -2, '13:30', 'confirmed'],
    [null, 'Twice', '018-000 3333', false, -6, '14:00', 'completed'],
    [null, 'Twice', '018-000 3333', false, -5, '14:00', 'completed'],
    [null, 'Flake', '012-444 5555', false, -8, '16:30', 'no_show'],
    [null, 'Ghost', '019-999 0000', false, -10, '14:30', 'cancelled'],
    [null, 'Deleted account', null, false, -15, '15:00', 'completed'],
    [null, null, null, true, -1, '15:30', 'confirmed'],
    [null, 'Ancient', '012-777 8888', false, -800, '16:00', 'completed'],
  ];
  for (const [customer, guestName, guestPhone, isBlock, days, clock, status] of diary) {
    const at = kajang(days, clock);
    insertRow('bookings', {
      shop_id: shop.id,
      barber_id: chair.id,
      customer_id: customer?.id ?? null,
      guest_name: guestName,
      guest_phone: guestPhone,
      is_block: isBlock,
      service_name: 'Haircut',
      price: 25,
      starts_at: at,
      ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
      status,
    });
  }

  // Due first, longest overdue first (Median 22 days, Zaki 12, Ben 7, Abu 0),
  // then everyone else by their last visit, with nothing yet last.
  const all = await customers(ali);
  const names = (rows: Customer[]) => rows.map((r) => r.name);
  assert.deepEqual(names(all), ['Median', 'Zaki', 'Ben', 'Abu', 'Kumar', 'uncle  LIM', 'Twice', 'Chong', 'Kamal', 'Old Timer', 'Flake']);
  assert.ok(all.every((r) => r.total_count === 11 && r.due_count === 4));
  assert.deepEqual(names(all.filter((r) => r.is_due)), ['Median', 'Zaki', 'Ben', 'Abu']);
  const row = (name: string) => all.find((r) => r.name === name)!;
  assert.deepEqual(
    { ...row('Ben'), last_visit_at: Date.parse(row('Ben').last_visit_at!) },
    {
      customer_key: `c:${ben.id}`,
      customer_id: ben.id,
      name: 'Ben',
      phone: null,
      visits: 3,
      no_shows: 1,
      last_visit_at: Date.parse(kajang(-28, '09:00')),
      next_booking_at: null,
      usual_gap_days: 21,
      is_due: true,
      total_count: 11,
      due_count: 4,
    },
  );
  assert.equal(row('Chong').phone, '013-222 3333');
  assert.equal(row('Chong').visits, 1);
  assert.equal(Date.parse(row('Chong').next_booking_at!), Date.parse(kajang(3, '10:00')));
  assert.equal(row('Chong').is_due, false);
  assert.deepEqual(
    [row('Abu').customer_key, row('Abu').phone, row('Abu').visits, row('Abu').usual_gap_days],
    ['p:60191112222', '+60 19-111 2222', 2, 30],
  );
  assert.equal(row('Kamal').is_due, false);
  assert.deepEqual(
    [row('uncle  LIM').customer_key, row('uncle  LIM').phone, row('uncle  LIM').visits, row('uncle  LIM').usual_gap_days],
    ['n:uncle lim', null, 2, 7],
  );
  assert.deepEqual([row('Zaki').usual_gap_days, row('Zaki').is_due], [28, true]);
  assert.deepEqual([row('Old Timer').usual_gap_days, row('Old Timer').is_due], [28, false]);
  assert.equal(row('Median').usual_gap_days, 23);
  assert.equal(row('Kumar').visits, 1);
  assert.equal(Date.parse(row('Kumar').last_visit_at!), Date.parse(kajang(-2, '13:30')));
  assert.deepEqual([row('Twice').usual_gap_days, row('Twice').is_due], [7, false]);
  assert.deepEqual([row('Flake').visits, row('Flake').no_shows, row('Flake').last_visit_at], [0, 1, null]);

  // Search: a name, or a number however it is typed. Not a pattern.
  assert.deepEqual(names(await customers(ali, '  ABU ')), ['Abu']);
  assert.deepEqual(names(await customers(ali, '0191112')), ['Abu']);
  assert.deepEqual(names(await customers(ali, '+60 19-111')), ['Abu']);
  assert.deepEqual(names(await customers(ali, '013-222')), ['Chong']);
  const twos = await customers(ali, '2222');
  assert.deepEqual(names(twos).sort(), ['Abu', 'Median']);
  assert.ok(twos.every((r) => r.total_count === 2 && r.due_count === 2));
  assert.deepEqual(names(await customers(ali, 'lim')), ['uncle  LIM']);
  assert.deepEqual(await customers(ali, '%'), []);

  // Pages, with odd sizes made sensible.
  assert.deepEqual(names(await customers(ali, null, 2, 0)), ['Median', 'Zaki']);
  assert.deepEqual(names(await customers(ali, null, 2, 2)), ['Ben', 'Abu']);
  assert.deepEqual(names(await customers(ali, null, 2, 10)), ['Flake']);
  assert.deepEqual(await customers(ali, null, 2, 11), []);
  assert.equal((await customers(ali, null, 0, 0)).length, 1);
  assert.equal((await customers(ali, null, null, -5)).length, 11);
  for (let k = 1; k <= 60; k++) {
    const at = kajang(-k, '16:00');
    insertRow('bookings', {
      shop_id: shop.id,
      barber_id: tables().barbers.filter((b) => b.shop_id === shop.id)[1].id,
      guest_name: `Guest ${k}`,
      guest_phone: `012-900 ${String(k).padStart(4, '0')}`,
      service_name: 'Haircut',
      price: 25,
      starts_at: at,
      ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
      status: 'completed',
    });
  }
  assert.equal((await customers(ali, null, 1000)).length, 50);
  assert.equal((await customers(ali, null, 1))[0].total_count, 71);

  // Nobody else sees them: not a customer, another shop's owner, or a guest.
  assert.deepEqual(await customers(await signedIn(DEMO_CUSTOMER_EMAIL)), []);
  assert.deepEqual(await customers(await signedIn('rahman@demo.potongku.my')), []);
  const guest = await client().rpc('shop_customers', { p_search: null, p_limit: 30, p_offset: 0 });
  assert.equal(guest.error?.code, '42501');
});

test('the sample shop has regulars, and a few are due for a cut whatever the day', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const all = await customers(ali, null, 50);
  const due = all.filter((r) => r.is_due);
  assert.deepEqual(
    due.map((r) => r.name),
    ['Daniel Tan', 'Ahmad Zaki', 'Amirul', 'Encik Kamal'],
  );
  assert.deepEqual(all.slice(0, 4), due);
  assert.ok(all.length >= 12 && all.every((r) => r.total_count === all.length && r.due_count === 4));
  const [daniel] = due;
  assert.deepEqual(
    [daniel.phone, daniel.visits, daniel.usual_gap_days, daniel.next_booking_at],
    ['016-778 2301', 3, 28, null],
  );
  assert.equal(Date.parse(daniel.last_visit_at!), Date.parse(kajang(-44, '18:00')));
  // Two gaps of 30 and 29 days: 29.5, so 30.
  assert.equal(due[3].usual_gap_days, 30);
  // Everyone else by their last visit, and Mr Wong has been away too long to nudge.
  const rest = all.slice(4).map((r) => (r.last_visit_at == null ? 0 : Date.parse(r.last_visit_at)));
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a));
  assert.equal(all.find((r) => r.name === 'Mr Wong')?.is_due, false);
  assert.equal(all.find((r) => r.name === 'Hakim')?.is_due, false);

  // My shop's card asks for one row, for the counts.
  const one = await customers(ali, null, 1);
  assert.deepEqual(one, [all[0]]);
  assert.deepEqual((await customers(ali, 'daniel')).map((r) => r.name), ['Daniel Tan']);
});
