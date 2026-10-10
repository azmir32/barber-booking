// The slice of PostgREST the app uses: select with embedded tables, filters,
// order, limit, counts, single rows, insert, update and delete, all under the
// same row-level security policies and column grants as the migration.

import {
  COLUMNS,
  compareValues,
  deleteRows,
  findById,
  FOREIGN_KEYS,
  insertRow,
  ownsShop,
  PgError,
  shopIsLive,
  shopVisible,
  tables,
  toColumnValue,
  updateRows,
  type Row,
  type TableName,
} from './db.ts';

export type Caller = { uid: string | null };

// Policies -------------------------------------------------------------------

type Policy = {
  select: (r: Row, c: Caller) => boolean;
  insert?: (r: Row, c: Caller) => boolean;
  update?: (r: Row, c: Caller) => boolean;
  delete?: (r: Row, c: Caller) => boolean;
};

const ownsBarbersShop = (barberId: unknown, c: Caller) => {
  const barber = findById('barbers', barberId);
  return Boolean(barber && ownsShop(barber.shop_id, c.uid));
};

const POLICIES: Record<Exclude<TableName, 'users'>, Policy> = {
  profiles: {
    select: (r, c) =>
      r.id === c.uid || tables().bookings.some((b) => b.customer_id === r.id && ownsShop(b.shop_id, c.uid)),
    update: (r, c) => r.id === c.uid,
  },
  shops: {
    select: (r, c) => shopIsLive(r) || (c.uid != null && r.owner_id === c.uid),
    insert: (r, c) =>
      c.uid != null && r.owner_id === c.uid && tables().profiles.some((p) => p.id === c.uid && p.role === 'barber'),
    update: (r, c) => c.uid != null && r.owner_id === c.uid,
  },
  barbers: {
    select: (r, c) => shopVisible(r.shop_id, c.uid) || ownsShop(r.shop_id, c.uid),
    insert: (r, c) => ownsShop(r.shop_id, c.uid),
    update: (r, c) => ownsShop(r.shop_id, c.uid),
    delete: (r, c) => ownsShop(r.shop_id, c.uid),
  },
  services: {
    select: (r, c) => shopVisible(r.shop_id, c.uid) || ownsShop(r.shop_id, c.uid),
    insert: (r, c) => ownsShop(r.shop_id, c.uid),
    update: (r, c) => ownsShop(r.shop_id, c.uid),
    delete: (r, c) => ownsShop(r.shop_id, c.uid),
  },
  working_hours: {
    select: (r, c) => {
      const barber = findById('barbers', r.barber_id);
      return Boolean(barber && shopVisible(barber.shop_id, c.uid)) || ownsBarbersShop(r.barber_id, c);
    },
    insert: (r, c) => ownsBarbersShop(r.barber_id, c),
    update: (r, c) => ownsBarbersShop(r.barber_id, c),
    delete: (r, c) => ownsBarbersShop(r.barber_id, c),
  },
  bookings: {
    select: (r, c) => (c.uid != null && r.customer_id === c.uid) || ownsShop(r.shop_id, c.uid),
  },
  // No policies: only the closing functions read and write it.
  shop_closures: { select: () => false },
};

/** Column grants: who may write which columns (everything else is open). */
const GRANTS: Partial<Record<TableName, Partial<Record<'insert' | 'update' | 'delete', string[]>>>> = {
  profiles: { update: ['full_name', 'phone'] },
  shops: {
    insert: ['owner_id', 'name', 'slug', 'about', 'address', 'area', 'phone', 'instagram', 'is_published'],
    update: ['name', 'slug', 'about', 'address', 'area', 'phone', 'instagram', 'is_published'],
  },
  bookings: { insert: [], update: [], delete: [] },
  shop_closures: { insert: [], update: [], delete: [] },
};

function denied(c: Caller, message: string) {
  return new PgError('42501', message, c.uid ? 403 : 401);
}

function checkGrant(table: TableName, action: 'insert' | 'update' | 'delete', columns: string[], c: Caller) {
  const allowed = GRANTS[table]?.[action];
  // Granted to "authenticated" only: anonymous callers have none of them.
  if (allowed && (!c.uid || columns.some((col) => !allowed.includes(col)) || allowed.length === 0)) {
    throw denied(c, `permission denied for table ${table}`);
  }
}

export const canSee = (table: TableName, row: Row, c: Caller) =>
  table !== 'users' && POLICIES[table].select(row, c);

// Query parsing --------------------------------------------------------------

type Item =
  | { kind: 'star' }
  | { kind: 'column'; name: string; alias: string }
  | { kind: 'embed'; name: string; alias: string; hints: string[]; items: Item[] };

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function parseSelect(text: string): Item[] {
  return splitTop(text || '*').map((part): Item => {
    if (part === '*') return { kind: 'star' };
    const m = /^(?:([\w]+):)?([\w]+)((?:![\w]+)*)(?:\((.*)\))?$/s.exec(part);
    if (!m) throw new PgError('PGRST100', `"failed to parse select parameter (${text})"`, 400);
    const [, alias, name, hints, inner] = m;
    if (inner !== undefined) {
      return {
        kind: 'embed',
        name,
        alias: alias ?? name,
        hints: hints.split('!').filter(Boolean),
        items: parseSelect(inner),
      };
    }
    return { kind: 'column', name, alias: alias ?? name };
  });
}

type Filter = { path: string; column: string; op: string; negate: boolean; value: string };

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

function parseFilters(params: URLSearchParams): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of params) {
    const dot = key.lastIndexOf('.');
    const path = dot === -1 ? '' : key.slice(0, dot);
    const column = dot === -1 ? key : key.slice(dot + 1);
    if (RESERVED.has(column)) continue;
    if (column === 'or' || column === 'and') {
      throw new PgError('PGRST100', `The demo does not support "${column}" filters`, 400);
    }
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like|ilike)\.(.*)$/s.exec(raw);
    if (!m) throw new PgError('PGRST100', `"failed to parse filter (${raw})"`, 400);
    filters.push({ path, column, negate: Boolean(m[1]), op: m[2], value: m[3] });
  }
  return filters;
}

function matches(table: TableName, row: Row, f: Filter): boolean {
  if (!(f.column in COLUMNS[table])) {
    throw new PgError('42703', `column ${table}.${f.column} does not exist`, 400);
  }
  const value = row[f.column];
  let result: boolean;
  if (f.op === 'is') {
    const v = f.value.toLowerCase();
    result = v === 'null' ? value == null : v === 'true' ? value === true : v === 'false' ? value === false : false;
  } else if (f.op === 'in') {
    const list = f.value.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    result = value != null && list.some((item) => compareValues(table, f.column, value, toColumnValue(table, f.column, item)) === 0);
  } else if (f.op === 'like' || f.op === 'ilike') {
    const pattern = f.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*').replace(/_/g, '.');
    result = value != null && new RegExp(`^${pattern}$`, f.op === 'ilike' ? 'is' : 's').test(String(value));
  } else {
    if (value == null) return false;
    const cmp = compareValues(table, f.column, value, toColumnValue(table, f.column, f.value));
    result =
      f.op === 'eq' ? cmp === 0 :
      f.op === 'neq' ? cmp !== 0 :
      f.op === 'gt' ? cmp > 0 :
      f.op === 'gte' ? cmp >= 0 :
      f.op === 'lt' ? cmp < 0 :
      cmp <= 0;
  }
  return f.negate ? !result : result;
}

type Order = { column: string; desc: boolean; nullsFirst: boolean };

function parseOrder(text: string | null): Order[] {
  if (!text) return [];
  return text.split(',').map((term) => {
    const [column, ...mods] = term.split('.');
    const desc = mods.includes('desc');
    return { column, desc, nullsFirst: mods.includes('nullsfirst') || (desc && !mods.includes('nullslast')) };
  });
}

function sortRows(table: TableName, rows: Row[], order: Order[]) {
  for (const o of order) {
    if (!(o.column in COLUMNS[table])) throw new PgError('42703', `column ${table}.${o.column} does not exist`, 400);
  }
  return [...rows].sort((a, b) => {
    for (const o of order) {
      const [x, y] = [a[o.column], b[o.column]];
      if (x == null || y == null) {
        if (x == null && y == null) continue;
        return (x == null) === o.nullsFirst ? -1 : 1;
      }
      const cmp = compareValues(table, o.column, x, y);
      if (cmp !== 0) return o.desc ? -cmp : cmp;
    }
    return 0;
  });
}

// Embedding ------------------------------------------------------------------

type Relation = { table: TableName; one: boolean; matches: (parent: Row, child: Row) => boolean };

function relation(from: TableName, name: string, hints: string[]): Relation {
  const fkHint = hints.find((h) => h !== 'inner' && h !== 'left');
  const found: Relation[] = [];
  for (const fk of FOREIGN_KEYS) {
    if (fkHint && fk.name !== fkHint) continue;
    if (fk.table === from && fk.references === name) {
      found.push({ table: fk.references, one: true, matches: (p, c) => p[fk.column] === c.id });
    } else if (fk.references === from && fk.table === name) {
      const unique = fk.table === 'shops' && fk.column === 'owner_id';
      found.push({ table: fk.table, one: unique, matches: (p, c) => c[fk.column] === p.id });
    }
  }
  if (found.length !== 1 || name === 'users') {
    throw new PgError(
      found.length > 1 ? 'PGRST201' : 'PGRST200',
      `Could not find a relationship between '${from}' and '${name}' in the schema cache`,
      400,
    );
  }
  return found[0];
}

type Query = { filters: Filter[]; params: URLSearchParams; caller: Caller };

/** Builds the JSON for one row, or null when an !inner embed rules it out. */
function shape(table: TableName, row: Row, items: Item[], path: string, q: Query): Row | null {
  const out: Row = {};
  for (const item of items) {
    if (item.kind === 'star') {
      for (const column of Object.keys(COLUMNS[table])) out[column] = row[column];
    } else if (item.kind === 'column') {
      if (!(item.name in COLUMNS[table])) {
        throw new PgError('42703', `column ${table}.${item.name} does not exist`, 400);
      }
      out[item.alias] = row[item.name];
    } else {
      const rel = relation(table, item.name, item.hints);
      const childPath = path ? `${path}.${item.alias}` : item.alias;
      const ownFilters = q.filters.filter((f) => f.path === childPath || (f.path === (path ? `${path}.${item.name}` : item.name)));
      let children = tables()[rel.table]
        .filter((child) => rel.matches(row, child) && canSee(rel.table, child, q.caller))
        .filter((child) => ownFilters.every((f) => matches(rel.table, child, f)))
        .map((child) => shape(rel.table, child, item.items, childPath, q))
        .filter((child): child is Row => child !== null);
      const inner = item.hints.includes('inner');
      if (rel.one) {
        if (inner && children.length === 0) return null;
        out[item.alias] = children[0] ?? null;
      } else {
        children = sortRows(rel.table, children, parseOrder(q.params.get(`${childPath}.order`)));
        if (inner && children.length === 0) return null;
        out[item.alias] = children;
      }
    }
  }
  return out;
}

// Requests -------------------------------------------------------------------

export type RestResult = { status: number; body?: unknown; headers?: Record<string, string> };

function tableName(name: string): Exclude<TableName, 'users'> {
  if (name in POLICIES) return name as Exclude<TableName, 'users'>;
  throw new PgError('PGRST205', `Could not find the table 'public.${name}' in the schema cache`, 404);
}

function prefers(headers: Headers, what: string) {
  return (headers.get('prefer') ?? '').split(',').some((p) => p.trim() === what);
}

/** The rows a request's top-level filters pick out, as the caller sees them. */
function pick(table: TableName, q: Query, use?: (r: Row, c: Caller) => boolean): Row[] {
  const top = q.filters.filter((f) => f.path === '');
  return tables()[table].filter(
    (r) => canSee(table, r, q.caller) && (!use || use(r, q.caller)) && top.every((f) => matches(table, r, f)),
  );
}

function respond(
  table: TableName,
  rows: Row[],
  q: Query,
  headers: Headers,
  method: string,
  status: number,
): RestResult {
  const items = parseSelect(q.params.get('select') ?? '*');
  let shaped = sortRows(table, rows, parseOrder(q.params.get('order')))
    .map((r) => ({ row: r, out: shape(table, r, items, '', q) }))
    .filter((x): x is { row: Row; out: Row } => x.out !== null)
    .map((x) => x.out);
  const total = shaped.length;
  const offset = Number(q.params.get('offset') ?? 0);
  const limit = q.params.get('limit');
  shaped = shaped.slice(offset, limit == null ? undefined : offset + Number(limit));
  const range = shaped.length ? `${offset}-${offset + shaped.length - 1}` : '*';
  const out: RestResult = {
    status,
    headers: { 'content-range': `${range}/${prefers(headers, 'count=exact') ? total : '*'}` },
  };
  if ((headers.get('accept') ?? '').includes('application/vnd.pgrst.object+json')) {
    if (shaped.length !== 1) {
      throw new PgError(
        'PGRST116',
        'JSON object requested, multiple (or no) rows returned',
        406,
        `The result contains ${shaped.length} rows`,
      );
    }
    out.body = shaped[0];
  } else out.body = shaped;
  if (method === 'HEAD') delete out.body;
  return out;
}

export function handleRest(method: string, name: string, params: URLSearchParams, headers: Headers, body: unknown, caller: Caller): RestResult {
  const table = tableName(name);
  const q: Query = { filters: parseFilters(params), params, caller };
  const policy = POLICIES[table];
  const representation = prefers(headers, 'return=representation');

  if (method === 'GET' || method === 'HEAD') return respond(table, pick(table, q), q, headers, method, 200);

  if (method === 'POST') {
    const list = (Array.isArray(body) ? body : [body]) as Row[];
    const columns = params.get('columns')?.split(',').map((c) => c.replace(/^"|"$/g, '')) ?? [...new Set(list.flatMap((r) => Object.keys(r ?? {})))];
    for (const column of columns) {
      if (!(column in COLUMNS[table])) {
        throw new PgError('PGRST204', `Could not find the '${column}' column of '${table}' in the schema cache`, 400);
      }
    }
    checkGrant(table, 'insert', columns, caller);
    const inserted = list.map((values) => {
      const picked: Row = {};
      for (const column of columns) if (values?.[column] !== undefined) picked[column] = values[column];
      return insertRow(table, picked, (row) => {
        if (!policy.insert?.(row, caller)) {
          throw denied(caller, `new row violates row-level security policy for table "${table}"`);
        }
      });
    });
    if (!representation) return { status: 201 };
    for (const row of inserted) {
      if (!canSee(table, row, caller)) {
        throw denied(caller, `new row violates row-level security policy for table "${table}"`);
      }
    }
    return respond(table, inserted, { ...q, filters: q.filters.filter((f) => f.path !== '') }, headers, method, 201);
  }

  if (method === 'PATCH') {
    const patch = (body ?? {}) as Row;
    for (const column of Object.keys(patch)) {
      if (!(column in COLUMNS[table])) {
        throw new PgError('PGRST204', `Could not find the '${column}' column of '${table}' in the schema cache`, 400);
      }
    }
    checkGrant(table, 'update', Object.keys(patch), caller);
    const targets = pick(table, q, policy.update ?? (() => false));
    const updated = updateRows(table, targets, patch, (row) => {
      if (!policy.update?.(row, caller)) {
        throw denied(caller, `new row violates row-level security policy for table "${table}"`);
      }
    });
    if (!representation) return { status: 204 };
    return respond(table, updated, { ...q, filters: q.filters.filter((f) => f.path !== '') }, headers, method, 200);
  }

  if (method === 'DELETE') {
    checkGrant(table, 'delete', [], caller);
    const targets = pick(table, q, policy.delete ?? (() => false));
    const copies = targets.map((r) => ({ ...r }));
    deleteRows(table, targets);
    if (!representation) return { status: 204 };
    return respond(table, copies, { ...q, filters: q.filters.filter((f) => f.path !== '') }, headers, method, 200);
  }

  throw new PgError('PGRST117', `Unsupported HTTP method: ${method}`, 405);
}
