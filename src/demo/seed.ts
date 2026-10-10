// Sample data for the demo: four shops around Kajang, their customers, a
// few days of bookings either side of today, eight weeks of history at
// Ali's and the reviews customers left. Everything is placed relative to
// "now", so the demo always looks lived in.

import { WALK_IN } from '../lib/customers.ts';
import { firstName } from '../lib/reviews.ts';
import { addDays, dayBounds, localDateString } from '../lib/time.ts';
import { findById, HISTORY_ID, insertRow, now, setSeed, tables, type Row } from './db.ts';

export const DEMO_PASSWORD = 'demo1234';
export const DEMO_CUSTOMER_EMAIL = 'hakim@demo.potongku.my';
export const DEMO_BARBER_EMAIL = 'ali@demo.potongku.my';

const TZ = 'Asia/Kuala_Lumpur';
const DAY = 86_400_000;

/** Fixed ids, so the sample shops keep their links after a reset. */
let next = 0;
const sid = () => `d0000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
/** Bookings from before yesterday have their own, so a saved demo can lay them out again on a later day. */
let nextPast = 0;
const pastId = () => `${HISTORY_ID}${String(++nextPast).padStart(12, '0')}`;

type Hours = Partial<Record<number, [string, string][]>>;
const SAT_TO_THU = [0, 1, 2, 3, 4, 6];

/** Same hours on the given weekdays, with Friday split for Friday prayers. */
function week(days: number[], opens: string, closes: string, fridayBreak = true): Hours {
  const hours: Hours = {};
  for (const d of days) hours[d] = [[opens, closes]];
  if (fridayBreak && days.includes(5)) hours[5] = [[opens, '12:45'], ['14:30', closes]];
  return hours;
}

function user(email: string, role: 'customer' | 'barber', fullName: string, phone: string): Row {
  return insertRow('users', {
    id: sid(),
    email,
    password: DEMO_PASSWORD,
    user_metadata: { role, full_name: fullName, phone },
    // Before the shops and their history.
    created_at: new Date(now() - 120 * DAY).toISOString(),
  });
}

type ShopPlan = {
  owner: Row;
  shop: Row;
  barbers: [string, Hours][];
  services: [string, number, number][];
};

function shop({ owner, shop: fields, barbers, services }: ShopPlan) {
  const s = insertRow('shops', { id: sid(), owner_id: owner.id, is_published: true, ...fields });
  const barberRows = barbers.map(([name, hours], i) => {
    const b = insertRow('barbers', { id: sid(), shop_id: s.id, name, sort_order: i });
    for (const [weekday, ranges] of Object.entries(hours)) {
      for (const [opens_at, closes_at] of ranges ?? []) {
        insertRow('working_hours', { id: sid(), barber_id: b.id, weekday: Number(weekday), opens_at, closes_at });
      }
    }
    return { row: b, hours };
  });
  const serviceRows = services.map(([name, duration_min, price], i) =>
    insertRow('services', { id: sid(), shop_id: s.id, name, duration_min, price, sort_order: i }),
  );
  return { shop: s, barbers: barberRows, services: serviceRows };
}

type Booked = {
  barber: { row: Row; hours: Hours };
  /** Days from today in Kajang, e.g. -1 for yesterday. */
  day: number;
  at: string;
  service?: Row;
  customer?: Row;
  guest?: [string, string?];
  block?: [string, number];
  status?: string;
  note?: string;
  /** Someone in the shop already sent a WhatsApp reminder. */
  reminded?: boolean;
};

function seed() {
  next = 0;
  nextPast = 0;
  const today = localDateString(new Date(now()), TZ);

  // Each day's midnight is worked out once: the time zone lookup is slow, and there are weeks of bookings.
  const midnights = new Map<number, number>();
  const startOf = (day: number, at: string) => {
    const [h, m] = at.split(':').map(Number);
    if (!midnights.has(day)) midnights.set(day, dayBounds(addDays(today, day), TZ).start.getTime());
    return midnights.get(day)! + (h * 60 + m) * 60_000;
  };
  /** Only book times the barber actually works, so every weekday looks right. */
  const works = (hours: Hours, day: number, at: string, minutes: number) => {
    const weekday = new Date(`${addDays(today, day)}T00:00:00Z`).getUTCDay();
    const [h, m] = at.split(':').map(Number);
    const from = h * 60 + m;
    return (hours[weekday] ?? []).some(([o, c]) => {
      const [oh, om] = o.split(':').map(Number);
      const [ch, cm] = c.split(':').map(Number);
      return from >= oh * 60 + om && from + minutes <= ch * 60 + cm;
    });
  };

  /** The booking, or null when the barber doesn't work then. */
  const book = (shopRow: Row, b: Booked, id?: string) => {
    const minutes = b.block ? b.block[1] : (b.service!.duration_min as number);
    if (!works(b.barber.hours, b.day, b.at, minutes)) return null;
    const starts = startOf(b.day, b.at);
    return insertRow('bookings', {
      id: id ?? (b.day < -1 ? pastId() : sid()),
      shop_id: shopRow.id,
      barber_id: b.barber.row.id,
      service_id: b.service?.id ?? null,
      customer_id: b.customer?.id ?? null,
      guest_name: b.guest?.[0] ?? null,
      guest_phone: b.guest?.[1] ?? null,
      is_block: Boolean(b.block),
      service_name: b.block ? b.block[0] : b.service!.name,
      price: b.block ? 0 : b.service!.price,
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(starts + minutes * 60_000).toISOString(),
      status: b.status ?? 'confirmed',
      customer_note: b.note ?? null,
      reminded_at: b.reminded ? new Date(now() - 2 * 3_600_000).toISOString() : null,
      created_at: new Date(Math.min(now(), starts) - 2 * DAY).toISOString(),
    });
  };

  // People ---------------------------------------------------------------------
  const ali = user(DEMO_BARBER_EMAIL, 'barber', 'Ali', '012-345 6789');
  const rahman = user('rahman@demo.potongku.my', 'barber', 'Rahman', '013-220 4411');
  const irfan = user('irfan@demo.potongku.my', 'barber', 'Irfan', '017-302 8890');
  const mat = user('mat@demo.potongku.my', 'barber', 'Pak Mat', '019-388 1020');
  const hakim = user(DEMO_CUSTOMER_EMAIL, 'customer', 'Hakim', '011-2233 4455');
  const farid = user('farid@demo.potongku.my', 'customer', 'Farid', '012-778 9012');
  const weiJie = user('weijie@demo.potongku.my', 'customer', 'Tan Wei Jie', '016-332 1145');
  const ravi = user('ravi@demo.potongku.my', 'customer', 'Ravi', '017-665 0021');
  const aiman = user('aiman@demo.potongku.my', 'customer', 'Aiman', '019-224 8890');
  const syafiq = user('syafiq@demo.potongku.my', 'customer', 'Syafiq', '011-1098 7766');
  const jason = user('jason@demo.potongku.my', 'customer', 'Jason', '012-901 3344');

  // Shops ----------------------------------------------------------------------
  const a = shop({
    owner: ali,
    shop: {
      name: 'Ali Barber Sungai Chua',
      slug: 'ali-barber',
      about: 'Fades, beard trims and kids cuts since 2015. Air-conditioned, parking right in front.',
      address: 'No. 12, Jalan Sungai Chua 3/1, 43000 Kajang',
      area: 'Sungai Chua',
      phone: '012-345 6789',
      instagram: '@alibarber.kajang',
      // On the app since before its eight weeks of history, so Takings
      // compares every period, and still on a (stretched) free trial to show.
      created_at: new Date(now() - 90 * DAY).toISOString(),
      trial_ends_at: new Date(now() + 23 * DAY).toISOString(),
    },
    barbers: [
      ['Ali', week([1, 2, 3, 4, 5, 6], '10:00', '20:00')],
      ['Danial', week([0, 2, 3, 4, 5, 6], '11:00', '21:00')],
    ],
    services: [
      ['Haircut', 30, 20],
      ['Skin fade', 45, 25],
      ['Haircut + beard', 45, 30],
      ['Beard trim', 15, 12],
      ['Kids cut (under 12)', 30, 15],
    ],
  });
  const k = shop({
    owner: rahman,
    shop: {
      name: 'Kemas Barber Kajang',
      slug: 'kemas-barber-kajang',
      about: 'Classic cuts and hot towel shaves in the middle of town. Three chairs, short waits.',
      address: '23, Jalan Mendaling, 43000 Kajang',
      area: 'Kajang town',
      phone: '013-220 4411',
      subscription_status: 'active',
    },
    barbers: [
      ['Rahman', week(SAT_TO_THU, '09:30', '21:00')],
      ['Hafiz', week(SAT_TO_THU, '09:30', '21:00')],
      ['Wei Ming', week([1, 2, 3, 4, 5, 6], '11:00', '21:00')],
    ],
    services: [
      ['Haircut', 30, 18],
      ['Fade', 40, 22],
      ['Hot towel shave', 20, 15],
      ['Wash + cut', 40, 25],
    ],
  });
  const f = shop({
    owner: irfan,
    shop: {
      name: 'The Fade Room',
      slug: 'the-fade-room',
      about: 'Skin fades, tapers and hair designs. Booking only, so there is no queue.',
      address: 'G-08, Jalan Saujana Impian 2/6, 43000 Kajang',
      area: 'Saujana Impian',
      phone: '017-302 8890',
      instagram: '@thefaderoom.kj',
      subscription_status: 'active',
    },
    barbers: [['Irfan', week([1, 2, 3, 4, 5, 6], '12:00', '22:00', false)]],
    services: [
      ['Skin fade', 45, 30],
      ['Taper + design', 60, 38],
      ['Beard sculpt', 20, 15],
    ],
  });
  const m = shop({
    owner: mat,
    shop: {
      name: 'Gunting Pak Mat',
      slug: 'gunting-pak-mat',
      about: 'Simple cuts at fair prices. Schoolkids RM8 on weekdays.',
      address: '5, Jalan Prima Saujana 1/2, 43000 Kajang',
      area: 'Taman Prima Saujana',
      phone: '019-388 1020',
      subscription_status: 'active',
    },
    barbers: [
      ['Pak Mat', week([0, 1, 2, 3, 4, 5, 6], '08:00', '18:00')],
      ['Faizal', week([0, 1, 2, 3, 4, 6], '08:00', '18:00')],
    ],
    services: [
      ['Potong biasa', 20, 12],
      ['Potong budak', 20, 8],
      ['Cukur misai & janggut', 15, 8],
    ],
  });

  // Bookings ---------------------------------------------------------------------
  const [aliChair, danial] = a.barbers;
  const [haircut, fade, haircutBeard, beard, kids] = a.services;
  const sa = a.shop;
  // Yesterday
  book(sa, { barber: aliChair, day: -1, at: '10:30', service: haircut, customer: farid, status: 'completed' });
  book(sa, { barber: aliChair, day: -1, at: '12:00', service: fade, customer: aiman, status: 'completed' });
  book(sa, { barber: danial, day: -1, at: '15:00', service: haircutBeard, customer: jason, status: 'no_show' });
  book(sa, { barber: danial, day: -1, at: '17:00', service: haircut, guest: ['Uncle Lim'], status: 'completed' });
  // Today
  book(sa, { barber: aliChair, day: 0, at: '10:30', service: haircut, customer: weiJie });
  book(sa, {
    barber: aliChair,
    day: 0,
    at: '11:30',
    service: haircutBeard,
    guest: ['Pak Abu', '013-456 7788'],
    note: 'Booked on WhatsApp',
  });
  book(sa, { barber: aliChair, day: 0, at: '13:00', block: ['Lunch', 45] });
  book(sa, {
    barber: aliChair,
    day: 0,
    at: '15:00',
    service: fade,
    customer: ravi,
    note: 'Low fade, keep the top long',
  });
  book(sa, { barber: aliChair, day: 0, at: '17:30', service: beard, customer: syafiq });
  book(sa, { barber: danial, day: 0, at: '12:00', service: kids, customer: farid, note: 'For my son, he is 7' });
  book(sa, { barber: danial, day: 0, at: '16:00', service: haircut, customer: aiman });
  book(sa, { barber: danial, day: 0, at: '19:00', service: haircut, guest: ['Kumar', '016-210 3398'] });
  // Coming days. Encik Rosli and Hakim (below) land tomorrow whatever the
  // weekday, so there is always someone to remind on WhatsApp.
  book(sa, { barber: aliChair, day: 1, at: '10:00', service: haircut, customer: jason, reminded: true });
  book(sa, { barber: aliChair, day: 1, at: '18:00', service: beard, customer: weiJie });
  const rosli = { day: 1, at: '11:30', service: haircut, guest: ['Encik Rosli', '019-765 4321'] as [string, string] };
  book(sa, { barber: danial, ...rosli }) || book(sa, { barber: aliChair, ...rosli });
  book(sa, { barber: aliChair, day: 2, at: '11:00', service: haircut, customer: ravi });
  book(sa, { barber: danial, day: 2, at: '20:00', service: fade, customer: syafiq });

  // Hakim, the demo customer: one cut coming up and a little history.
  book(sa, { barber: danial, day: 1, at: '16:30', service: fade, customer: hakim, note: 'Same as last time' }) ||
    book(sa, { barber: aliChair, day: 1, at: '16:30', service: fade, customer: hakim, note: 'Same as last time' });
  book(sa, { barber: aliChair, day: -26, at: '11:00', service: haircut, customer: hakim, status: 'completed' }) ||
    book(sa, { barber: danial, day: -26, at: '11:00', service: haircut, customer: hakim, status: 'completed' });
  const [rahmanChair, hafiz] = k.barbers;
  book(k.shop, { barber: rahmanChair, day: -12, at: '10:00', service: k.services[0], customer: hakim, status: 'completed' }) ||
    book(k.shop, { barber: rahmanChair, day: -11, at: '10:00', service: k.services[0], customer: hakim, status: 'completed' });

  // Other shops are busy too, so not every time is free.
  book(k.shop, { barber: rahmanChair, day: 0, at: '10:00', service: k.services[0], guest: ['Encik Zul'] });
  book(k.shop, { barber: hafiz, day: 0, at: '11:00', service: k.services[1], customer: jason });
  book(k.shop, { barber: hafiz, day: 1, at: '14:00', service: k.services[3], customer: aiman });
  book(f.shop, { barber: f.barbers[0], day: 0, at: '14:00', service: f.services[0], guest: ['Danish'] });
  book(f.shop, { barber: f.barbers[0], day: 0, at: '15:00', service: f.services[1], customer: syafiq });
  book(f.shop, { barber: f.barbers[0], day: 1, at: '20:00', service: f.services[0], customer: ravi });
  book(m.shop, { barber: m.barbers[0], day: 0, at: '09:00', service: m.services[0], guest: ['Pak Long'] });
  book(m.shop, { barber: m.barbers[1], day: 0, at: '15:00', service: m.services[1], guest: ['Adik Amin'] });

  // A few months of regulars at Ali's, for the customer list. Added before
  // the weeks of takings below, which fit around them.
  const amirul = user('amirul@demo.potongku.my', 'customer', 'Amirul', '011-1987 2210');
  const danielTan = user('daniel@demo.potongku.my', 'customer', 'Daniel Tan', '016-778 2301');
  const cuts = (who: Pick<Booked, 'customer' | 'guest'>, days: number[], at: string, status = 'completed') => {
    for (const day of days) {
      const cut = { day, at, service: haircut, status, ...who };
      book(sa, { barber: aliChair, ...cut }) || book(sa, { barber: danial, ...cut });
    }
  };
  // Due for a cut whatever day the demo opens: their usual gap has passed and
  // nothing is booked.
  cuts({ customer: danielTan }, [-100, -72, -44], '18:00');
  cuts({ guest: ['Ahmad Zaki', '013-245 9087'] }, [-40], '17:00');
  cuts({ customer: amirul }, [-68, -47, -26], '15:00');
  cuts({ guest: ['Encik Kamal', '012-688 4521'] }, [-92, -62, -33], '16:00');
  // Not due yet, even on days their bookings above don't land.
  cuts({ customer: farid }, [-58, -37, -16], '19:00');
  cuts({ customer: weiJie }, [-49, -35, -21, -7], '16:00');
  cuts({ customer: ravi }, [-70, -45, -20], '15:00');
  cuts({ guest: ['Uncle Lim'] }, [-41, -27, -13], '17:00');
  cuts({ guest: ['Pak Abu', '013-456 7788'] }, [-20], '19:00');
  cuts({ guest: ['Kumar', '016-210 3398'] }, [-21], '19:00');
  cuts({ customer: jason }, [-25], '18:00');
  cuts({ customer: jason }, [-12], '18:00', 'no_show');
  // Not in for months: most likely goes to another barber now.
  cuts({ guest: ['Mr Wong', '012-330 1188'] }, [-150], '15:00');
  // Walk-ins added with no name are in the day's bookings, not the list.
  cuts({ guest: [WALK_IN] }, [-38, -24, -10], '11:00');
  // Syafiq WhatsApped once before booking online, and is listed once.
  cuts({ guest: ['Syafiq', '+60 11-1098 7766'] }, [-30], '11:00');

  // Eight weeks of history at Ali's, and a few afternoons in the coming
  // days, so Takings has weeks and months to compare. Weekends and evenings
  // are busiest, after lunch is quiet, and about one in twenty is a no-show.
  // Each chair takes at most one cut an hour, starting on the hour or at a
  // quarter past, so the 45-minute ones never run into the next.
  // The past ones are walk-ins nobody named, so the customer list above stays
  // as it is; the coming ones rang, so they gave a name.
  const walkIns = ['Uncle Lim', 'Mr Tan', 'Faiz', 'Haziq', 'Adik Irfan', 'Encik Zul'];
  const menu = [haircut, haircut, haircut, fade, fade, haircutBeard, beard, kids];
  // Only the bookings above can be in the way.
  const before = [...tables().bookings];
  const free = (barberId: unknown, start: number, minutes: number) =>
    !before.some(
      (b) =>
        b.barber_id === barberId &&
        b.status !== 'cancelled' &&
        Date.parse(String(b.starts_at)) < start + minutes * 60_000 &&
        start < Date.parse(String(b.ends_at)),
    );
  let n = 0;
  for (let day = -56; day <= 6; day++) {
    if (day >= -1 && day <= 2) continue;
    const weekday = new Date(`${addDays(today, day)}T00:00:00Z`).getUTCDay();
    for (const [chair, barber] of [aliChair, danial].entries()) {
      // Coming days only have afternoons booked so far, by walk-ins who rang.
      for (let hour = day > 0 ? 14 : 10; hour <= 20; hour++) {
        n++;
        const roll = (n * 37 + (day + 100) * 11 + hour * 7 + chair * 13) % 100;
        const chance =
          (weekday === 6 ? 75 : weekday === 0 || weekday === 5 ? 60 : 40) +
          (hour >= 17 ? 20 : hour >= 14 && hour < 16 ? -15 : 0) -
          (day > 0 ? 25 : 0);
        if (roll >= chance) continue;
        const service = menu[(n * 7 + hour) % menu.length];
        const at = `${hour}:${n % 3 === 0 ? '15' : '00'}`;
        if (!free(barber.row.id, startOf(day, at), service.duration_min as number)) continue;
        book(sa, {
          barber,
          day,
          at,
          service,
          guest: [day < 0 ? WALK_IN : walkIns[n % walkIns.length]],
          status: day > 0 ? 'confirmed' : roll % 20 === 5 ? 'no_show' : roll % 11 === 7 ? 'cancelled' : 'completed',
        });
      }
    }
  }

  // Reviews ------------------------------------------------------------------------
  // Mostly happy, a few so-so, in English and Malay, now and then with the
  // shop's answer. Each is left some hours after the cut, as people do.
  // Hakim's cut at Kemas twelve days ago stays unrated, so the demo has a
  // cut to rate.
  const HOUR = 3_600_000;
  const review = (booking: Row | null | undefined, rating: number, after: number, comment?: string, reply?: string) => {
    if (!booking) return;
    const at = Math.min(now(), Date.parse(String(booking.ends_at)) + after * HOUR);
    insertRow('reviews', {
      booking_id: booking.id,
      shop_id: booking.shop_id,
      barber_id: booking.barber_id,
      customer_id: booking.customer_id,
      rating,
      comment: comment ?? null,
      first_name: firstName(String(findById('profiles', booking.customer_id)?.full_name ?? '')),
      reply: reply ?? null,
      replied_at: reply ? new Date(Math.min(now(), at + 5 * HOUR)).toISOString() : null,
      created_at: new Date(at).toISOString(),
      updated_at: new Date(at).toISOString(),
    });
  };
  /** The customer's finished cut at Ali's on that day, from the regulars above. */
  const cutAtAli = (customer: Row, day: number) =>
    tables().bookings.find(
      (b) =>
        b.shop_id === sa.id &&
        b.customer_id === customer.id &&
        b.status === 'completed' &&
        Date.parse(String(b.starts_at)) >= startOf(day, '00:00') &&
        Date.parse(String(b.starts_at)) < startOf(day + 1, '00:00'),
    );
  review(
    cutAtAli(danielTan, -44),
    5,
    3,
    'Best haircut I’ve had in Kajang. They take their time and really listen.',
    'Thanks Daniel! See you next month.',
  );
  review(cutAtAli(amirul, -26), 5, 20, 'Potong kemas, harga berpatutan. Memang akan datang lagi.');
  review(cutAtAli(farid, -16), 4, 2, 'Good cut. Waited about 10 minutes even with a booking.');
  review(cutAtAli(weiJie, -7), 5, 26, 'Always consistent, and booking here is so easy.');
  review(
    cutAtAli(ravi, -45),
    3,
    4,
    'The cut was fine but a bit shorter on the sides than I asked.',
    'Sorry about that, Ravi. We’ve noted it for next time.',
  );
  review(cutAtAli(jason, -25), 5, 30);
  review(cutAtAli(hakim, -26), 5, 6, 'Neat cut and friendly service.');
  review(cutAtAli(aiman, -1), 5, 3, 'Pantas dan kemas. Recommended!');

  // A cut at another shop for a review. Its id stays the same whichever chair
  // or day it lands on, so a demo saved on another day keeps its review.
  let nextRated = 0;
  const ratedCut = (s: ReturnType<typeof shop>, chair: number, day: number, at: string, service: number, customer: Row) => {
    const id = `${HISTORY_ID}${String(900_000 + ++nextRated).padStart(12, '0')}`;
    const chairs = [...s.barbers.slice(chair), ...s.barbers.slice(0, chair)];
    for (const d of [day, day - 1]) {
      for (const barber of chairs) {
        const cut = book(s.shop, { barber, day: d, at, service: s.services[service], customer, status: 'completed' }, id);
        if (cut) return cut;
      }
    }
    return null;
  };
  review(ratedCut(k, 1, -5, '12:00', 1, syafiq), 5, 5, 'Fade was spot on, and they started right on time.');
  review(ratedCut(k, 2, -9, '14:00', 0, farid), 4, 3, 'Neat cut. Parking in town is a pain, but worth it.');
  review(ratedCut(k, 0, -15, '17:00', 2, weiJie), 5, 22, 'The hot towel shave is the best part of my month.');
  review(ratedCut(k, 1, -19, '11:00', 3, amirul), 4, 8);
  review(ratedCut(k, 2, -22, '18:00', 1, ravi), 5, 2, 'Very professional. Three chairs, so the wait is short.');
  review(
    ratedCut(k, 0, -30, '15:30', 0, aiman),
    5,
    4,
    'Tukang gunting peramah, kedai bersih. Memang puas hati.',
    'Terima kasih Aiman! Jumpa lagi.',
  );
  review(ratedCut(k, 1, -38, '13:00', 0, jason), 3, 6, 'Decent cut, but it felt a bit rushed.');

  review(ratedCut(f, 0, -4, '20:00', 0, farid), 5, 2, 'Irfan is a fade artist. Worth every ringgit.');
  review(ratedCut(f, 0, -10, '16:00', 1, syafiq), 5, 20, 'Asked for a simple line design and it came out clean.');
  review(ratedCut(f, 0, -18, '19:00', 0, ravi), 4, 3, 'Great fade. A bit pricey, but no queue at all.');
  review(ratedCut(f, 0, -27, '13:00', 2, jason), 5, 28);
  review(ratedCut(f, 0, -33, '18:00', 0, weiJie), 5, 5, 'Fade paling kemas di Kajang. Tak perlu tunggu lama.');

  review(ratedCut(m, 0, -6, '09:30', 0, aiman), 5, 7, 'Murah, cepat dan kemas. Kedai lama yang boleh harap.');
  review(
    ratedCut(m, 1, -13, '10:00', 1, amirul),
    4,
    9,
    'Anak saya suka. Sabar layan budak yang tak reti duduk diam.',
    'Terima kasih! Bawa adik datang lagi ya.',
  );
  review(ratedCut(m, 0, -24, '11:30', 0, syafiq), 4, 4, 'Simple cut, fair price. Exactly what it says.');
  review(ratedCut(m, 1, -40, '16:00', 2, ravi), 3, 2, 'OK for the price, but the shave could be closer.');
}

setSeed(seed);
