// The demo's database: the tables, constraints and row-level security from
// supabase/migrations, rebuilt in plain TypeScript so the whole app can run
// in a browser with no server. Rows live in memory and are saved to
// localStorage, so a demo survives a reload on the same phone.

import { addDays, dayBounds, localDateString } from '../lib/time.ts';

export type Row = Record<string, unknown>;
export type TableName =
  | 'users'
  | 'profiles'
  | 'shops'
  | 'barbers'
  | 'services'
  | 'working_hours'
  | 'bookings'
  | 'shop_closures'
  | 'reviews'
  | 'review_reports'
  | 'waitlist'
  | 'queue_entries'
  | 'shop_photos'
  | 'stamp_cards';
export type Tables = Record<TableName, Row[]>;
type ColumnType = 'uuid' | 'text' | 'int' | 'numeric' | 'float' | 'bool' | 'timestamptz' | 'date' | 'time' | 'jsonb';
type Column = {
  type: ColumnType;
  nullable: boolean;
  default?: () => unknown;
  values?: readonly string[];
  /** For a demo saved before the column was added: what the row would have had. */
  backfill?: (row: Row) => unknown;
};

/** An error shaped like the ones PostgREST sends back. */
export class PgError extends Error {
  code: string;
  details: string | null;
  hint: string | null;
  status: number | undefined;
  constructor(code: string, message: string, status?: number, details: string | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = null;
  }
}

// Clock and ids --------------------------------------------------------------

let clock = () => Date.now();
export const now = () => clock();
export const nowIso = () => new Date(clock()).toISOString();
/** Tests move time with this. */
export function setClock(next: () => number) {
  clock = next;
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

// Schema ---------------------------------------------------------------------

/** A NOT NULL column, with the default Postgres would fill in. */
const req = (type: ColumnType, fill?: () => unknown, values?: readonly string[]): Column => ({
  type,
  nullable: false,
  default: fill,
  values,
});
/** A column that may be null. */
const opt = (type: ColumnType): Column => ({ type, nullable: true });
const id = req('uuid', newId);
const createdAt = req('timestamptz', nowIso);

export const COLUMNS: Record<TableName, Record<string, Column>> = {
  // Stands in for auth.users; never reachable through the REST API.
  users: {
    id,
    email: req('text'),
    password: req('text'),
    user_metadata: opt('jsonb'),
    created_at: createdAt,
  },
  profiles: {
    id: req('uuid'),
    role: req('text', () => 'customer', ['customer', 'barber']),
    full_name: req('text', () => ''),
    phone: opt('text'),
    created_at: createdAt,
  },
  shops: {
    id,
    owner_id: req('uuid'),
    name: req('text'),
    slug: req('text'),
    about: opt('text'),
    address: opt('text'),
    area: req('text', () => 'Kajang'),
    // A demo saved before shops had a location gets the sample shops' own.
    latitude: { ...opt('float'), backfill: (r) => sampleValue('shops', r.id, 'latitude') },
    longitude: { ...opt('float'), backfill: (r) => sampleValue('shops', r.id, 'longitude') },
    phone: opt('text'),
    instagram: opt('text'),
    time_zone: req('text', () => 'Asia/Kuala_Lumpur'),
    is_published: req('bool', () => false),
    published_at: { ...opt('timestamptz'), backfill: (r) => (r.is_published ? r.created_at : null) },
    trial_ends_at: req('timestamptz', () => new Date(clock() + 30 * 86_400_000).toISOString()),
    subscription_status: req('text', () => 'trialing', ['trialing', 'active', 'past_due', 'cancelled']),
    // Kept by the reviews_count trigger (countReview below).
    rating_count: req('int', () => 0),
    rating_sum: req('int', () => 0),
    // A demo saved before the walk-in queue gets the sample shops' own setting.
    queue_enabled: { ...req('bool', () => false), backfill: (r) => sampleValue('shops', r.id, 'queue_enabled') === true },
    // The stamp card: every stamp_card_cuts-th cut free, or stamp_card_off ringgit off it. A demo saved
    // before stamp cards gets the sample shops' own.
    stamp_card_on: { ...req('bool', () => false), backfill: (r) => sampleValue('shops', r.id, 'stamp_card_on') === true },
    stamp_card_cuts: { ...req('int', () => 10), backfill: (r) => sampleValue('shops', r.id, 'stamp_card_cuts') ?? 10 },
    stamp_card_off: { ...opt('int'), backfill: (r) => sampleValue('shops', r.id, 'stamp_card_off') },
    created_at: createdAt,
  },
  barbers: {
    id,
    shop_id: req('uuid'),
    name: req('text'),
    // A demo saved before barbers had a line gets the sample barbers' own.
    about: { ...opt('text'), backfill: (r) => sampleValue('barbers', r.id, 'about') },
    is_active: req('bool', () => true),
    sort_order: req('int', () => 0),
    // Kept by the reviews_count trigger (countReview below).
    rating_count: req('int', () => 0),
    rating_sum: req('int', () => 0),
    created_at: createdAt,
  },
  services: {
    id,
    shop_id: req('uuid'),
    name: req('text'),
    duration_min: req('int'),
    price: req('numeric'),
    is_active: req('bool', () => true),
    sort_order: req('int', () => 0),
    created_at: createdAt,
  },
  working_hours: {
    id,
    barber_id: req('uuid'),
    weekday: req('int'),
    opens_at: req('time'),
    closes_at: req('time'),
  },
  bookings: {
    id,
    shop_id: req('uuid'),
    barber_id: req('uuid'),
    service_id: opt('uuid'),
    customer_id: opt('uuid'),
    guest_name: opt('text'),
    guest_phone: opt('text'),
    is_block: req('bool', () => false),
    service_name: req('text'),
    price: req('numeric'),
    starts_at: req('timestamptz'),
    ends_at: req('timestamptz'),
    status: req('text', () => 'confirmed', ['confirmed', 'cancelled', 'completed', 'no_show']),
    customer_note: opt('text'),
    reminded_at: opt('timestamptz'),
    customer_changed_at: opt('timestamptz'),
    customer_change: opt('text'),
    // What the cut did to the customer's stamp card when marked done (stampCardCut below).
    stamp_card: { ...opt('text'), backfill: (r) => sampleValue('bookings', r.id, 'stamp_card') },
    reward_off: { ...opt('numeric'), backfill: (r) => sampleValue('bookings', r.id, 'reward_off') },
    reward_stamps: { ...opt('int'), backfill: (r) => sampleValue('bookings', r.id, 'reward_stamps') },
    created_at: createdAt,
  },
  shop_closures: {
    shop_id: req('uuid'),
    day: req('date'),
    reason: opt('text'),
  },
  reviews: {
    booking_id: req('uuid'),
    shop_id: req('uuid'),
    barber_id: req('uuid'),
    customer_id: req('uuid'),
    rating: req('int'),
    comment: opt('text'),
    first_name: req('text'),
    reply: opt('text'),
    replied_at: opt('timestamptz'),
    // Kept in step with its report by the review_reports_removed trigger (reviewRemoved below).
    removed: req('bool', () => false),
    created_at: createdAt,
    updated_at: req('timestamptz', nowIso),
  },
  // An owner's report of a review: open while outcome is null, then the team's 'kept' or 'removed'.
  review_reports: {
    booking_id: req('uuid'),
    shop_id: req('uuid'),
    reason: req('text', undefined, ['not_customer', 'rude', 'off_topic', 'other']),
    note: opt('text'),
    outcome: opt('text'),
    decided_at: opt('timestamptz'),
    created_at: createdAt,
  },
  waitlist: {
    id,
    shop_id: req('uuid'),
    customer_id: req('uuid'),
    day: req('date'),
    service_id: req('uuid'),
    // Null: any barber.
    barber_id: opt('uuid'),
    offered_at: opt('timestamptz'),
    created_at: createdAt,
  },
  queue_entries: {
    id,
    shop_id: req('uuid'),
    day: req('date'),
    customer_id: opt('uuid'),
    guest_name: opt('text'),
    guest_phone: opt('text'),
    service_id: opt('uuid'),
    // Null: any barber.
    barber_id: opt('uuid'),
    state: req('text', () => 'waiting', ['waiting', 'called', 'gone']),
    gone_reason: opt('text'),
    called_at: opt('timestamptz'),
    // When it went, so a customer the shop took off is told so for a while.
    gone_at: opt('timestamptz'),
    booking_id: opt('uuid'),
    created_at: createdAt,
  },
  // The files are in the demo's own Storage (files.ts).
  shop_photos: {
    id,
    shop_id: req('uuid'),
    // Null: the owner hasn't said who did the cut.
    barber_id: opt('uuid'),
    caption: opt('text'),
    path: req('text'),
    thumb_path: req('text'),
    width: req('int'),
    height: req('int'),
    // Set by the shop_photos_check trigger on the way in (beforeWrite below).
    sort_order: req('int', () => 0),
    created_at: createdAt,
  },
  // Each customer's stamps on a shop's card, kept by stampCardCut; read only through the functions.
  stamp_cards: {
    shop_id: req('uuid'),
    customer_id: req('uuid'),
    stamps: req('int', () => 0),
  },
};

/** Tables keyed by something other than id. */
const PRIMARY_KEY: Partial<Record<TableName, string[]>> = {
  shop_closures: ['shop_id', 'day'],
  reviews: ['booking_id'],
  review_reports: ['booking_id'],
  stamp_cards: ['shop_id', 'customer_id'],
};

/** Postgres trim(): spaces only, unlike String.prototype.trim. */
export const pgTrim = (s: string) => s.replace(/^ +| +$/g, '');
/** Postgres btrim() with one argument: the same. */
const btrim = pgTrim;
const len = (v: unknown) => (v == null ? null : [...String(v)].length);
const between = (n: number | null, lo: number, hi: number) => n == null || (n >= lo && n <= hi);
const atMost = (v: unknown, max: number) => v == null || (len(v) as number) <= max;
/** What Postgres's [[:cntrl:]] matches. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** CHECK constraints, by name. A null result passes, as in Postgres. */
const CHECKS: Partial<Record<TableName, [string, (r: Row) => boolean][]>> = {
  profiles: [
    ['profiles_full_name_check', (r) => atMost(r.full_name, 80)],
    ['profiles_full_name_not_blank', (r) => (len(pgTrim(String(r.full_name))) as number) > 0],
    ['profiles_phone_check', (r) => atMost(r.phone, 20)],
  ],
  shops: [
    ['shops_name_check', (r) => between(len(pgTrim(String(r.name))), 1, 80)],
    [
      'shops_slug_check',
      (r) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(r.slug)) && between(len(r.slug), 3, 40),
    ],
    ['shops_about_check', (r) => atMost(r.about, 500)],
    ['shops_address_check', (r) => atMost(r.address, 200)],
    ['shops_area_check', (r) => between(len(r.area), 1, 60)],
    ['shops_latitude_check', (r) => between(r.latitude as number | null, -90, 90)],
    ['shops_longitude_check', (r) => between(r.longitude as number | null, -180, 180)],
    ['shops_location_pair', (r) => (r.latitude == null) === (r.longitude == null)],
    ['shops_phone_check', (r) => atMost(r.phone, 20)],
    ['shops_instagram_check', (r) => atMost(r.instagram, 60)],
    ['shops_stamp_card_cuts_check', (r) => between(r.stamp_card_cuts as number, 4, 12)],
    ['shops_stamp_card_off_check', (r) => between(r.stamp_card_off as number | null, 1, 50)],
  ],
  barbers: [
    ['barbers_name_check', (r) => between(len(pgTrim(String(r.name))), 1, 40)],
    // One line of plain text: no line breaks, tabs or other control characters.
    [
      'barbers_about_check',
      (r) => r.about == null || (atMost(r.about, 60) && pgTrim(String(r.about)) !== '' && !CONTROL.test(String(r.about))),
    ],
  ],
  services: [
    ['services_name_check', (r) => between(len(pgTrim(String(r.name))), 1, 60)],
    ['services_duration_min_check', (r) => between(r.duration_min as number, 5, 480)],
    ['services_price_check', (r) => between(r.price as number, 0, 10000)],
  ],
  working_hours: [
    ['working_hours_weekday_check', (r) => between(r.weekday as number, 0, 6)],
    ['working_hours_check', (r) => String(r.closes_at) > String(r.opens_at)],
  ],
  bookings: [
    ['bookings_guest_name_check', (r) => atMost(r.guest_name, 80)],
    ['bookings_guest_phone_check', (r) => atMost(r.guest_phone, 20)],
    ['bookings_service_name_check', (r) => atMost(r.service_name, 80)],
    ['bookings_customer_note_check', (r) => atMost(r.customer_note, 280)],
    ['bookings_check', (r) => Date.parse(String(r.ends_at)) > Date.parse(String(r.starts_at))],
    ['bookings_check1', (r) => Boolean(r.is_block) || r.customer_id != null || r.guest_name != null],
    [
      'bookings_customer_change_check',
      (r) => r.customer_change == null || ['booked', 'moved', 'cancelled'].includes(String(r.customer_change)),
    ],
    ['bookings_customer_change_pair', (r) => (r.customer_changed_at == null) === (r.customer_change == null)],
    ['bookings_stamp_card_check', (r) => r.stamp_card == null || ['stamp', 'reward'].includes(String(r.stamp_card))],
    ['bookings_reward_off_check', (r) => r.reward_off == null || Number(r.reward_off) >= 0],
    ['bookings_reward_pair', (r) => (r.stamp_card === 'reward') === (r.reward_off != null && r.reward_stamps != null)],
  ],
  shop_closures: [['shop_closures_reason_check', (r) => atMost(r.reason, 80)]],
  reviews: [
    ['reviews_rating_check', (r) => between(r.rating as number, 1, 5)],
    ['reviews_comment_check', (r) => atMost(r.comment, 280)],
    ['reviews_first_name_check', (r) => atMost(r.first_name, 40)],
    ['reviews_reply_check', (r) => atMost(r.reply, 280)],
    ['reviews_check', (r) => (r.reply == null) === (r.replied_at == null)],
  ],
  review_reports: [
    ['review_reports_note_check', (r) => atMost(r.note, 200)],
    ['review_reports_outcome_check', (r) => r.outcome == null || ['kept', 'removed'].includes(String(r.outcome))],
    ['review_reports_check', (r) => (r.outcome == null) === (r.decided_at == null)],
  ],
  queue_entries: [
    ['queue_entries_guest_name_check', (r) => atMost(r.guest_name, 80)],
    ['queue_entries_guest_phone_check', (r) => atMost(r.guest_phone, 20)],
    [
      'queue_entries_gone_reason_check',
      (r) => r.gone_reason == null || ['left', 'removed', 'not_here', 'served'].includes(String(r.gone_reason)),
    ],
    ['queue_entries_check', (r) => r.customer_id != null || r.guest_name != null],
    ['queue_entries_gone_reason', (r) => (r.state === 'gone') === (r.gone_reason != null)],
    ['queue_entries_called_at', (r) => r.state !== 'called' || r.called_at != null],
  ],
  stamp_cards: [['stamp_cards_stamps_check', (r) => (r.stamps as number) >= 0]],
  shop_photos: [
    [
      'shop_photos_caption_check',
      (r) => r.caption == null || (atMost(r.caption, 60) && btrim(String(r.caption)) !== '' && !CONTROL.test(String(r.caption))),
    ],
    ['shop_photos_width_check', (r) => between(r.width as number, 1, 1600)],
    ['shop_photos_height_check', (r) => between(r.height as number, 1, 1600)],
    // Both files in the shop's own folder, the only one its owner can write to.
    [
      'shop_photos_in_shop_folder',
      (r) =>
        [r.path, r.thumb_path].every((p) => String(p).split('/')[0] === r.shop_id && /^[^/]+\/[A-Za-z0-9_.-]+$/.test(String(p))) &&
        r.thumb_path !== r.path,
    ],
  ],
};

const UNIQUE: Partial<Record<TableName, [string, string | string[]][]>> = {
  users: [['users_email_key', 'email']],
  shops: [
    ['shops_owner_id_key', 'owner_id'],
    ['shops_slug_key', 'slug'],
  ],
  waitlist: [['waitlist_one_a_day', ['customer_id', 'day', 'shop_id']]],
  shop_photos: [
    ['shop_photos_path_key', 'path'],
    ['shop_photos_thumb_path_key', 'thumb_path'],
  ],
};

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
const ms = (v: unknown) => Date.parse(String(v));

/** Exclusion constraints: two rows that may not exist together. */
const EXCLUDE: Partial<Record<TableName, [string, (a: Row, b: Row) => boolean][]>> = {
  working_hours: [
    [
      'working_hours_no_overlap',
      (a, b) =>
        a.barber_id === b.barber_id &&
        a.weekday === b.weekday &&
        String(a.opens_at) < String(b.closes_at) &&
        String(b.opens_at) < String(a.closes_at),
    ],
  ],
  bookings: [
    [
      'bookings_no_overlap',
      (a, b) =>
        a.status !== 'cancelled' &&
        b.status !== 'cancelled' &&
        a.barber_id === b.barber_id &&
        overlaps(ms(a.starts_at), ms(a.ends_at), ms(b.starts_at), ms(b.ends_at)),
    ],
  ],
};

export type ForeignKey = {
  name: string;
  table: TableName;
  column: string;
  references: TableName;
  /** The column it points at, when that isn't the table's id. */
  key?: string;
  onDelete: 'cascade' | 'set null' | 'restrict';
};

/** The column a foreign key points at. */
export const keyOf = (fk: ForeignKey) => fk.key ?? 'id';

export const FOREIGN_KEYS: ForeignKey[] = [
  { name: 'profiles_id_fkey', table: 'profiles', column: 'id', references: 'users', onDelete: 'cascade' },
  { name: 'shops_owner_id_fkey', table: 'shops', column: 'owner_id', references: 'profiles', onDelete: 'cascade' },
  { name: 'barbers_shop_id_fkey', table: 'barbers', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  { name: 'services_shop_id_fkey', table: 'services', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  {
    name: 'working_hours_barber_id_fkey',
    table: 'working_hours',
    column: 'barber_id',
    references: 'barbers',
    onDelete: 'cascade',
  },
  { name: 'bookings_shop_id_fkey', table: 'bookings', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  { name: 'bookings_barber_id_fkey', table: 'bookings', column: 'barber_id', references: 'barbers', onDelete: 'restrict' },
  {
    name: 'bookings_service_id_fkey',
    table: 'bookings',
    column: 'service_id',
    references: 'services',
    onDelete: 'set null',
  },
  {
    name: 'bookings_customer_id_fkey',
    table: 'bookings',
    column: 'customer_id',
    references: 'profiles',
    onDelete: 'cascade',
  },
  {
    name: 'shop_closures_shop_id_fkey',
    table: 'shop_closures',
    column: 'shop_id',
    references: 'shops',
    onDelete: 'cascade',
  },
  { name: 'reviews_booking_id_fkey', table: 'reviews', column: 'booking_id', references: 'bookings', onDelete: 'cascade' },
  { name: 'reviews_shop_id_fkey', table: 'reviews', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  { name: 'reviews_barber_id_fkey', table: 'reviews', column: 'barber_id', references: 'barbers', onDelete: 'restrict' },
  {
    name: 'reviews_customer_id_fkey',
    table: 'reviews',
    column: 'customer_id',
    references: 'profiles',
    onDelete: 'cascade',
  },
  {
    name: 'review_reports_booking_id_fkey',
    table: 'review_reports',
    column: 'booking_id',
    references: 'reviews',
    key: 'booking_id',
    onDelete: 'cascade',
  },
  { name: 'waitlist_shop_id_fkey', table: 'waitlist', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  {
    name: 'waitlist_customer_id_fkey',
    table: 'waitlist',
    column: 'customer_id',
    references: 'profiles',
    onDelete: 'cascade',
  },
  {
    name: 'waitlist_service_id_fkey',
    table: 'waitlist',
    column: 'service_id',
    references: 'services',
    onDelete: 'cascade',
  },
  { name: 'waitlist_barber_id_fkey', table: 'waitlist', column: 'barber_id', references: 'barbers', onDelete: 'cascade' },
  {
    name: 'queue_entries_shop_id_fkey',
    table: 'queue_entries',
    column: 'shop_id',
    references: 'shops',
    onDelete: 'cascade',
  },
  {
    name: 'queue_entries_customer_id_fkey',
    table: 'queue_entries',
    column: 'customer_id',
    references: 'profiles',
    onDelete: 'cascade',
  },
  {
    name: 'queue_entries_service_id_fkey',
    table: 'queue_entries',
    column: 'service_id',
    references: 'services',
    onDelete: 'set null',
  },
  {
    name: 'queue_entries_barber_id_fkey',
    table: 'queue_entries',
    column: 'barber_id',
    references: 'barbers',
    onDelete: 'set null',
  },
  {
    name: 'queue_entries_booking_id_fkey',
    table: 'queue_entries',
    column: 'booking_id',
    references: 'bookings',
    onDelete: 'set null',
  },
  { name: 'shop_photos_shop_id_fkey', table: 'shop_photos', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  {
    name: 'shop_photos_barber_id_fkey',
    table: 'shop_photos',
    column: 'barber_id',
    references: 'barbers',
    onDelete: 'set null',
  },
  { name: 'stamp_cards_shop_id_fkey', table: 'stamp_cards', column: 'shop_id', references: 'shops', onDelete: 'cascade' },
  {
    name: 'stamp_cards_customer_id_fkey',
    table: 'stamp_cards',
    column: 'customer_id',
    references: 'profiles',
    onDelete: 'cascade',
  },
];

// Values ---------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses "9:00", "09:00" or "17:30:00" the way Postgres reads a time. */
export function parseTime(value: unknown): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(value));
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 24 || min > 59 || s > 59 || (h === 24 && (min > 0 || s > 0))) return null;
  return [h, min, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Turns a value from JSON or a query string into what the column stores. */
export function toColumnValue(table: TableName, column: string, value: unknown): unknown {
  const col = COLUMNS[table][column];
  if (value === null || value === undefined) return null;
  const bad = (type: string) =>
    new PgError('22P02', `invalid input syntax for type ${type}: "${String(value)}"`, 400);
  switch (col.type) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID.test(value)) throw bad('uuid');
      return value.toLowerCase();
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw bad('integer');
      return n;
    }
    case 'numeric': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad('numeric');
      return Math.round(n * 100) / 100;
    }
    case 'float': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad('double precision');
      return n;
    }
    case 'bool':
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw bad('boolean');
    case 'timestamptz': {
      const t = Date.parse(String(value));
      if (Number.isNaN(t)) throw bad('timestamp with time zone');
      return new Date(t).toISOString();
    }
    case 'date': {
      const d = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || addDays(d, 0) !== d) {
        throw new PgError('22007', `invalid input syntax for type date: "${d}"`, 400);
      }
      return d;
    }
    case 'time': {
      const t = parseTime(value);
      if (!t) throw new PgError('22007', `invalid input syntax for type time: "${String(value)}"`, 400);
      return t;
    }
    case 'jsonb':
      return value;
    default: {
      const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (col.values && !col.values.includes(s)) {
        throw new PgError('22P02', `invalid input value for enum ${column}: "${s}"`, 400);
      }
      return s;
    }
  }
}

/** Compares two stored values of a column, for ORDER BY and filters. */
export function compareValues(table: TableName, column: string, a: unknown, b: unknown): number {
  const type = COLUMNS[table][column]?.type;
  if (type === 'timestamptz') return ms(a) - ms(b);
  if (type === 'int' || type === 'numeric' || type === 'float') return (a as number) - (b as number);
  if (type === 'bool') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// The tables -----------------------------------------------------------------

const STORAGE_KEY = 'potongku.demo.v1';
const TZ = 'Asia/Kuala_Lumpur';
let current: Tables | null = null;
/** The Kajang date the sample data was laid out for. */
let seededOn = '';
let seedFn: (() => void) | null = null;

/** Registered by seed.ts, so the database can fill itself on first use. */
export function setSeed(fn: () => void) {
  seedFn = fn;
}

/** How the ids of the sample bookings from before yesterday start (seed.ts); see moveToToday. */
export const HISTORY_ID = 'd0000000-0000-4000-9000-';

/** Saved with the demo, so a later one can tell which sample customers it has had. */
const VERSION = 3;
/**
 * The sample customers that came in after the first saved demos, with the
 * version that brought them (seed.ts). A demo saved before then gets them
 * when it opens; any other sample customer it lacks was deleted in it, and
 * stays deleted.
 */
const CAME_IN: Record<string, number> = {
  // Danial's own customers, so both of Ali's barbers show their stars.
  'siti@demo.potongku.my': 3,
  'izzat@demo.potongku.my': 3,
  'kevin@demo.potongku.my': 3,
  'nurul@demo.potongku.my': 3,
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const today = () => localDateString(new Date(clock()), TZ);

const emptyTables = () =>
  Object.fromEntries(Object.keys(COLUMNS).map((t) => [t, [] as Row[]])) as unknown as Tables;

function seeded(): Tables {
  current = emptyTables();
  seededOn = today();
  seedFn?.();
  save();
  return current;
}

/**
 * Moves every date forward by the days since the demo was last opened, so
 * "today" keeps its bookings and the sample trial never runs out. Changes
 * people made move with everything else. The sample weeks before yesterday
 * are laid out again for the new day instead: moved by a day, Ali would have
 * worked his Sundays off and Takings would name the wrong busy days. Nobody
 * can change those bookings in the app any more, so nothing is lost.
 * A demo saved before reviews or some sample customers came in is laid out
 * again the same day, so it gets them.
 */
function moveToToday(saved: Tables, savedOn: string, version: number) {
  const days = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${savedOn}T00:00:00Z`)) / 86_400_000);
  const has = new Set((saved.users ?? []).map((u) => u.email));
  const newcomers = Object.keys(CAME_IN).filter((email) => CAME_IN[email] > version && !has.has(email));
  const hadQueue = Array.isArray(saved.queue_entries);
  const settled = Array.isArray(saved.reviews) && Array.isArray(saved.review_reports) && hadQueue;
  if (!Number.isFinite(days) || (days === 0 && settled && newcomers.length === 0)) {
    return;
  }
  for (const [table, columns] of Object.entries(COLUMNS) as [TableName, Record<string, Column>][]) {
    const moved = Object.keys(columns).filter((c) => columns[c].type === 'timestamptz');
    const dates = Object.keys(columns).filter((c) => columns[c].type === 'date');
    for (const row of saved[table] ?? []) {
      for (const c of moved) {
        if (row[c] == null) continue;
        const at = ms(row[c]) + days * 86_400_000;
        // A customer's change has already happened. Opened at an earlier hour than last time, it
        // would land later today, and a phone that saw it would miss everything booked before then.
        row[c] = new Date(c === 'customer_changed_at' ? Math.min(at, clock()) : at).toISOString();
      }
      for (const c of dates) {
        if (row[c] != null) row[c] = addDays(String(row[c]), days);
      }
    }
  }

  const past = sampleHistory();
  // Newcomers join as the seed has them today, so the cuts and reviews laid
  // out below are theirs. Their ids hang on the weekday too, and the saved
  // demo may have given one to someone else.
  const sample = sampleTables();
  const taken = new Set((saved.users ?? []).map((u) => u.id));
  for (const user of sample.users.filter((u) => newcomers.includes(String(u.email)))) {
    const id = taken.has(user.id) ? newId() : user.id;
    (saved.users ??= []).push({ ...user, id });
    const profile = sample.profiles.find((p) => p.id === user.id);
    if (profile) (saved.profiles ??= []).push({ ...profile, id });
  }
  const kept = saved.bookings.filter((b) => !String(b.id).startsWith(HISTORY_ID));
  const barbers = new Set((saved.barbers ?? []).map((b) => b.id));
  // The sample customers added after the first bookings get ids that
  // depend on the weekday, so each is found again by their email.
  const savedIds = new Map((saved.users ?? []).map((u) => [u.email, u.id]));
  const userIds = new Map(past.users.map((u) => [u.id, savedIds.get(u.email)]));
  const [[, clash]] = EXCLUDE.bookings!;
  const end = Math.max(0, ...past.bookings.map((b) => ms(b.ends_at)));
  const earlier = kept.filter((b) => ms(b.starts_at) < end);
  saved.bookings = [
    ...kept,
    // A deleted shop or barber takes its history with it, and a customer who
    // deleted their account is gone from theirs, as delete_my_account does.
    ...past.bookings
      .filter((b) => barbers.has(b.barber_id) && !earlier.some((other) => clash(b, other)))
      .map((b) =>
        b.customer_id == null
          ? b
          : userIds.get(b.customer_id)
            ? { ...b, customer_id: userIds.get(b.customer_id) }
            : { ...b, customer_id: null, guest_name: 'Deleted account', guest_phone: null, customer_note: null },
      ),
  ];

  // A review stays while the booking it is on is still that customer's cut
  // at that shop, so ratings and replies people wrote are kept; it follows
  // the cut if it was laid out with the other barber. The weeks laid out
  // again bring their sample reviews, and a demo saved before reviews came
  // in gets every sample review that fits.
  const byId = new Map(saved.bookings.map((b) => [b.id, b]));
  const fits = (r: Row) => {
    const b = byId.get(r.booking_id);
    return b != null && b.customer_id === r.customer_id && b.shop_id === r.shop_id;
  };
  const had = Array.isArray(saved.reviews) ? saved.reviews : null;
  const stays = (had ?? []).filter(fits);
  const reviewed = new Set(stays.map((r) => r.booking_id));
  saved.reviews = [
    ...stays,
    ...past.reviews
      .map((r): Row => ({ ...r, customer_id: userIds.get(r.customer_id) }))
      .filter(
        (r) =>
          !reviewed.has(r.booking_id) &&
          (had == null || String(r.booking_id).startsWith(HISTORY_ID)) &&
          fits(r) &&
          byId.get(r.booking_id)!.status === 'completed',
      ),
  ].map((r) => ({ ...r, barber_id: byId.get(r.booking_id)!.barber_id }));

  // A report stays with its review, and a sample review laid out again
  // brings its sample report; each review is removed as its report says.
  const rated = new Set(saved.reviews.map((r) => r.booking_id));
  const reports = (saved.review_reports ?? []).filter((r) => rated.has(r.booking_id));
  const reported = new Set(reports.map((r) => r.booking_id));
  saved.review_reports = [
    ...reports,
    ...sample.review_reports.filter((r) => rated.has(r.booking_id) && !reported.has(r.booking_id)),
  ];
  const outcomes = new Map(saved.review_reports.map((r) => [r.booking_id, r.outcome]));
  for (const r of saved.reviews) r.removed = outcomes.get(r.booking_id) === 'removed';

  // The walk-in queue is today's. One from a day gone by is over, as the
  // shop's page leaves it out, so today's sample queue takes its place at
  // the shops that still take walk-ins in turn; a demo saved before the
  // queue came in gets it too. People in it are found again by their email,
  // and a deleted customer, barber or service is gone from it.
  if (days !== 0 || !hadQueue) {
    const queueShops = new Set(
      saved.shops
        .filter((s) => (s.queue_enabled ?? sampleValue('shops', s.id, 'queue_enabled')) === true)
        .map((s) => s.id),
    );
    const services = new Set((saved.services ?? []).map((v) => v.id));
    const emails = new Map(sample.users.map((u) => [u.id, u.email]));
    saved.queue_entries = sample.queue_entries.flatMap((e) => {
      const customer = e.customer_id == null ? null : savedIds.get(emails.get(e.customer_id));
      if (!queueShops.has(e.shop_id) || (e.customer_id != null && customer == null)) return [];
      return [
        {
          ...e,
          customer_id: customer,
          barber_id: barbers.has(e.barber_id) ? e.barber_id : null,
          service_id: services.has(e.service_id) ? e.service_id : null,
        },
      ];
    });
  }
}

/** The sample data as the seed lays it out for today, worked out at most once while a saved demo loads. */
let sample: Tables | null = null;
function sampleTables(): Tables {
  if (sample) return sample;
  const kept = current;
  current = emptyTables();
  try {
    seedFn?.();
    sample = current;
    return sample;
  } finally {
    current = kept;
  }
}

/** The sample bookings from before yesterday, every sample review and their customers, as the seed lays them out for today. */
function sampleHistory(): { bookings: Row[]; reviews: Row[]; users: Row[] } {
  const { bookings, reviews, users } = sampleTables();
  return { bookings: bookings.filter((b) => String(b.id).startsWith(HISTORY_ID)), reviews, users };
}

/**
 * For a demo saved before shops had photos: the sample photos of the shops
 * it still has, without the barbers it no longer has.
 */
function samplePhotos(all: Tables): Row[] {
  const shops = new Set(all.shops.map((s) => s.id));
  const barbers = new Set(all.barbers.map((b) => b.id));
  return sampleTables()
    .shop_photos.filter((p) => shops.has(p.shop_id))
    .map((p) => ({ ...p, barber_id: barbers.has(p.barber_id) ? p.barber_id : null }));
}

/**
 * For a demo saved before stamp cards: the sample customers' stamps at the
 * shops it still has, for the customers it still has (found by their email,
 * as their ids may differ).
 */
function sampleStamps(all: Tables): Row[] {
  const sample = sampleTables();
  const emails = new Map(sample.users.map((u) => [u.id, u.email]));
  const ids = new Map(all.users.map((u) => [u.email, u.id]));
  const shops = new Set(all.shops.map((s) => s.id));
  return sample.stamp_cards.flatMap((c) => {
    const customer = ids.get(emails.get(c.customer_id));
    return shops.has(c.shop_id) && customer != null ? [{ ...c, customer_id: customer }] : [];
  });
}

/** What the sample data has in a column for a row; null for rows people added. */
function sampleValue(table: TableName, rowId: unknown, column: string): unknown {
  return sampleTables()[table].find((r) => r.id === rowId)?.[column] ?? null;
}

export function tables(): Tables {
  if (current) return current;
  try {
    const saved = storage()?.getItem(STORAGE_KEY);
    const parsed = saved ? (JSON.parse(saved) as { tables?: Tables; seededOn?: string; version?: number }) : null;
    if (parsed?.tables && Array.isArray(parsed.tables.bookings)) {
      const hadReviews = Array.isArray(parsed.tables.reviews);
      const hadQueue = Array.isArray(parsed.tables.queue_entries);
      const hadPhotos = Array.isArray(parsed.tables.shop_photos);
      const hadReports = Array.isArray(parsed.tables.review_reports);
      const hadStamps = Array.isArray(parsed.tables.stamp_cards);
      const version = Number(parsed.version) || 0;
      if (parsed.seededOn) moveToToday(parsed.tables, parsed.seededOn, version);
      // A demo saved before a table was added has no list for it yet,
      // and one saved before a column was added has it empty.
      current = { ...emptyTables(), ...parsed.tables };
      for (const [table, columns] of Object.entries(COLUMNS) as [TableName, Record<string, Column>][]) {
        for (const row of current[table]) {
          for (const [column, col] of Object.entries(columns)) {
            if (!(column in row)) row[column] = col.backfill ? col.backfill(row) : col.default ? col.default() : null;
          }
        }
      }
      recountReviews(current);
      if (!hadPhotos) current.shop_photos = samplePhotos(current);
      if (!hadStamps) current.stamp_cards = sampleStamps(current);
      seededOn = today();
      if (
        parsed.seededOn !== seededOn ||
        !hadReviews ||
        !hadQueue ||
        !hadPhotos ||
        !hadReports ||
        !hadStamps ||
        version < VERSION
      ) {
        save();
      }
    }
  } catch {
    // Unreadable or blocked storage: start fresh.
  } finally {
    sample = null;
  }
  return current ?? seeded();
}

export function save() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, seededOn, tables: current }));
  } catch {
    // Storage full or blocked: the demo keeps working until the page closes.
  }
}

// Another tab saved: read its copy before the next request instead of
// writing over it.
try {
  globalThis.addEventListener?.('storage', (e: Event) => {
    const key = (e as StorageEvent).key;
    if (key === STORAGE_KEY || key === null) current = null;
  });
} catch {
  // No window events here (tests).
}

/** Forgets the copy in memory, as opening the page again would. */
export function reloadTables() {
  current = null;
}

/** Throws away every change and starts again from the sample data. */
export function resetTables() {
  seeded();
}

/** Runs fn as one transaction: if it throws, nothing it changed is kept. */
export function transaction<T>(fn: () => T): T {
  const before = JSON.stringify(tables());
  try {
    const result = fn();
    if (JSON.stringify(current) !== before) save();
    return result;
  } catch (e) {
    current = JSON.parse(before) as Tables;
    throw e;
  }
}

// Writes, with every constraint checked --------------------------------------

function checkRow(table: TableName, row: Row) {
  for (const [column, col] of Object.entries(COLUMNS[table])) {
    if (row[column] == null && !col.nullable) {
      throw new PgError(
        '23502',
        `null value in column "${column}" of relation "${table}" violates not-null constraint`,
        400,
      );
    }
  }
  for (const [name, ok] of CHECKS[table] ?? []) {
    if (!ok(row)) throw new PgError('23514', `new row for relation "${table}" violates check constraint "${name}"`, 400);
  }
  const all = tables();
  const key = PRIMARY_KEY[table] ?? ['id'];
  if (all[table].some((other) => key.every((k) => other[k] === row[k]))) {
    throw new PgError('23505', `duplicate key value violates unique constraint "${table}_pkey"`, 409);
  }
  for (const [name, column] of UNIQUE[table] ?? []) {
    const key = typeof column === 'string' ? [column] : column;
    if (
      key.every((k) => row[k] != null) &&
      all[table].some((other) => other.id !== row.id && key.every((k) => other[k] === row[k]))
    ) {
      throw new PgError('23505', `duplicate key value violates unique constraint "${name}"`, 409);
    }
  }
  for (const [name, clash] of EXCLUDE[table] ?? []) {
    if (all[table].some((other) => other.id !== row.id && clash(row, other))) {
      throw new PgError('23P01', `conflicting key value violates exclusion constraint "${name}"`, 409);
    }
  }
  for (const fk of FOREIGN_KEYS) {
    if (fk.table !== table || row[fk.column] == null) continue;
    if (!all[fk.references].some((target) => target[keyOf(fk)] === row[fk.column])) {
      throw new PgError(
        '23503',
        `insert or update on table "${table}" violates foreign key constraint "${fk.name}"`,
        409,
      );
    }
  }
}

/**
 * INSERT one row: fills defaults, checks constraints, runs triggers. `guard`
 * sees the finished row first, where Postgres checks row-level security.
 */
export function insertRow(table: TableName, values: Row, guard?: (row: Row) => void): Row {
  const row: Row = {};
  for (const [column, col] of Object.entries(COLUMNS[table])) {
    if (values[column] !== undefined) row[column] = toColumnValue(table, column, values[column]);
    else row[column] = col.default ? col.default() : null;
  }
  guard?.(row);
  beforeWrite(table, row);
  checkRow(table, row);
  tables()[table].push(row);
  if (table === 'users') handleNewUser(row);
  if (table === 'reviews') countReview(row, 1);
  if (table === 'review_reports') reviewRemoved(row);
  return row;
}

/** UPDATE the given rows with patch; all are checked before any change lands. */
export function updateRows(table: TableName, rows: Row[], patch: Row, guard?: (row: Row) => void): Row[] {
  const coerced: Row = {};
  for (const [column, value] of Object.entries(patch)) coerced[column] = toColumnValue(table, column, value);
  const list = tables()[table];
  const updated: Row[] = [];
  for (const row of rows) {
    const next = { ...row, ...coerced };
    guard?.(next);
    beforeWrite(table, next, row);
    if (next.id !== row.id) {
      // ON UPDATE NO ACTION: an id other rows point at can't change.
      for (const fk of FOREIGN_KEYS) {
        if (fk.references === table && keyOf(fk) === 'id' && tables()[fk.table].some((r) => r[fk.column] === row.id)) {
          throw new PgError(
            '23503',
            `update or delete on table "${table}" violates foreign key constraint "${fk.name}" on table "${fk.table}"`,
            409,
          );
        }
      }
    }
    const index = list.indexOf(row);
    // Check against the table as it will be, one row at a time like Postgres.
    list.splice(index, 1);
    try {
      checkRow(table, next);
    } finally {
      list.splice(index, 0, row);
    }
    list[index] = next;
    if (table === 'reviews') {
      countReview(row, -1);
      countReview(next, 1);
      if (next.rating !== row.rating || next.comment !== row.comment || next.first_name !== row.first_name) {
        reopenReport(next);
      }
    }
    if (table === 'review_reports' && next.outcome !== row.outcome) reviewRemoved(next);
    if (table === 'bookings' && next.barber_id !== row.barber_id) reviewFollowsCut(next);
    updated.push(next);
  }
  return updated;
}

/** DELETE the given rows, following each foreign key's ON DELETE rule. */
export function deleteRows(table: TableName, rows: Row[]) {
  const all = tables();
  const doomed = new Map<TableName, Set<Row>>();
  const mark = (t: TableName, list: Row[]) => {
    const set = doomed.get(t) ?? new Set<Row>();
    doomed.set(t, set);
    for (const row of list) {
      if (set.has(row)) continue;
      set.add(row);
      for (const fk of FOREIGN_KEYS) {
        if (fk.references !== t || fk.onDelete !== 'cascade') continue;
        mark(fk.table, all[fk.table].filter((r) => r[fk.column] === row[keyOf(fk)]));
      }
    }
  };
  mark(table, rows);

  for (const fk of FOREIGN_KEYS) {
    const gone = doomed.get(fk.references);
    if (!gone || gone.size === 0) continue;
    const ids = new Set([...gone].map((r) => r[keyOf(fk)]));
    for (const ref of all[fk.table]) {
      if (!ids.has(ref[fk.column]) || doomed.get(fk.table)?.has(ref)) continue;
      if (fk.onDelete === 'set null') ref[fk.column] = null;
      else {
        throw new PgError(
          '23503',
          `update or delete on table "${fk.references}" violates foreign key constraint "${fk.name}" on table "${fk.table}"`,
          409,
        );
      }
    }
  }
  for (const review of doomed.get('reviews') ?? []) countReview(review, -1);
  // A report deleted on its own puts its review back; one going with its review changes nothing.
  const reviewsGone = doomed.get('reviews') ?? new Set<Row>();
  const putBack = [...(doomed.get('review_reports') ?? [])].filter(
    (report) => ![...reviewsGone].some((r) => r.booking_id === report.booking_id),
  );
  for (const [t, set] of doomed) all[t] = all[t].filter((r) => !set.has(r));
  for (const report of putBack) reviewRemoved({ ...report, outcome: null });
}

/**
 * The reviews_count trigger: adds a review to its shop's and its barber's
 * count and total, or (sign -1) takes it off. A removed review counts for nobody.
 */
function countReview(review: Row, sign: 1 | -1) {
  if (review.removed === true) return;
  for (const row of [findById('shops', review.shop_id), findById('barbers', review.barber_id)]) {
    if (!row) continue;
    row.rating_count = (row.rating_count as number) + sign;
    row.rating_sum = (row.rating_sum as number) + sign * (review.rating as number);
  }
}

/** The review_reports_removed trigger: the review is removed while its report says so, and back otherwise. */
function reviewRemoved(report: Row) {
  const review = tables().reviews.find((r) => r.booking_id === report.booking_id);
  const removed = report.outcome === 'removed';
  if (review && review.removed !== removed) updateRows('reviews', [review], { removed });
}

/** The reviews_reopen_report trigger: a kept review its customer changes goes back to the team. */
function reopenReport(review: Row) {
  const report = tables().review_reports.find((r) => r.booking_id === review.booking_id && r.outcome === 'kept');
  if (report) updateRows('review_reports', [report], { outcome: null });
}

/** The bookings_review_barber trigger: a rated cut put right to another barber takes its review along. */
function reviewFollowsCut(booking: Row) {
  const review = tables().reviews.find((r) => r.booking_id === booking.id);
  if (review) updateRows('reviews', [review], { barber_id: booking.barber_id });
}

/** Every shop's and barber's count and total worked out afresh, for a saved demo whose reviews were laid out again. */
function recountReviews(all: Tables) {
  const byId = new Map<unknown, Row>([...all.shops, ...all.barbers].map((r) => [r.id, r]));
  for (const row of [...all.shops, ...all.barbers]) {
    row.rating_count = 0;
    row.rating_sum = 0;
  }
  for (const review of all.reviews) {
    if (review.removed === true) continue;
    for (const row of [byId.get(review.shop_id), byId.get(review.barber_id)]) {
      if (!row) continue;
      row.rating_count = (row.rating_count as number) + 1;
      row.rating_sum = (row.rating_sum as number) + (review.rating as number);
    }
  }
}

/**
 * The before triggers: shop_photos_check, review_reports_decided, and the
 * shops': shops_first_published notes when a shop first goes live and keeps
 * it while paused, and shops_ready_to_go_live (on an update, `before` being
 * the row as it was) only lets a shop go live with something customers can book.
 */
function beforeWrite(table: TableName, row: Row, before?: Row) {
  if (table === 'shop_photos') return shopPhotosCheck(row, before);
  if (table === 'bookings') {
    if (before && before.status !== row.status && (before.status === 'completed' || row.status === 'completed')) {
      stampCardCut(row, before);
    }
    return;
  }
  // review_reports_decided: decided_at follows the outcome.
  if (table === 'review_reports') {
    if (row.outcome == null) row.decided_at = null;
    else if (!before || row.outcome !== before.outcome) row.decided_at = nowIso();
    return;
  }
  if (table !== 'shops') return;
  if (row.is_published === true && row.published_at == null) row.published_at = nowIso();
  if (before && row.is_published === true && before.is_published !== true) readyToGoLive(row);
}

/** Midnight today on the shop's clock, from which a booking can be a stamp card reward (shop_today_start). */
export function shopTodayStart(tz: string): number {
  return dayBounds(localDateString(new Date(clock()), tz), tz).start.getTime();
}

/** What a stamp card reward takes off a booking's price: all of it, or the card's amount at most (stamp_reward_off). */
export const stampRewardOff = (off: unknown, price: unknown) =>
  off == null ? Number(price) : Math.min(Number(off), Number(price));

/** A customer's stamps on a shop's card (stamp_cards), 0 without a row. */
export function stampsAt(shopId: unknown, customerId: unknown): number {
  const card = tables().stamp_cards.find((c) => c.shop_id === shopId && c.customer_id === customerId);
  return card ? Number(card.stamps) : 0;
}

/**
 * The customer's reward booking at a shop, or undefined (stamp_reward_booking): with the card on and
 * at least one stamp fewer than its cuts, their earliest booking there from today on that is still confirmed.
 */
export function stampRewardBooking(shopId: unknown, customerId: unknown): Row | undefined {
  const shop = findById('shops', shopId);
  if (!shop || shop.stamp_card_on !== true || customerId == null) return undefined;
  if (stampsAt(shopId, customerId) < Number(shop.stamp_card_cuts) - 1) return undefined;
  const from = shopTodayStart(String(shop.time_zone));
  return tables()
    .bookings.filter(
      (b) => b.customer_id === customerId && b.shop_id === shopId && ms(b.starts_at) >= from && b.status === 'confirmed',
    )
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || (String(a.id) < String(b.id) ? -1 : 1))[0];
}

/**
 * The stamp_card_cut trigger, as a booking's status goes to or from done: done takes the reward if
 * this is the reward booking (as if still confirmed), else earns a stamp; done taken back takes the
 * stamp back, or gives back the stamps the reward used.
 */
function stampCardCut(row: Row, before: Row) {
  const all = tables();
  const cardOf = (b: Row) => all.stamp_cards.find((c) => c.shop_id === b.shop_id && c.customer_id === b.customer_id);
  if (before.status === 'completed') {
    const card = cardOf(before);
    if (card && before.stamp_card === 'stamp') {
      updateRows('stamp_cards', [card], { stamps: Math.max(Number(card.stamps) - 1, 0) });
    } else if (card && before.stamp_card === 'reward') {
      updateRows('stamp_cards', [card], { stamps: Number(card.stamps) + Number(before.reward_stamps) });
    }
    row.stamp_card = null;
    row.reward_off = null;
    row.reward_stamps = null;
  }
  if (row.status !== 'completed' || row.customer_id == null) return;
  const shop = findById('shops', row.shop_id);
  if (!shop || shop.stamp_card_on !== true) return;
  const card = cardOf(row) ?? insertRow('stamp_cards', { shop_id: row.shop_id, customer_id: row.customer_id });
  const stamps = Number(card.stamps);
  const from = shopTodayStart(String(shop.time_zone));
  const at = ms(row.starts_at);
  const earlier = all.bookings.some(
    (b) =>
      b.customer_id === row.customer_id &&
      b.shop_id === row.shop_id &&
      b.status === 'confirmed' &&
      b.id !== row.id &&
      ms(b.starts_at) >= from &&
      (ms(b.starts_at) < at || (ms(b.starts_at) === at && String(b.id) < String(row.id))),
  );
  if (stamps >= Number(shop.stamp_card_cuts) - 1 && at >= from && !earlier) {
    row.stamp_card = 'reward';
    row.reward_off = stampRewardOff(shop.stamp_card_off, row.price);
    row.reward_stamps = stamps;
    updateRows('stamp_cards', [cardOf(row)!], { stamps: 0 });
  } else {
    row.stamp_card = 'stamp';
    updateRows('stamp_cards', [cardOf(row)!], { stamps: stamps + 1 });
  }
}

/** The most photos a shop keeps (max_shop_photos). */
export const MAX_SHOP_PHOTOS = 24;

/**
 * The shop_photos_check trigger: a photo's barber works at its shop, a
 * shop keeps at most 24 photos, and a new one goes last.
 */
function shopPhotosCheck(photo: Row, before?: Row) {
  const all = tables();
  if (photo.barber_id != null && !all.barbers.some((b) => b.id === photo.barber_id && b.shop_id === photo.shop_id)) {
    throw new PgError('P0001', 'Barber not found.', 400);
  }
  if (before) return;
  const theirs = all.shop_photos.filter((p) => p.shop_id === photo.shop_id);
  if (theirs.length >= MAX_SHOP_PHOTOS) {
    throw new PgError('P0001', 'Your shop has 24 photos, the most it can have. Remove one to add another.', 400);
  }
  photo.sort_order = theirs.length ? Math.max(...theirs.map((p) => p.sort_order as number)) + 1 : 0;
}

function readyToGoLive(shop: Row) {
  const all = tables();
  if (!all.services.some((v) => v.shop_id === shop.id && v.is_active === true)) {
    throw new PgError('P0001', 'Add a service before you go live, so customers have something to book.', 400);
  }
  const team = new Set(all.barbers.filter((b) => b.shop_id === shop.id && b.is_active === true).map((b) => b.id));
  if (!all.working_hours.some((h) => team.has(h.barber_id))) {
    throw new PgError('P0001', 'Add a barber with working hours before you go live, so customers can pick a time.', 400);
  }
}

/** The on_auth_user_created trigger: every new user gets a profile. */
function handleNewUser(user: Row) {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const clip = (v: unknown, max: number) => [...pgTrim(String(v ?? ''))].slice(0, max).join('');
  insertRow('profiles', {
    id: user.id,
    role: meta.role === 'barber' ? 'barber' : 'customer',
    // Named after the email when no name was given, as the migration does.
    full_name: clip(meta.full_name, 80) || clip(String(user.email ?? '').split('@')[0], 80) || 'Customer',
    phone: clip(meta.phone, 20) || null,
  });
}

// Row-level security helpers --------------------------------------------------

export const findById = (table: TableName, rowId: unknown) => tables()[table].find((r) => r.id === rowId);

export function shopIsLive(shop: Row): boolean {
  return (
    shop.is_published === true &&
    (shop.subscription_status === 'active' ||
      (shop.subscription_status === 'trialing' && ms(shop.trial_ends_at) > clock()))
  );
}

export function ownsShop(shopId: unknown, uid: string | null): boolean {
  return uid != null && tables().shops.some((s) => s.id === shopId && s.owner_id === uid);
}

export function shopVisible(shopId: unknown, uid: string | null): boolean {
  const shop = findById('shops', shopId);
  return Boolean(shop && (shopIsLive(shop) || (uid != null && shop.owner_id === uid)));
}
