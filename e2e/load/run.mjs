// Load test: sends the app's own requests (same query shapes, through
// postgrest-js) to a PostgREST filled by seed.sql, many at once, and reports
// how fast each screen's data comes back. Then a pre-Raya rush: hundreds of
// customers booking one shop's Saturday at the same moment.
//
// Env: REST_URL (PostgREST), JWT_SECRET, SHOPS, CUSTOMERS (as seeded),
//      CONCURRENCY (default 50), SECONDS per scenario (default 15),
//      RUSH (customers in the rush, default 300), ONLY (comma list of scenarios)
//
// Some screens against a PostgREST of your own, e.g. on port 54581:
//   REST_URL=http://127.0.0.1:54581 JWT_SECRET=... ONLY="shop page,barber's day" SECONDS=10 node e2e/load/run.mjs

import crypto from 'node:crypto';

import { PostgrestClient } from '@supabase/postgrest-js';

import { signJwt } from '../backend/jwt.mjs';

const REST_URL = process.env.REST_URL ?? 'http://127.0.0.1:54352';
const SECRET = process.env.JWT_SECRET;
const SHOPS = Number(process.env.SHOPS ?? 1000);
const CUSTOMERS = Number(process.env.CUSTOMERS ?? 100000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const SECONDS = Number(process.env.SECONDS ?? 15);
const RUSH = Number(process.env.RUSH ?? 300);
const ONLY = process.env.ONLY?.split(',');
const TZ = 'Asia/Kuala_Lumpur';

/** The same ids seed.sql makes with md5(text)::uuid. */
const idOf = (text) => crypto.createHash('md5').update(text).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const pick = (n) => 1 + Math.floor(Math.random() * n);
const AREAS = ['Kajang', 'Bangi', 'Semenyih', 'Cheras', 'Ipoh', 'Melaka', 'Kuching', 'Gunting 12'];

function client(sub) {
  const now = Math.floor(Date.now() / 1000);
  const claims = sub
    ? { sub, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }
    : { role: 'anon', iat: now, exp: now + 3600 };
  return new PostgrestClient(REST_URL, { headers: { Authorization: `Bearer ${signJwt(claims, SECRET)}` } });
}
const anon = client(null);
const customer = () => client(idOf(`customer${pick(CUSTOMERS)}`));
const owner = (i) => client(idOf(`owner${i}`));

const localDate = (offsetDays) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86_400_000));
/** This week in Kajang, Monday to Sunday, as My shop's takings card asks for it. */
function thisWeek() {
  const back = (new Date(`${localDate(0)}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { from: localDate(-back), to: localDate(6 - back) };
}
/** Next Saturday in Kajang (a busy day), at least two days out. */
function nextSaturday() {
  for (let d = 2; d < 10; d++) {
    const day = localDate(d);
    if (new Date(`${day}T00:00:00Z`).getUTCDay() === 6) return day;
  }
  return localDate(2);
}

async function must(promise) {
  const res = await promise;
  if (res.error) throw new Error(`${res.error.code ?? res.status}: ${res.error.message}`);
  return res;
}

/** The data each screen loads, the way the app asks for it. */
const SCENARIOS = {
  // Signed in, so their next cut and their barbers come alongside the list.
  'Find a barber': async () => {
    const c = customer();
    return Promise.all([
      must(c.rpc('find_shops', { p_search: null, p_area: null, p_limit: 20, p_offset: 0 })),
      must(c.rpc('shop_areas')),
      must(c.rpc('my_shops')),
    ]);
  },
  // Near me from somewhere around Kajang, within about 5 km of the town, to
  // three decimals as the app sends it: every shop measured, the nearest 21 kept.
  'Barbers near me': async () => {
    const c = customer();
    const around = (centre) => Math.round((centre + (Math.random() - 0.5) * 0.1) * 1000) / 1000;
    return Promise.all([
      must(
        c.rpc('find_shops', {
          p_search: null,
          p_area: null,
          p_limit: 21,
          p_offset: 0,
          p_lat: around(2.99),
          p_lng: around(101.79),
        }),
      ),
      must(c.rpc('shop_areas')),
      must(c.rpc('my_shops')),
    ]);
  },
  'Search for a barber': async () =>
    must(anon.rpc('find_shops', { p_search: AREAS[pick(AREAS.length) - 1], p_area: null, p_limit: 20, p_offset: 0 })),
  // Everything the page shows on opening, in one request (shop_page): the shop, its services, barbers
  // with their hours, intros and stars, closed days, today's hours, the walk-in queue at the one shop in
  // three that runs one, and the newest reviews. Another day's free times and more reviews come later.
  'Shop page': async () => must(anon.rpc('shop_page', { p_slug: `kedai-gunting-${pick(SHOPS)}` })),
  'Free times for a day': async () =>
    must(
      anon.rpc('available_slots', {
        p_service_id: idOf(`service${pick(SHOPS)}-1`),
        p_day: localDate(pick(7)),
        p_barber_id: null,
      }),
    ),
  // One request: the bookings come with the days they are waiting on and their place in a walk-in queue.
  'My bookings': async () => must(customer().rpc('my_bookings')),
  // Not something the app sends, but anyone with an account can: the
  // bookings policy has to stay fast without the app's filter.
  'Every booking I may see': async () =>
    must(customer().from('bookings').select('id, starts_at').order('starts_at', { ascending: false }).limit(100)),
  // Everything the Bookings tab shows, in one request (shop_day), on opening and each minute: the day's
  // bookings, the team with their hours, the strip's closed days, the waiting list, on today tomorrow's
  // reminders and the walk-in queue, and what customers changed, as a phone that has never looked (the
  // most to count).
  "Barber's day": async () =>
    must(owner(pick(SHOPS)).rpc('shop_day', { p_day: localDate(pick(3) - 1), p_since: null, p_limit: 5 })),
  // The owner opening the app on My shop: their shop, then every card's
  // numbers in one call (the week's takings, customers, reviews and closed
  // days). Every seeded shop is live, so the "Get your shop ready" card's
  // shop_setup, which the app sends only while a shop is getting ready, is
  // sent each time here to measure it at its most.
  'My shop': async () => {
    const i = pick(SHOPS);
    const c = owner(i);
    await must(c.from('shops').select('*').eq('owner_id', idOf(`owner${i}`)).maybeSingle());
    const week = thisWeek();
    return Promise.all([
      must(c.rpc('shop_cards', { p_from: week.from, p_to: week.to })),
      must(c.rpc('shop_setup')),
    ]);
  },
  'Book a cut': async () => {
    const i = pick(SHOPS);
    const c = customer();
    const service = idOf(`service${i}-1`);
    const slots = await must(c.rpc('available_slots', { p_service_id: service, p_day: localDate(pick(14) + 1) }));
    if (!slots.data.length) return slots;
    const slot = slots.data[Math.floor(Math.random() * slots.data.length)];
    const res = await c.rpc('book_appointment', { p_service_id: service, p_starts_at: slot.starts_at });
    // Losing a race or hitting the 4-per-shop limit is a normal answer, not a failure.
    if (res.error && res.error.code !== 'P0001') throw new Error(`${res.error.code}: ${res.error.message}`);
    return res;
  },
  // A full day's "Tell the shop I'd take a cancellation", then Leave, so the table stays the size seeded.
  'Join and leave a waiting list': async () => {
    const i = pick(SHOPS);
    const c = customer();
    const res = await c.rpc('join_waitlist', {
      p_service_id: idOf(`service${i}-1`),
      p_day: localDate(pick(14)),
      p_barber_id: null,
    });
    // Already waiting or booked that day, three lists already (P0001), or a closed day (22023): normal answers.
    if (res.error && !['P0001', '22023', '23505'].includes(res.error.code)) {
      throw new Error(`${res.error.code}: ${res.error.message}`);
    }
    if (!res.error) await must(c.rpc('leave_waitlist', { p_id: res.data.id }));
    return res;
  },
  // A customer joins a shop's walk-in queue, their page asks for their place every 30 seconds (three
  // times here, back to back), My bookings once, then they leave, so the queue stays the size seeded.
  // Outside the seeded hours (10 am to 8 pm, Monday to Saturday) the queue is shut and only the
  // asking is measured.
  'Wait in a queue': async () => {
    const i = 3 * pick(Math.floor(SHOPS / 3));
    const shopId = idOf(`shop${i}`);
    const c = customer();
    const res = await c.rpc('join_queue', { p_service_id: idOf(`service${i}-${pick(5)}`), p_barber_id: null });
    // Shut, full, already in a queue or booked there today (P0001): normal answers.
    if (res.error && res.error.code !== 'P0001') throw new Error(`${res.error.code}: ${res.error.message}`);
    for (let n = 0; n < 3; n++) await must(c.rpc('queue_status', { p_shop_id: shopId }));
    await must(c.rpc('my_queue'));
    if (!res.error) await must(c.rpc('leave_queue', { p_id: res.data.id }));
    return res;
  },
};

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN;
}

async function measure(name, fn) {
  const times = [];
  let errors = 0;
  let firstError = '';
  let bytes = 0;
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < until) {
        const t0 = performance.now();
        try {
          const res = await fn();
          if (!Array.isArray(res) && res?.data) bytes += JSON.stringify(res.data).length;
          times.push(performance.now() - t0);
        } catch (e) {
          errors++;
          firstError ||= String(e.message ?? e);
        }
      }
    }),
  );
  times.sort((a, b) => a - b);
  return {
    screen: name,
    'per sec': Math.round(times.length / SECONDS),
    'p50 ms': Math.round(percentile(times, 50)),
    'p95 ms': Math.round(percentile(times, 95)),
    'p99 ms': Math.round(percentile(times, 99)),
    'avg KB': times.length ? Math.round(bytes / times.length / 1024) : 0,
    errors: errors ? `${errors} (${firstError.slice(0, 60)})` : 0,
  };
}

async function rush() {
  const i = pick(SHOPS);
  const service = idOf(`service${i}-2`); // Skin fade, 45 min
  const day = nextSaturday();
  const before = await must(anon.rpc('available_slots', { p_service_id: service, p_day: day }));
  const free = [...new Set(before.data.map((s) => s.starts_at))];
  const outcome = { booked: 0, 'time just taken': 0, 'other errors': 0 };
  const errorCodes = {};
  const times = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: RUSH }, async (_, n) => {
      const c = client(idOf(`customer${n + 1}`));
      // Everyone wants the evening, like the week before Raya.
      const wanted = free[free.length - 1 - Math.floor(Math.random() * Math.min(6, free.length))];
      const start = performance.now();
      const res = await c.rpc('book_appointment', { p_service_id: service, p_starts_at: wanted });
      times.push(performance.now() - start);
      if (!res.error) outcome.booked++;
      else if (res.error.code === 'P0001') outcome['time just taken']++;
      else {
        outcome['other errors']++;
        errorCodes[res.error.code] = (errorCodes[res.error.code] ?? 0) + 1;
      }
    }),
  );
  times.sort((a, b) => a - b);
  return {
    shop: `kedai-gunting-${i}`,
    day,
    'free start times before': free.length,
    customers: RUSH,
    ...outcome,
    'took ms': Math.round(performance.now() - t0),
    'p95 ms': Math.round(percentile(times, 95)),
    ...(Object.keys(errorCodes).length ? { 'error codes': JSON.stringify(errorCodes) } : {}),
  };
}

const results = [];
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.some((o) => name.toLowerCase().includes(o.toLowerCase()))) continue;
  process.stdout.write(`› ${name}…\n`);
  results.push(await measure(name, fn));
}
if (results.length) console.table(results);
if (!ONLY || ONLY.includes('rush')) {
  console.log(`› Rush: ${RUSH} customers booking one shop's Saturday evening at once`);
  console.table([await rush()]);
}
