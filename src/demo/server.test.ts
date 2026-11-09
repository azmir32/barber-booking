/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createClient } from '@supabase/supabase-js';

import { distanceText, kmBetween } from '../lib/distance.ts';
import { firstName } from '../lib/reviews.ts';
import type { MyShops } from '../lib/my-shops.ts';
import { plannedReminders, reminderChanges, type ReminderBooking } from '../lib/phone-reminders.ts';
import { MAX_PHOTOS, PHOTO_UPLOAD } from '../lib/photos.ts';
import { REPORT_COLUMNS } from '../lib/review-reports.ts';
import { canCompare, periodDays } from '../lib/summary.ts';
import { addDays, dayBounds, localDateString, localInstant } from '../lib/time.ts';
import { deleteRows, insertRow, now as demoNow, reloadTables, save, setClock, tables, updateRows, type Row } from './db.ts';
import {
  DEMO_ANON_KEY,
  DEMO_BARBER_EMAIL,
  DEMO_CUSTOMER_EMAIL,
  DEMO_NETWORK_KEY,
  DEMO_PASSWORD,
  DEMO_REQUESTS_KEY,
  DEMO_RESET_CODE,
  DEMO_URL,
  demoFetch,
  demoFileUrl,
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
  // Today's hours: Ali is in 10 to 8 Monday to Saturday and Danial 11 to 9
  // all but Monday (the Friday prayers break doesn't count), Gunting Pak Mat
  // is shut today, and The Fade Room is shut on Sundays.
  const hoursOf = (slug: string) => {
    const s = shops!.find((x: { slug: string }) => x.slug === slug);
    return [s.opens_today, s.closes_today];
  };
  const weekday = new Date(`${today()}T00:00:00Z`).getUTCDay();
  const sunday = weekday === 0;
  assert.deepEqual(
    hoursOf('ali-barber'),
    sunday ? ['11:00:00', '21:00:00'] : weekday === 1 ? ['10:00:00', '20:00:00'] : ['10:00:00', '21:00:00'],
  );
  assert.deepEqual(hoursOf('gunting-pak-mat'), [null, null]);
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

test('Near me lists the nearest shops first, with how far each is', async () => {
  const c = client();
  const sungaiChua = { p_lat: 2.9833, p_lng: 101.7667 };
  const listed = async (args: Record<string, unknown>) => {
    const { data, error } = await c.rpc('find_shops', { p_search: null, p_area: null, p_limit: 20, p_offset: 0, ...args });
    assert.equal(error, null);
    return data as { slug: string; distance_km: number | null; latitude: number | null; longitude: number | null }[];
  };
  const slugs = (list: { slug: string }[]) => list.map((s) => s.slug);
  const near = await listed(sungaiChua);
  assert.deepEqual(slugs(near), ['ali-barber', 'kemas-barber-kajang', 'gunting-pak-mat', 'the-fade-room']);
  assert.deepEqual(
    near.map((s) => distanceText(s.distance_km!)),
    ['500 m', '2.6 km', '3.2 km', '4.2 km'],
  );
  const ali = await shopBySlug(c, 'ali-barber');
  assert.equal(near[0].distance_km, kmBetween({ latitude: 2.9833, longitude: 101.7667 }, ali));
  // Where the shop is too, for Directions before its page loads.
  assert.deepEqual([near[0].latitude, near[0].longitude], [ali.latitude, ali.longitude]);

  // A page at a time, every shop once.
  const paged = [];
  for (let offset = 0; offset < 4; offset++) paged.push(...(await listed({ ...sungaiChua, p_limit: 1, p_offset: offset })));
  assert.deepEqual(slugs(paged), slugs(near));
  // Search and areas still filter, nearest first.
  assert.deepEqual(slugs(await listed({ ...sungaiChua, p_search: 'barber' })), ['ali-barber', 'kemas-barber-kajang']);
  const town = await listed({ ...sungaiChua, p_area: 'kajang town' });
  assert.deepEqual([slugs(town), distanceText(town[0].distance_km!)], [['kemas-barber-kajang'], '2.6 km']);

  // Without a whole position on the map, by name as before.
  const byName = ['ali-barber', 'gunting-pak-mat', 'kemas-barber-kajang', 'the-fade-room'];
  for (const args of [{}, { p_lat: 2.9833 }, { p_lat: 95, p_lng: 101.7667 }, { p_lat: 2.9833, p_lng: -200 }]) {
    const list = await listed(args);
    assert.deepEqual(slugs(list), byName, JSON.stringify(args));
    assert.ok(list.every((s) => s.distance_km === null), JSON.stringify(args));
  }
  const nonsense = await c.rpc('find_shops', { p_lat: 'here', p_lng: 101.7667 });
  assert.equal(nonsense.error?.code, '22P02');

  // A shop without a location comes after the rest.
  const owner = await signedIn(DEMO_BARBER_EMAIL);
  assert.equal((await owner.from('shops').update({ latitude: null, longitude: null }).eq('id', ali.id)).error, null);
  const after = await listed(sungaiChua);
  assert.deepEqual(slugs(after), ['kemas-barber-kajang', 'gunting-pak-mat', 'the-fade-room', 'ali-barber']);
  assert.equal(after[3].distance_km, null);
});

test('Find a barber filters to shops open now, free today or taking walk-ins, with everything else', async () => {
  const c = client();
  const day = today();
  const at = (clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return dayBounds(day, TZ).start.getTime() + (h * 60 + m) * 60_000;
  };
  const sunday = new Date(`${day}T00:00:00Z`).getUTCDay() === 0;
  type Listed = { id: string | null; slug: string; next_free_at: string | null; next_from: number | null };
  const list = async (args: Record<string, unknown>) => {
    const { data, error } = await c.rpc('find_shops', { p_search: null, p_area: null, p_limit: 20, p_offset: 0, ...args });
    assert.equal(error, null, JSON.stringify(args));
    return data as Listed[];
  };
  /** The shops a page lists, and where the next page starts (next_from, the same on every row). */
  const page = async (args: Record<string, unknown>) => {
    const rows = await list(args);
    const from = [...new Set(rows.map((r) => r.next_from))];
    assert.ok(from.length <= 1, JSON.stringify(args));
    const shops = rows.filter((r) => r.id != null).map((r) => r.slug);
    // A row without a shop, only saying how far the page looked, comes alone.
    assert.ok(shops.length === rows.length || rows.length === 1, JSON.stringify(args));
    return { shops, from: from[0] ?? null };
  };
  const slugs = async (args: Record<string, unknown>) => (await page(args)).shops;
  /** Every page in turn, each carrying on from where the one before stopped, until the end of the list. */
  const pages = async (args: Record<string, unknown>) => {
    const got = [];
    let from: number | null = 0;
    while (from != null && got.length < 10) {
      const next = await page({ ...args, p_from: from });
      got.push(next);
      from = next.from;
    }
    return got;
  };
  const [ali, pakMat, kemas, fadeRoom] = ['ali-barber', 'gunting-pak-mat', 'kemas-barber-kajang', 'the-fade-room'];
  const open = { p_open_now: true };
  const free = { p_free_today: true };
  const walkIn = { p_walk_ins: true };
  // Nearest first from The Fade Room: itself, Kemas, Ali's, then Pak Mat.
  const atFadeRoom = { p_lat: 2.9822, p_lng: 101.8045 };
  try {
    // The demo laid out at 3 pm: Pak Mat is shut today, and The Fade Room is
    // booked up (or, on Sundays, shut).
    setClock(() => at('15:00'));
    resetDemo();
    assert.deepEqual(await slugs({}), [ali, pakMat, kemas, fadeRoom]);
    assert.deepEqual(await slugs(open), sunday ? [ali, kemas] : [ali, kemas, fadeRoom]);
    assert.deepEqual(await slugs(free), [ali, kemas]);
    assert.deepEqual(await slugs(walkIn), [ali, pakMat]);
    assert.deepEqual(await slugs({ ...open, ...free }), [ali, kemas]);
    assert.deepEqual(await slugs({ ...free, ...walkIn }), [ali]);
    assert.deepEqual(await slugs({ ...open, ...free, ...walkIn }), [ali]);
    // A shop under a filter is the row the list has for it without, but for where the next page starts.
    const all = await list({});
    for (const args of [open, free, walkIn, { ...open, ...free, ...walkIn }]) {
      for (const row of await list(args)) {
        assert.deepEqual({ ...row, next_from: null }, all.find((s) => s.slug === row.slug));
      }
    }
    // Free today is a free time today by the shop's clock.
    for (const row of await list(free)) assert.equal(localDateString(new Date(row.next_free_at!), TZ), day);
    const fadeNext = all.find((s) => s.slug === fadeRoom)!.next_free_at;
    assert.ok(fadeNext == null || localDateString(new Date(fadeNext), TZ) !== day, 'The Fade Room has nothing left today');

    // With a search, an area, Near me and pages.
    assert.deepEqual(await slugs({ ...free, p_search: 'fade' }), []);
    assert.deepEqual(await slugs({ ...walkIn, p_search: 'GUNTING' }), [pakMat]);
    assert.deepEqual(await slugs({ ...open, p_area: 'saujana impian' }), sunday ? [] : [fadeRoom]);
    assert.deepEqual(await slugs({ ...free, p_lat: 2.9833, p_lng: 101.7667 }), [ali, kemas]);
    assert.deepEqual(await slugs({ ...walkIn, p_lat: 3.0102, p_lng: 101.7781 }), [pakMat, ali]);
    const paged = [];
    for (let offset = 0; offset < 3; offset++) paged.push(...(await slugs({ ...free, p_limit: 1, p_offset: offset })));
    assert.deepEqual(paged, [ali, kemas]);

    // Where the next page starts: nowhere without Open now or Free today, or at the end of the list.
    assert.ok(all.every((s) => s.next_from === null));
    assert.deepEqual(await page(walkIn), { shops: [ali, pakMat], from: null });
    assert.deepEqual(await page(open), { shops: sunday ? [ali, kemas] : [ali, kemas, fadeRoom], from: null });
    // One call works out at most two shops' next free times here (128 in the database), so Free today
    // stops after Kemas, three shops in, Pak Mat's hours having ruled it out; the next page carries on
    // from there and reaches the end.
    assert.deepEqual(await pages(free), [
      { shops: [ali, kemas], from: 3 },
      { shops: [], from: null },
    ]);
    // A page at a time, each from where the one before stopped: every shop once, in order.
    assert.deepEqual(await pages({ ...free, p_limit: 1 }), [
      { shops: [ali], from: 1 },
      { shops: [kemas], from: 3 },
      { shops: [], from: null },
    ]);
    // Across the cap: from The Fade Room, which is booked up, the first page stops at Kemas and the
    // second finds Ali's (on Sundays The Fade Room is shut, so both fit in the first).
    assert.deepEqual(
      await pages({ ...free, ...atFadeRoom }),
      sunday
        ? [
            { shops: [kemas, ali], from: 3 },
            { shops: [], from: null },
          ]
        : [
            { shops: [kemas], from: 2 },
            { shops: [ali], from: null },
          ],
    );
    // As Postgres reads an int.
    assert.deepEqual(await page({ ...free, p_from: ' 3 ' }), { shops: [], from: null });
    assert.equal((await c.rpc('find_shops', { ...free, p_from: '2.5' })).error?.code, '22P02');

    // As Postgres reads a boolean: any of its spellings, and null is off.
    for (const yes of ['true', ' T ', 'yes', 'y', 'on', '1']) {
      assert.deepEqual(await slugs({ p_walk_ins: yes }), [ali, pakMat], yes);
    }
    for (const no of ['false', 'f', 'NO', 'off', '0', null]) {
      assert.deepEqual(await slugs({ p_walk_ins: no, p_open_now: no, p_free_today: no }), [ali, pakMat, kemas, fadeRoom]);
    }
    for (const nonsense of ['maybe', 'o', '']) {
      const { error } = await c.rpc('find_shops', { p_free_today: nonsense });
      assert.equal(error?.code, '22P02', nonsense);
    }

    // Early in the morning nobody is open yet, but Ali's and Kemas still have
    // the day ahead; late in the evening only The Fade Room is still open,
    // and it is booked up.
    setClock(() => at('07:00'));
    assert.deepEqual(await slugs(open), []);
    assert.deepEqual(await slugs(free), [ali, kemas]);
    setClock(() => at('21:30'));
    assert.deepEqual(await slugs(open), sunday ? [] : [fadeRoom]);
    assert.deepEqual(await page(free), { shops: [], from: null });
    assert.deepEqual(await slugs(walkIn), [ali, pakMat]);

    // Ten to nine, Ali's and Kemas are open a little longer with no time left. From The Fade Room,
    // also booked up, the first page stops at the cap with nothing found: one row that only says how
    // far it looked. The next carries on and reaches the end.
    setClock(() => at('20:50'));
    const looked = sunday ? 3 : 2;
    const [only, ...rest] = await list({ ...free, ...atFadeRoom });
    assert.deepEqual(rest, []);
    assert.equal(only.next_from, looked);
    assert.ok(Object.entries(only).every(([column, value]) => column === 'next_from' || value === null));
    assert.deepEqual(Object.keys(only), Object.keys(all[0]));
    assert.deepEqual(await page({ ...free, ...atFadeRoom, p_from: looked }), { shops: [], from: null });
  } finally {
    setClock(() => Date.now());
  }
});

test('owners set where their shop is, both halves and on the map, and nobody else can', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const set = (patch: Record<string, unknown>, id = shop.id) => ali.from('shops').update(patch).eq('id', id);
  assert.equal((await set({ latitude: 2.98461, longitude: 101.77125 })).error, null);
  assert.deepEqual(
    [(await shopBySlug(ali, 'ali-barber')).latitude, (await shopBySlug(ali, 'ali-barber')).longitude],
    [2.98461, 101.77125],
  );
  for (const patch of [{ latitude: null }, { longitude: null }, { latitude: 91 }, { latitude: -90.5 }, { longitude: 181 }]) {
    assert.equal((await set(patch)).error?.code, '23514', JSON.stringify(patch));
  }
  assert.equal((await set({ latitude: null, longitude: null })).error, null);
  assert.equal((await shopBySlug(ali, 'ali-barber')).latitude, null);

  // Another owner's update finds no shop to change, and guests can't write at all.
  const rahman = await signedIn('rahman@demo.potongku.my');
  const kemas = await shopBySlug(rahman, 'kemas-barber-kajang');
  assert.equal((await set({ latitude: 0, longitude: 0 }, kemas.id)).error, null);
  assert.deepEqual([(await shopBySlug(rahman, 'kemas-barber-kajang')).latitude], [2.9925]);
  assert.equal((await client().from('shops').update({ latitude: 0, longitude: 0 }).eq('id', kemas.id)).error?.code, '42501');

  // A new shop can say where it is from the start.
  const c = client();
  const signUp = await c.auth.signUp({
    email: 'near@shop.my',
    password: 'password123',
    options: { data: { role: 'barber', full_name: 'Amin' } },
  });
  const created = await c
    .from('shops')
    .insert({ name: 'Amin Cuts', slug: 'amin-cuts', owner_id: signUp.data.user!.id, latitude: 2.9637, longitude: 101.7681 })
    .select()
    .single();
  assert.equal(created.error, null);
  assert.deepEqual([created.data.latitude, created.data.longitude], [2.9637, 101.7681]);
});

test('a demo saved before shops had a location gets the sample shops’ own, and none for the rest', () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    const where = () => Object.fromEntries(tables().shops.map((s) => [s.slug, [s.latitude, s.longitude]]));
    const sample = where();
    insertRow('shops', { owner_id: tables().profiles.find((p) => p.full_name === 'Hakim')!.id, name: 'Mine', slug: 'mine' });
    save();
    const [key, json] = [...saved.entries()][0];
    const old = JSON.parse(json);
    for (const s of old.tables.shops) {
      delete s.latitude;
      delete s.longitude;
    }
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.deepEqual(where(), { ...sample, mine: [null, null] });
    assert.deepEqual(sample['ali-barber'], [2.9846, 101.7712]);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
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

test('My bookings keeps the shop and barber when the shop pauses, and shows only the customer’s own', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const hakimId = (await hakim.auth.getUser()).data.user!.id;
  const mine = async () => {
    const { data, error } = await hakim.rpc('my_bookings');
    assert.equal(error, null);
    return data.bookings as (Row & { shops: Row & { is_live: boolean }; barbers: Row })[];
  };
  const before = await mine();
  const own = tables().bookings.filter((b) => b.customer_id === hakimId);
  assert.equal(before.length, own.length);
  assert.ok(before.length >= 2);
  // Newest first, every column of the booking, and its shop and barber.
  const starts = before.map((b) => Date.parse(String(b.starts_at)));
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
  assert.ok(before.every((b) => b.customer_id === hakimId && b.service_name && b.price != null && b.status));
  const atAli = before.find((b) => b.shops.slug === 'ali-barber')!;
  assert.deepEqual(atAli.shops, {
    name: 'Ali Barber Sungai Chua',
    slug: 'ali-barber',
    address: 'No. 12, Jalan Sungai Chua 3/1, 43000 Kajang',
    area: 'Sungai Chua',
    latitude: 2.9846,
    longitude: 101.7712,
    phone: '012-345 6789',
    time_zone: TZ,
    is_live: true,
  });
  assert.match(String(atAli.barbers.name), /^(Ali|Danial)$/);

  // Ali pauses bookings: the shop is hidden, but Hakim still sees where to go and whom to message.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  await ali.from('shops').update({ is_published: false }).eq('id', shop.id);
  const joined = await hakim.from('bookings').select('id, shops(name), barbers(name)').eq('shop_id', shop.id);
  assert.ok(joined.data!.every((b) => b.shops === null && b.barbers === null));
  const paused = (await mine()).find((b) => b.id === atAli.id)!;
  assert.deepEqual(paused.shops, { ...atAli.shops, is_live: false });
  assert.deepEqual(paused.barbers, atAli.barbers);

  // Nobody else's bookings, and guests can't ask.
  const ravi = await signedIn('ravi@demo.potongku.my');
  const raviId = (await ravi.auth.getUser()).data.user!.id;
  const theirs = (await ravi.rpc('my_bookings')).data.bookings as Row[];
  assert.ok(theirs.every((b) => b.customer_id === raviId));
  assert.equal((await client().rpc('my_bookings')).error?.code, '42501');
  assert.equal(((await hakim.rpc('my_bookings', { p_limit: 1 })).data.bookings as Row[]).length, 1);
});

test('a name can’t be cleared, and an account made without one is named after its email', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const id = (await hakim.auth.getUser()).data.user!.id;
  const blank = await hakim.from('profiles').update({ full_name: '   ' }).eq('id', id);
  assert.equal(blank.error?.code, '23514');
  assert.equal((await hakim.from('profiles').update({ full_name: 'Hakim R' }).eq('id', id)).error, null);

  const c = client();
  const signUp = await c.auth.signUp({ email: 'nobody.named@shop.my', password: 'password123' });
  assert.equal(signUp.error, null);
  const { data: profile } = await c.from('profiles').select('full_name').eq('id', signUp.data.user!.id).single();
  assert.equal(profile!.full_name, 'nobody.named');
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

test('customers (and their shop) move a booking to another free time, and nobody else can', async () => {
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

  // The shop can move it too (Hakim called to change it), and it stays Hakim's; so can a walk-in.
  // Never blocked time.
  const byShop = await move(owner, { p_starts_at: at('10:00'), p_barber_id: mat.id });
  assert.equal(byShop.error, null);
  assert.equal(byShop.data.customer_id, booked.data.customer_id);
  assert.equal(byShop.data.barber_id, mat.id);
  assert.equal(Date.parse(byShop.data.starts_at), Date.parse(at('10:00')));
  const walkIn = await owner.rpc('reschedule_booking', { p_booking_id: guest.data.id, p_starts_at: at('11:30') });
  assert.equal(walkIn.error, null);
  assert.equal(walkIn.data.guest_name, 'Pak Long');
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

type ShopChanges = { since: string; count: number; latest: string | null; changes: Row[] };

test('the shop hears what customers booked, moved or cancelled since it last looked, and nothing else', async () => {
  const mat = await signedIn('mat@demo.potongku.my');
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const ravi = await signedIn('ravi@demo.potongku.my');
  const changes = async (c = mat, args: Record<string, unknown> = {}) => {
    const { data, error } = await c.rpc('shop_changes', { p_since: null, p_limit: 5, ...args });
    assert.equal(error, null);
    return data as ShopChanges;
  };
  // Pak Mat's sample bookings were all added by the shop.
  const quiet = await changes();
  assert.deepEqual([quiet.count, quiet.latest, quiet.changes], [0, null, []]);
  assert.ok(Math.abs(Date.parse(quiet.since) - (Date.now() - 86_400_000)) < 5000, 'a phone that never looked gets the last day');

  const shop = await shopBySlug(hakim, 'gunting-pak-mat');
  const { data: services } = await hakim.from('services').select('*').eq('shop_id', shop.id).order('sort_order');
  const cut = services![0]; // 20 minutes
  const { data: barbers } = await hakim.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const [pakMat, faizal] = barbers!;
  // A day Pak Mat has no Friday prayers break.
  let day = addDays(today(), 3);
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 5) day = addDays(day, 1);
  const at = (clock: string, date = day) => {
    const [h, m] = clock.split(':').map(Number);
    return new Date(dayBounds(date, TZ).start.getTime() + (h * 60 + m) * 60_000).toISOString();
  };
  // A minute between each step, so every change has its own time.
  let clock = Date.now();
  setClock(() => clock);
  const tick = () => (clock += 60_000);
  try {
    const book = async (c: ReturnType<typeof client>, time: string) => {
      tick();
      const { data, error } = await c.rpc('book_appointment', { p_service_id: cut.id, p_starts_at: at(time), p_barber_id: pakMat.id });
      assert.equal(error, null);
      return data as Row;
    };
    const booked = await book(hakim, '09:00');
    assert.equal(booked.customer_change, 'booked');
    assert.equal(Date.parse(String(booked.customer_changed_at)), clock);
    const toMove = await book(hakim, '10:00');
    tick();
    const moved = (await hakim.rpc('reschedule_booking', { p_booking_id: toMove.id, p_starts_at: at('11:00') })).data as Row;
    assert.deepEqual([moved.customer_change, Date.parse(String(moved.customer_changed_at))], ['moved', clock]);
    const toCancel = await book(ravi, '12:00');
    tick();
    const cancelled = (await ravi.rpc('set_booking_status', { p_booking_id: toCancel.id, p_status: 'cancelled' })).data as Row;
    assert.equal(cancelled.customer_change, 'cancelled');

    // The shop's own changes leave them as they were.
    const shopCancels = await book(ravi, '13:00');
    tick();
    const byShop = (await mat.rpc('set_booking_status', { p_booking_id: shopCancels.id, p_status: 'cancelled' })).data as Row;
    assert.deepEqual([byShop.customer_change, byShop.customer_changed_at], ['booked', shopCancels.customer_changed_at]);
    const shopMoved = (await mat.rpc('reschedule_booking', { p_booking_id: moved.id, p_starts_at: at('11:30') })).data as Row;
    assert.deepEqual([shopMoved.customer_change, shopMoved.customer_changed_at], ['moved', moved.customer_changed_at]);
    // Ravi cancelled one, and the shop took it back: it stands, so it is no news.
    const takenBack = await book(ravi, '14:00');
    await ravi.rpc('set_booking_status', { p_booking_id: takenBack.id, p_status: 'cancelled' });
    const restored = (await mat.rpc('set_booking_status', { p_booking_id: takenBack.id, p_status: 'confirmed' })).data as Row;
    assert.deepEqual([restored.status, restored.customer_change], ['confirmed', 'cancelled']);
    const walkIn = await mat.rpc('add_shop_booking', {
      p_barber_id: pakMat.id,
      p_day: day,
      p_time: '15:00',
      p_service_id: cut.id,
      p_guest_name: 'Pak Abu',
    });
    assert.deepEqual([walkIn.data.customer_change, walkIn.data.customer_changed_at], [null, null]);
    const direct = await mat.from('bookings').update({ customer_change: null, customer_changed_at: null }).eq('id', walkIn.data.id);
    assert.equal(direct.error?.code, '42501');

    // Newest first, each saying who, what, with whom and when it is now.
    const news = await changes();
    assert.equal(news.count, 3);
    assert.deepEqual(
      news.changes.map((c) => [c.change, c.customer_name, c.chair_free]),
      [
        ['cancelled', 'Ravi', true],
        ['moved', 'Hakim', false],
        ['booked', 'Hakim', false],
      ],
    );
    assert.deepEqual(news.changes[1], {
      booking_id: moved.id,
      barber_id: pakMat.id,
      barber_name: 'Pak Mat',
      customer_name: 'Hakim',
      service_name: 'Potong biasa',
      starts_at: shopMoved.starts_at,
      change: 'moved',
      changed_at: moved.customer_changed_at,
      chair_free: false,
      // Only a cancellation says how many are waiting for its day.
      waiting: 0,
    });
    assert.equal(news.latest, cancelled.customer_changed_at);
    // Once the shop puts a walk-in in Ravi's cancelled time, that chair is no longer free.
    await mat.rpc('add_shop_booking', {
      p_barber_id: pakMat.id,
      p_day: day,
      p_time: '12:00',
      p_service_id: cut.id,
      p_guest_name: 'Pak Long',
    });
    assert.equal((await changes()).changes[0].chair_free, false);

    // Once a phone has seen up to the newest, nothing is new; from an earlier change, what came after.
    assert.equal((await changes(mat, { p_since: news.latest })).count, 0);
    assert.equal((await changes(mat, { p_since: booked.customer_changed_at })).count, 2);
    // Never more than a week back, and a few at a time with the count for all.
    const month = await changes(mat, { p_since: new Date(clock - 30 * 86_400_000).toISOString() });
    assert.deepEqual([Date.parse(month.since), month.count], [clock - 7 * 86_400_000, 3]);
    const one = await changes(mat, { p_limit: 1 });
    assert.deepEqual([one.count, one.changes.length], [3, 1]);
    assert.deepEqual((await changes(mat, { p_limit: 0 })).changes, []);

    // Only bookings that end today or later: this morning's first minutes count whenever this runs, last night's don't.
    const faizalAt = (date: string, time: string, ago: number, extra: Row = {}) =>
      insertRow('bookings', {
        shop_id: shop.id,
        barber_id: faizal.id,
        customer_id: tables().users.find((u) => u.email === 'jason@demo.potongku.my')!.id,
        service_name: 'Potong biasa',
        price: 12,
        starts_at: at(time, date),
        ends_at: new Date(Date.parse(at(time, date)) + 20 * 60_000).toISOString(),
        customer_changed_at: new Date(clock - ago).toISOString(),
        customer_change: 'booked',
        ...extra,
      });
    faizalAt(today(), '00:00', 2 * 3_600_000);
    faizalAt(addDays(today(), -1), '23:30', 3_600_000);
    faizalAt(addDays(today(), 7), '09:00', 8 * 86_400_000);
    assert.equal((await changes()).count, 4);
    // A page is at most 20.
    for (let k = 1; k <= 25; k++) faizalAt(addDays(day, 2), `${8 + Math.floor(k / 3)}:${(k % 3) * 20}`, k * 60_000);
    const page = await changes(mat, { p_limit: 1000 });
    assert.deepEqual([page.count, page.changes.length], [29, 20]);

    // Nobody else hears about them: another shop's owner, a customer, or a guest.
    assert.equal((await changes(await signedIn('rahman@demo.potongku.my'))).count, 0);
    assert.deepEqual((await changes(hakim)).changes, []);
    assert.equal((await client().rpc('shop_changes', { p_since: null })).error?.code, '42501');

    // A customer who deletes their account cancels what they had booked, and the shop hears it.
    tick();
    assert.equal((await hakim.rpc('delete_my_account')).error, null);
    const gone = (await changes(mat, { p_limit: 2 })).changes;
    assert.deepEqual(
      gone.map((c) => [c.change, c.customer_name, c.booking_id]).sort(),
      [
        ['cancelled', 'Deleted account', booked.id],
        ['cancelled', 'Deleted account', moved.id],
      ].sort(),
    );
  } finally {
    setClock(() => Date.now());
  }
});

test('Ali’s sample shop has a booking, a cancellation and a move from the last few hours, whatever the day and hour', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  try {
    // Every hour of the day, each on a different weekday in turn.
    for (let hour = 0; hour < 24; hour++) {
      const date = addDays(today(), hour % 7);
      const at = dayBounds(date, TZ).start.getTime() + (hour * 60 + 7) * 60_000;
      const when = `on ${date} at ${hour}:07`;
      setClock(() => at);
      resetDemo();
      const { data, error } = await ali.rpc('shop_changes', { p_since: null, p_limit: 5 });
      assert.equal(error, null);
      const { count, changes } = data as ShopChanges;
      assert.deepEqual(
        [count, ...changes.map((c) => `${c.change} ${c.customer_name}`)],
        [3, 'booked Aiman', 'cancelled Jason', 'moved Ravi'],
        when,
      );
      const [booked, cancelled] = changes;
      // Booked for later in the week; the cancelled time is still to come, so a walk-in can have it.
      assert.ok(localDateString(new Date(String(booked.starts_at)), TZ) >= addDays(date, 2), when);
      assert.ok(Date.parse(String(cancelled.starts_at)) > at && cancelled.chair_free === true, when);
      for (const c of changes) assert.ok(at - Date.parse(String(c.changed_at)) < 6 * 3_600_000, when);
    }
  } finally {
    setClock(() => Date.now());
  }
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
  // A barber added by mistake is removed, hours and all, while nobody has booked them.
  const typo = await c.from('barbers').insert({ shop_id: created.data.id, name: 'Zak', sort_order: 1 }).select().single();
  await c.from('working_hours').insert({ barber_id: typo.data.id, weekday: 1, opens_at: '10:00', closes_at: '20:00' });
  assert.equal((await c.from('barbers').delete().eq('id', typo.data.id)).error, null);
  assert.deepEqual((await c.from('barbers').select('name').eq('shop_id', created.data.id)).data, [{ name: 'Zack' }]);
  assert.equal((await c.from('working_hours').select('id').eq('barber_id', typo.data.id)).data?.length, 0);
  const service = await c.from('services').insert({ shop_id: created.data.id, name: 'Haircut', duration_min: 30, price: 20, sort_order: 0 });
  assert.equal(service.error, null);

  // Not live yet: guests can't see it.
  assert.equal((await client().from('shops').select('*').eq('slug', 'zack-cuts').maybeSingle()).data, null);
  assert.equal(created.data.published_at, null);
  const sneakyLive = await c.from('shops').update({ published_at: new Date().toISOString() }).eq('id', created.data.id);
  assert.equal(sneakyLive.error?.code, '42501');
  await c.from('shops').update({ is_published: true }).eq('id', created.data.id);
  assert.equal((await client().from('shops').select('*').eq('slug', 'zack-cuts').maybeSingle()).data?.name, 'Zack Cuts');
  // When it first went live is kept through a pause, so My shop can say "Bookings paused".
  const firstLive = (await shopBySlug(c, 'zack-cuts')).published_at;
  assert.ok(firstLive);
  await c.from('shops').update({ is_published: false }).eq('id', created.data.id);
  assert.equal((await shopBySlug(c, 'zack-cuts')).published_at, firstLive);

  const dup = await c.auth.signUp({ email: 'NEW@shop.my', password: 'password123' });
  assert.equal(dup.error?.message, 'User already registered');

  // Customers can't open a shop.
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const sneaky = await hakim
    .from('shops')
    .insert({ name: 'Hakim', slug: 'hakim-cuts', owner_id: (await hakim.auth.getUser()).data.user!.id });
  assert.equal(sneaky.error?.code, '42501');
});

test('a new shop goes live only with something to book, and its owner can see what is missing', async () => {
  const c = client();
  const signUp = await c.auth.signUp({
    email: 'ready@shop.my',
    password: 'password123',
    options: { data: { role: 'barber', full_name: 'Hafiz' } },
  });
  assert.equal(signUp.error, null);
  const owner = signUp.data.user!.id;
  assert.equal((await c.rpc('shop_setup')).data, null);

  // Not already live: going live is an update, which checks.
  const atOnce = await c.from('shops').insert({ name: 'Live At Once', slug: 'live-at-once', owner_id: owner, is_published: true });
  assert.equal(atOnce.error?.code, '42501');
  const { data: shop } = await c.from('shops').insert({ name: 'Hafiz Cuts', slug: 'hafiz-cuts', owner_id: owner }).select().single();
  assert.deepEqual((await c.rpc('shop_setup')).data, { services: 0, barbers: [] });
  const goLive = () => c.from('shops').update({ is_published: true }).eq('id', shop.id);
  const noService = 'Add a service before you go live, so customers have something to book.';
  const noHours = 'Add a barber with working hours before you go live, so customers can pick a time.';
  let refused = await goLive();
  assert.equal(refused.error?.code, 'P0001');
  assert.equal(refused.error?.message, noService);

  // A hidden service doesn't count, a shown one does.
  await c.from('services').insert({ shop_id: shop.id, name: 'Old menu', duration_min: 30, price: 15, is_active: false });
  assert.equal((await goLive()).error?.message, noService);
  await c.from('services').insert({ shop_id: shop.id, name: 'Haircut', duration_min: 30, price: 20 });

  // The first chair with no hours yet, and one away with hours, which doesn't count either.
  const { data: first } = await c.from('barbers').insert({ shop_id: shop.id, name: 'Hafiz', sort_order: 0 }).select().single();
  const { data: away } = await c
    .from('barbers')
    .insert({ shop_id: shop.id, name: 'Away Ali', sort_order: 1, is_active: false })
    .select()
    .single();
  await c.from('working_hours').insert({ barber_id: away.id, weekday: 1, opens_at: '10:00', closes_at: '20:00' });
  assert.deepEqual((await c.rpc('shop_setup')).data, {
    services: 1,
    barbers: [{ id: first.id, name: 'Hafiz', has_hours: false }],
  });
  refused = await goLive();
  assert.equal(refused.error?.message, noHours);
  const kept = await shopBySlug(c, 'hafiz-cuts');
  assert.equal(kept.is_published, false);
  assert.equal(kept.published_at, null);

  // One day a week is enough.
  await c.rpc('set_barber_hours', {
    p_barber_id: first.id,
    p_hours: [{ weekday: 6, opens_at: '10:00', closes_at: '14:00' }],
  });
  assert.equal((await c.rpc('shop_setup')).data.barbers[0].has_hours, true);
  assert.equal((await goLive()).error, null);
  assert.ok((await shopBySlug(c, 'hafiz-cuts')).published_at);

  // Emptying the menu later is the owner's call, but coming back on after a pause checks again.
  await c.from('services').update({ is_active: false }).eq('shop_id', shop.id);
  assert.equal((await c.from('shops').update({ name: 'Hafiz Cuts Kajang' }).eq('id', shop.id)).error, null);
  assert.equal((await shopBySlug(c, 'hafiz-cuts')).is_published, true);
  await c.from('shops').update({ is_published: false }).eq('id', shop.id);
  assert.equal((await goLive()).error?.message, noService);

  // Only the owner hears about their own shop.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const alis = (await ali.rpc('shop_setup')).data;
  assert.equal(alis.services, 5);
  assert.deepEqual(
    alis.barbers.map((b: { name: string; has_hours: boolean }) => [b.name, b.has_hours]),
    [
      ['Ali', true],
      ['Danial', true],
    ],
  );
  assert.equal((await (await signedIn(DEMO_CUSTOMER_EMAIL)).rpc('shop_setup')).data, null);
  assert.equal((await client().rpc('shop_setup')).error?.code, '42501');
});

test('a barber account with no shop can become a customer one, but an owner can\'t', async () => {
  const c = client();
  const signUp = await c.auth.signUp({
    email: 'oops@shop.my',
    password: 'password123',
    options: { data: { role: 'barber', full_name: 'Oops' } },
  });
  assert.equal(signUp.error, null);
  const changed = await c.rpc('become_customer');
  assert.equal(changed.error, null);
  const { data: profile } = await c.from('profiles').select('role').eq('id', signUp.data.user!.id).single();
  assert.equal(profile!.role, 'customer');

  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const refused = await ali.rpc('become_customer');
  assert.equal(refused.error?.message, 'You have a shop, so this account stays a barber account.');
  assert.equal(tables().profiles.find((p) => p.full_name === 'Ali')?.role, 'barber');
  assert.equal((await client().rpc('become_customer')).error?.code, '42501');
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
    // From yesterday on; the weeks before are laid out again (the next test).
    const yesterday = dayBounds(addDays(today(), -1), TZ).start.getTime();
    const before = new Map(
      tables()
        .bookings.filter((b) => Date.parse(String(b.starts_at)) >= yesterday)
        .map((b) => [b.id, Date.parse(String(b.starts_at))]),
    );
    const trialBefore = Date.parse(String(tables().shops[0].trial_ends_at));
    const closedBefore = String(tables().shop_closures[0].day);

    const later = Date.now() + 3 * 86_400_000;
    setClock(() => later);
    reloadTables();
    const after = tables().bookings.map((b) => Date.parse(String(b.starts_at)));
    const moved = [...before.keys()].map((id) => tables().bookings.find((b) => b.id === id)?.starts_at);
    assert.deepEqual(
      moved.map((at) => Date.parse(String(at))),
      [...before.values()].map((t) => t + 3 * 86_400_000),
    );
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

test('opened a day later, the weeks before yesterday keep their weekdays', () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    save();
    const later = Date.now() + 86_400_000;
    setClock(() => later);
    reloadTables();
    const day = localDateString(new Date(later), TZ);
    const yesterday = dayBounds(addDays(day, -1), TZ).start.getTime();
    const past = tables().bookings.filter((b) => Date.parse(String(b.starts_at)) < yesterday);
    const dayOf = (b: Row) => localDateString(new Date(String(b.starts_at)), TZ);
    const minutes = (clock: unknown) => {
      const [h, m] = String(clock).split(':').map(Number);
      return h * 60 + m;
    };
    // Each inside its barber's hours that weekday: Ali never on a Sunday,
    // Danial never on a Monday, and nobody during Friday prayers.
    for (const b of past) {
      const date = dayOf(b);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const from = (Date.parse(String(b.starts_at)) - dayBounds(date, TZ).start.getTime()) / 60_000;
      const to = from + (Date.parse(String(b.ends_at)) - Date.parse(String(b.starts_at))) / 60_000;
      const hours = tables().working_hours.filter((h) => h.barber_id === b.barber_id && h.weekday === weekday);
      assert.ok(
        hours.some((h) => minutes(h.opens_at) <= from && to <= minutes(h.closes_at)),
        `${b.service_name} on ${date} at ${from / 60}h is outside its barber's hours`,
      );
    }
    // Still eight weeks of them, right up to the day before yesterday.
    const ali = tables().shops.find((s) => s.slug === 'ali-barber')!;
    const days = new Set(past.filter((b) => b.shop_id === ali.id).map(dayOf));
    for (let i = 2; i <= 56; i++) assert.ok(days.has(addDays(day, -i)), `nothing ${i} days ago`);
  } finally {
    setClock(() => Date.now());
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

test('opened the next morning, what customers changed last evening is still in the past, and a new booking still counts', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const changes = async (since: string | null = null) =>
    (await ali.rpc('shop_changes', { p_since: since, p_limit: 5 })).data as ShopChanges;
  try {
    // Tried at 8 pm, opened again at 9 am: moved a whole day, the sample changes would be this evening.
    setClock(() => dayBounds(today(), TZ).start.getTime() + 20 * 3_600_000);
    resetDemo();
    save();
    const morning = addDays(today(), 1);
    let clock = dayBounds(morning, TZ).start.getTime() + 9 * 3_600_000;
    setClock(() => clock);
    reloadTables();
    const news = await changes();
    assert.equal(news.count, 3);
    assert.ok(news.latest && Date.parse(news.latest) <= clock, `latest ${news.latest}`);
    for (const c of news.changes) assert.ok(Date.parse(String(c.changed_at)) <= clock, `${c.change} at ${c.changed_at}`);

    // Got it keeps the newest, and Hakim's booking a few minutes later is news.
    clock += 5 * 60_000;
    const shop = await shopBySlug(hakim, 'ali-barber');
    const { data: services } = await hakim.from('services').select('*').eq('shop_id', shop.id).order('sort_order');
    let slot: { barber_id: string; starts_at: string } | undefined;
    for (let d = 1; !slot && d < 7; d++) {
      const { data } = await hakim.rpc('available_slots', { p_service_id: services![0].id, p_day: addDays(morning, d) });
      slot = data?.[0];
    }
    assert.ok(slot);
    const booked = await hakim.rpc('book_appointment', {
      p_service_id: services![0].id,
      p_starts_at: slot.starts_at,
      p_barber_id: slot.barber_id,
    });
    assert.equal(booked.error, null);
    const after = await changes(news.latest);
    assert.deepEqual([after.count, after.changes[0]?.booking_id], [1, booked.data.id]);
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
  // A barber's id isn't the owner's to write at all; a service's is, but not while bookings point at it.
  const moved = await ali.from('barbers').update({ id: '00000000-0000-4000-8000-000000000999' }).eq('id', myChair.id);
  assert.equal(moved.error?.code, '42501');
  const myService = tables().services.find((v) => v.shop_id === mine.id)!;
  const renumbered = await ali
    .from('services')
    .update({ id: '00000000-0000-4000-8000-000000000999' })
    .eq('id', myService.id);
  assert.equal(renumbered.error?.code, '23503');
  // A barber with bookings stays (Remove on the Barbers tab says so), so past bookings keep their barber.
  const removed = await ali.from('barbers').delete().eq('id', myChair.id);
  assert.equal(removed.error?.code, '23503');
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
      barber_id: string | null;
    }[];

  // One barber's own day off doesn't close the shop, but the booking page hears that barber is off,
  // and closing leaves it alone. Danial works Sundays on his own, so his Sunday off is the shop's.
  const offDay = addDays(from, 1);
  const off = await barber.rpc('add_shop_booking', {
    p_barber_id: barbers![1].id,
    p_day: offDay,
    p_time: '00:00',
    p_duration_min: 1440,
    p_note: 'Day off',
    p_is_block: true,
  });
  assert.equal(off.error, null);
  const sunday = new Date(`${offDay}T00:00:00Z`).getUTCDay() === 0;
  assert.deepEqual(await closed(barber), [
    { day: offDay, reason: 'Day off', is_closure: false, barber_id: sunday ? null : barbers![1].id },
  ]);

  const close = await barber.rpc('close_shop_days', { p_from: from, p_days: 3, p_reason: '  Hari Raya ' });
  assert.equal(close.error, null);
  assert.equal(close.data, 3);
  const days = [0, 1, 2].map((i) => addDays(from, i));
  assert.deepEqual(
    await closed(barber),
    days.map((day) => ({ day, reason: 'Hari Raya', is_closure: true, barber_id: null })),
  );
  assert.equal(tables().bookings.find((b) => b.id === off.data.id)!.status, 'confirmed');
  // Closing again changes the reason, not the days.
  await barber.rpc('close_shop_days', { p_from: from, p_days: 3, p_reason: 'Hari Raya Aidilfitri' });
  assert.deepEqual((await closed(barber)).map((d) => d.reason), ['Hari Raya Aidilfitri', 'Hari Raya Aidilfitri', 'Hari Raya Aidilfitri']);

  // Guests see the days, not the reason, and no free times on them.
  const guest = client();
  assert.deepEqual(await closed(guest), days.map((day) => ({ day, reason: null, is_closure: true, barber_id: null })));
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
  // With how many and the first day, for the app to say.
  assert.equal(
    refused.error!.message,
    `There are bookings on those days (1, the first on ${addDays(from, 4)}). Cancel them first (and let the customers know), then close the shop.`,
  );
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
  // Danial's day off is his own again, now that Hakim works that day too.
  assert.deepEqual(await closed(guest), [{ day: offDay, reason: null, is_closure: false, barber_id: barbers![1].id }]);
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
  assert.deepEqual(allOff.data, [{ day, reason: 'Kursus', is_closure: false, barber_id: null }]);
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
    { day: today(), reason: null, is_closure: true, barber_id: null },
  ]);
  assert.deepEqual(await hours(), { opens_today: null, closes_today: null });
  assert.deepEqual(await listed(), [null, null]);
});

test('the sample shop has weeks of takings to look back on', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  // Last week, Monday to Sunday.
  const weekday = new Date(`${today()}T00:00:00Z`).getUTCDay();
  const monday = addDays(today(), -((weekday + 6) % 7) - 7);
  const { data, error } = await ali.rpc('shop_summary', { p_from: monday, p_to: addDays(monday, 6) });
  assert.equal(error, null);
  // On the app since before its history, so last week and this month have a period before to compare with.
  const shop = await shopBySlug(ali, 'ali-barber');
  const month = periodDays('month', Date.now(), TZ);
  const thisMonth = (await ali.rpc('shop_summary', { p_from: month.from, p_to: month.to })).data;
  assert.ok(canCompare(data.previous.from, shop.created_at, TZ));
  assert.ok(canCompare(thisMonth.previous.from, shop.created_at, TZ));
  assert.ok(data.totals.done >= 30 && data.totals.takings >= 600, `a busy week: ${JSON.stringify(data.totals)}`);
  assert.ok(data.totals.no_shows > 0 && data.totals.cancelled > 0);
  assert.ok(data.previous.done >= 30, 'and a week before it to compare');
  assert.equal(data.days.length, 7);
  assert.ok(data.days.every((d: { bookings: number }) => d.bookings > 0), 'every day has someone');
  assert.ok(data.hours.length >= 8, 'from morning to evening');
  assert.deepEqual(data.barbers.map((b: { name: string }) => b.name).sort(), ['Ali', 'Danial']);
  assert.ok(data.services.length >= 3);
});

test('the owner sees a week’s takings and the week before, and nobody else does', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const [aliChair, danial] = barbers!;
  const rahman = await signedIn('rahman@demo.potongku.my');
  const kemas = await shopBySlug(rahman, 'kemas-barber-kajang');
  const kemasChair = tables().barbers.find((b) => b.shop_id === kemas.id)!;
  // Only the bookings added below count, at both shops.
  const sample = (b: Row) => b.shop_id === shop.id || b.shop_id === kemas.id;
  tables().bookings = tables().bookings.filter((b) => !sample(b));
  tables().reviews = tables().reviews.filter((r) => !sample(r));
  // Two barbers since marked away.
  const faiz = insertRow('barbers', { shop_id: shop.id, name: 'Faiz', is_active: false, sort_order: 2 });
  const zul = insertRow('barbers', { shop_id: shop.id, name: 'Zul', is_active: false, sort_order: 3 });

  // The same weeks as booking_test.sql: three weeks ago, and the week before it.
  const d = addDays(today(), -20);
  const add = (barber: unknown, day: string, clock: string, name: string, price: number, status: string, block = false) => {
    const [h, m] = clock.split(':').map(Number);
    const at = dayBounds(day, TZ).start.getTime() + (h * 60 + m) * 60_000;
    insertRow('bookings', {
      shop_id: tables().barbers.find((b) => b.id === barber)!.shop_id,
      barber_id: barber,
      guest_name: block ? null : 'Guest',
      is_block: block,
      service_name: name,
      price,
      starts_at: new Date(at).toISOString(),
      ends_at: new Date(at + 30 * 60_000).toISOString(),
      status,
    });
  };
  // This week: one haircut was booked at an old price of 18.
  add(aliChair.id, d, '10:00', 'Haircut', 25, 'completed');
  add(aliChair.id, d, '11:00', 'Skin fade', 30, 'completed');
  add(danial.id, addDays(d, 1), '10:00', 'Haircut', 25, 'no_show');
  add(aliChair.id, addDays(d, 2), '10:00', 'Haircut', 25, 'cancelled');
  add(danial.id, addDays(d, 2), '10:00', 'Haircut', 25, 'completed');
  add(aliChair.id, addDays(d, 3), '13:00', 'Lunch', 50, 'confirmed', true);
  add(danial.id, addDays(d, 4), '15:00', 'Haircut', 25, 'confirmed');
  add(aliChair.id, addDays(d, 5), '10:00', 'Haircut', 18, 'completed');
  add(aliChair.id, addDays(d, 6), '23:30', 'Haircut', 40, 'completed');
  // Not this week: the day after, and another shop.
  add(aliChair.id, addDays(d, 7), '00:00', 'Haircut', 99, 'completed');
  add(kemasChair.id, addDays(d, 1), '10:00', 'Haircut', 500, 'completed');
  // The week after, while Danial is away: Faiz's no-show and Zul's cancelled cut.
  add(faiz.id, addDays(d, 9), '10:00', 'Haircut', 25, 'no_show');
  add(zul.id, addDays(d, 9), '11:00', 'Haircut', 25, 'cancelled');
  // The week before, and one from before that.
  add(aliChair.id, addDays(d, -7), '10:00', 'Haircut', 25, 'completed');
  add(aliChair.id, addDays(d, -3), '10:00', 'Skin fade', 30, 'no_show');
  add(danial.id, addDays(d, -1), '23:45', 'Haircut', 20, 'completed');
  add(aliChair.id, addDays(d, -1), '12:00', 'Haircut', 25, 'cancelled');
  add(aliChair.id, addDays(d, -8), '10:00', 'Haircut', 1000, 'completed');

  const { data: s, error } = await ali.rpc('shop_summary', { p_from: d, p_to: addDays(d, 6) });
  assert.equal(error, null);
  assert.deepEqual(s.totals, {
    done: 5,
    takings: 138,
    no_shows: 1,
    no_show_value: 25,
    cancelled: 1,
    to_come: 0,
    to_come_value: 0,
    unmarked: 1,
    unmarked_value: 25,
  });
  const { until, ...previous } = s.previous;
  assert.deepEqual(previous, {
    from: addDays(d, -7),
    to: addDays(d, -1),
    done: 2,
    takings: 45,
    no_shows: 1,
    no_show_value: 30,
    cancelled: 1,
  });
  assert.equal(Date.parse(until), dayBounds(d, TZ).start.getTime(), 'a finished week compares with the whole week before');
  assert.deepEqual(
    s.days.map((x: { bookings: number }) => x.bookings),
    [2, 1, 1, 0, 1, 1, 1],
  );
  assert.deepEqual(s.days[6], { day: addDays(d, 6), bookings: 1, done: 1, takings: 40 });
  assert.deepEqual(s.hours, [
    { hour: 10, bookings: 4 },
    { hour: 11, bookings: 1 },
    { hour: 15, bookings: 1 },
    { hour: 23, bookings: 1 },
  ]);
  assert.deepEqual(s.barbers, [
    { barber_id: aliChair.id, name: 'Ali', bookings: 4, done: 4, takings: 113, no_shows: 0 },
    { barber_id: danial.id, name: 'Danial', bookings: 3, done: 1, takings: 25, no_shows: 1 },
  ]);
  assert.deepEqual(s.services, [
    { name: 'Haircut', done: 4, takings: 108 },
    { name: 'Skin fade', done: 1, takings: 30 },
  ]);

  // A barber with nothing booked is still there with nothing, so a week away
  // shows. One since marked away shows only for a week they had bookings in.
  const after = (await ali.rpc('shop_summary', { p_from: addDays(d, 7), p_to: addDays(d, 13) })).data;
  assert.deepEqual(after.barbers, [
    { barber_id: aliChair.id, name: 'Ali', bookings: 1, done: 1, takings: 99, no_shows: 0 },
    { barber_id: danial.id, name: 'Danial', bookings: 0, done: 0, takings: 0, no_shows: 0 },
    { barber_id: faiz.id, name: 'Faiz', bookings: 1, done: 0, takings: 0, no_shows: 1 },
  ]);

  // A quiet week; and the period before has the same length, except a whole month.
  const quiet = (await ali.rpc('shop_summary', { p_from: addDays(d, -50), p_to: addDays(d, -44) })).data;
  assert.equal(quiet.totals.done, 0);
  assert.deepEqual([quiet.hours, quiet.services], [[], []]);
  assert.deepEqual(
    quiet.barbers.map((b: { name: string; bookings: number; takings: number }) => [b.name, b.bookings, b.takings]),
    [
      ['Ali', 0, 0],
      ['Danial', 0, 0],
    ],
  );
  const before = async (from: string, to: string) =>
    (await ali.rpc('shop_summary', { p_from: from, p_to: to })).data.previous as { from: string; to: string };
  assert.equal((await before('2026-01-01', '2026-01-31')).from, '2025-12-01');
  const march = await before('2026-03-01', '2026-03-31');
  assert.deepEqual([march.from, march.to], ['2026-02-01', '2026-02-28']);
  assert.equal((await before('2026-03-01', '2026-03-15')).from, '2026-02-14');
  assert.equal((await before('2026-01-02', '2026-02-01')).from, '2025-12-02');

  // At most 93 days, and only forwards.
  assert.equal((await ali.rpc('shop_summary', { p_from: addDays(d, -92), p_to: d })).data.days.length, 93);
  const long = await ali.rpc('shop_summary', { p_from: addDays(d, -93), p_to: d });
  assert.equal(long.error?.code, '22023');
  assert.equal(long.error?.message, 'Pick a period of up to 93 days.');
  assert.equal((await ali.rpc('shop_summary', { p_from: d, p_to: addDays(d, -1) })).error?.code, '22023');
  assert.equal((await ali.rpc('shop_summary', { p_from: null, p_to: d })).error?.code, '22023');

  // Each owner gets their own shop; customers have none, and guests can't ask.
  assert.equal((await rahman.rpc('shop_summary', { p_from: d, p_to: addDays(d, 6) })).data.totals.takings, 500);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const notOwner = await hakim.rpc('shop_summary', { p_from: d, p_to: addDays(d, 6) });
  assert.equal(notOwner.error?.message, 'Set up your shop first.');
  assert.equal((await client().rpc('shop_summary', { p_from: d, p_to: addDays(d, 6) })).error?.code, '42501');
});

test('a week still running counts what is to come, and the week before only up to this time', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const [aliChair, danial] = barbers!;
  tables().bookings = tables().bookings.filter((b) => b.shop_id !== shop.id);
  const fixed = Date.now();
  const HOUR = 3_600_000;
  const add = (barber: unknown, at: number, price: number, status: string) =>
    insertRow('bookings', {
      shop_id: shop.id,
      barber_id: barber,
      guest_name: 'Guest',
      service_name: 'Haircut',
      price,
      starts_at: new Date(at).toISOString(),
      ends_at: new Date(at + 30 * 60_000).toISOString(),
      status,
    });
  add(aliChair.id, fixed + 2 * HOUR, 25, 'confirmed');
  add(danial.id, fixed - 10 * 60_000, 30, 'confirmed');
  add(aliChair.id, fixed - HOUR, 20, 'confirmed');
  add(danial.id, fixed - 24 * HOUR, 18, 'completed');
  // The week before: an hour before this time of the week, and an hour after.
  add(aliChair.id, fixed - 7 * 24 * HOUR - HOUR, 25, 'completed');
  add(aliChair.id, fixed - 7 * 24 * HOUR + HOUR, 30, 'completed');
  setClock(() => fixed);
  try {
    const { data: s, error } = await ali.rpc('shop_summary', { p_from: addDays(today(), -1), p_to: addDays(today(), 5) });
    assert.equal(error, null);
    // To come includes the one in the chair; over and not marked is counted apart.
    assert.deepEqual(s.totals, {
      done: 1,
      takings: 18,
      no_shows: 0,
      no_show_value: 0,
      cancelled: 0,
      to_come: 2,
      to_come_value: 55,
      unmarked: 1,
      unmarked_value: 20,
    });
    assert.equal(Date.parse(s.previous.until), fixed - 7 * 24 * HOUR, 'up to this time last week');
    assert.deepEqual([s.previous.done, s.previous.takings], [1, 25]);
    // A week that hasn't started has nothing before it to compare.
    const later = (await ali.rpc('shop_summary', { p_from: addDays(today(), 7), p_to: addDays(today(), 13) })).data;
    assert.ok(Date.parse(later.previous.until) < dayBounds(today(), TZ).start.getTime());
    assert.equal(later.previous.done, 0);
  } finally {
    setClock(() => Date.now());
  }
});

type Customer = {
  customer_key: string;
  customer_id: string | null;
  name: string | null;
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
  const hakim = Object.assign(profile('farid@demo.potongku.my'), { full_name: 'Hakim', phone: '011-2233 4455' });
  const farid = Object.assign(profile('weijie@demo.potongku.my'), { full_name: 'Farid', phone: '012-778 9012' });
  // A father and daughter on one phone.
  const ahSeng = Object.assign(profile('aiman@demo.potongku.my'), { full_name: 'Ah Seng', phone: '019-888 7777' });
  const meiLing = Object.assign(profile('syafiq@demo.potongku.my'), { full_name: 'Mei Ling', phone: '019-888 7777' });
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
    [null, 'Walk-in', null, false, -40, '17:00', 'completed'],
    [null, 'Walk-in', null, false, -33, '17:00', 'completed'],
    [null, 'Walk-in', null, false, -26, '17:00', 'completed'],
    [null, 'Walk-in', '', false, -19, '17:00', 'completed'],
    [null, ' walk-in', null, false, -12, '17:00', 'completed'],
    [null, 'Walk-in', '017-555 1234', false, -9, '17:30', 'completed'],
    [null, 'Daniel Tan', '016-778 2301', false, -60, '12:00', 'completed'],
    [null, 'Daniel Tan', '016-778 2301', false, -32, '12:00', 'completed'],
    [null, 'Walk-in', '0167782301', false, -4, '12:00', 'completed'],
    [null, 'Hakim', '011-2233 4455', false, -70, '11:00', 'completed'],
    [null, 'Hakim', '011-2233 4455', false, -42, '11:00', 'completed'],
    [hakim, null, null, false, 1, '11:00', 'confirmed'],
    [farid, null, null, false, -70, '10:00', 'completed'],
    [farid, null, null, false, -42, '10:00', 'completed'],
    [null, 'Farid', '+60 12-778 9012', false, -7, '10:00', 'completed'],
    [ahSeng, null, null, false, -15, '10:00', 'completed'],
    [meiLing, null, null, false, -16, '10:00', 'completed'],
    [null, 'Wei Ming', '019-888 7777', false, -10, '15:00', 'completed'],
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
  assert.deepEqual(names(all), [
    'Median',
    'Zaki',
    'Ben',
    'Abu',
    'Kumar',
    'uncle  LIM',
    'Daniel Tan',
    'Twice',
    'Farid',
    null,
    'Wei Ming',
    'Ah Seng',
    'Mei Ling',
    'Chong',
    'Kamal',
    'Hakim',
    'Old Timer',
    'Flake',
  ]);
  assert.ok(all.every((r) => r.total_count === 18 && r.due_count === 4));
  assert.deepEqual(names(all.filter((r) => r.is_due)), ['Median', 'Zaki', 'Ben', 'Abu']);
  // My shop's card counts the same people without the list.
  const cardCounts = async () => (await ali.rpc('shop_cards', { p_from: today(), p_to: today() })).data.customers;
  const listCounts = async () => {
    const [first] = await customers(ali, null, 1);
    return { total: first.total_count, due: first.due_count };
  };
  assert.deepEqual(await cardCounts(), { total: 18, due: 4 });
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
      total_count: 18,
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

  // Walk-ins added with no name: nobody, or their number with no name to show.
  assert.ok(!all.some((r) => /walk-in/i.test(r.name ?? '') || r.customer_key.startsWith('n:walk')));
  const unnamed = all.find((r) => r.customer_key === 'p:60175551234')!;
  assert.deepEqual([unnamed.name, unnamed.phone, unnamed.visits, unnamed.is_due], [null, '017-555 1234', 1, false]);
  const daniel = all.find((r) => r.customer_key === 'p:60167782301')!;
  assert.deepEqual([daniel.name, daniel.phone, daniel.visits, daniel.usual_gap_days], ['Daniel Tan', '0167782301', 3, 28]);
  assert.equal(Date.parse(daniel.last_visit_at!), Date.parse(kajang(-4, '12:00')));

  // Guests under an online customer's number are that customer, unless two share it.
  assert.deepEqual(
    [row('Hakim').customer_key, row('Hakim').phone, row('Hakim').visits, row('Hakim').is_due],
    [`c:${hakim.id}`, '011-2233 4455', 2, false],
  );
  assert.equal(Date.parse(row('Hakim').next_booking_at!), Date.parse(kajang(1, '11:00')));
  assert.deepEqual(
    [row('Farid').customer_key, row('Farid').visits, row('Farid').usual_gap_days, row('Farid').is_due],
    [`c:${farid.id}`, 3, 32, false],
  );
  assert.equal(Date.parse(row('Farid').last_visit_at!), Date.parse(kajang(-7, '10:00')));
  assert.ok(!all.some((r) => r.customer_key === 'p:601122334455' || r.customer_key === 'p:60127789012'));
  assert.deepEqual([row('Wei Ming').customer_key, row('Wei Ming').customer_id], ['p:60198887777', null]);
  assert.deepEqual((await customers(ali, '0112233')).map((r) => r.customer_key), [`c:${hakim.id}`]);

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
  assert.deepEqual(names(await customers(ali, null, 2, 16)), ['Old Timer', 'Flake']);
  assert.deepEqual(await customers(ali, null, 2, 18), []);
  assert.equal((await customers(ali, null, 0, 0)).length, 1);
  assert.equal((await customers(ali, null, null, -5)).length, 18);
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
  assert.equal((await customers(ali, null, 1))[0].total_count, 78);
  // One visit 28 to 89 days ago is due: guests 28 to 60.
  assert.deepEqual(await cardCounts(), { total: 78, due: 37 });
  assert.deepEqual(await cardCounts(), await listCounts());

  // Moved bookings count where they are now: Chong's next cut moves later and
  // stays to come; Zaki's last cut moves to 20 days ago, too soon to be due.
  const moveBy = (which: (b: Row) => boolean, days: number) => {
    const b = tables().bookings.find(which)!;
    Object.assign(b, {
      starts_at: new Date(Date.parse(String(b.starts_at)) + days * 86_400_000).toISOString(),
      ends_at: new Date(Date.parse(String(b.ends_at)) + days * 86_400_000).toISOString(),
      customer_change: 'moved',
      customer_changed_at: new Date().toISOString(),
    });
  };
  moveBy((b) => b.customer_id === chong.id && b.status === 'confirmed', 3);
  moveBy((b) => b.guest_name === 'Zaki', 20);
  assert.deepEqual(await cardCounts(), { total: 78, due: 36 });
  assert.deepEqual(await cardCounts(), await listCounts());

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
  // Walk-ins with no name aren't anyone, and Syafiq's WhatsApp booking is on his account.
  assert.ok(!all.some((r) => r.name === 'Walk-in'));
  const syafiq = all.filter((r) => r.name === 'Syafiq' || r.customer_key === 'p:601110987766');
  assert.deepEqual(
    syafiq.map((r) => [r.customer_key.slice(0, 2), r.phone]),
    [['c:', '011-1098 7766']],
  );

  // My shop's card asks for one row, for the counts.
  const one = await customers(ali, null, 1);
  assert.deepEqual(one, [all[0]]);
  assert.deepEqual((await customers(ali, 'daniel')).map((r) => r.name), ['Daniel Tan']);
});

// My shop's cards ------------------------------------------------------------

type ShopCards = {
  takings: Record<string, number>;
  customers: { total: number; due: number };
  reviews: { count: number; sum: number; newest: { rating: number; comment: string; first_name: string } | null };
  closures: { day: string; reason: string | null }[];
  photos: Row[];
};

test('My shop’s cards come in one answer, the same numbers as the screens behind them', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const cards = async (from: string, to: string) => {
    const { data, error } = await ali.rpc('shop_cards', { p_from: from, p_to: to });
    assert.equal(error, null);
    return data as ShopCards;
  };
  // What My shop asked for before, one request for each card.
  const before = async (from: string, to: string): Promise<ShopCards> => {
    const takings = await ali.rpc('shop_summary', { p_from: from, p_to: to });
    const [first] = (await ali.rpc('shop_customers', { p_search: null, p_limit: 1, p_offset: 0 })).data;
    const reviews = await ali
      .from('shops')
      .select('rating_count, rating_sum, reviews(rating, comment, first_name)')
      .eq('id', shop.id)
      .not('reviews.comment', 'is', null)
      .eq('reviews.removed', false)
      .order('created_at', { referencedTable: 'reviews', ascending: false })
      .limit(1, { referencedTable: 'reviews' })
      .single();
    const closed = await ali.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: today(), p_to: addDays(today(), 60) });
    // The photo card's own request until round 15 (useShopPhotos).
    const photos = await ali
      .from('shop_photos')
      .select(`${PHOTO_COLUMNS}, barber:barbers(name)`)
      .eq('shop_id', shop.id)
      .order('sort_order')
      .order('created_at')
      .order('id')
      .limit(MAX_PHOTOS);
    return {
      takings: takings.data.totals,
      customers: { total: first.total_count, due: first.due_count },
      reviews: {
        count: reviews.data!.rating_count,
        sum: reviews.data!.rating_sum,
        newest: reviews.data!.reviews[0] ?? null,
      },
      closures: (closed.data as { day: string; reason: string | null; is_closure: boolean }[])
        .filter((d) => d.is_closure)
        .map(({ day, reason }) => ({ day, reason })),
      photos: photos.data as Row[],
    };
  };

  // The sample shop has walk-ins, cancellations, no-shows, a moved booking and
  // a guest booked under a customer's number.
  const mine = tables().bookings.filter((b) => b.shop_id === shop.id);
  assert.ok(mine.some((b) => b.customer_change === 'moved'));
  for (const status of ['completed', 'cancelled', 'no_show', 'confirmed']) {
    assert.ok(mine.some((b) => b.status === status));
  }
  const week = periodDays('week', Date.now(), TZ);
  const month = periodDays('month', Date.now(), TZ);
  const periods: [string, string][] = [
    [week.from, week.to],
    [addDays(week.from, -7), addDays(week.from, -1)],
    [today(), today()],
    [month.from, month.to],
    [addDays(today(), -92), today()],
  ];
  for (const [from, to] of periods) assert.deepEqual(await cards(from, to), await before(from, to));
  const first = await cards(week.from, week.to);
  // Last week, as on a Monday this week has no cuts done yet.
  assert.ok((await cards(addDays(week.from, -7), addDays(week.from, -1))).takings.done > 0);
  assert.ok(first.reviews.newest != null);
  assert.deepEqual(first.customers.due, 4);
  assert.deepEqual(first.closures, []);

  // Days closed from today to 60 days ahead, each with its reason, in order.
  assert.equal((await ali.rpc('close_shop_days', { p_from: addDays(today(), 30), p_days: 2, p_reason: 'Hari Raya' })).error, null);
  assert.equal((await ali.rpc('close_shop_days', { p_from: addDays(today(), 60), p_days: 1, p_reason: 'Kenduri' })).error, null);
  insertRow('shop_closures', { shop_id: shop.id, day: addDays(today(), -1), reason: 'Yesterday' });
  insertRow('shop_closures', { shop_id: shop.id, day: addDays(today(), 61), reason: 'Too far' });
  assert.deepEqual((await cards(week.from, week.to)).closures, [
    { day: addDays(today(), 30), reason: 'Hari Raya' },
    { day: addDays(today(), 31), reason: 'Hari Raya' },
    { day: addDays(today(), 60), reason: 'Kenduri' },
  ]);
  assert.deepEqual(await cards(week.from, week.to), await before(week.from, week.to));

  // A cut marked done shows on coming back.
  const weekStart = dayBounds(week.from, TZ).start.getTime();
  const over = tables().bookings.find(
    (b) =>
      b.shop_id === shop.id &&
      !b.is_block &&
      b.status === 'confirmed' &&
      Date.parse(String(b.starts_at)) >= weekStart &&
      Date.parse(String(b.ends_at)) <= Date.now(),
  );
  if (over) {
    assert.equal((await ali.rpc('set_booking_status', { p_booking_id: over.id, p_status: 'completed' })).error, null);
    assert.equal((await cards(week.from, week.to)).takings.done, first.takings.done + 1);
    assert.deepEqual(await cards(week.from, week.to), await before(week.from, week.to));
  }

  // Each photo with its barber's name, as the photo card lists them; one
  // added, tagged, moved first or removed shows on coming back.
  assert.ok(first.photos.length > 0);
  assert.ok(first.photos.some((p) => (p.barber as { name: string } | null)?.name === 'Danial'));
  const [moved, gone] = first.photos.slice(-2) as { id: string }[];
  assert.equal((await ali.from('shop_photos').update({ sort_order: -1, caption: 'First now' }).eq('id', moved.id)).error, null);
  assert.equal((await ali.from('shop_photos').delete().eq('id', gone.id)).error, null);
  const photosNow = (await cards(week.from, week.to)).photos;
  assert.deepEqual([photosNow[0].id, photosNow[0].caption, photosNow.length], [moved.id, 'First now', first.photos.length - 1]);
  assert.deepEqual(await cards(week.from, week.to), await before(week.from, week.to));

  // A review the team removed is not the newest comment, and counts no more.
  const newest = tables()
    .reviews.filter((r) => r.shop_id === shop.id && r.comment != null)
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0];
  assert.equal(first.reviews.newest!.comment, newest.comment);
  insertRow('review_reports', { booking_id: newest.booking_id, shop_id: shop.id, reason: 'rude', outcome: 'removed' });
  const removed = await cards(week.from, week.to);
  assert.notEqual(removed.reviews.newest!.comment, newest.comment);
  assert.deepEqual(
    [removed.reviews.count, removed.reviews.sum],
    [first.reviews.count - 1, first.reviews.sum - Number(newest.rating)],
  );
  assert.deepEqual(removed, await before(week.from, week.to));

  // No review with a comment: the count and total still, and no comment.
  for (const r of tables().reviews) if (r.shop_id === shop.id) r.comment = null;
  const quiet = await cards(week.from, week.to);
  assert.equal(quiet.reviews.newest, null);
  assert.ok(quiet.reviews.count > 0);
  assert.deepEqual(quiet, await before(week.from, week.to));

  // The same checks as shop_summary, and only for the shop's owner.
  const long = await ali.rpc('shop_cards', { p_from: addDays(today(), -93), p_to: today() });
  assert.deepEqual([long.error?.code, long.error?.message], ['22023', 'Pick a period of up to 93 days.']);
  assert.equal((await ali.rpc('shop_cards', { p_from: null, p_to: today() })).error?.code, '22023');
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const notOwner = await hakim.rpc('shop_cards', { p_from: today(), p_to: today() });
  assert.deepEqual([notOwner.error?.code, notOwner.error?.message], ['P0002', 'Set up your shop first.']);
  assert.equal((await client().rpc('shop_cards', { p_from: today(), p_to: today() })).error?.code, '42501');
  // Another owner gets their own shop's.
  const rahman = await signedIn('rahman@demo.potongku.my');
  const kemas = await shopBySlug(rahman, 'kemas-barber-kajang');
  const theirs = (await rahman.rpc('shop_cards', { p_from: week.from, p_to: week.to })).data as ShopCards;
  assert.deepEqual([theirs.reviews.count, theirs.reviews.sum, theirs.closures], [kemas.rating_count, kemas.rating_sum, []]);
  assert.deepEqual(
    theirs.photos.map((p) => p.id),
    tables().shop_photos.filter((p) => p.shop_id === kemas.id).map((p) => p.id),
  );
});

// Reviews ----------------------------------------------------------------------

type MyBooking = Row & {
  shops: { slug: string };
  review: { rating: number; comment: string | null; first_name: string; reply: string | null; updated_at: string } | null;
};

async function myBookings(c: ReturnType<typeof client>) {
  const { data, error } = await c.rpc('my_bookings');
  assert.equal(error, null);
  return data.bookings as MyBooking[];
}

const doneAt = (list: MyBooking[], slug: string) =>
  list.find((b) => b.shops.slug === slug && b.status === 'completed')!;

/** [rating_count, rating_avg] as find_shops sends them. */
const ratingOf = async (slug: string) => {
  const { data } = await client().rpc('find_shops', { p_search: null, p_area: null, p_limit: 20, p_offset: 0 });
  const shop = (data as { slug: string; rating_count: number; rating_avg: number | null }[]).find((s) => s.slug === slug)!;
  return [shop.rating_count, shop.rating_avg];
};

const sampleTotals = (slug: string) => {
  const shop = tables().shops.find((s) => s.slug === slug)!;
  // A review the team removed counts for nobody.
  const own = tables().reviews.filter((r) => r.shop_id === shop.id && r.removed !== true);
  const sum = own.reduce((n, r) => n + Number(r.rating), 0);
  return { count: own.length, sum, avg: Math.round((sum * 10) / own.length) / 10 };
};

test('customers rate a finished cut for 14 days, and each shop keeps count', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const mine = await myBookings(hakim);
  // The sample leaves his cut at Kemas unrated, and his older one at Ali's rated.
  const kemasCut = doneAt(mine, 'kemas-barber-kajang');
  const aliCut = doneAt(mine, 'ali-barber');
  assert.equal(kemasCut.review, null);
  assert.equal(aliCut.review?.rating, 5);
  const kemas = sampleTotals('kemas-barber-kajang');
  assert.deepEqual(await ratingOf('kemas-barber-kajang'), [kemas.count, kemas.avg]);

  const rate = (id: unknown, rating: unknown, comment: unknown = null, name?: unknown) =>
    hakim.rpc('rate_booking', { p_booking_id: id, p_rating: rating, p_comment: comment, p_name: name });
  const first = await rate(kemasCut.id, 5, '  Great hot towel shave \n');
  assert.equal(first.error, null);
  assert.deepEqual(
    [first.data.rating, first.data.comment, first.data.first_name, first.data.reply],
    [5, 'Great hot towel shave', 'Hakim', null],
  );
  const avg = (sum: number, count: number) => Math.round((sum * 10) / count) / 10;
  assert.deepEqual(await ratingOf('kemas-barber-kajang'), [kemas.count + 1, avg(kemas.sum + 5, kemas.count + 1)]);

  // Rating again changes the same review; a blank comment is none.
  const again = await rate(kemasCut.id, 3, '   ');
  assert.equal(again.error, null);
  assert.deepEqual([again.data.rating, again.data.comment], [3, null]);
  assert.equal(tables().reviews.filter((r) => r.booking_id === kemasCut.id).length, 1);
  assert.deepEqual(await ratingOf('kemas-barber-kajang'), [kemas.count + 1, avg(kemas.sum + 3, kemas.count + 1)]);
  assert.equal((await myBookings(hakim)).find((b) => b.id === kemasCut.id)?.review?.rating, 3);

  // He can change the name it shows, which stays until he changes it again,
  // tidied and cut to 40 characters; a blank one is no change.
  assert.equal((await rate(kemasCut.id, 3, null, '  Kim \n Hakim ')).data.first_name, 'Kim Hakim');
  assert.equal((await rate(kemasCut.id, 3)).data.first_name, 'Kim Hakim');
  assert.equal((await rate(kemasCut.id, 3, null, '   ')).data.first_name, 'Kim Hakim');
  assert.equal((await rate(kemasCut.id, 3, null, 'Kim '.repeat(15))).data.first_name, 'Kim '.repeat(10).trimEnd());
  assert.equal((await rate(kemasCut.id, 3, null, 'Hakim')).data.first_name, 'Hakim');
  assert.equal((await myBookings(hakim)).find((b) => b.id === kemasCut.id)?.review?.first_name, 'Hakim');

  // 280 characters fit, 281 don't.
  assert.equal((await rate(kemasCut.id, 4, 'x'.repeat(280))).error, null);
  const long = await rate(kemasCut.id, 4, 'x'.repeat(281));
  assert.deepEqual([long.error?.code, long.error?.message], ['22001', 'Please keep your comment under 280 characters.']);
  for (const stars of [0, 6, null]) {
    const bad = await rate(kemasCut.id, stars);
    assert.deepEqual([bad.error?.code, bad.error?.message], ['22023', 'Pick from 1 to 5 stars.']);
  }

  // Too long ago, still to come, or not marked done.
  const window = 'You can rate a cut once the shop marks it done, until 14 days after it.';
  assert.equal((await rate(aliCut.id, 4)).error?.message, window);
  const coming = mine.find((b) => b.status === 'confirmed')!;
  assert.equal((await rate(coming.id, 4)).error?.message, window);
  const kemasShop = tables().shops.find((s) => s.slug === 'kemas-barber-kajang')!;
  const chair = tables().barbers.find((b) => b.shop_id === kemasShop.id)!;
  const notDone = insertRow('bookings', {
    shop_id: kemasShop.id,
    barber_id: chair.id,
    customer_id: kemasCut.customer_id,
    service_name: 'Haircut',
    price: 18,
    starts_at: kajang(-3, '08:00'),
    ends_at: kajang(-3, '08:30'),
  });
  assert.equal((await rate(notDone.id, 4)).error?.message, window);
  const rahman = await signedIn('rahman@demo.potongku.my');
  assert.equal((await rahman.rpc('set_booking_status', { p_booking_id: notDone.id, p_status: 'completed' })).error, null);
  assert.equal((await rate(notDone.id, 4)).error, null);

  // Up to the minute 14 days after it started.
  const start = Date.parse(String(notDone.starts_at));
  try {
    setClock(() => start + 14 * 86_400_000 - 60_000);
    assert.equal((await rate(notDone.id, 5)).error, null);
    setClock(() => start + 14 * 86_400_000);
    assert.equal((await rate(notDone.id, 2)).error?.message, window);
  } finally {
    setClock(() => Date.now());
  }

  // Someone else's cut, a guest, and an owner at their own shop.
  const farid = tables().profiles.find((p) => p.full_name === 'Farid')!;
  const faridsCut = tables().bookings.find((b) => b.customer_id === farid.id && b.status === 'completed')!;
  const notMine = await rate(faridsCut.id, 1);
  assert.deepEqual([notMine.error?.code, notMine.error?.message], ['P0002', 'Booking not found.']);
  const guest = await client().rpc('rate_booking', { p_booking_id: kemasCut.id, p_rating: 1 });
  assert.equal(guest.error?.code, '42501');
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const aliId = (await ali.auth.getUser()).data.user!.id;
  const aliShop = tables().shops.find((s) => s.owner_id === aliId)!;
  const ownCut = insertRow('bookings', {
    shop_id: aliShop.id,
    barber_id: tables().barbers.find((b) => b.shop_id === aliShop.id)!.id,
    customer_id: aliId,
    service_name: 'Haircut',
    price: 20,
    starts_at: kajang(-3, '07:00'),
    ends_at: kajang(-3, '07:30'),
    status: 'completed',
  });
  const own = await ali.rpc('rate_booking', { p_booking_id: ownCut.id, p_rating: 5 });
  assert.equal(own.error?.message, 'You can\'t rate your own shop.');

  // Only through the functions, and owners can't touch their count.
  const direct = await hakim.from('reviews').insert({ booking_id: kemasCut.id, rating: 5 });
  assert.equal(direct.error?.code, '42501');
  const changed = await hakim.from('reviews').update({ rating: 1 }).eq('booking_id', kemasCut.id);
  assert.equal(changed.error?.code, '42501');
  const removed = await rahman.from('reviews').delete().eq('booking_id', kemasCut.id);
  assert.equal(removed.error?.code, '42501');
  const counted = await rahman.from('shops').update({ rating_count: 100, rating_sum: 500 }).eq('id', kemasShop.id);
  assert.equal(counted.error?.code, '42501');
});

test('anyone reads a live shop’s reviews, but not who wrote them, and the owner replies', async () => {
  const guest = client();
  const kemas = tables().shops.find((s) => s.slug === 'kemas-barber-kajang')!;
  const totals = sampleTotals('kemas-barber-kajang');
  // The shop page's first page, newest first.
  const page = await guest
    .from('reviews')
    .select('booking_id, rating, comment, first_name, reply, replied_at, created_at, barbers(name)')
    .eq('shop_id', kemas.id)
    .order('created_at', { ascending: false })
    .order('booking_id')
    .range(0, 4);
  assert.equal(page.error, null);
  assert.equal(page.data!.length, 5);
  const times = page.data!.map((r) => Date.parse(r.created_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok(page.data!.every((r) => typeof (r.barbers as unknown as { name: string }).name === 'string'));
  // Each with the name its customer goes by: Tan Wei Jie is Wei Jie.
  const reviewer = (bookingId: string) =>
    tables().profiles.find((p) => p.id === tables().reviews.find((r) => r.booking_id === bookingId)!.customer_id)!;
  assert.deepEqual(
    page.data!.map((r) => r.first_name),
    page.data!.map((r) => firstName(String(reviewer(r.booking_id).full_name))),
  );
  const weiJie = tables().reviews.find((r) => r.shop_id === kemas.id && reviewer(String(r.booking_id)).full_name === 'Tan Wei Jie');
  assert.equal(weiJie?.first_name, 'Wei Jie');
  const rest = await guest.from('reviews').select('booking_id').eq('shop_id', kemas.id).range(5, 14);
  assert.equal(rest.data!.length, totals.count - 5);

  // Nothing ties a review to the account that wrote it.
  for (const query of [
    guest.from('reviews').select('*'),
    guest.from('reviews').select('booking_id, customer_id'),
    guest.from('reviews').select('booking_id').eq('customer_id', kemas.owner_id),
    guest.from('reviews').select('booking_id, profiles(full_name)'),
  ]) {
    assert.equal((await query).error?.code, '42501');
  }
  // Nor to its booking, which only the customer and the shop can see.
  const withBooking = await guest.from('reviews').select('booking_id, bookings(customer_id)').eq('shop_id', kemas.id);
  assert.ok(withBooking.data!.every((r) => r.bookings === null));

  // The owner answers, changes the answer, and takes it away.
  const rahman = await signedIn('rahman@demo.potongku.my');
  const target = page.data!.find((r) => r.reply === null)!;
  const reply = (c: ReturnType<typeof client>, text: unknown) =>
    c.rpc('reply_to_review', { p_booking_id: target.booking_id, p_reply: text });
  const answered = await reply(rahman, '  Thanks for coming! \n');
  assert.equal(answered.error, null);
  assert.equal(answered.data.reply, 'Thanks for coming!');
  assert.ok(Math.abs(Date.parse(answered.data.replied_at) - Date.now()) < 5_000);
  const seen = await guest.from('reviews').select('reply').eq('booking_id', target.booking_id).single();
  assert.equal(seen.data?.reply, 'Thanks for coming!');
  assert.equal((await reply(rahman, 'Thank you!')).data.reply, 'Thank you!');
  const long = await reply(rahman, 'x'.repeat(281));
  assert.deepEqual([long.error?.code, long.error?.message], ['22001', 'Please keep your reply under 280 characters.']);
  const cleared = await reply(rahman, '   ');
  assert.deepEqual([cleared.data.reply, cleared.data.replied_at], [null, null]);
  // A reply changes no count.
  assert.deepEqual(await ratingOf('kemas-barber-kajang'), [totals.count, totals.avg]);

  // Not another shop's owner, the customer, or a guest.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  assert.equal((await reply(ali, 'Hi')).error?.message, 'Review not found.');
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  assert.equal((await reply(hakim, 'Hi')).error?.message, 'Review not found.');
  assert.equal((await reply(guest, 'Hi')).error?.code, '42501');

  // My shop's card: the count, the total and the newest review with a comment, in one request,
  // ordered by a column it doesn't read, as the app asks.
  const cardOf = (c: ReturnType<typeof client>, shopId: unknown) =>
    c
      .from('shops')
      .select('rating_count, rating_sum, reviews(rating, comment, first_name)')
      .eq('id', shopId)
      .not('reviews.comment', 'is', null)
      .order('created_at', { referencedTable: 'reviews', ascending: false })
      .limit(1, { referencedTable: 'reviews' })
      .single();
  const newestComment = (shopId: unknown) =>
    tables()
      .reviews.filter((r) => r.shop_id === shopId && r.comment != null)
      .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0].comment;
  const card = await cardOf(rahman, kemas.id);
  assert.equal(card.error, null);
  assert.deepEqual([card.data!.rating_count, card.data!.rating_sum], [totals.count, totals.sum]);
  assert.equal(card.data!.reviews.length, 1);
  assert.equal(card.data!.reviews[0].comment, newestComment(kemas.id));
  // At Ali's the first review left is not the newest, so this one shows the order is kept.
  const aliShop = tables().shops.find((s) => s.slug === 'ali-barber')!;
  assert.equal((await cardOf(ali, aliShop.id)).data!.reviews[0].comment, newestComment(aliShop.id));

  // Paused, its reviews are hidden, except from the owner and each reviewer.
  assert.equal((await hakim.rpc('rate_booking', { p_booking_id: doneAt(await myBookings(hakim), 'kemas-barber-kajang').id, p_rating: 4 })).error, null);
  assert.equal((await rahman.from('shops').update({ is_published: false }).eq('id', kemas.id)).error, null);
  const count = async (c: ReturnType<typeof client>) =>
    (await c.from('reviews').select('booking_id', { count: 'exact', head: true }).eq('shop_id', kemas.id)).count;
  assert.equal(await count(guest), 0);
  assert.equal(await count(ali), 0);
  assert.equal(await count(hakim), 1);
  assert.equal(await count(rahman), totals.count + 1);
});

/** What the owner's Reviews asks for: each review with its report, or null. */
const ownerReviews = async (c: ReturnType<typeof client>, shopId: unknown) => {
  const { data, error } = await c
    .from('reviews')
    .select(`booking_id, rating, comment, removed, report:review_reports(${REPORT_COLUMNS})`)
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  assert.equal(error, null);
  return data as unknown as { booking_id: string; rating: number; comment: string | null; removed: boolean; report: Row | null }[];
};

test('an owner reports an unfair review once, and it counts until the team removes it', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
  const aiman = tables().profiles.find((p) => p.full_name === 'Aiman')!;
  const ravi = tables().profiles.find((p) => p.full_name === 'Ravi')!;
  const target = tables().reviews.find((r) => r.shop_id === shop.id && r.customer_id === aiman.id)!;
  // The rows as they are now: each change puts a new one in the table.
  const review = () => tables().reviews.find((r) => r.booking_id === target.booking_id)!;
  const reported = () => tables().review_reports.find((r) => r.booking_id === target.booking_id);
  const report = (c: ReturnType<typeof client>, bookingId: unknown, reason: unknown, note?: unknown) =>
    c.rpc('report_review', { p_booking_id: bookingId, p_reason: reason, p_note: note });

  // Ravi's one star about parking came already reported, and is waiting for the team.
  const listed = await ownerReviews(ali, shop.id);
  const parking = listed.find((r) => tables().reviews.find((x) => x.booking_id === r.booking_id)!.customer_id === ravi.id && r.rating === 1)!;
  assert.deepEqual([parking.removed, parking.report?.reason, parking.report?.outcome, parking.report?.decided_at], [false, 'off_topic', null, null]);
  assert.match(String(parking.comment), /parking/);
  assert.deepEqual(
    listed.filter((r) => r.report).map((r) => r.booking_id),
    [parking.booking_id],
  );
  const totals = sampleTotals('ali-barber');
  assert.deepEqual(await ratingOf('ali-barber'), [totals.count, totals.avg]);
  assert.ok(totals.count >= 10);

  // Not another shop's owner, a customer (the reviewer neither) or a guest; and never with a reason it doesn't know.
  const rahman = await signedIn('rahman@demo.potongku.my');
  const aimanClient = await signedIn('aiman@demo.potongku.my');
  for (const c of [rahman, aimanClient]) {
    const no = await report(c, target.booking_id, 'rude');
    assert.deepEqual([no.error?.code, no.error?.message], ['P0002', 'Review not found.']);
  }
  assert.equal((await report(client(), target.booking_id, 'rude')).error?.code, '42501');
  assert.equal((await report(ali, crypto.randomUUID(), 'rude')).error?.message, 'Review not found.');
  for (const reason of [null, 'spam', 'Rude']) {
    const bad = await report(ali, target.booking_id, reason);
    assert.deepEqual([bad.error?.code, bad.error?.message], ['22023', 'Pick a reason.']);
  }
  const long = await report(ali, target.booking_id, 'other', 'x'.repeat(201));
  assert.deepEqual([long.error?.code, long.error?.message], ['22001', 'Please keep your note under 200 characters.']);
  assert.equal(tables().review_reports.length, 1);

  // The owner's report, with the note trimmed; it stays up and counts while the team looks.
  const sent = await report(ali, target.booking_id, 'not_customer', `  ${'Never came in. '.repeat(13)}\n`);
  assert.equal(sent.error, null);
  assert.deepEqual(
    [sent.data.reason, sent.data.note, sent.data.outcome, sent.data.decided_at],
    ['not_customer', 'Never came in. '.repeat(13).trim(), null, null],
  );
  assert.equal(sent.data.note.length, 194);
  const twice = await report(ali, target.booking_id, 'rude');
  assert.deepEqual([twice.error?.code, twice.error?.message], ['23505', 'This review has already been reported.']);
  assert.equal(reported()!.reason, 'not_customer');
  assert.deepEqual(await ratingOf('ali-barber'), [totals.count, totals.avg]);
  const guest = client();
  const onPage = async () =>
    ((await guest.rpc('shop_page', { p_slug: 'ali-barber' })).data.reviews as Row[]).some((r) => r.booking_id === target.booking_id);
  assert.equal(await onPage(), true);
  // An empty note is no note.
  const other = tables().reviews.find((r) => r.shop_id === shop.id && r.comment == null)!;
  assert.equal((await report(ali, other.booking_id, 'other', '  \n ')).data.note, null);

  // Only the owner reads reports: not the reviewer, another owner or a guest, by any way in.
  for (const c of [aimanClient, rahman, await signedIn(DEMO_CUSTOMER_EMAIL)]) {
    assert.deepEqual((await c.from('review_reports').select('reason, outcome')).data, []);
    const theirs = await c.from('reviews').select(`booking_id, report:review_reports(${REPORT_COLUMNS})`).eq('shop_id', shop.id);
    assert.equal(theirs.error, null);
    assert.ok(theirs.data!.length > 0 && theirs.data!.every((r) => r.report === null));
  }
  assert.equal((await guest.from('review_reports').select('reason')).error?.code, '42501');
  assert.equal((await guest.from('reviews').select('booking_id, review_reports(reason)').eq('shop_id', shop.id)).error?.code, '42501');
  assert.equal((await ali.from('review_reports').select('shop_id')).error?.code, '42501');
  assert.ok(!JSON.stringify((await aimanClient.rpc('my_bookings')).data).includes('not_customer'));
  // Nor writes one, or decides it, except through report_review.
  const direct = [
    ali.from('review_reports').insert({ booking_id: target.booking_id, shop_id: shop.id, reason: 'rude' }),
    ali.from('review_reports').update({ outcome: 'removed' }).eq('booking_id', target.booking_id),
    ali.from('review_reports').delete().eq('booking_id', target.booking_id),
    ali.from('reviews').update({ removed: true }).eq('booking_id', target.booking_id),
  ];
  for (const query of direct) assert.equal((await query).error?.code, '42501');

  // The team removes it: off the shop's page, the barber's reviews and the stars; the owner still sees it, removed.
  const barber = () => tables().barbers.find((b) => b.id === target.barber_id)!;
  const barberBefore = [barber().rating_count, barber().rating_sum];
  const decide = (outcome: string | null) => updateRows('review_reports', [reported()!], { outcome });
  decide('removed');
  assert.ok(Math.abs(Date.parse(String(reported()!.decided_at)) - demoNow()) < 5_000);
  assert.equal(review().removed, true);
  const less = sampleTotals('ali-barber');
  assert.deepEqual([less.count, less.sum], [totals.count - 1, totals.sum - Number(target.rating)]);
  assert.deepEqual(await ratingOf('ali-barber'), [less.count, less.avg]);
  assert.deepEqual([barber().rating_count, barber().rating_sum], [Number(barberBefore[0]) - 1, Number(barberBefore[1]) - Number(target.rating)]);
  assert.equal(await onPage(), false);
  for (const c of [guest, aimanClient, ali]) {
    const theBarbers = await c
      .from('reviews')
      .select('booking_id')
      .eq('shop_id', shop.id)
      .eq('barber_id', target.barber_id)
      .eq('removed', false);
    assert.ok(!theBarbers.data!.some((r) => r.booking_id === target.booking_id));
  }
  assert.equal((await guest.from('reviews').select('booking_id').eq('booking_id', target.booking_id)).data!.length, 0);
  const mine = (await ownerReviews(ali, shop.id)).find((r) => r.booking_id === target.booking_id)!;
  assert.deepEqual([mine.removed, mine.report?.outcome], [true, 'removed']);
  // The reviewer still has their rating on My bookings, though no one else sees it.
  assert.equal((await myBookings(aimanClient)).find((b) => b.id === target.booking_id)?.review?.rating, target.rating);
  const noReply = await ali.rpc('reply_to_review', { p_booking_id: target.booking_id, p_reply: 'Hmm' });
  assert.deepEqual([noReply.error?.code, noReply.error?.message], ['42501', 'This review was removed, so it can\'t have a reply.']);
  // Changed while removed, it stays removed, and still counts for nobody.
  assert.equal((await aimanClient.rpc('rate_booking', { p_booking_id: target.booking_id, p_rating: 2, p_comment: 'Meh' })).error, null);
  assert.deepEqual([review().removed, reported()!.outcome], [true, 'removed']);
  assert.deepEqual(await ratingOf('ali-barber'), [less.count, less.avg]);

  // Kept after all (as the team can put right): back on the page and in the stars, at its new rating.
  decide('kept');
  assert.equal(review().removed, false);
  const back = sampleTotals('ali-barber');
  assert.deepEqual([back.count, back.sum], [totals.count, totals.sum - Number(target.rating) + 2]);
  assert.deepEqual(await ratingOf('ali-barber'), [back.count, back.avg]);
  assert.deepEqual([barber().rating_count, barber().rating_sum], [barberBefore[0], Number(barberBefore[1]) - Number(target.rating) + 2]);
  assert.equal(await onPage(), true);
  assert.equal((await ali.rpc('reply_to_review', { p_booking_id: target.booking_id, p_reply: 'Thanks!' })).error, null);
  // A reply is the owner's, so it leaves the team's decision alone; the customer changing the review sends it back.
  assert.equal(reported()!.outcome, 'kept');
  assert.equal((await aimanClient.rpc('rate_booking', { p_booking_id: target.booking_id, p_rating: 2, p_comment: 'Meh, again' })).error, null);
  assert.deepEqual([reported()!.outcome, reported()!.decided_at], [null, null]);
  assert.equal((await ownerReviews(ali, shop.id)).find((r) => r.booking_id === target.booking_id)!.report?.outcome, null);
  // Saved again with nothing changed is no change.
  decide('kept');
  assert.equal((await aimanClient.rpc('rate_booking', { p_booking_id: target.booking_id, p_rating: 2, p_comment: 'Meh, again' })).error, null);
  assert.equal(reported()!.outcome, 'kept');

  // Undone: the report deleted, the review is as it was and can be reported again.
  decide('removed');
  assert.equal(review().removed, true);
  deleteRows('review_reports', [reported()!]);
  assert.equal(review().removed, false);
  assert.deepEqual(await ratingOf('ali-barber'), [back.count, back.avg]);
  assert.equal((await report(ali, target.booking_id, 'rude')).error, null);

  // A removed review goes with its customer's account, report and all, and the counts stay right.
  decide('removed');
  assert.equal((await aimanClient.rpc('delete_my_account')).error, null);
  assert.equal(reported(), undefined);
  const after = sampleTotals('ali-barber');
  assert.deepEqual(await ratingOf('ali-barber'), [after.count, after.avg]);
  for (const b of tables().barbers) assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
});

test('deleting an account takes its reviews off the shop', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const kemasCut = doneAt(await myBookings(hakim), 'kemas-barber-kajang');
  const kemas = sampleTotals('kemas-barber-kajang');
  const ali = sampleTotals('ali-barber');
  assert.equal((await hakim.rpc('rate_booking', { p_booking_id: kemasCut.id, p_rating: 1 })).error, null);
  assert.equal((await ratingOf('kemas-barber-kajang'))[0], kemas.count + 1);
  assert.equal((await hakim.rpc('delete_my_account')).error, null);
  assert.deepEqual(await ratingOf('kemas-barber-kajang'), [kemas.count, kemas.avg]);
  // His sample rating at Ali's goes too.
  assert.equal((await ratingOf('ali-barber'))[0], ali.count - 1);
  assert.equal(tables().reviews.some((r) => r.booking_id === kemasCut.id), false);

  // An owner's shop takes its reviews with it.
  const rahman = await signedIn('rahman@demo.potongku.my');
  const shop = tables().shops.find((s) => s.slug === 'kemas-barber-kajang')!;
  assert.equal((await rahman.rpc('delete_my_account')).error, null);
  assert.equal(tables().reviews.some((r) => r.shop_id === shop.id), false);
});

test('the sample reviews sit on each shop’s own finished cuts, and Hakim has one to rate', () => {
  for (const r of tables().reviews) {
    const b = tables().bookings.find((x) => x.id === r.booking_id)!;
    assert.deepEqual([b.shop_id, b.barber_id, b.customer_id, b.status], [r.shop_id, r.barber_id, r.customer_id, 'completed']);
    const at = Date.parse(String(r.created_at));
    assert.ok(at > Date.parse(String(b.ends_at)) && at <= Date.now() && at < Date.parse(String(b.starts_at)) + 14 * 86_400_000);
  }
  // Every shop has enough to show its stars, and the counts add up.
  for (const shop of tables().shops) {
    const { count, sum } = sampleTotals(String(shop.slug));
    assert.ok(count >= 3, `${shop.name} has ${count} reviews`);
    assert.deepEqual([shop.rating_count, shop.rating_sum], [count, sum]);
  }
  const hakim = tables().profiles.find((p) => p.full_name === 'Hakim')!;
  const kemas = tables().shops.find((s) => s.slug === 'kemas-barber-kajang')!;
  const cut = tables().bookings.find((b) => b.customer_id === hakim.id && b.shop_id === kemas.id)!;
  assert.equal(cut.status, 'completed');
  assert.ok(Date.parse(String(cut.starts_at)) > Date.now() - 13 * 86_400_000);
  assert.equal(tables().reviews.some((r) => r.booking_id === cut.id), false);
});

test('opened on a later day, ratings and replies people left stay, and the sample ones follow their cuts', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
    const cut = doneAt(await myBookings(hakim), 'kemas-barber-kajang');
    assert.equal((await hakim.rpc('rate_booking', { p_booking_id: cut.id, p_rating: 4, p_comment: 'Kemas!' })).error, null);
    // Ali answers a review on one of Daniel's regular cuts.
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const daniel = tables().profiles.find((p) => p.full_name === 'Daniel Tan')!;
    const his = tables().reviews.find((r) => r.customer_id === daniel.id)!;
    assert.equal((await ali.rpc('reply_to_review', { p_booking_id: his.booking_id, p_reply: 'Thanks!' })).error, null);
    // And reports one of Jason's, which the team removes.
    const jason = tables().profiles.find((p) => p.full_name === 'Jason')!;
    const unfair = tables().reviews.find((r) => r.customer_id === jason.id && r.shop_id === his.shop_id)!;
    assert.equal((await ali.rpc('report_review', { p_booking_id: unfair.booking_id, p_reason: 'rude' })).error, null);
    updateRows('review_reports', tables().review_reports.filter((r) => r.booking_id === unfair.booking_id), { outcome: 'removed' });
    save();

    setClock(() => Date.now() + 86_400_000);
    reloadTables();
    // His cut is laid out again a day on, still with his rating, and Ali's answer stays.
    const mine = tables().reviews.find((r) => r.booking_id === cut.id);
    assert.deepEqual([mine?.rating, mine?.comment], [4, 'Kemas!']);
    assert.equal(tables().reviews.find((r) => r.booking_id === his.booking_id)?.reply, 'Thanks!');
    // The reports stay with their reviews: Ravi's sample one still open, Jason's still removed.
    const outcomes = () => tables().review_reports.map((r) => [r.booking_id, r.outcome]);
    const ravi = tables().profiles.find((p) => p.full_name === 'Ravi')!;
    const parking = tables().reviews.find((r) => r.customer_id === ravi.id && r.shop_id === his.shop_id && r.rating === 1)!;
    assert.deepEqual(outcomes(), [
      [parking.booking_id, null],
      [unfair.booking_id, 'removed'],
    ]);
    assert.equal(tables().reviews.find((r) => r.booking_id === unfair.booking_id)?.removed, true);
    // Daniel and Amirul joined after the first bookings, so their ids hang on
    // the weekday; their cuts are still theirs.
    assert.ok(!tables().bookings.some((b) => b.guest_name === 'Deleted account'));
    // Every review still sits on its customer's cut, and the counts follow.
    for (const r of tables().reviews) {
      const b = tables().bookings.find((x) => x.id === r.booking_id)!;
      assert.deepEqual([b.shop_id, b.barber_id, b.customer_id], [r.shop_id, r.barber_id, r.customer_id]);
    }
    for (const shop of tables().shops) {
      const { count, sum } = sampleTotals(String(shop.slug));
      assert.deepEqual([shop.rating_count, shop.rating_sum], [count, sum]);
    }

    // A demo saved before reviews came in gets the sample ones that same day.
    const [key, json] = [...saved.entries()][0];
    const old = JSON.parse(json);
    delete old.tables.reviews;
    delete old.tables.review_reports;
    for (const s of old.tables.shops) {
      delete s.rating_count;
      delete s.rating_sum;
    }
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.ok(tables().shops.every((s) => (s.rating_count as number) >= 3));
    assert.equal(JSON.parse(saved.get(key)!).tables.reviews.length, tables().reviews.length, 'and saves them');
    // With the sample report, and no other.
    assert.deepEqual(outcomes(), [[parking.booking_id, null]]);
    assert.equal(tables().reviews.filter((r) => r.removed).length, 0);

    // A demo saved before reports came keeps its reviews and gets the sample report.
    const kept = JSON.parse(saved.get(key)!);
    delete kept.tables.review_reports;
    for (const r of kept.tables.reviews) delete r.removed;
    saved.set(key, JSON.stringify(kept));
    reloadTables();
    assert.deepEqual(outcomes(), [[parking.booking_id, null]]);
    assert.ok(tables().reviews.every((r) => r.removed === false));
    assert.ok(Array.isArray(JSON.parse(saved.get(key)!).tables.review_reports), 'and saves it');
  } finally {
    setClock(() => Date.now());
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

// Each barber's line and stars ----------------------------------------------------

/** A barber's review count and total, added up from the reviews themselves. */
const barberTotals = (barberId: unknown) => {
  const own = tables().reviews.filter((r) => r.barber_id === barberId && r.removed !== true);
  return [own.length, own.reduce((n, r) => n + Number(r.rating), 0)];
};

const barberNamed = (slug: string, name: string) => {
  const shop = tables().shops.find((s) => s.slug === slug)!;
  return tables().barbers.find((b) => b.shop_id === shop.id && b.name === name)!;
};

test('the shop page’s barbers come with each one’s line and stars, in the request it already sends', async () => {
  const guest = client();
  const shop = await shopBySlug(guest, 'ali-barber');
  const { data, error } = await guest
    .from('barbers')
    .select('*, working_hours(weekday, opens_at, closes_at)')
    .eq('shop_id', shop.id)
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  assert.equal(error, null);
  assert.deepEqual(
    data!.map((b) => [b.name, b.about]),
    [
      ['Ali', 'Skin fades and beard trims, cutting since 2015'],
      ['Danial', 'Kids’ cuts, patient with first-timers'],
    ],
  );
  for (const b of data!) {
    assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
    // Enough for both to show their stars, whatever the weekday.
    assert.ok(b.rating_count >= 3, `${b.name} has ${b.rating_count} reviews`);
  }
  // Every sample barber's figures add up, and one at Kemas hasn't written a line yet.
  for (const b of tables().barbers) assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
  assert.equal(barberNamed('kemas-barber-kajang', 'Wei Ming').about, null);
});

test('a shop’s reviews narrow to one barber, newest first, a page at a time', async () => {
  const guest = client();
  const danial = barberNamed('ali-barber', 'Danial');
  // By the barber alone: their id says which shop.
  const page = (offset: number, size: number) =>
    guest
      .from('reviews')
      .select('booking_id, rating, created_at, barbers(name)')
      .eq('barber_id', danial.id)
      .order('created_at', { ascending: false })
      .order('booking_id')
      .range(offset, offset + size);
  const first = await page(0, 3);
  assert.equal(first.error, null);
  assert.equal(first.data!.length, Math.min(4, danial.rating_count as number));
  assert.ok(first.data!.every((r) => (r.barbers as unknown as { name: string }).name === 'Danial'));
  const seen: string[] = [];
  for (let offset = 0; ; offset += 2) {
    const { data } = await page(offset, 1);
    seen.push(...data!.map((r) => r.booking_id));
    if (data!.length < 2) break;
  }
  assert.equal(seen.length, danial.rating_count);
  assert.equal(new Set(seen).size, seen.length);
  const times = seen.map((id) => Date.parse(String(tables().reviews.find((r) => r.booking_id === id)!.created_at)));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  // Still nothing says who wrote them.
  assert.equal((await guest.from('reviews').select('customer_id').eq('barber_id', danial.id)).error?.code, '42501');

  // The owner's Reviews: the shop's figures and each reviewed barber's, in the team's order, in one request.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const totals = await ali
    .from('shops')
    .select('rating_count, rating_sum, barbers(id, name, rating_count, rating_sum)')
    .eq('id', shop.id)
    .gt('barbers.rating_count', 0)
    .order('sort_order', { referencedTable: 'barbers' })
    .order('created_at', { referencedTable: 'barbers' })
    .single();
  assert.equal(totals.error, null);
  assert.deepEqual(
    totals.data!.barbers.map((b) => [b.name, b.rating_count, b.rating_sum]),
    ['Ali', 'Danial'].map((name) => [name, ...barberTotals(barberNamed('ali-barber', name).id)]),
  );
});

test('the owner writes each barber’s line, and nobody writes their stars', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const danial = barberNamed('ali-barber', 'Danial');
  const write = (c: ReturnType<typeof client>, about: unknown, id = danial.id) =>
    c.from('barbers').update({ about }).eq('id', id).select('about');
  assert.deepEqual((await write(ali, 'Fades and kids’ cuts, 6 years')).data, [{ about: 'Fades and kids’ cuts, 6 years' }]);
  assert.equal((await write(ali, 'x'.repeat(60))).error, null);
  for (const bad of ['x'.repeat(61), '', '   ', 'Fades\nand beards', 'Kids\tcuts']) {
    assert.equal((await write(ali, bad)).error?.code, '23514', JSON.stringify(bad));
  }
  assert.deepEqual((await write(ali, null)).data, [{ about: null }]);
  // A new barber can start with one.
  const amin = await ali
    .from('barbers')
    .insert({ shop_id: shop.id, name: 'Amin', about: 'Beard trims and shaves', sort_order: 2 })
    .select()
    .single();
  assert.deepEqual([amin.error, amin.data?.about, amin.data?.rating_count], [null, 'Beard trims and shaves', 0]);

  // The stars are the database's.
  const counted = await ali.from('barbers').update({ rating_count: 100, rating_sum: 500 }).eq('id', danial.id);
  assert.equal(counted.error?.code, '42501');
  const started = await ali.from('barbers').insert({ shop_id: shop.id, name: 'Five Stars', rating_count: 100, rating_sum: 500 });
  assert.equal(started.error?.code, '42501');

  // Not another shop's barber, a customer or a guest.
  const rahman = barberNamed('kemas-barber-kajang', 'Rahman');
  assert.deepEqual((await write(ali, 'Mine now', rahman.id)).data, []);
  assert.deepEqual((await write(await signedIn(DEMO_CUSTOMER_EMAIL), 'Best barber', danial.id)).data, []);
  assert.equal((await write(client(), 'Best barber', danial.id)).error?.code, '42501');
  assert.equal(tables().barbers.find((b) => b.id === rahman.id)!.about, 'Classic cuts and hot towel shaves, 20 years');
  assert.equal(tables().barbers.find((b) => b.id === danial.id)!.about, null);
});

test('each barber’s stars follow the reviews of their cuts: written, changed, moved and removed', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const figures = (id: unknown) => {
    const b = tables().barbers.find((x) => x.id === id)!;
    return [b.rating_count as number, b.rating_sum as number];
  };
  const kemasCut = doneAt(await myBookings(hakim), 'kemas-barber-kajang');
  const chair = kemasCut.barber_id;
  const [count, sum] = figures(chair);
  assert.equal((await hakim.rpc('rate_booking', { p_booking_id: kemasCut.id, p_rating: 5 })).error, null);
  assert.deepEqual(figures(chair), [count + 1, sum + 5]);
  assert.equal((await hakim.rpc('rate_booking', { p_booking_id: kemasCut.id, p_rating: 2, p_comment: 'Rushed' })).error, null);
  assert.deepEqual(figures(chair), [count + 1, sum + 2]);

  // Put right to another chair by hand, the review and its stars go along.
  const other = tables().barbers.find((b) => b.shop_id === kemasCut.shop_id && b.id !== chair)!;
  const [otherCount, otherSum] = figures(other.id);
  updateRows('bookings', [tables().bookings.find((b) => b.id === kemasCut.id)!], { barber_id: other.id });
  assert.equal(tables().reviews.find((r) => r.booking_id === kemasCut.id)!.barber_id, other.id);
  assert.deepEqual(figures(chair), [count, sum]);
  assert.deepEqual(figures(other.id), [otherCount + 1, otherSum + 2]);

  // His next cut at Ali's moves to the other barber before he has it: his rating is theirs.
  const next = (await myBookings(hakim)).find((b) => b.status === 'confirmed')!;
  const aliShop = tables().shops.find((s) => s.slug === 'ali-barber')!;
  const to = tables().barbers.find((b) => b.shop_id === aliShop.id && b.id !== next.barber_id)!;
  let slot: { starts_at: string } | undefined;
  for (let d = 1; !slot && d <= 7; d++) {
    const { data } = await hakim.rpc('available_slots', {
      p_service_id: next.service_id,
      p_day: addDays(today(), d),
      p_barber_id: to.id,
      p_ignore_booking: next.id,
    });
    slot = (data as { starts_at: string }[])[0];
  }
  const moved = await hakim.rpc('reschedule_booking', { p_booking_id: next.id, p_starts_at: slot!.starts_at, p_barber_id: to.id });
  assert.equal(moved.error, null);
  const [toCount, toSum] = figures(to.id);
  const [fromCount, fromSum] = figures(next.barber_id);
  try {
    setClock(() => Date.parse(moved.data.ends_at) + 3_600_000);
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    assert.equal((await ali.rpc('set_booking_status', { p_booking_id: next.id, p_status: 'completed' })).error, null);
    const rated = await hakim.rpc('rate_booking', { p_booking_id: next.id, p_rating: 4 });
    assert.equal(rated.data.barber_id, to.id);
    assert.deepEqual(figures(to.id), [toCount + 1, toSum + 4]);
    assert.deepEqual(figures(next.barber_id), [fromCount, fromSum]);
  } finally {
    setClock(() => Date.now());
  }

  // Deleting his account takes his ratings off every barber.
  assert.equal((await hakim.rpc('delete_my_account')).error, null);
  assert.ok(!tables().reviews.some((r) => r.booking_id === next.id || r.booking_id === kemasCut.id));
  for (const b of tables().barbers) assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
});

test('a demo saved before barbers had a line gets the sample ones, and each barber’s stars', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    const [key, json] = [...saved.entries()][0];
    const old = JSON.parse(json);
    for (const b of old.tables.barbers) {
      delete b.about;
      delete b.rating_count;
      delete b.rating_sum;
    }
    // And a barber the owner added then has no line.
    const shop = old.tables.shops.find((s: Row) => s.slug === 'ali-barber');
    old.tables.barbers.push({
      id: '00000000-0000-4000-8000-0000000000aa',
      shop_id: shop.id,
      name: 'Amin',
      is_active: true,
      sort_order: 2,
      created_at: new Date().toISOString(),
    });
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.equal(barberNamed('ali-barber', 'Danial').about, 'Kids’ cuts, patient with first-timers');
    assert.equal(barberNamed('ali-barber', 'Amin').about, null);
    for (const b of tables().barbers) assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

test('a demo saved before Danial’s own customers came gets them, their cuts and their reviews, while a deleted account stays deleted', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  const newcomers = ['siti', 'izzat', 'kevin', 'nurul'].map((n) => `${n}@demo.potongku.my`);
  // The copy as a demo saved before them has it: none of the four, their cuts or their reviews.
  const before = (json: string) => {
    const old = JSON.parse(json);
    old.version = 2;
    const gone = new Set(old.tables.users.filter((u: Row) => newcomers.includes(String(u.email))).map((u: Row) => u.id));
    assert.equal(gone.size, newcomers.length);
    const cuts = new Set(old.tables.bookings.filter((b: Row) => gone.has(b.customer_id)).map((b: Row) => b.id));
    old.tables.users = old.tables.users.filter((u: Row) => !gone.has(u.id));
    old.tables.profiles = old.tables.profiles.filter((p: Row) => !gone.has(p.id));
    old.tables.bookings = old.tables.bookings.filter((b: Row) => !cuts.has(b.id));
    old.tables.reviews = old.tables.reviews.filter((r: Row) => !cuts.has(r.booking_id));
    return JSON.stringify(old);
  };
  const theirs = () => {
    const danial = barberNamed('ali-barber', 'Danial');
    for (const email of newcomers) {
      const user = tables().users.find((u) => u.email === email);
      assert.ok(user && tables().profiles.some((p) => p.id === user.id), email);
      const cuts = tables().bookings.filter((b) => b.customer_id === user.id);
      assert.deepEqual(
        cuts.map((b) => [b.barber_id, b.status]),
        [[danial.id, 'completed']],
        email,
      );
      assert.ok(tables().reviews.some((r) => r.booking_id === cuts[0].id && r.customer_id === user.id), email);
    }
    assert.ok((danial.rating_count as number) >= 3, `Danial has ${danial.rating_count} reviews`);
    for (const b of tables().barbers) assert.deepEqual([b.rating_count, b.rating_sum], barberTotals(b.id));
  };
  const day = 86_400_000;
  try {
    resetDemo();
    const [key, json] = [...saved.entries()][0];
    // Opened again the same day, and saved with them...
    const old = JSON.parse(before(json));
    // (Someone who signed up in it has the id Siti has today, and keeps it.)
    const siti = (JSON.parse(json).tables.users as Row[]).find((u) => u.email === newcomers[0])!;
    old.tables.users.push({ ...siti, email: 'visitor@example.com' });
    old.tables.profiles.push({ id: siti.id, role: 'customer', full_name: 'Visitor', phone: null, created_at: siti.created_at });
    saved.set(key, JSON.stringify(old));
    reloadTables();
    theirs();
    assert.ok(!tables().bookings.some((b) => b.guest_name === 'Deleted account'));
    assert.equal(tables().users.find((u) => u.id === siti.id)?.email, 'visitor@example.com');
    assert.equal(tables().profiles.find((p) => p.id === siti.id)?.full_name, 'Visitor');
    assert.equal(JSON.parse(saved.get(key)!).tables.users.filter((u: Row) => newcomers.includes(String(u.email))).length, 4);
    // ...so a day later they are still there.
    setClock(() => Date.now() + day);
    reloadTables();
    theirs();
    assert.ok(!tables().bookings.some((b) => b.guest_name === 'Deleted account'));
    // Opened first on a later day.
    saved.set(key, before(json));
    reloadTables();
    theirs();
    assert.ok(!tables().bookings.some((b) => b.guest_name === 'Deleted account'));

    // Hakim deleted his account in it: he doesn't come back with them.
    setClock(() => Date.now());
    resetDemo();
    const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
    assert.equal((await hakim.rpc('delete_my_account')).error, null);
    save();
    const without = before(saved.get(key)!);
    for (const later of [0, day]) {
      setClock(() => Date.now() + later);
      saved.set(key, without);
      reloadTables();
      theirs();
      assert.ok(!tables().users.some((u) => u.email === DEMO_CUSTOMER_EMAIL));
      assert.ok(!tables().profiles.some((p) => p.full_name === 'Hakim'));
    }
    const gone = await client().auth.signInWithPassword({ email: DEMO_CUSTOMER_EMAIL, password: DEMO_PASSWORD });
    assert.equal(gone.error?.message, 'Invalid login credentials');
    await signedIn('siti@demo.potongku.my');
  } finally {
    setClock(() => Date.now());
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

test('Find a barber gives Hakim his next cut and his barbers, with what Book again needs', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const { data, error } = await hakim.rpc('my_shops');
  assert.equal(error, null);
  const mine = data as MyShops;
  // His skin fade tomorrow at 4:30 pm is the only one to come.
  assert.equal(mine.upcoming, 1);
  const { id, starts_at, barber_name, ...next } = mine.next!;
  assert.deepEqual(next, { service_name: 'Skin fade', shop_name: 'Ali Barber Sungai Chua', time_zone: TZ });
  assert.equal(Date.parse(starts_at), Date.parse(kajang(1, '16:30')));
  assert.match(String(barber_name), /^(Ali|Danial)$/);
  assert.equal(tables().bookings.find((b) => b.id === id)?.customer_note, 'Same as last time');

  // Kemas about two weeks ago, Ali's four weeks ago and The Fade Room two months ago, latest first.
  assert.deepEqual(
    mine.shops.map((s) => s.slug),
    ['kemas-barber-kajang', 'ali-barber', 'the-fade-room'],
  );
  const [kemas, ali, fadeRoom] = mine.shops;
  const serviceId = (slug: string, name: string) => {
    const shop = tables().shops.find((s) => s.slug === slug)!;
    return tables().services.find((v) => v.shop_id === shop.id && v.name === name)!.id;
  };
  assert.deepEqual(
    [kemas.name, kemas.service_name, kemas.service_id, kemas.barber_name],
    ['Kemas Barber Kajang', 'Haircut', serviceId('kemas-barber-kajang', 'Haircut'), 'Rahman'],
  );
  assert.deepEqual([ali.service_name, ali.service_id], ['Haircut', serviceId('ali-barber', 'Haircut')]);
  assert.match(ali.barber_name, /^(Ali|Danial)$/);
  assert.deepEqual(
    [fadeRoom.service_name, fadeRoom.service_id, fadeRoom.barber_name],
    ['Skin fade', serviceId('the-fade-room', 'Skin fade'), 'Irfan'],
  );
  assert.equal(Date.parse(ali.last_visit_at), Date.parse(kajang(-26, '11:00')));
  assert.ok([kajang(-61, '15:00'), kajang(-60, '15:00')].some((at) => Date.parse(at) === Date.parse(fadeRoom.last_visit_at)));
  // One visit each so far, so four weeks between cuts; each live, with today's hours and next free time as listed.
  const { data: listed } = await client().rpc('find_shops', { p_limit: 50 });
  for (const s of mine.shops) {
    const l = (listed as Row[]).find((x) => x.id === s.shop_id)!;
    assert.deepEqual(
      [s.is_live, s.visits, s.usual_gap_days, s.time_zone, s.opens_today, s.closes_today, s.next_free_at],
      [true, 1, 28, TZ, l.opens_today, l.closes_today, l.next_free_at],
    );
  }

  // Once Ali pauses bookings, his shop still shows, saying so, with no free times.
  const owner = await signedIn(DEMO_BARBER_EMAIL);
  await owner.from('shops').update({ is_published: false }).eq('slug', 'ali-barber');
  const after = (await hakim.rpc('my_shops')).data as MyShops;
  const paused = after.shops[1];
  assert.deepEqual(
    [paused.slug, paused.is_live, paused.opens_today, paused.closes_today, paused.next_free_at],
    ['ali-barber', false, null, null, null],
  );
  assert.equal(after.next?.shop_name, 'Ali Barber Sungai Chua');
});

test('my_shops works out the last cut, visits and usual gap at each shop, as the database does', async () => {
  // The same diary as supabase/tests/booking_test.sql, across the sample shops.
  const shop = (slug: string) => tables().shops.find((s) => s.slug === slug)!;
  const barber = (slug: string, name: string) =>
    tables().barbers.find((b) => b.shop_id === shop(slug).id && b.name === name)!;
  const service = (slug: string, name: string) =>
    tables().services.find((v) => v.shop_id === shop(slug).id && v.name === name) ?? null;
  const userId = (email: string) => tables().users.find((u) => u.email === email)!.id;
  const ben = userId(DEMO_CUSTOMER_EMAIL);
  const chong = userId('ravi@demo.potongku.my');
  shop('the-fade-room').is_published = false;
  tables().bookings.splice(0);
  const diary: [unknown, string, string, string, number, string, string][] = [
    // Every three weeks at Ali's, the last with Danial; a no-show isn't a visit,
    // two cuts on one day are one, and one over two years ago is too old.
    [ben, 'ali-barber', 'Ali', 'Haircut', -800, '10:00', 'completed'],
    [ben, 'ali-barber', 'Ali', 'Haircut', -70, '10:00', 'completed'],
    [ben, 'ali-barber', 'Ali', 'Haircut', -49, '10:00', 'completed'],
    [ben, 'ali-barber', 'Ali', 'Beard trim', -49, '10:30', 'completed'],
    [ben, 'ali-barber', 'Danial', 'Haircut', -28, '11:00', 'completed'],
    [ben, 'ali-barber', 'Ali', 'Haircut', -14, '10:00', 'no_show'],
    // His latest cut was at Kemas, and he is booked there again tomorrow, and at Ali's later on.
    [ben, 'kemas-barber-kajang', 'Rahman', 'Fade', -10, '10:00', 'completed'],
    [ben, 'kemas-barber-kajang', 'Rahman', 'Fade', 1, '10:00', 'confirmed'],
    [ben, 'ali-barber', 'Ali', 'Haircut', 3, '11:00', 'confirmed'],
    // Not marked done, but its time has passed: a visit, at a shop since paused.
    [ben, 'the-fade-room', 'Irfan', 'Skin fade', -40, '13:00', 'confirmed'],
    // The fourth shop back is left out, and a cancelled booking isn't one to come.
    [ben, 'gunting-pak-mat', 'Pak Mat', 'Potong biasa', -100, '10:00', 'completed'],
    [ben, 'gunting-pak-mat', 'Pak Mat', 'Potong biasa', 2, '10:00', 'cancelled'],
    // Chong's cut is his own.
    [chong, 'ali-barber', 'Ali', 'Haircut', -5, '10:00', 'completed'],
  ];
  for (const [customer, slug, barberName, serviceName, days, clock, status] of diary) {
    const at = kajang(days, clock);
    insertRow('bookings', {
      shop_id: shop(slug).id,
      barber_id: barber(slug, barberName).id,
      service_id: serviceName === 'Beard trim' ? null : service(slug, serviceName)!.id,
      customer_id: customer,
      service_name: serviceName,
      price: 20,
      starts_at: at,
      ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
      status,
    });
  }

  const mine = async (email: string) => {
    const { data, error } = await (await signedIn(email)).rpc('my_shops');
    assert.equal(error, null);
    return data as MyShops;
  };
  const m = await mine(DEMO_CUSTOMER_EMAIL);
  assert.deepEqual(
    m.shops.map((s) => s.slug),
    ['kemas-barber-kajang', 'ali-barber', 'the-fade-room'],
  );
  const { data: listed } = await client().rpc('find_shops', { p_limit: 50 });
  const asListed = (slug: string) => {
    const l = (listed as Row[]).find((x) => x.slug === slug)!;
    return [l.opens_today, l.closes_today, l.next_free_at];
  };
  const [kemas, ali, fadeRoom] = m.shops;
  const [opens, closes, nextFree] = asListed('kemas-barber-kajang');
  assert.deepEqual(
    { ...kemas, last_visit_at: Date.parse(kemas.last_visit_at) },
    {
      shop_id: shop('kemas-barber-kajang').id,
      name: 'Kemas Barber Kajang',
      slug: 'kemas-barber-kajang',
      time_zone: TZ,
      is_live: true,
      opens_today: opens,
      closes_today: closes,
      next_free_at: nextFree,
      last_visit_at: Date.parse(kajang(-10, '10:00')),
      service_id: service('kemas-barber-kajang', 'Fade')!.id,
      service_name: 'Fade',
      barber_id: barber('kemas-barber-kajang', 'Rahman').id,
      barber_name: 'Rahman',
      visits: 1,
      usual_gap_days: 28,
    },
  );
  assert.deepEqual(
    [ali.barber_name, ali.service_name, ali.visits, ali.usual_gap_days, Date.parse(ali.last_visit_at), ali.is_live],
    ['Danial', 'Haircut', 3, 21, Date.parse(kajang(-28, '11:00')), true],
  );
  assert.deepEqual([ali.opens_today, ali.closes_today, ali.next_free_at], asListed('ali-barber'));
  assert.deepEqual(
    [fadeRoom.is_live, fadeRoom.next_free_at, fadeRoom.opens_today, fadeRoom.barber_name, fadeRoom.visits],
    [false, null, null, 'Irfan', 1],
  );
  assert.equal(m.upcoming, 2);
  assert.deepEqual(
    { ...m.next!, id: undefined, starts_at: Date.parse(m.next!.starts_at) },
    {
      id: undefined,
      starts_at: Date.parse(kajang(1, '10:00')),
      service_name: 'Fade',
      barber_name: 'Rahman',
      shop_name: 'Kemas Barber Kajang',
      time_zone: TZ,
    },
  );

  // Only the caller's own: Chong sees his one cut, someone with none sees nothing, and guests can't ask.
  const c = await mine('ravi@demo.potongku.my');
  assert.deepEqual(
    [c.next, c.upcoming, c.shops.map((s) => [s.slug, s.visits, s.barber_name])],
    [null, 0, [['ali-barber', 1, 'Ali']]],
  );
  assert.deepEqual(await mine(DEMO_BARBER_EMAIL), { next: null, upcoming: 0, upcoming_bookings: [], shops: [] });
  assert.equal((await client().rpc('my_shops')).error?.code, '42501');
});

test('the phone’s reminders get Hakim’s upcoming bookings with each shop’s clock, and Find a barber brings them along', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const upcoming = async (c = hakim) => {
    const { data, error } = await c.rpc('my_upcoming_bookings');
    assert.equal(error, null);
    return data as ReminderBooking[];
  };
  // The sample's one cut to come: his skin fade tomorrow at 4:30 pm at Ali's.
  const [fade, ...none] = await upcoming();
  assert.deepEqual(none, []);
  assert.deepEqual(
    { ...fade, id: undefined, starts_at: Date.parse(fade.starts_at) },
    {
      id: undefined,
      starts_at: Date.parse(kajang(1, '16:30')),
      service_name: 'Skin fade',
      shop_name: 'Ali Barber Sungai Chua',
      time_zone: TZ,
    },
  );
  assert.equal(tables().bookings.find((b) => b.id === fade.id)?.customer_id, tables().users.find((u) => u.email === DEMO_CUSTOMER_EMAIL)!.id);
  assert.deepEqual(((await hakim.rpc('my_shops')).data as MyShops).upcoming_bookings, await upcoming());

  // The same rules as supabase/tests/booking_test.sql: confirmed and still to start, soonest first, a
  // paused shop's too (on its own clock), at most 30, and only his own.
  const shop = (slug: string) => tables().shops.find((s) => s.slug === slug)!;
  const hakimId = tables().users.find((u) => u.email === DEMO_CUSTOMER_EMAIL)!.id;
  const chongId = tables().users.find((u) => u.email === 'ravi@demo.potongku.my')!.id;
  shop('the-fade-room').is_published = false;
  shop('the-fade-room').time_zone = 'Asia/Makassar';
  tables().bookings.splice(0);
  const book = (customer: unknown, slug: string, service: string, startsInMin: number, chair = 0, status = 'confirmed') => {
    const at = new Date(Date.now() + startsInMin * 60_000).toISOString();
    insertRow('bookings', {
      shop_id: shop(slug).id,
      barber_id: tables().barbers.filter((b) => b.shop_id === shop(slug).id)[chair].id,
      customer_id: customer,
      service_name: service,
      price: 20,
      starts_at: at,
      ends_at: new Date(Date.parse(at) + 30 * 60_000).toISOString(),
      status,
    });
  };
  book(hakimId, 'ali-barber', 'Started', -10);
  book(hakimId, 'ali-barber', 'Soon', 10, 1);
  book(hakimId, 'the-fade-room', 'At a paused shop', 2 * 24 * 60);
  book(hakimId, 'ali-barber', 'Cancelled', 24 * 60, 0, 'cancelled');
  book(hakimId, 'ali-barber', 'Tomorrow', 24 * 60, 1);
  book(chongId, 'kemas-barber-kajang', 'Chong’s', 3 * 24 * 60);
  const list = await upcoming();
  assert.deepEqual(
    list.map((b) => b.service_name),
    ['Soon', 'Tomorrow', 'At a paused shop'],
  );
  assert.deepEqual([list[2].shop_name, list[2].time_zone], ['The Fade Room', 'Asia/Makassar']);
  for (let i = 1; i <= 30; i++) book(hakimId, 'kemas-barber-kajang', `Later ${i}`, 3 * 24 * 60 + i * 60);
  const capped = await upcoming();
  assert.deepEqual([capped.length, capped[0].service_name, capped[29].service_name], [30, 'Soon', 'Later 27']);
  assert.deepEqual(
    (await upcoming(await signedIn('ravi@demo.potongku.my'))).map((b) => b.service_name),
    ['Chong’s'],
  );
  assert.deepEqual(await upcoming(await signedIn(DEMO_BARBER_EMAIL)), []);
  assert.equal((await client().rpc('my_upcoming_bookings')).error?.code, '42501');
});

test('a booking the shop moves or cancels moves or drops its reminders on the next sync', async () => {
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const owner = await signedIn(DEMO_BARBER_EMAIL);
  const upcoming = async () => (await hakim.rpc('my_upcoming_bookings')).data as ReminderBooking[];
  const settings = { evening: true, hour: true };
  // Planned as of an hour after midnight tonight, so both reminders of tomorrow's 4:30 pm cut are still to come.
  const at = Date.parse(kajang(1, '01:00'));
  const [fade] = await upcoming();
  const before = plannedReminders(await upcoming(), settings, at);
  assert.deepEqual(
    before.map((r) => [r.kind, r.bookingId]),
    [['hour', fade.id]],
  );

  // Ali moves it to a free time two or more days on: the old reminder goes and both new ones come.
  const service = tables().bookings.find((b) => b.id === fade.id)!.service_id;
  let free: { barber_id: string; starts_at: string } | undefined;
  for (let day = 2; !free && day < 9; day++) {
    const { data } = await client().rpc('available_slots', { p_service_id: service, p_day: addDays(today(), day) });
    free = (data as { barber_id: string; starts_at: string }[])[0];
  }
  assert.ok(free, 'a free time in the week after tomorrow');
  const moved = await owner.rpc('reschedule_booking', {
    p_booking_id: fade.id,
    p_starts_at: free.starts_at,
    p_barber_id: free.barber_id,
  });
  assert.equal(moved.error, null);
  const after = plannedReminders(await upcoming(), settings, at);
  const { cancel, schedule } = reminderChanges(after, before.map((r) => r.id));
  assert.deepEqual(cancel, before.map((r) => r.id));
  const dayBefore = addDays(localDateString(new Date(free.starts_at), TZ), -1);
  assert.deepEqual(
    schedule.map((r) => [r.kind, r.at]),
    [
      ['evening', localInstant(dayBefore, '20:00', TZ).getTime()],
      ['hour', Date.parse(free.starts_at) - 60 * 60_000],
    ],
  );

  // Then cancels it: nothing is left to remind of.
  assert.equal((await owner.rpc('set_booking_status', { p_booking_id: fade.id, p_status: 'cancelled' })).error, null);
  assert.deepEqual(await upcoming(), []);
  assert.deepEqual(reminderChanges(plannedReminders([], settings, at), after.map((r) => r.id)).cancel, after.map((r) => r.id));
});

test('the demo can be slowed down or cut off, the way a phone with a weak signal is', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    const c = client();
    const list = () => c.rpc('find_shops', { p_search: null, p_area: null, p_limit: 21, p_offset: 0 });
    saved.set(DEMO_NETWORK_KEY, JSON.stringify({ delayMs: 150 }));
    const started = Date.now();
    const slow = await list();
    assert.equal(slow.error, null);
    assert.ok(Date.now() - started >= 140, 'answered late');
    assert.equal(slow.data.length, 4);

    // No signal: no answer at all, which the app words as no connection.
    saved.set(DEMO_NETWORK_KEY, JSON.stringify({ offline: true }));
    const { data, error } = await list();
    assert.equal(data, null);
    assert.equal(error?.code, '');
    assert.match(error!.message, /Failed to fetch/);

    // Back to normal once the setting goes.
    saved.delete(DEMO_NETWORK_KEY);
    assert.equal((await list()).error, null);
    assert.equal(saved.get(DEMO_REQUESTS_KEY), undefined);

    // Each request's path can be noted, to count what a screen asks for.
    saved.set(DEMO_NETWORK_KEY, JSON.stringify({ log: true }));
    await list();
    await c.rpc('shop_areas');
    await list();
    assert.deepEqual(JSON.parse(saved.get(DEMO_REQUESTS_KEY)!), [
      '/rest/v1/rpc/find_shops',
      '/rest/v1/rpc/shop_areas',
      '/rest/v1/rpc/find_shops',
    ]);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

// Waiting list ---------------------------------------------------------------

test('customers wait for a time on a day they could book, and only the shop sees who is waiting', async () => {
  // As in supabase/tests/booking_test.sql: Ali works 8 am to 10 pm every day
  // and Danial not at all, on days a month out, clear of the sample bookings.
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const jason = await signedIn('jason@demo.potongku.my');
  const rahman = await signedIn('rahman@demo.potongku.my');
  const guest = client();
  const shop = await shopBySlug(ali, 'ali-barber');
  const kemas = await shopBySlug(ali, 'kemas-barber-kajang');
  const { data: services } = await ali.from('services').select('*').eq('shop_id', shop.id).order('sort_order');
  const haircut = services![0];
  const { data: kemasServices } = await ali.from('services').select('*').eq('shop_id', kemas.id).order('sort_order');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const [aliChair, danial] = barbers!;
  const { data: kemasBarbers } = await ali.from('barbers').select('*').eq('shop_id', kemas.id);
  const everyDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at: '08:00', closes_at: '22:00' }));
  assert.equal((await ali.rpc('set_barber_hours', { p_barber_id: aliChair.id, p_hours: everyDay })).error, null);
  assert.equal((await ali.rpc('set_barber_hours', { p_barber_id: danial.id, p_hours: [] })).error, null);
  const day = (n: number) => addDays(today(), 30 + n);
  const userId = (email: string) => tables().users.find((u) => u.email === email)!.id as string;
  const join = (c: ReturnType<typeof client>, serviceId: string, d: string, barberId: string | null = null) =>
    c.rpc('join_waitlist', { p_service_id: serviceId, p_day: d, p_barber_id: barberId });
  const mine = async (c: ReturnType<typeof client>) => {
    const { data, error } = await c.rpc('my_waitlist');
    assert.equal(error, null);
    return data as Row[];
  };
  const waiting = async (c: ReturnType<typeof client>, d: string) => {
    const { data, error } = await c.rpc('shop_waitlist', { p_day: d });
    assert.equal(error, null);
    return data as Row[];
  };

  // Guests can't ask, and nobody reads or writes the table itself.
  for (const [name, args] of [
    ['join_waitlist', { p_service_id: haircut.id, p_day: day(0) }],
    ['my_waitlist', {}],
    ['shop_waitlist', { p_day: day(0) }],
    ['leave_waitlist', { p_id: haircut.id }],
    ['mark_waitlist_offered', { p_id: haircut.id }],
  ] as const) {
    assert.equal((await guest.rpc(name, args)).error?.code, '42501', name);
  }
  for (const c of [guest, hakim, ali]) {
    assert.equal((await c.from('waitlist').select('*')).error?.code, '42501');
    assert.equal((await c.from('waitlist').select('id')).error?.code, '42501');
  }
  const written = await hakim
    .from('waitlist')
    .insert({ shop_id: shop.id, customer_id: userId(DEMO_CUSTOMER_EMAIL), day: day(0), service_id: haircut.id });
  assert.equal(written.error?.code, '42501');

  // Hakim joins day 30 with any barber and day 31 with Ali.
  const anyBarber = await join(hakim, haircut.id, day(0));
  assert.equal(anyBarber.error, null);
  assert.deepEqual(
    [anyBarber.data.customer_id, anyBarber.data.shop_id, anyBarber.data.day, anyBarber.data.barber_id, anyBarber.data.offered_at],
    [userId(DEMO_CUSTOMER_EMAIL), shop.id, day(0), null, null],
  );
  const withAli = (await join(hakim, haircut.id, day(1), aliChair.id)).data as Row;
  assert.equal(withAli.barber_id, aliChair.id);

  const refused = async (c: ReturnType<typeof client>, serviceId: string, d: string, barberId: string | null, message: string) => {
    const { data, error } = await join(c, serviceId, d, barberId);
    assert.equal(data, null);
    assert.equal(error?.message, message);
    return error!.code;
  };
  // Once a day per shop, whatever the service or barber.
  const twice = await refused(hakim, services![1].id, day(0), aliChair.id, 'You\'re already on the waiting list for that day.');
  assert.equal(twice, 'P0001');
  // Only a day they could book.
  const range = 'Pick a day from today up to 60 days ahead.';
  assert.equal(await refused(hakim, haircut.id, addDays(today(), -1), null, range), '22023');
  assert.equal(await refused(hakim, haircut.id, addDays(today(), 61), null, range), '22023');
  await ali.from('services').update({ is_active: false }).eq('id', services![4].id);
  assert.equal(await refused(hakim, services![4].id, day(2), null, 'This service is no longer available.'), 'P0002');
  assert.equal(await refused(hakim, aliChair.id, day(2), null, 'This service is no longer available.'), 'P0002');
  assert.equal(await refused(hakim, haircut.id, day(2), kemasBarbers![0].id, 'Barber not found.'), 'P0002');
  // Danial has no hours, so his days are never full: there is nothing to wait for.
  const barberOff = 'That barber is off that day. Try any barber.';
  assert.equal(await refused(hakim, haircut.id, day(2), danial.id, barberOff), '22023');
  const notTaking = 'The shop isn\'t taking bookings that day.';
  assert.equal((await mine(hakim)).length, 2, 'nothing refused was kept');
  // My bookings gets the same list with the bookings, in one request.
  assert.deepEqual((await hakim.rpc('my_bookings')).data.waitlist, await mine(hakim));
  assert.deepEqual((await jason.rpc('my_bookings')).data.waitlist, await mine(jason));

  // Closed days and a whole day off; half a day off still leaves the evening.
  assert.equal((await ali.rpc('close_shop_days', { p_from: day(3), p_days: 1, p_reason: 'Kenduri' })).error, null);
  const block = (d: string, time: string, minutes: number) =>
    ali.rpc('add_shop_booking', { p_barber_id: aliChair.id, p_day: d, p_time: time, p_duration_min: minutes, p_is_block: true });
  assert.equal((await block(day(4), '00:00', 1440)).error, null);
  assert.equal((await block(day(5), '08:00', 360)).error, null);
  assert.equal(await refused(jason, haircut.id, day(3), null, notTaking), '22023');
  assert.equal(await refused(jason, haircut.id, day(4), aliChair.id, notTaking), '22023');
  assert.equal((await join(jason, haircut.id, day(5), aliChair.id)).error, null);
  // A paused shop takes nobody.
  await rahman.from('shops').update({ is_published: false }).eq('id', kemas.id);
  await refused(jason, kemasServices![0].id, day(0), null, 'This service is no longer available.');
  await rahman.from('shops').update({ is_published: true }).eq('id', kemas.id);

  // Hakim's cut tomorrow: no waiting for a day he has a time.
  await refused(hakim, haircut.id, addDays(today(), 1), null, 'You already have a booking here that day.');

  // Three days at a time across every shop; a day gone by doesn't count and goes.
  const gone = () => ({ shop_id: shop.id, day: addDays(today(), -1), service_id: haircut.id, created_at: kajang(-3, '09:00') });
  insertRow('waitlist', { ...gone(), customer_id: userId(DEMO_CUSTOMER_EMAIL) });
  // Kemas is closed on Fridays. Not day 7, which Hakim waits on at Ali's below.
  const kemasDay = new Date(`${day(6)}T00:00:00Z`).getUTCDay() === 5 ? day(9) : day(6);
  const atKemas = (await join(hakim, kemasServices![1].id, kemasDay)).data as Row;
  assert.ok(atKemas);
  await refused(hakim, haircut.id, day(8), null, 'You can be on 3 waiting lists at a time. Leave one to join another.');
  assert.equal(tables().waitlist.filter((w) => w.customer_id === userId(DEMO_CUSTOMER_EMAIL)).length, 3);
  insertRow('waitlist', { ...gone(), customer_id: userId(DEMO_CUSTOMER_EMAIL) });
  insertRow('waitlist', { ...gone(), customer_id: userId('jason@demo.potongku.my') });

  // His own, soonest first, with each shop, service and barber; never a day gone by.
  const own = await mine(hakim);
  assert.deepEqual(
    own.map((w) => [w.day, w.service_name, w.barber_name, (w.shop as Row).name]),
    [
      [day(0), 'Haircut', null, 'Ali Barber Sungai Chua'],
      [day(1), 'Haircut', 'Ali', 'Ali Barber Sungai Chua'],
      [kemasDay, kemasServices![1].name, null, 'Kemas Barber Kajang'],
    ],
  );
  assert.deepEqual(own[0], {
    id: anyBarber.data.id,
    shop_id: shop.id,
    day: day(0),
    service_id: haircut.id,
    service_name: 'Haircut',
    barber_id: null,
    barber_name: null,
    created_at: anyBarber.data.created_at,
    shop: { name: 'Ali Barber Sungai Chua', slug: 'ali-barber', time_zone: TZ },
  });

  // Leaving: his own, twice over is fine, and it makes room for another. Jason can't take Hakim off.
  assert.equal((await hakim.rpc('leave_waitlist', { p_id: atKemas.id })).error, null);
  assert.equal((await hakim.rpc('leave_waitlist', { p_id: atKemas.id })).error, null);
  assert.equal((await mine(hakim)).length, 2);
  assert.equal((await join(hakim, haircut.id, day(8))).error, null);
  assert.deepEqual((await mine(jason)).map((w) => w.day), [day(5)]);
  await jason.rpc('leave_waitlist', { p_id: anyBarber.data.id });
  assert.equal((await mine(hakim)).length, 3);
  assert.deepEqual(await waiting(jason, day(0)), [], 'customers see no shop’s list');

  // Jason joins day 30 after Hakim, with Ali. Hakim asked first.
  const jasonsTurn = (await join(jason, haircut.id, day(0), aliChair.id)).data as Row;
  updateRows('waitlist', [tables().waitlist.find((w) => w.id === anyBarber.data.id)!], {
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  });

  // The owner sees who is waiting that day, oldest first, with each one's name and number.
  const list = await waiting(ali, day(0));
  assert.deepEqual(
    list.map((w) => [w.name, w.phone, w.service_name, w.duration_min, w.barber_name, w.offered_at]),
    [
      ['Hakim', '011-2233 4455', 'Haircut', 30, null, null],
      ['Jason', '012-901 3344', 'Haircut', 30, 'Ali', null],
    ],
  );
  assert.deepEqual(Object.keys(list[0]).sort(), [
    'barber_id',
    'barber_name',
    'created_at',
    'duration_min',
    'id',
    'name',
    'offered_at',
    'phone',
    'service_id',
    'service_name',
  ]);
  assert.equal((await waiting(ali, day(1))).length, 1);
  assert.deepEqual(await waiting(ali, addDays(today(), -1)), [], 'a day gone by is empty');
  assert.deepEqual(await waiting(ali, kemasDay), [], 'Kemas’s list isn’t Ali’s');

  // WhatsApping someone marks them offered for every phone; the owner takes Jason off.
  const offered = await ali.rpc('mark_waitlist_offered', { p_id: anyBarber.data.id });
  assert.equal(offered.error, null);
  assert.ok(Math.abs(Date.parse(offered.data.offered_at) - Date.now()) < 5000);
  assert.equal((await waiting(ali, day(0)))[0].offered_at, offered.data.offered_at);
  assert.equal((await ali.rpc('leave_waitlist', { p_id: jasonsTurn.id })).error, null);
  assert.deepEqual((await waiting(ali, day(0))).map((w) => w.name), ['Hakim']);
  const goneNow = await ali.rpc('mark_waitlist_offered', { p_id: jasonsTurn.id });
  assert.deepEqual([goneNow.error?.code, goneNow.error?.message], ['P0002', 'They\'re no longer on the waiting list.']);

  // Nobody else: Hakim can't mark himself offered, and another shop's owner sees and touches nothing.
  assert.equal((await hakim.rpc('mark_waitlist_offered', { p_id: withAli.id })).error?.code, 'P0002');
  assert.deepEqual(await waiting(rahman, day(0)), []);
  await rahman.rpc('leave_waitlist', { p_id: withAli.id });
  assert.equal((await rahman.rpc('mark_waitlist_offered', { p_id: withAli.id })).error?.code, 'P0002');
  assert.equal(tables().waitlist.find((w) => w.id === withAli.id)?.offered_at, null);

  // A cancellation on a day someone is waiting for tells the shop so.
  const bookAndCancel = async (d: number) => {
    const { data, error } = await jason.rpc('book_appointment', { p_service_id: haircut.id, p_starts_at: kajang(30 + d, '10:00') });
    assert.equal(error, null);
    await jason.rpc('set_booking_status', { p_booking_id: data.id, p_status: 'cancelled' });
    return data.id as string;
  };
  const onDay30 = await bookAndCancel(0);
  const onDay32 = await bookAndCancel(2);
  const news = (await ali.rpc('shop_changes', { p_since: null, p_limit: 20 })).data as ShopChanges;
  const waitingFor = (id: string) => news.changes.find((c) => c.booking_id === id)?.waiting;
  assert.deepEqual([waitingFor(onDay30), waitingFor(onDay32)], [1, 0]);
  assert.ok(news.changes.filter((c) => c.change !== 'cancelled').every((c) => c.waiting === 0));

  // Booking that day ends the request, and so does moving a booking into it, by the customer or the shop.
  const booked = await hakim.rpc('book_appointment', { p_service_id: haircut.id, p_starts_at: kajang(30, '11:00') });
  assert.equal(booked.error, null);
  assert.deepEqual((await mine(hakim)).map((w) => w.day), [day(1), day(8)]);
  await hakim.rpc('reschedule_booking', { p_booking_id: booked.data.id, p_starts_at: kajang(31, '11:00') });
  assert.deepEqual((await mine(hakim)).map((w) => w.day), [day(8)]);
  assert.equal(
    (await ali.rpc('reschedule_booking', { p_booking_id: booked.data.id, p_starts_at: kajang(38, '09:00') })).error,
    null,
  );
  assert.deepEqual(await mine(hakim), []);

  // Deleting an account takes its requests with it.
  const jasonId = userId('jason@demo.potongku.my');
  assert.ok(tables().waitlist.some((w) => w.customer_id === jasonId));
  assert.equal((await jason.rpc('delete_my_account')).error, null);
  assert.ok(!tables().waitlist.some((w) => w.customer_id === jasonId));
});

test('Ali’s sample shop has a Saturday with no time left and two customers waiting, whatever the day and hour', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  try {
    // Every hour of the day, each on a different weekday in turn.
    for (let hour = 0; hour < 24; hour++) {
      const date = addDays(today(), hour % 7);
      const at = dayBounds(date, TZ).start.getTime() + (hour * 60 + 7) * 60_000;
      const when = `on ${date} at ${hour}:07`;
      setClock(() => at);
      resetDemo();
      const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
      const saturday = [7, 8, 9, 10, 11, 12, 13]
        .map((n) => addDays(date, n))
        .find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 6)!;
      for (const service of tables().services.filter((v) => v.shop_id === shop.id)) {
        const { data } = await hakim.rpc('available_slots', { p_service_id: service.id, p_day: saturday });
        assert.deepEqual(data, [], `${service.name} ${when}`);
      }
      const list = (await ali.rpc('shop_waitlist', { p_day: saturday })).data as Row[];
      assert.deepEqual(
        list.map((w) => [w.name, w.service_name, w.barber_name, w.offered_at]),
        [
          ['Farid', 'Haircut', null, null],
          ['Aiman', 'Skin fade', 'Danial', null],
        ],
        when,
      );
      // Hakim isn't on it, and can be.
      assert.deepEqual((await hakim.rpc('my_waitlist')).data, [], when);
    }
    const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
    const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!;
    const saturday = String(tables().waitlist[0].day);
    assert.equal((await hakim.rpc('join_waitlist', { p_service_id: haircut.id, p_day: saturday })).error, null);
  } finally {
    setClock(() => Date.now());
  }
});

/** The first given weekday (0 is Sunday) from a month out, clear of the sample bookings. */
const monthOutOn = (weekday: number) => {
  const from = addDays(today(), 30);
  return addDays(from, (weekday - new Date(`${from}T00:00:00Z`).getUTCDay() + 7) % 7);
};

test('a barber’s own day off shows on the booking page, and waiting for them that day says so', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const guest = client();
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const danial = barbers![1];
  const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!;
  // Both work Tuesdays; Danial works Sundays on his own.
  const [tuesday, sunday] = [monthOutOn(2), monthOutOn(0)];
  for (const day of [tuesday, sunday]) {
    const off = await ali.rpc('add_shop_booking', {
      p_barber_id: danial.id,
      p_day: day,
      p_time: '00:00',
      p_duration_min: 1440,
      p_note: 'Cuti',
      p_is_block: true,
    });
    assert.equal(off.error, null);
  }
  const closed = async (c: ReturnType<typeof client>, day: string) =>
    (await c.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: day, p_to: day })).data;

  // Everyone sees it, only the owner why: Danial off on the Tuesday, and the Sunday closed, as nobody else works it.
  assert.deepEqual(await closed(guest, tuesday), [{ day: tuesday, reason: null, is_closure: false, barber_id: danial.id }]);
  assert.deepEqual(await closed(ali, tuesday), [{ day: tuesday, reason: 'Cuti', is_closure: false, barber_id: danial.id }]);
  assert.deepEqual(await closed(guest, sunday), [{ day: sunday, reason: null, is_closure: false, barber_id: null }]);

  // Asked for anyway, the day having gone off with the page open: said plainly, and any barber still works.
  const join = (day: string, barberId: string | null) =>
    hakim.rpc('join_waitlist', { p_service_id: haircut.id, p_day: day, p_barber_id: barberId });
  const withDanial = await join(tuesday, danial.id);
  assert.deepEqual(
    [withDanial.error?.code, withDanial.error?.message],
    ['22023', 'That barber is off that day. Try any barber.'],
  );
  const onSunday = await join(sunday, null);
  assert.deepEqual([onSunday.error?.code, onSunday.error?.message], ['22023', 'The shop isn\'t taking bookings that day.']);
  assert.equal((await join(tuesday, null)).error, null);
});

test('the shop putting someone waiting in by hand ends their request', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const { data: barbers } = await ali.from('barbers').select('*').eq('shop_id', shop.id).order('sort_order');
  const aliChair = barbers![0];
  const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!;
  // A Tuesday, which Ali works.
  const day = monthOutOn(2);
  assert.equal((await hakim.rpc('join_waitlist', { p_service_id: haircut.id, p_day: day })).error, null);
  const add = (d: string, time: string, extra: Record<string, unknown>) =>
    ali.rpc('add_shop_booking', { p_barber_id: aliChair.id, p_day: d, p_time: time, ...extra });
  const waiting = async () => ((await ali.rpc('shop_waitlist', { p_day: day })).data as Row[]).map((w) => w.name);

  // Another number, another day or blocked time leaves it.
  for (const [d, time, extra] of [
    [day, '12:00', { p_service_id: haircut.id, p_guest_name: 'Someone else', p_guest_phone: '011-2233 4456' }],
    [addDays(day, 1), '12:00', { p_service_id: haircut.id, p_guest_name: 'Hakim', p_guest_phone: '011-2233 4455' }],
    [day, '13:00', { p_duration_min: 30, p_is_block: true }],
  ] as const) {
    assert.equal((await add(d, time, extra)).error, null);
  }
  assert.deepEqual(await waiting(), ['Hakim']);

  // His number, however it was typed, finds him: he has his time now.
  assert.equal(
    (await add(day, '14:00', { p_service_id: haircut.id, p_guest_name: 'Hakim', p_guest_phone: '+60 11-2233 4455' })).error,
    null,
  );
  assert.deepEqual(await waiting(), []);
  assert.deepEqual((await hakim.rpc('my_waitlist')).data, []);
});

// Walk-in queue ------------------------------------------------------------------

/** The first given weekday (0 is Sunday) from today on, at a Kajang clock time. */
const thisWeekOn = (weekday: number, clock: string) => {
  const day = addDays(today(), (weekday - new Date(`${today()}T00:00:00Z`).getUTCDay() + 7) % 7);
  const [h, m] = clock.split(':').map(Number);
  return { day, at: dayBounds(day, TZ).start.getTime() + (h * 60 + m) * 60_000 };
};

test('customers join a shop’s walk-in queue while it is open, and only the shop sees who', async () => {
  // A Tuesday at 3:20 pm, both barbers in: Ali on Ravi's skin fade until
  // 3:45, Danial free until Aiman's haircut at 4:00 (the sample day).
  const { day, at } = thisWeekOn(2, '15:20');
  setClock(() => at);
  try {
    resetDemo();
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
    const jason = await signedIn('jason@demo.potongku.my');
    const ravi = await signedIn('ravi@demo.potongku.my');
    const farid = await signedIn('farid@demo.potongku.my');
    const rahman = await signedIn('rahman@demo.potongku.my');
    const guest = client();
    const shop = await shopBySlug(ali, 'ali-barber');
    const kemas = await shopBySlug(ali, 'kemas-barber-kajang');
    const service = (shopId: string, name: string) =>
      tables().services.find((v) => v.shop_id === shopId && v.name === name)!.id as string;
    const [haircut, fade] = [service(shop.id, 'Haircut'), service(shop.id, 'Skin fade')];
    const barber = (name: string) => tables().barbers.find((b) => b.shop_id === shop.id && b.name === name)!.id as string;
    const [aliChair, danial] = [barber('Ali'), barber('Danial')];
    const status = async (c: ReturnType<typeof client>, shopId = shop.id as string) => {
      const { data, error } = await c.rpc('queue_status', { p_shop_id: shopId });
      assert.equal(error, null);
      return data as Row & { mine: Row | null };
    };
    const join = (c: ReturnType<typeof client>, serviceId: string, barberId: string | null = null) =>
      c.rpc('join_queue', { p_service_id: serviceId, p_barber_id: barberId });
    const refused = async (pending: PromiseLike<{ error: { code?: string; message: string } | null }>, code: string, message: string) => {
      const { error } = await pending;
      assert.deepEqual([error?.code, error?.message], [code, message]);
    };
    const list = async () => {
      const { data, error } = await ali.rpc('shop_queue');
      assert.equal(error, null);
      return data as Row[];
    };
    const waitingAt = async (slug: string) =>
      ((await guest.rpc('find_shops', { p_search: null, p_area: null, p_limit: 21, p_offset: 0 })).data as Row[]).find(
        (s) => s.slug === slug,
      )!.queue_waiting;

    // The sample queue: Encik Hisham's haircut, Jason's skin fade and a kids
    // cut, 105 minutes over two chairs. Guests see how many and how long, never who.
    assert.deepEqual(await status(guest), { open: true, waiting: 3, estimate_min: 55, barbers_in: 2, mine: null });
    assert.equal(await waitingAt('ali-barber'), 3);
    assert.equal(await waitingAt('kemas-barber-kajang'), null);
    for (const [name, args] of [
      ['join_queue', { p_service_id: haircut }],
      ['leave_queue', { p_id: haircut }],
      ['my_queue', {}],
      ['shop_queue', {}],
      ['add_to_queue', { p_name: 'Pak Long' }],
      ['call_from_queue', { p_id: haircut }],
      ['remove_from_queue', { p_id: haircut }],
      ['start_from_queue', { p_id: haircut, p_barber_id: aliChair }],
    ] as const) {
      assert.equal((await guest.rpc(name, args)).error?.code, '42501', name);
    }
    for (const c of [guest, hakim, ali]) {
      assert.equal((await c.from('queue_entries').select('*')).error?.code, '42501');
    }
    const written = await hakim.from('queue_entries').insert({ shop_id: shop.id, day, guest_name: 'Me' });
    assert.equal(written.error?.code, '42501');

    // Hakim joins for a skin fade with anyone: fourth, about 55 minutes away.
    const joined = await join(hakim, fade);
    assert.equal(joined.error, null);
    assert.deepEqual([joined.data.state, joined.data.barber_id, joined.data.day], ['waiting', null, day]);
    const mine = (await status(hakim)).mine!;
    assert.deepEqual([mine.id, mine.state, mine.place, mine.estimate_min], [joined.data.id, 'waiting', 4, 55]);
    const { data: myQueue } = await hakim.rpc('my_queue');
    assert.deepEqual(
      (myQueue as Row[]).map((q) => [q.id, q.place, q.service_name, q.barber_name, (q.shop as Row).slug]),
      [[joined.data.id, 4, 'Skin fade', null, 'ali-barber']],
    );
    // My bookings gets the same place with the bookings, in one request.
    assert.deepEqual((await hakim.rpc('my_bookings')).data.queue, myQueue);
    assert.equal(await waitingAt('ali-barber'), 4);

    // One place at a time, here or anywhere; nobody with a booking still to
    // come today (Ravi is in the chair); a queue that is off isn't open.
    await refused(join(hakim, haircut, aliChair), 'P0001', 'You\'re already in this queue.');
    await refused(join(jason, haircut), 'P0001', 'You\'re already in this queue.');
    await refused(join(ravi, haircut), 'P0001', 'You already have a booking here today.');
    const kemasCut = service(kemas.id, 'Haircut');
    await refused(join(hakim, kemasCut), 'P0001', 'The queue isn\'t open right now.');
    assert.equal((await rahman.from('shops').update({ queue_enabled: true }).eq('id', kemas.id)).error, null);
    await refused(join(hakim, kemasCut), 'P0001', 'You\'re already in another shop\'s queue. Leave it to join this one.');
    // Customers can't switch on someone else's queue.
    await hakim.from('shops').update({ queue_enabled: false }).eq('id', shop.id);
    assert.equal(tables().shops.find((s) => s.id === shop.id)!.queue_enabled, true);
    // Farid's cut this morning is over, so he can join, with Danial.
    assert.equal((await join(farid, haircut, danial)).error, null);
    await refused(join(guest, haircut), '42501', 'permission denied for function join_queue');

    // The shop's list, with names and numbers as its customer list has them.
    assert.deepEqual(
      (await list()).map((q) => [q.name, q.phone, q.online, q.service_name, q.barber_name, q.state]),
      [
        ['Encik Hisham', '012-667 4410', false, 'Haircut', null, 'waiting'],
        ['Jason', '012-901 3344', true, 'Skin fade', 'Ali', 'waiting'],
        ['Adik Faris', null, false, 'Kids cut (under 12)', 'Danial', 'waiting'],
        ['Hakim', '011-2233 4455', true, 'Skin fade', null, 'waiting'],
        ['Farid', '012-778 9012', true, 'Haircut', 'Danial', 'waiting'],
      ],
    );
    assert.deepEqual((await rahman.rpc('shop_queue')).data, []);
    await refused(rahman.rpc('call_from_queue', { p_id: joined.data.id }), 'P0002', 'They\'re no longer in the queue.');
    await rahman.rpc('remove_from_queue', { p_id: joined.data.id });
    await refused(
      rahman.rpc('start_from_queue', { p_id: joined.data.id, p_barber_id: aliChair }),
      'P0002',
      'They\'re no longer in the queue.',
    );

    // Ali calls Hakim: it's his turn, and Farid moves up to fourth.
    const called = await ali.rpc('call_from_queue', { p_id: joined.data.id });
    assert.deepEqual([called.error, called.data.state, called.data.called_at], [null, 'called', new Date(at).toISOString()]);
    const turn = (await status(hakim)).mine!;
    assert.deepEqual([turn.state, turn.place, turn.estimate_min], ['called', null, null]);
    assert.equal((await status(farid)).mine!.place, 4);

    // Starting his cut: Ali is still on Ravi's, and a skin fade with Danial
    // would run into Aiman's 4:00. Each says when, in the detail too.
    const start = (id: string, barberId: string, serviceId: string | null = null) =>
      ali.rpc('start_from_queue', { p_id: id, p_barber_id: barberId, p_service_id: serviceId });
    const ravisCut = tables().bookings.find(
      (b) => b.barber_id === aliChair && Date.parse(String(b.starts_at)) === at - 20 * 60_000,
    )!;
    const busy = await start(joined.data.id, aliChair);
    assert.deepEqual(
      [busy.error?.code, busy.error?.message, busy.error?.details],
      ['P0001', 'Ali is busy until 3:45 pm. Pick another barber.', ravisCut.ends_at],
    );
    const before = await start(joined.data.id, danial);
    assert.deepEqual(
      [before.error?.message, Date.parse(String(before.error?.details)) - at],
      ['Danial has a 4:00 pm booking before this cut would finish. Pick another barber.', 40 * 60_000],
    );
    await refused(start(joined.data.id, tables().barbers.find((b) => b.shop_id === kemas.id)!.id as string), 'P0002', 'Barber not found.');

    // Encik Hisham's haircut fits Danial before 4:00, as a booking from now.
    const hisham = (await list())[0];
    const cut = await start(hisham.id as string, danial);
    assert.equal(cut.error, null);
    assert.deepEqual(
      [cut.data.guest_name, cut.data.guest_phone, cut.data.customer_id, cut.data.service_name, cut.data.price],
      ['Encik Hisham', '012-667 4410', null, 'Haircut', 20],
    );
    assert.deepEqual([cut.data.starts_at, cut.data.ends_at], [new Date(at).toISOString(), new Date(at + 30 * 60_000).toISOString()]);
    await refused(start(hisham.id as string, aliChair), 'P0002', 'They\'re no longer in the queue.');
    const served = tables().queue_entries.find((e) => e.id === hisham.id)!;
    assert.deepEqual([served.state, served.gone_reason, served.booking_id], ['gone', 'served', cut.data.id]);

    // Later, once Ravi's fade is done, Hakim's starts with Ali and is his booking.
    setClock(() => at + 26 * 60_000);
    const his = await start(joined.data.id, aliChair);
    assert.equal(his.error, null);
    assert.deepEqual(
      [his.data.customer_id, his.data.guest_name, his.data.service_name, his.data.starts_at],
      [tables().users.find((u) => u.email === DEMO_CUSTOMER_EMAIL)!.id, null, 'Skin fade', new Date(at + 26 * 60_000).toISOString()],
    );
    assert.deepEqual((await hakim.rpc('my_queue')).data, []);
    assert.equal((await status(hakim)).mine, null);
    const { data: his2 } = await hakim.rpc('my_bookings');
    assert.ok((his2.bookings as Row[]).some((b) => b.id === his.data.id));

    // A service when they said none; Not here; Leave; taken off while waiting.
    const walkIn = await ali.rpc('add_to_queue', { p_name: '  Pak Long ', p_phone: ' 012-111 2222 ' });
    assert.deepEqual(
      [walkIn.data.guest_name, walkIn.data.guest_phone, walkIn.data.service_id, walkIn.data.barber_id],
      ['Pak Long', '012-111 2222', null, null],
    );
    await refused(ali.rpc('add_to_queue', { p_name: '  ' }), '22023', 'Add the customer\'s name.');
    await refused(ali.rpc('add_to_queue', { p_name: 'X', p_service_id: kemasCut }), 'P0002', 'Service not found.');
    await refused(start(walkIn.data.id, danial), '22023', 'Pick a service for their cut.');
    const jasonsPlace = (await list()).find((q) => q.name === 'Jason')!;
    await ali.rpc('call_from_queue', { p_id: jasonsPlace.id });
    await ali.rpc('remove_from_queue', { p_id: jasonsPlace.id });
    assert.equal(tables().queue_entries.find((e) => e.id === jasonsPlace.id)!.gone_reason, 'not_here');
    const faridsPlace = (await status(farid)).mine!;
    await hakim.rpc('leave_queue', { p_id: faridsPlace.id });
    assert.equal((await status(farid)).mine!.id, faridsPlace.id, 'only Farid can leave his place');
    await farid.rpc('leave_queue', { p_id: faridsPlace.id });
    assert.equal(tables().queue_entries.find((e) => e.id === faridsPlace.id)!.gone_reason, 'left');
    await ali.rpc('remove_from_queue', { p_id: walkIn.data.id });
    assert.equal(tables().queue_entries.find((e) => e.id === walkIn.data.id)!.gone_reason, 'removed');
    assert.deepEqual((await list()).map((q) => q.name), ['Adik Faris']);

    // Thirty waiting at most, online or added by the shop.
    for (let n = 0; n < 29; n++) insertRow('queue_entries', { shop_id: shop.id, day, guest_name: `Extra ${n}` });
    await refused(join(farid, haircut), 'P0001', 'The queue is full for now. Try booking a time instead.');
    await refused(ali.rpc('add_to_queue', { p_name: 'One more' }), 'P0001', 'The queue is full for now. Try booking a time instead.');
    tables().queue_entries = tables().queue_entries.filter((e) => !String(e.guest_name).startsWith('Extra'));

    // Closed today: not open, and nobody can join.
    tables().shop_closures.push({ shop_id: shop.id, day, reason: null });
    assert.deepEqual([(await status(guest)).open, (await status(guest)).barbers_in], [false, 0]);
    await refused(join(farid, haircut), 'P0001', 'The queue isn\'t open right now.');
    tables().shop_closures = [];

    // With the queue off, the shop still sees who is left; Find a barber shows no count.
    assert.equal((await ali.from('shops').update({ queue_enabled: false }).eq('id', shop.id)).error, null);
    assert.deepEqual((await list()).map((q) => q.name), ['Adik Faris']);
    assert.equal(await waitingAt('ali-barber'), null);
    assert.equal((await status(guest)).open, false);
    await refused(ali.rpc('add_to_queue', { p_name: 'Pak Long' }), 'P0001', 'Turn on the walk-in queue in My shop first.');
  } finally {
    setClock(() => Date.now());
  }
});

test('a booking at eight or eleven is said with “an”, and a cut starts with anyone working today, past closing too', async () => {
  // A Tuesday at 11:00: Ali has Pak Abu's 11:30, and Danial starts at 11.
  const { at } = thisWeekOn(2, '11:00');
  setClock(() => at);
  try {
    resetDemo();
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const shop = await shopBySlug(ali, 'ali-barber');
    const barber = (name: string) => tables().barbers.find((b) => b.shop_id === shop.id && b.name === name)!.id as string;
    const queue = async () => (await ali.rpc('shop_queue')).data as Row[];
    const [first] = await queue();
    const fade = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Skin fade')!.id;
    const ok = await ali.rpc('start_from_queue', { p_id: first.id, p_barber_id: barber('Ali'), p_service_id: fade });
    assert.equal(ok.error?.message, 'Ali has an 11:30 am booking before this cut would finish. Pick another barber.');
    // Danial starts at 11 and his first customer cancelled. In five minutes
    // early, he can take someone.
    const danials = tables().bookings.filter(
      (b) => b.barber_id === barber('Danial') && Date.parse(String(b.starts_at)) < at + 30 * 60_000 && Date.parse(String(b.ends_at)) > at,
    );
    updateRows('bookings', danials, { status: 'cancelled' });
    setClock(() => at - 5 * 60_000);
    const early = await ali.rpc('start_from_queue', { p_id: first.id, p_barber_id: barber('Danial') });
    assert.equal(early.error, null, early.error?.message);
    assert.equal(early.data.barber_id, barber('Danial'));
    // At 9:30 pm both have finished and the queue is shut, but those still waiting are served.
    setClock(() => at + 630 * 60_000);
    const { data: status } = await ali.rpc('queue_status', { p_shop_id: shop.id });
    assert.deepEqual([status.open, status.barbers_in], [false, 0]);
    const [next] = await queue();
    const late = await ali.rpc('start_from_queue', { p_id: next.id, p_barber_id: barber('Ali'), p_service_id: fade });
    assert.deepEqual([late.error, late.data.barber_id, late.data.starts_at], [null, barber('Ali'), new Date(at + 630 * 60_000).toISOString()]);
  } finally {
    setClock(() => Date.now());
  }
});

test('a barber off today can’t start a cut: Danial on a Monday', async () => {
  const { at } = thisWeekOn(1, '15:00');
  setClock(() => at);
  try {
    resetDemo();
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const shop = await shopBySlug(ali, 'ali-barber');
    const danial = tables().barbers.find((b) => b.shop_id === shop.id && b.name === 'Danial')!.id;
    const [first] = (await ali.rpc('shop_queue')).data as Row[];
    const off = await ali.rpc('start_from_queue', { p_id: first.id, p_barber_id: danial });
    assert.deepEqual([off.error?.code, off.error?.message], ['P0001', 'That barber isn\'t working today. Pick another barber.']);
  } finally {
    setClock(() => Date.now());
  }
});

test('taken off the queue, a customer is told for an hour; joining is five times a day; a time today ends a place', async () => {
  // A Tuesday at 3:20 pm, both barbers in (the sample day).
  const { day, at } = thisWeekOn(2, '15:20');
  setClock(() => at);
  try {
    resetDemo();
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
    const farid = await signedIn('farid@demo.potongku.my');
    const shop = await shopBySlug(ali, 'ali-barber');
    const kemas = await shopBySlug(ali, 'kemas-barber-kajang');
    const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!.id as string;
    const mine = async (c: ReturnType<typeof client>) => (await c.rpc('queue_status', { p_shop_id: shop.id })).data.mine as Row | null;
    const join = async (c: ReturnType<typeof client>) => {
      const { data, error } = await c.rpc('join_queue', { p_service_id: haircut });
      assert.equal(error, null);
      return data as Row;
    };

    // Called, then taken off as not here: his page and My bookings say so,
    // with the shop's number and where it is, for Directions.
    const place = await join(hakim);
    await ali.rpc('call_from_queue', { p_id: place.id });
    setClock(() => at + 10 * 60_000);
    await ali.rpc('remove_from_queue', { p_id: place.id });
    assert.deepEqual(
      [(await mine(hakim))?.id, (await mine(hakim))?.state, (await mine(hakim))?.gone_reason, (await mine(hakim))?.place],
      [place.id, 'gone', 'not_here', null],
    );
    const [told] = (await hakim.rpc('my_queue')).data as Row[];
    assert.deepEqual([told.id, told.state, told.gone_reason], [place.id, 'gone', 'not_here']);
    assert.deepEqual(told.shop, {
      name: shop.name,
      slug: 'ali-barber',
      time_zone: TZ,
      phone: shop.phone,
      address: shop.address,
      area: shop.area,
      latitude: shop.latitude,
      longitude: shop.longitude,
    });
    assert.deepEqual((await hakim.rpc('my_bookings')).data.queue, [told]);
    // An hour on, it is as it was.
    setClock(() => at + 71 * 60_000);
    assert.equal(await mine(hakim), null);
    assert.deepEqual((await hakim.rpc('my_queue')).data, []);
    // Joining again, his new place is the one shown; leaving it, nothing is.
    const again = await join(hakim);
    assert.deepEqual([(await mine(hakim))?.id, (await mine(hakim))?.state], [again.id, 'waiting']);
    setClock(() => at + 72 * 60_000);
    await hakim.rpc('leave_queue', { p_id: again.id });
    assert.equal(await mine(hakim), null);

    // Five times a day at one shop, however each place ended.
    for (let n = 0; n < 3; n++) await hakim.rpc('leave_queue', { p_id: (await join(hakim)).id });
    const sixth = await hakim.rpc('join_queue', { p_service_id: haircut });
    assert.deepEqual(
      [sixth.error?.code, sixth.error?.message],
      ['P0001', 'You can join this queue 5 times a day. Book a time instead.'],
    );
    assert.equal(
      tables().queue_entries.filter((e) => e.shop_id === shop.id && e.day === day && e.state === 'gone' && e.gone_reason === 'left').length,
      4,
    );

    // Farid books a time later today: he is out of the queue. Moving a time
    // from another day into today does the same.
    const faridsPlace = await join(farid);
    const later = (await farid.rpc('available_slots', { p_service_id: haircut, p_day: day })).data as Row[];
    const booked = await farid.rpc('book_appointment', { p_service_id: haircut, p_starts_at: later.at(-1)!.starts_at });
    assert.equal(booked.error, null);
    const gone = tables().queue_entries.find((e) => e.id === faridsPlace.id)!;
    assert.deepEqual([gone.state, gone.gone_reason, gone.gone_at], ['gone', 'left', new Date(at + 72 * 60_000).toISOString()]);
    assert.equal(await mine(farid), null);
    await farid.rpc('set_booking_status', { p_booking_id: booked.data.id, p_status: 'cancelled' });
    const tomorrow = addDays(day, 1);
    const nextDay = (await farid.rpc('available_slots', { p_service_id: haircut, p_day: tomorrow })).data as Row[];
    const ahead = await farid.rpc('book_appointment', { p_service_id: haircut, p_starts_at: nextDay[0].starts_at });
    assert.equal(ahead.error, null);
    const second = await join(farid);
    const moved = await farid.rpc('reschedule_booking', { p_booking_id: ahead.data.id, p_starts_at: later.at(-1)!.starts_at });
    assert.equal(moved.error, null);
    assert.equal(tables().queue_entries.find((e) => e.id === second.id)!.gone_reason, 'left');
    // A time at another shop, or another day, leaves the place as it is.
    assert.equal((await farid.rpc('set_booking_status', { p_booking_id: ahead.data.id, p_status: 'cancelled' })).error, null);
    const third = await join(farid);
    const kemasCut = tables().services.find((v) => v.shop_id === kemas.id && v.name === 'Haircut')!.id;
    const kemasSlots = (await farid.rpc('available_slots', { p_service_id: kemasCut, p_day: day })).data as Row[];
    if (kemasSlots.length) {
      assert.equal((await farid.rpc('book_appointment', { p_service_id: kemasCut, p_starts_at: kemasSlots[0].starts_at })).error, null);
    }
    assert.equal((await mine(farid))?.id, third.id);
  } finally {
    setClock(() => Date.now());
  }
});

test('Ali’s sample shop has three in its queue, open whenever he or Danial is in, whatever the day and hour', async () => {
  try {
    // Every hour of the day, each on a different weekday in turn.
    for (let hour = 0; hour < 24; hour++) {
      const date = addDays(today(), hour % 7);
      const at = dayBounds(date, TZ).start.getTime() + (hour * 60 + 7) * 60_000;
      const when = `on ${date} at ${hour}:07`;
      setClock(() => at);
      resetDemo();
      const ali = await signedIn(DEMO_BARBER_EMAIL);
      const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
      const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const inNow = tables()
        .barbers.filter((b) => b.shop_id === shop.id)
        .filter((b) =>
          tables().working_hours.some(
            (h) => h.barber_id === b.id && h.weekday === weekday && String(h.opens_at) <= `${String(hour).padStart(2, '0')}:07` &&
              `${String(hour).padStart(2, '0')}:07` < String(h.closes_at),
          ),
        );
      const { data: status } = await hakim.rpc('queue_status', { p_shop_id: shop.id });
      assert.deepEqual([status.open, status.waiting, status.barbers_in], [inNow.length > 0, 3, inNow.length], when);
      const queue = (await ali.rpc('shop_queue')).data as Row[];
      assert.deepEqual(queue.map((q) => q.name), ['Encik Hisham', 'Jason', 'Adik Faris'], when);
      // Anyone asked for works that day.
      for (const q of queue.filter((q) => q.barber_id != null)) {
        assert.ok(tables().working_hours.some((h) => h.barber_id === q.barber_id && h.weekday === weekday), `${q.name} ${when}`);
      }
      // Hakim can join while it is open.
      const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!;
      const joined = await hakim.rpc('join_queue', { p_service_id: haircut.id });
      assert.equal(joined.error?.message ?? null, inNow.length > 0 ? null : 'The queue isn\'t open right now.', when);
    }
  } finally {
    setClock(() => Date.now());
  }
});

test('opened on a later day, yesterday’s queue is over and today’s sample queue takes its place', async () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  const { at } = thisWeekOn(2, '15:20');
  setClock(() => at);
  try {
    resetDemo();
    const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
    const ali = await signedIn(DEMO_BARBER_EMAIL);
    const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
    const haircut = tables().services.find((v) => v.shop_id === shop.id && v.name === 'Haircut')!;
    assert.equal((await hakim.rpc('join_queue', { p_service_id: haircut.id })).error, null);
    const [first] = (await ali.rpc('shop_queue')).data as Row[];
    await ali.rpc('remove_from_queue', { p_id: first.id });

    // Later the same day, it is as it was left.
    reloadTables();
    assert.deepEqual(((await ali.rpc('shop_queue')).data as Row[]).map((q) => q.name), ['Jason', 'Adik Faris', 'Hakim']);

    // The next day, Hakim's place is gone and the sample's three wait again.
    setClock(() => at + 86_400_000);
    reloadTables();
    const tomorrow = localDateString(new Date(at + 86_400_000), TZ);
    assert.deepEqual(((await ali.rpc('shop_queue')).data as Row[]).map((q) => q.name), ['Encik Hisham', 'Jason', 'Adik Faris']);
    assert.ok(tables().queue_entries.every((e) => e.day === tomorrow));
    assert.deepEqual((await hakim.rpc('my_queue')).data, []);

    // A shop that turned its queue off gets none.
    assert.equal((await ali.from('shops').update({ queue_enabled: false }).eq('id', shop.id)).error, null);
    setClock(() => at + 2 * 86_400_000);
    reloadTables();
    assert.deepEqual(tables().queue_entries, []);

    // A demo saved before the queue came in gets it, with Ali's switched on.
    const [key, json] = [...saved.entries()].find(([k]) => k === 'potongku.demo.v1')!;
    const old = JSON.parse(json);
    delete old.tables.queue_entries;
    for (const s of old.tables.shops) delete s.queue_enabled;
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.equal(tables().shops.find((s) => s.id === shop.id)!.queue_enabled, true);
    assert.equal(tables().shops.filter((s) => s.queue_enabled === true).length, 2);
    assert.deepEqual(((await ali.rpc('shop_queue')).data as Row[]).map((q) => q.name), ['Encik Hisham', 'Jason', 'Adik Faris']);
  } finally {
    setClock(() => Date.now());
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});

// Whole screens in one request ---------------------------------------------------

type Client = ReturnType<typeof client>;
/** Working hours in one order: the requests the app sent before left it to the database. */
const byHours = (hours: Row[]) =>
  [...hours].sort((a, b) => Number(a.weekday) - Number(b.weekday) || String(a.opens_at).localeCompare(String(b.opens_at)));
const withSortedHours = (barbers: Row[]) => barbers.map((b) => ({ ...b, working_hours: byHours(b.working_hours as Row[]) }));
/** Rows in time order, then by id, as the one request sends them. */
const byStart = (rows: Row[]) =>
  [...rows].sort((a, b) => Date.parse(String(a.starts_at)) - Date.parse(String(b.starts_at)) || (String(a.id) < String(b.id) ? -1 : 1));

/** What a shop's page asked for before shop_page, one request each, as the app sent them. */
async function shopPageBefore(c: Client, slug: string) {
  const shop = (await c.from('shops').select('*').eq('slug', slug).maybeSingle()).data;
  if (!shop) {
    const status = (await c.rpc('shop_public_status', { p_slug: slug })).data as Row[];
    return { shop: null, status: status[0] ?? null };
  }
  const day = localDateString(new Date(demoNow()), shop.time_zone);
  const [services, barbers, closed, hours, queue, reviews] = await Promise.all([
    c.from('services').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
    c
      .from('barbers')
      .select('*, working_hours(weekday, opens_at, closes_at)')
      .eq('shop_id', shop.id)
      .eq('is_active', true)
      .order('sort_order')
      .order('name'),
    c.rpc('shop_closed_days', { p_shop_id: shop.id, p_from: day, p_to: addDays(day, 13) }),
    c.rpc('shop_hours_today', { p_shop_id: shop.id }),
    shop.queue_enabled ? c.rpc('queue_status', { p_shop_id: shop.id }) : null,
    c
      .from('reviews')
      .select('booking_id, rating, comment, first_name, reply, replied_at, created_at, barbers(name)')
      .eq('shop_id', shop.id)
      .eq('removed', false)
      .order('created_at', { ascending: false })
      .order('booking_id')
      .range(0, 3),
  ]);
  const photos = await c
    .from('shop_photos')
    .select('id, barber_id, caption, path, thumb_path, width, height, sort_order')
    .eq('shop_id', shop.id)
    .order('sort_order')
    .order('created_at')
    .order('id')
    .limit(24);
  return {
    shop,
    services: services.data,
    barbers: withSortedHours(barbers.data as Row[]),
    today: day,
    closed_days: closed.data,
    hours_today: (hours.data as Row[])[0],
    queue: queue ? queue.data : null,
    photos: photos.data,
    reviews: reviews.data!.slice(0, 3),
    more_reviews: reviews.data!.length > 3,
  };
}

async function shopPage(c: Client, slug: string) {
  const { data, error } = await c.rpc('shop_page', { p_slug: slug });
  assert.equal(error, null);
  return data;
}

test('a shop’s page comes in one answer, part for part what its requests gave a guest, a customer and the owner', async () => {
  try {
    // A few hours of the day, each on another weekday: the queue open and shut, today's hours, the closed days.
    for (const hour of [0, 9, 13, 21]) {
      const date = addDays(today(), hour % 7);
      const at = dayBounds(date, TZ).start.getTime() + (hour * 60 + 7) * 60_000;
      const when = `on ${date} at ${hour}:07`;
      setClock(() => at);
      resetDemo();
      const ali = await signedIn(DEMO_BARBER_EMAIL);
      const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
      const guest = client();
      const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
      const team = tables().barbers.filter((b) => b.shop_id === shop.id);
      // A closure and a barber's day off in the next fortnight, with reasons only the owner may read,
      // and Hakim in the queue today.
      insertRow('shop_closures', { shop_id: shop.id, day: addDays(date, 6), reason: 'Hari Raya' });
      // Danial's customers that day are put off first: a barber can't be booked twice.
      const off = addDays(date, 12);
      const offStart = dayBounds(off, TZ).start.getTime();
      updateRows(
        'bookings',
        tables().bookings.filter(
          (b) => b.barber_id === team[1].id && Date.parse(String(b.ends_at)) > offStart && Date.parse(String(b.starts_at)) < offStart + 86_400_000,
        ),
        { status: 'cancelled' },
      );
      insertRow('bookings', {
        shop_id: shop.id,
        barber_id: team[1].id,
        is_block: true,
        service_name: 'Kenduri',
        price: 0,
        starts_at: dayBounds(off, TZ).start.toISOString(),
        ends_at: dayBounds(addDays(off, 1), TZ).start.toISOString(),
      });
      const hakimId = (await hakim.auth.getUser()).data.user!.id;
      insertRow('queue_entries', { shop_id: shop.id, day: date, customer_id: hakimId, created_at: new Date(at).toISOString() });
      // The newest review, removed by the team: not on the page, even for the owner.
      const newest = tables()
        .reviews.filter((r) => r.shop_id === shop.id)
        .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))[0];
      insertRow('review_reports', { booking_id: newest.booking_id, shop_id: shop.id, reason: 'rude', outcome: 'removed' });

      for (const [who, c] of [['guest', guest], ['Hakim', hakim], ['Ali', ali]] as const) {
        for (const slug of ['ali-barber', 'kemas-barber-kajang', 'the-fade-room']) {
          assert.deepEqual(await shopPage(c, slug), await shopPageBefore(c, slug), `${who} at ${slug} ${when}`);
        }
      }
      const page = await shopPage(guest, 'ali-barber');
      assert.equal(page.shop.name, 'Ali Barber Sungai Chua');
      assert.equal(page.reviews.length, 3);
      assert.ok(!(await shopPage(ali, 'ali-barber')).reviews.some((r: Row) => r.booking_id === newest.booking_id));
      assert.equal(page.more_reviews, true);
      assert.ok(page.photos.length > 0);
      assert.equal(page.photos.length, tables().shop_photos.filter((p) => p.shop_id === shop.id).length);
      assert.ok(page.barbers.every((b: Row) => (b.working_hours as Row[]).length > 0));
      assert.ok(page.queue.waiting >= 3, when);
      assert.equal(page.queue.mine, null);
      assert.equal((await shopPage(hakim, 'ali-barber')).queue.mine.state, 'waiting', when);
      assert.deepEqual(
        page.closed_days.map((d: Row) => [d.day, d.reason]),
        [
          [addDays(date, 6), null],
          [off, null],
        ],
        when,
      );
      assert.ok(JSON.stringify(await shopPage(ali, 'ali-barber')).includes('Hari Raya'), 'the owner sees the reasons');
      // Nothing private reaches a guest: no customer's number, note or account, nobody in the queue, no reasons.
      const text = JSON.stringify(page);
      const hakimProfile = tables().profiles.find((p) => p.id === hakimId)!;
      const customers = tables().profiles.filter((p) => p.role === 'customer' && p.phone);
      const notes = tables().bookings.filter((b) => b.customer_note).map((b) => String(b.customer_note));
      assert.ok(notes.length > 0 && customers.length > 0);
      for (const secret of [...customers.map((p) => String(p.phone)), ...notes, 'Kenduri', 'Hari Raya', hakimId, 'customer_id']) {
        assert.ok(!text.includes(secret), `a guest must not see ${secret}`);
      }
      assert.ok(!JSON.stringify(await shopPage(hakim, 'ali-barber')).includes('Kenduri'));
      assert.equal(hakimProfile.full_name, 'Hakim');

      // Paused: customers only learn whose shop it is; the owner still sees their page; an unknown link, nothing.
      assert.equal((await ali.from('shops').update({ is_published: false }).eq('id', shop.id)).error, null);
      for (const [who, c] of [['guest', guest], ['Hakim', hakim], ['Ali', ali]] as const) {
        assert.deepEqual(await shopPage(c, 'ali-barber'), await shopPageBefore(c, 'ali-barber'), `${who} paused ${when}`);
        assert.deepEqual(await shopPage(c, 'nope'), { shop: null, status: null });
      }
      assert.deepEqual(await shopPage(guest, 'ali-barber'), {
        shop: null,
        status: { name: 'Ali Barber Sungai Chua', phone: '012-345 6789', is_live: false },
      });
      assert.equal((await shopPage(ali, 'ali-barber')).shop.name, 'Ali Barber Sungai Chua');
    }
  } finally {
    setClock(() => Date.now());
  }
});

/** What the Bookings tab asked for on a day before shop_day, one request each, as the app sent them. */
async function shopDayBefore(c: Client, day: string, since: string | null = null, limit = 5) {
  const uid = (await c.auth.getUser()).data.user!.id;
  const mine = (await c.from('shops').select('*').eq('owner_id', uid).maybeSingle()).data!;
  const tz = mine.time_zone;
  const now = localDateString(new Date(demoNow()), tz);
  const days = [addDays(now, -1), addDays(now, 13)];
  const { start, end } = dayBounds(day, tz);
  const next = dayBounds(addDays(now, 1), tz);
  const [list, active, team, closed, unreminded, waitlist, queued, changes] = await Promise.all([
    c
      .from('bookings')
      .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
      .eq('shop_id', mine.id)
      .gte('starts_at', start.toISOString())
      .lt('starts_at', end.toISOString())
      .order('starts_at'),
    c.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', mine.id).eq('is_active', true),
    c.from('barbers').select('*, working_hours(*)').eq('shop_id', mine.id).order('sort_order').order('created_at'),
    c.rpc('shop_closed_days', {
      p_shop_id: mine.id,
      p_from: day < days[0] ? day : days[0],
      p_to: day > days[1] ? day : days[1],
    }),
    day === now
      ? c
          .from('bookings')
          .select(
            'id, barber_id, status, is_block, starts_at, reminded_at, guest_phone, created_at, customer:profiles!bookings_customer_id_fkey(phone)',
          )
          .eq('shop_id', mine.id)
          .eq('status', 'confirmed')
          .eq('is_block', false)
          .is('reminded_at', null)
          .gte('starts_at', next.start.toISOString())
          .lt('starts_at', next.end.toISOString())
      : null,
    day >= now ? c.rpc('shop_waitlist', { p_day: day }) : null,
    day === now ? c.rpc('shop_queue') : null,
    c.rpc('shop_changes', { p_since: since, p_limit: limit }),
  ]);
  return {
    bookings: byStart(list.data as Row[]),
    services: active.count,
    barbers: withSortedHours(
      [...(team.data as Row[])].sort(
        (a, b) =>
          Number(a.sort_order) - Number(b.sort_order) ||
          Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) ||
          (String(a.id) < String(b.id) ? -1 : 1),
      ),
    ),
    closed: closed.data,
    tomorrow: unreminded ? byStart(unreminded.data as unknown as Row[]) : [],
    waiting: waitlist ? waitlist.data : [],
    queue: queued ? queued.data : [],
    changes: changes.data,
  };
}

async function shopDay(c: Client, day: string, since: string | null = null, limit = 5) {
  const { data, error } = await c.rpc('shop_day', { p_day: day, p_since: since, p_limit: limit });
  assert.equal(error, null);
  return data;
}

test('the barber’s day comes in one answer, part for part what the Bookings tab’s requests gave the owner', async () => {
  try {
    for (const hour of [0, 10, 18, 23]) {
      const date = addDays(today(), hour % 7);
      const at = dayBounds(date, TZ).start.getTime() + (hour * 60 + 7) * 60_000;
      const when = `on ${date} at ${hour}:07`;
      setClock(() => at);
      resetDemo();
      const ali = await signedIn(DEMO_BARBER_EMAIL);
      const shop = tables().shops.find((s) => s.slug === 'ali-barber')!;
      insertRow('shop_closures', { shop_id: shop.id, day: addDays(date, 3), reason: 'Hari Raya' });
      insertRow('shop_closures', { shop_id: shop.id, day: addDays(date, 40), reason: 'Kenduri' });
      const saturday = String(tables().waitlist.find((w) => w.shop_id === shop.id)!.day);
      const days = [addDays(date, -7), addDays(date, -1), date, addDays(date, 1), addDays(date, 3), saturday, addDays(date, 40)];
      for (const day of days) assert.deepEqual(await shopDay(ali, day), await shopDayBefore(ali, day), `${day} ${when}`);
      const mark = (await shopDay(ali, date)).changes.changes[1]?.changed_at ?? null;
      assert.ok(mark, `the sample has changes to count from ${when}`);
      assert.deepEqual(await shopDay(ali, date, mark, 1), await shopDayBefore(ali, date, mark, 1), when);

      // Something in every part on its day.
      const todays = await shopDay(ali, date);
      assert.ok(todays.bookings.some((b: Row) => (b.customer as Row | null)?.phone && b.barbers), when);
      assert.equal(todays.services, 5);
      assert.ok(todays.tomorrow.length >= 2, when);
      assert.deepEqual(todays.queue.map((q: Row) => q.name), ['Encik Hisham', 'Jason', 'Adik Faris'], when);
      assert.equal(todays.changes.count, 3, when);
      assert.ok(todays.closed.some((d: Row) => d.reason === 'Hari Raya'), when);
      assert.deepEqual((await shopDay(ali, saturday)).waiting.map((w: Row) => w.name), ['Farid', 'Aiman'], when);
      assert.ok((await shopDay(ali, addDays(date, 40))).closed.some((d: Row) => d.reason === 'Kenduri'), 'a day off the strip');
      assert.deepEqual((await shopDay(ali, addDays(date, 1))).queue, []);

      // Paused, the owner's day is the same as before.
      assert.equal((await ali.from('shops').update({ is_published: false }).eq('id', shop.id)).error, null);
      assert.deepEqual(await shopDay(ali, date), await shopDayBefore(ali, date), `paused ${when}`);
    }
  } finally {
    setClock(() => Date.now());
  }

  // Another owner gets their own shop's day and nothing of Ali's; customers have none, and guests can't ask.
  // The clock stands still, as a phone that never looked counts from 24 hours before the call.
  const at = Date.now();
  setClock(() => at);
  const rahman = await signedIn('rahman@demo.potongku.my');
  const kemas = tables().shops.find((s) => s.slug === 'kemas-barber-kajang')!;
  const ali = tables().shops.find((s) => s.slug === 'ali-barber')!;
  let seen = 0;
  const booked = tables()
    .bookings.filter((b) => b.shop_id === kemas.id)
    .map((b) => localDateString(new Date(String(b.starts_at)), TZ))
    .filter((d) => d >= addDays(today(), -7) && d <= addDays(today(), 13));
  for (const day of [...new Set([today(), addDays(today(), 1), ...booked.slice(0, 3)])]) {
    const theirs = await shopDay(rahman, day);
    seen += theirs.bookings.length;
    assert.deepEqual(theirs, await shopDayBefore(rahman, day), day);
    assert.ok((theirs.bookings as Row[]).every((b) => b.shop_id === kemas.id));
    assert.ok((theirs.barbers as Row[]).every((b) => b.shop_id === kemas.id));
    assert.ok(!JSON.stringify(theirs).includes(String(ali.id)), 'nothing of Ali’s shop');
    // Not one of Ali's bookings, queue places or requests, nor his barbers.
    const alis = [
      ...tables().bookings.filter((b) => b.shop_id === ali.id),
      ...tables().queue_entries.filter((e) => e.shop_id === ali.id),
      ...tables().waitlist.filter((w) => w.shop_id === ali.id),
      ...tables().barbers.filter((b) => b.shop_id === ali.id),
    ].map((r) => String(r.id));
    assert.ok(alis.length > 50);
    for (const id of alis) assert.ok(!JSON.stringify(theirs).includes(id), id);
  }
  assert.ok(seen > 0, 'Rahman has bookings of his own');
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const notOwner = await hakim.rpc('shop_day', { p_day: today() });
  assert.deepEqual([notOwner.error?.code, notOwner.error?.message], ['P0002', 'Set up your shop first.']);
  assert.equal((await client().rpc('shop_day', { p_day: today() })).error?.code, '42501');
  setClock(() => Date.now());
});

// Photos of the shop's cuts ---------------------------------------------------

const PHOTO_COLUMNS = 'id, barber_id, caption, path, thumb_path, width, height, sort_order';
const jpeg = (size = 64) => Uint8Array.from({ length: size }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : i % 251));

async function photosOf(c: ReturnType<typeof client>, shopId: unknown) {
  const { data, error } = await c
    .from('shop_photos')
    .select(PHOTO_COLUMNS)
    .eq('shop_id', shopId)
    .order('sort_order')
    .order('created_at')
    .order('id')
    .limit(24);
  assert.equal(error, null);
  return data as Row[];
}

/** What the app does to add one: both files, then the row. */
async function addPhoto(c: ReturnType<typeof client>, shopId: unknown, name: string, row: Row = {}) {
  const files = c.storage.from('shop-photos');
  assert.equal((await files.upload(`${shopId}/${name}.jpg`, jpeg(), PHOTO_UPLOAD)).error, null);
  assert.equal((await files.upload(`${shopId}/${name}-thumb.jpg`, jpeg(16), PHOTO_UPLOAD)).error, null);
  return c
    .from('shop_photos')
    .insert({ shop_id: shopId, path: `${shopId}/${name}.jpg`, thumb_path: `${shopId}/${name}-thumb.jpg`, width: 1200, height: 1600, ...row })
    .select(PHOTO_COLUMNS)
    .single();
}

const publicFile = (path: string) => demoFetch(`${DEMO_URL}/storage/v1/object/public/shop-photos/${path}`);

test('Ali’s sample shop has drawn photos of his and Danial’s cuts, which anyone can look through', async () => {
  const guest = client();
  const shop = await shopBySlug(guest, 'ali-barber');
  const photos = await photosOf(guest, shop.id);
  assert.equal(photos.length, 7);
  assert.deepEqual(photos.map((p) => p.sort_order), [0, 1, 2, 3, 4, 5, 6]);
  const names = new Map(tables().barbers.map((b) => [b.id, b.name]));
  assert.deepEqual(
    photos.map((p) => names.get(p.barber_id)),
    ['Ali', 'Danial', 'Ali', 'Danial', 'Ali', 'Danial', 'Ali'],
  );
  assert.equal(photos[0].caption, 'Skin fade with a hard part');
  for (const p of photos) {
    assert.ok(String(p.path).startsWith(`${shop.id}/sample-`));
    assert.ok(Number(p.width) <= 1600 && Number(p.height) <= 1600);
    // Each file is there, as Supabase's public link gives it.
    for (const path of [p.path, p.thumb_path]) {
      const res = await publicFile(String(path));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/svg+xml');
      assert.match(await res.text(), /Sample illustration/);
    }
  }
  // The app shows them by a data: link, as the demo page lets images come only from data: and blob:.
  assert.match(demoFileUrl('shop-photos', String(photos[0].thumb_path)), /^data:image\/svg\+xml/);
  assert.equal((await publicFile(`${shop.id}/nope.jpg`)).status, 404);

  // Find a barber shows each shop's first photo, and nothing for a shop without any.
  const found = (await guest.rpc('find_shops', {})).data as Row[];
  assert.equal(found.find((s) => s.slug === 'ali-barber')!.photo_thumb, photos[0].thumb_path);
  assert.ok(found.filter((s) => s.slug !== 'ali-barber').every((s) => s.photo_thumb === null));
});

test('the owner adds photos to their shop’s folder, tags the barber, writes a caption and moves one first', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const danial = barberNamed('ali-barber', 'Danial');

  const added = await addPhoto(ali, shop.id, 'fresh');
  assert.equal(added.error, null);
  assert.equal(added.data!.sort_order, 7, 'a new photo goes last');
  assert.equal(added.data!.barber_id, null);
  const res = await publicFile(`${shop.id}/fresh.jpg`);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  // Kept a day, so a removed photo's link stops working within a day.
  assert.equal(res.headers.get('cache-control'), 'max-age=86400');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg());
  assert.ok(/^(blob:|data:image\/jpeg)/.test(demoFileUrl('shop-photos', `${shop.id}/fresh-thumb.jpg`)));

  // Who did it and what it is, then first in the list.
  const id = added.data!.id;
  const first = Math.min(...(await photosOf(ali, shop.id)).map((p) => Number(p.sort_order))) - 1;
  const edit = await ali
    .from('shop_photos')
    .update({ barber_id: danial.id, caption: 'Mid fade for Raya', sort_order: first })
    .eq('id', id)
    .select(PHOTO_COLUMNS)
    .single();
  assert.equal(edit.error, null);
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const seen = await photosOf(hakim, shop.id);
  assert.equal(seen[0].id, id);
  assert.deepEqual([seen[0].barber_id, seen[0].caption], [danial.id, 'Mid fade for Raya']);
  const found = (await hakim.rpc('find_shops', {})).data as Row[];
  assert.equal(found.find((s) => s.slug === 'ali-barber')!.photo_thumb, `${shop.id}/fresh-thumb.jpg`);

  // Removing it takes the row and both files.
  assert.equal((await ali.from('shop_photos').delete().eq('id', id)).error, null);
  const removed = await ali.storage.from('shop-photos').remove([`${shop.id}/fresh.jpg`, `${shop.id}/fresh-thumb.jpg`]);
  assert.equal(removed.error, null);
  assert.equal(removed.data!.length, 2);
  assert.equal((await publicFile(`${shop.id}/fresh.jpg`)).status, 404);
  assert.equal((await photosOf(hakim, shop.id)).length, 7);

  // A sample photo goes the same way.
  const sample = (await photosOf(ali, shop.id))[0];
  assert.equal((await ali.from('shop_photos').delete().eq('id', sample.id)).error, null);
  assert.equal((await ali.storage.from('shop-photos').remove([String(sample.path), String(sample.thumb_path)])).data!.length, 2);
  assert.equal((await publicFile(String(sample.path))).status, 404);
  assert.match(decodeURIComponent(demoFileUrl('shop-photos', String(sample.path))), /Photo not kept/);
  // And a reset brings it back.
  resetDemo();
  assert.equal((await publicFile(String(sample.path))).status, 200);
});

test('only the owner writes their shop’s photos and files, within the bucket’s limits', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const other = await shopBySlug(client(), 'the-fade-room');
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  const guest = client();
  const options = { contentType: 'image/jpeg', upsert: false };

  // Files: only into the owner's own shop's folder, as JPEG, PNG or WebP of up to 2 MB, never over another.
  for (const [c, path] of [
    [hakim, `${shop.id}/x.jpg`],
    [guest, `${shop.id}/x.jpg`],
    [ali, `${other.id}/x.jpg`],
    [ali, 'x.jpg'],
  ] as const) {
    const { error } = await c.storage.from('shop-photos').upload(path, jpeg(), options);
    assert.equal((error as { statusCode?: string } | null)?.statusCode, '403', path);
  }
  const files = ali.storage.from('shop-photos');
  const gif = await files.upload(`${shop.id}/x.gif`, jpeg(), { contentType: 'image/gif' });
  assert.equal((gif.error as { statusCode?: string }).statusCode, '415');
  const svg = await files.upload(`${shop.id}/x.svg`, '<svg/>', { contentType: 'image/svg+xml' });
  assert.equal((svg.error as { statusCode?: string }).statusCode, '415');
  const big = await files.upload(`${shop.id}/big.jpg`, new Uint8Array(2 * 1024 * 1024 + 1), options);
  assert.equal((big.error as { statusCode?: string }).statusCode, '413');
  assert.equal((await files.upload(`${shop.id}/x.jpg`, jpeg(), options)).error, null);
  const again = await files.upload(`${shop.id}/x.jpg`, jpeg(), options);
  assert.equal((again.error as { statusCode?: string }).statusCode, '409');
  assert.equal((await files.upload(`${shop.id}/x.jpg`, jpeg(), { ...options, upsert: true })).error?.message,
    'new row violates row-level security policy');
  // Others' files are left alone, without a word, as Storage does.
  const theirs = await hakim.storage.from('shop-photos').remove([`${shop.id}/x.jpg`]);
  assert.deepEqual(theirs.data, []);
  assert.equal((await publicFile(`${shop.id}/x.jpg`)).status, 200);

  // Rows: only the owner adds, changes or removes them.
  const row = { shop_id: shop.id, path: `${shop.id}/y.jpg`, thumb_path: `${shop.id}/y-thumb.jpg`, width: 800, height: 600 };
  assert.equal((await hakim.from('shop_photos').insert(row)).error?.code, '42501');
  assert.equal((await guest.from('shop_photos').insert(row)).error?.code, '42501');
  const [mine] = await photosOf(ali, shop.id);
  await hakim.from('shop_photos').update({ caption: 'Mine now' }).eq('id', mine.id);
  await hakim.from('shop_photos').delete().eq('id', mine.id);
  assert.equal(tables().shop_photos.find((p) => p.id === mine.id)!.caption, 'Skin fade with a hard part');
  // A photo's files, shop and place on the way in are the database's.
  assert.equal((await ali.from('shop_photos').update({ path: `${shop.id}/z.jpg` }).eq('id', mine.id)).error?.code, '42501');
  assert.equal((await ali.from('shop_photos').update({ shop_id: other.id }).eq('id', mine.id)).error?.code, '42501');
  assert.equal((await ali.from('shop_photos').insert({ ...row, sort_order: -5 })).error?.code, '42501');

  // What a photo may be.
  const bad = async (patch: Row) => (await ali.from('shop_photos').insert({ ...row, ...patch })).error;
  assert.equal((await bad({ caption: 'x'.repeat(61) }))?.code, '23514');
  assert.equal((await bad({ caption: '   ' }))?.code, '23514');
  assert.equal((await bad({ caption: 'Two\nlines' }))?.code, '23514');
  assert.equal((await bad({ width: 2400 }))?.code, '23514');
  assert.equal((await bad({ path: `${other.id}/y.jpg` }))?.code, '23514');
  assert.equal((await bad({ path: `${shop.id}/a/y.jpg` }))?.code, '23514');
  assert.equal((await bad({ thumb_path: row.path }))?.code, '23514');
  assert.equal((await bad({ path: String(mine.path) }))?.code, '23505');
  const kemas = tables().barbers.find((b) => b.shop_id !== shop.id)!;
  assert.equal((await bad({ barber_id: kemas.id }))?.message, 'Barber not found.');
  assert.equal((await ali.from('shop_photos').update({ barber_id: kemas.id }).eq('id', mine.id)).error?.message, 'Barber not found.');
  assert.equal((await ali.from('shop_photos').insert({ ...row, caption: 'Fine' }).select('sort_order').single()).data?.sort_order, 7);
});

test('a shop keeps at most 24 photos, and removing one makes room', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  for (let i = 7; i < 24; i++) assert.equal((await addPhoto(ali, shop.id, `p${i}`)).error, null);
  const full = await addPhoto(ali, shop.id, 'p24');
  assert.equal(full.error?.message, 'Your shop has 24 photos, the most it can have. Remove one to add another.');
  assert.equal(tables().shop_photos.filter((p) => p.shop_id === shop.id).length, 24);
  const [first] = await photosOf(ali, shop.id);
  await ali.from('shop_photos').delete().eq('id', first.id);
  assert.equal((await ali.from('shop_photos').insert({
    shop_id: shop.id, path: `${shop.id}/p24.jpg`, thumb_path: `${shop.id}/p24-thumb.jpg`, width: 1200, height: 1600,
  })).error, null);
});

test('a shop’s folder holds at most 56 files, so files no photo lists can’t fill the bucket', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const files = ali.storage.from('shop-photos');
  // The 7 sample photos are 14 files; the rest are uploads no photo lists, as a phone that lost signal leaves.
  for (let i = 14; i < 56; i++) assert.equal((await files.upload(`${shop.id}/stray${i}.jpg`, jpeg(), PHOTO_UPLOAD)).error, null);
  const listed = await files.list(String(shop.id), { limit: 100 });
  assert.equal(listed.error, null);
  assert.equal(listed.data!.length, 56);
  assert.ok(listed.data!.some((f) => f.name === 'sample-skin-fade.svg'));
  const refused = await files.upload(`${shop.id}/one-more.jpg`, jpeg(), PHOTO_UPLOAD);
  assert.equal((refused.error as { statusCode?: string }).statusCode, '403');
  // Removing one makes room again.
  assert.equal((await files.remove([`${shop.id}/stray14.jpg`])).data?.length, 1);
  assert.equal((await files.upload(`${shop.id}/one-more.jpg`, jpeg(), PHOTO_UPLOAD)).error, null);
  // Another shop's folder has its own count, and nobody else can list Ali's.
  const hakim = await signedIn(DEMO_CUSTOMER_EMAIL);
  assert.deepEqual((await hakim.storage.from('shop-photos').list(String(shop.id))).data, []);
  assert.deepEqual((await client().storage.from('shop-photos').list(String(shop.id))).data, []);
});

test('a paused shop’s photos are its owner’s alone, and a deleted barber or shop takes theirs along', async () => {
  const ali = await signedIn(DEMO_BARBER_EMAIL);
  const shop = await shopBySlug(ali, 'ali-barber');
  const guest = client();
  await ali.from('shops').update({ is_published: false }).eq('id', shop.id);
  assert.deepEqual(await photosOf(guest, shop.id), []);
  assert.deepEqual(await photosOf(await signedIn(DEMO_CUSTOMER_EMAIL), shop.id), []);
  assert.equal((await photosOf(ali, shop.id)).length, 7);
  await ali.from('shops').update({ is_published: true }).eq('id', shop.id);

  // Danial leaves: his photos stay, without a name.
  const danial = barberNamed('ali-barber', 'Danial');
  tables().bookings = tables().bookings.filter((b) => b.barber_id !== danial.id);
  tables().reviews = tables().reviews.filter((r) => r.barber_id !== danial.id);
  assert.equal((await ali.from('barbers').delete().eq('id', danial.id)).error, null);
  const left = await photosOf(guest, shop.id);
  assert.equal(left.length, 7);
  assert.equal(left.filter((p) => p.barber_id === null).length, 3);

  // Ali deletes his account: the shop's photos go with it.
  assert.equal((await ali.rpc('delete_my_account')).error, null);
  assert.equal(tables().shop_photos.length, 0);
});

test('a demo saved before shops had photos gets the sample ones, without a barber it no longer has', () => {
  const saved = new Map<string, string>();
  const fake = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    resetDemo();
    const sample = tables().shop_photos.map((p) => ({ ...p }));
    const [key, json] = [...saved.entries()][0];
    const old = JSON.parse(json);
    delete old.tables.shop_photos;
    const danial = old.tables.barbers.find((b: Row) => b.name === 'Danial');
    old.tables.barbers = old.tables.barbers.filter((b: Row) => b !== danial);
    saved.set(key, JSON.stringify(old));
    reloadTables();
    assert.equal(tables().shop_photos.length, 7);
    assert.deepEqual(
      tables().shop_photos.map((p) => p.barber_id),
      sample.map((p) => (p.barber_id === danial.id ? null : p.barber_id)),
    );
    assert.ok(Array.isArray(JSON.parse(saved.get(key)!).tables.shop_photos), 'saved with them');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    reloadTables();
  }
});
