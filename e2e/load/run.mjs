// Load test: sends the app's own requests (same query shapes, through
// postgrest-js) to a PostgREST filled by seed.sql, many at once, and reports
// how fast each screen's data comes back. Then a pre-Raya rush: hundreds of
// customers booking one shop's Saturday at the same moment.
//
// Env: REST_URL (PostgREST), JWT_SECRET, SHOPS, CUSTOMERS (as seeded),
//      CONCURRENCY (default 50), SECONDS per scenario (default 15),
//      RUSH (customers in the rush, default 300), ONLY (comma list of scenarios)

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
  'Find a barber': async () =>
    Promise.all([
      must(anon.rpc('find_shops', { p_search: null, p_area: null, p_limit: 20, p_offset: 0 })),
      must(anon.rpc('shop_areas')),
    ]),
  'Search for a barber': async () =>
    must(anon.rpc('find_shops', { p_search: AREAS[pick(AREAS.length) - 1], p_area: null, p_limit: 20, p_offset: 0 })),
  'Shop page': async () => {
    const i = pick(SHOPS);
    const shop = await must(anon.from('shops').select('*').eq('slug', `kedai-gunting-${i}`).maybeSingle());
    await Promise.all([
      must(anon.from('services').select('*').eq('shop_id', shop.data.id).eq('is_active', true).order('sort_order').order('name')),
      must(
        anon
          .from('barbers')
          .select('*, working_hours(weekday, opens_at, closes_at)')
          .eq('shop_id', shop.data.id)
          .eq('is_active', true)
          .order('sort_order')
          .order('name'),
      ),
      // Closed days for the day picker and today's hours for "Open now".
      must(anon.rpc('shop_closed_days', { p_shop_id: shop.data.id, p_from: localDate(0), p_to: localDate(13) })),
      must(anon.rpc('shop_hours_today', { p_shop_id: shop.data.id })),
    ]);
    return shop;
  },
  'Free times for a day': async () =>
    must(
      anon.rpc('available_slots', {
        p_service_id: idOf(`service${pick(SHOPS)}-1`),
        p_day: localDate(pick(7)),
        p_barber_id: null,
      }),
    ),
  'My bookings': async () => must(client(idOf(`customer${pick(CUSTOMERS)}`)).rpc('my_bookings')),
  // Not something the app sends, but anyone with an account can: the
  // bookings policy has to stay fast without the app's filter.
  'Every booking I may see': async () =>
    must(customer().from('bookings').select('id, starts_at').order('starts_at', { ascending: false }).limit(100)),
  "Barber's day": async () => {
    const i = pick(SHOPS);
    const c = owner(i);
    const shopId = idOf(`shop${i}`);
    const day = localDate(pick(3) - 1);
    const start = new Date(`${day}T00:00:00+08:00`).toISOString();
    const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
    return Promise.all([
      must(
        c
          .from('bookings')
          .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
          .eq('shop_id', shopId)
          .gte('starts_at', start)
          .lt('starts_at', end)
          .order('starts_at'),
      ),
      must(c.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('is_active', true)),
      must(c.from('barbers').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('is_active', true)),
      must(
        c
          .from('working_hours')
          .select('id, barbers!inner(shop_id)', { count: 'exact', head: true })
          .eq('barbers.shop_id', shopId),
      ),
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
