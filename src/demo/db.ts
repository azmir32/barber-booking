// The demo's database: the tables, constraints and row-level security from
// supabase/migrations, rebuilt in plain TypeScript so the whole app can run
// in a browser with no server. Rows live in memory and are saved to
// localStorage, so a demo survives a reload on the same phone.

import { addDays, localDateString } from '../lib/time.ts';

export type Row = Record<string, unknown>;
export type TableName =
  | 'users'
  | 'profiles'
  | 'shops'
  | 'barbers'
  | 'services'
  | 'working_hours'
  | 'bookings'
  | 'shop_closures';
export type Tables = Record<TableName, Row[]>;
type ColumnType = 'uuid' | 'text' | 'int' | 'numeric' | 'bool' | 'timestamptz' | 'date' | 'time' | 'jsonb';
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
    phone: opt('text'),
    instagram: opt('text'),
    time_zone: req('text', () => 'Asia/Kuala_Lumpur'),
    is_published: req('bool', () => false),
    published_at: { ...opt('timestamptz'), backfill: (r) => (r.is_published ? r.created_at : null) },
    trial_ends_at: req('timestamptz', () => new Date(clock() + 30 * 86_400_000).toISOString()),
    subscription_status: req('text', () => 'trialing', ['trialing', 'active', 'past_due', 'cancelled']),
    created_at: createdAt,
  },
  barbers: {
    id,
    shop_id: req('uuid'),
    name: req('text'),
    is_active: req('bool', () => true),
    sort_order: req('int', () => 0),
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
    created_at: createdAt,
  },
  shop_closures: {
    shop_id: req('uuid'),
    day: req('date'),
    reason: opt('text'),
  },
};

/** Tables keyed by something other than id. */
const PRIMARY_KEY: Partial<Record<TableName, string[]>> = {
  shop_closures: ['shop_id', 'day'],
};

/** Postgres trim(): spaces only, unlike String.prototype.trim. */
export const pgTrim = (s: string) => s.replace(/^ +| +$/g, '');
const len = (v: unknown) => (v == null ? null : [...String(v)].length);
const between = (n: number | null, lo: number, hi: number) => n == null || (n >= lo && n <= hi);
const atMost = (v: unknown, max: number) => v == null || (len(v) as number) <= max;

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
    ['shops_phone_check', (r) => atMost(r.phone, 20)],
    ['shops_instagram_check', (r) => atMost(r.instagram, 60)],
  ],
  barbers: [['barbers_name_check', (r) => between(len(pgTrim(String(r.name))), 1, 40)]],
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
  ],
  shop_closures: [['shop_closures_reason_check', (r) => atMost(r.reason, 80)]],
};

const UNIQUE: Partial<Record<TableName, [string, string][]>> = {
  users: [['users_email_key', 'email']],
  shops: [
    ['shops_owner_id_key', 'owner_id'],
    ['shops_slug_key', 'slug'],
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
  onDelete: 'cascade' | 'set null' | 'restrict';
};

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
  if (type === 'int' || type === 'numeric') return (a as number) - (b as number);
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
 */
function moveToToday(saved: Tables, savedOn: string) {
  const days = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${savedOn}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days === 0) return;
  for (const [table, columns] of Object.entries(COLUMNS) as [TableName, Record<string, Column>][]) {
    const moved = Object.keys(columns).filter((c) => columns[c].type === 'timestamptz');
    const dates = Object.keys(columns).filter((c) => columns[c].type === 'date');
    for (const row of saved[table] ?? []) {
      for (const c of moved) {
        if (row[c] != null) row[c] = new Date(ms(row[c]) + days * 86_400_000).toISOString();
      }
      for (const c of dates) {
        if (row[c] != null) row[c] = addDays(String(row[c]), days);
      }
    }
  }

  const past = sampleHistory();
  const kept = saved.bookings.filter((b) => !String(b.id).startsWith(HISTORY_ID));
  const barbers = new Set((saved.barbers ?? []).map((b) => b.id));
  const users = new Set((saved.users ?? []).map((u) => u.id));
  const [[, clash]] = EXCLUDE.bookings!;
  const end = Math.max(0, ...past.map((b) => ms(b.ends_at)));
  const earlier = kept.filter((b) => ms(b.starts_at) < end);
  saved.bookings = [
    ...kept,
    // A deleted shop or barber takes its history with it, and a customer who
    // deleted their account is gone from theirs, as delete_my_account does.
    ...past
      .filter((b) => barbers.has(b.barber_id) && !earlier.some((other) => clash(b, other)))
      .map((b) =>
        b.customer_id == null || users.has(b.customer_id)
          ? b
          : { ...b, customer_id: null, guest_name: 'Deleted account', guest_phone: null, customer_note: null },
      ),
  ];
}

/** The sample bookings from before yesterday, as the seed lays them out for today. */
function sampleHistory(): Row[] {
  const kept = current;
  current = emptyTables();
  try {
    seedFn?.();
    return current.bookings.filter((b) => String(b.id).startsWith(HISTORY_ID));
  } finally {
    current = kept;
  }
}

export function tables(): Tables {
  if (current) return current;
  try {
    const saved = storage()?.getItem(STORAGE_KEY);
    const parsed = saved ? (JSON.parse(saved) as { tables?: Tables; seededOn?: string }) : null;
    if (parsed?.tables && Array.isArray(parsed.tables.bookings)) {
      if (parsed.seededOn) moveToToday(parsed.tables, parsed.seededOn);
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
      seededOn = today();
      if (parsed.seededOn !== seededOn) save();
    }
  } catch {
    // Unreadable or blocked storage: start fresh.
  }
  return current ?? seeded();
}

export function save() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: 2, seededOn, tables: current }));
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
    if (row[column] != null && all[table].some((other) => other.id !== row.id && other[column] === row[column])) {
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
    if (!all[fk.references].some((target) => target.id === row[fk.column])) {
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
    beforeWrite(table, next);
    if (next.id !== row.id) {
      // ON UPDATE NO ACTION: an id other rows point at can't change.
      for (const fk of FOREIGN_KEYS) {
        if (fk.references === table && tables()[fk.table].some((r) => r[fk.column] === row.id)) {
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
        mark(fk.table, all[fk.table].filter((r) => r[fk.column] === row.id));
      }
    }
  };
  mark(table, rows);

  for (const fk of FOREIGN_KEYS) {
    const gone = doomed.get(fk.references);
    if (!gone || gone.size === 0) continue;
    const ids = new Set([...gone].map((r) => r.id));
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
  for (const [t, set] of doomed) all[t] = all[t].filter((r) => !set.has(r));
}

/** The shops_first_published trigger: notes when a shop first goes live, and keeps it while paused. */
function beforeWrite(table: TableName, row: Row) {
  if (table === 'shops' && row.is_published === true && row.published_at == null) row.published_at = nowIso();
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
