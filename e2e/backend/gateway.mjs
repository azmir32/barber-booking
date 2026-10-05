// A tiny stand-in for the Supabase API gateway, for end-to-end tests only.
//
//   /auth/v1/*  a minimal email + password auth (sign up, sign in, refresh,
//               user, sign out) that issues the same kind of JWTs Supabase does
//   /rest/v1/*  proxied to a local PostgREST
//   anything else  the exported web app (dist/), with SPA fallback
//
// Env: PORT, DATABASE_URL, POSTGREST_URL, JWT_SECRET, STATIC_DIR

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import pg from 'pg';

import { signJwt as sign, verifyJwt as verify } from './jwt.mjs';

const PORT = Number(process.env.PORT ?? 54321);
const POSTGREST_URL = new URL(process.env.POSTGREST_URL ?? 'http://127.0.0.1:54322');
const JWT_SECRET = process.env.JWT_SECRET;
const STATIC_DIR = process.env.STATIC_DIR;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const signJwt = (claims) => sign(claims, JWT_SECRET);
const verifyJwt = (token) => verify(token, JWT_SECRET);

// Auth -----------------------------------------------------------------------

const refreshTokens = new Map(); // token -> user id

function toUser(row) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    user_metadata: row.raw_user_meta_data,
    app_metadata: { provider: 'email', providers: ['email'] },
    created_at: row.created_at,
  };
}

function session(row) {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600;
  const refresh = crypto.randomBytes(24).toString('hex');
  refreshTokens.set(refresh, row.id);
  return {
    access_token: signJwt({
      sub: row.id,
      role: 'authenticated',
      aud: 'authenticated',
      email: row.email,
      iat: now,
      exp: now + expiresIn,
    }),
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: refresh,
    user: toUser(row),
  };
}

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;

function checkPassword(password, stored) {
  const [salt] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt)), Buffer.from(stored));
}

const authError = (status, error_code, msg) => [status, { code: status, error_code, msg }];

async function handleAuth(req, route, body) {
  if (req.method === 'POST' && route === '/signup') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email || String(body.password ?? '').length < 6) {
      return authError(422, 'validation_failed', 'Password should be at least 6 characters.');
    }
    const client = await db.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning *',
        [email, body.data ?? {}],
      );
      await client.query('insert into auth.passwords (user_id, hash) values ($1, $2)', [
        rows[0].id,
        hashPassword(body.password),
      ]);
      await client.query('commit');
      return [200, session(rows[0])];
    } catch (e) {
      await client.query('rollback');
      if (e.code === '23505') return authError(422, 'user_already_exists', 'User already registered');
      throw e;
    } finally {
      client.release();
    }
  }

  if (req.method === 'POST' && route === '/token') {
    const grant = new URL(req.url, 'http://x').searchParams.get('grant_type');
    if (grant === 'password') {
      const { rows } = await db.query(
        'select u.*, p.hash from auth.users u join auth.passwords p on p.user_id = u.id where u.email = $1',
        [String(body.email ?? '').trim().toLowerCase()],
      );
      if (!rows[0] || !checkPassword(String(body.password ?? ''), rows[0].hash)) {
        return authError(400, 'invalid_credentials', 'Invalid login credentials');
      }
      return [200, session(rows[0])];
    }
    if (grant === 'refresh_token') {
      const userId = refreshTokens.get(body.refresh_token);
      if (!userId) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token');
      refreshTokens.delete(body.refresh_token);
      const { rows } = await db.query('select * from auth.users where id = $1', [userId]);
      return [200, session(rows[0])];
    }
  }

  if (route === '/user' && req.method === 'GET') {
    const claims = verifyJwt(req.headers.authorization?.replace(/^Bearer /i, ''));
    if (!claims?.sub) return authError(401, 'bad_jwt', 'invalid JWT');
    const { rows } = await db.query('select * from auth.users where id = $1', [claims.sub]);
    return rows[0] ? [200, toUser(rows[0])] : authError(404, 'user_not_found', 'User not found');
  }

  if (route === '/logout') return [204, null];

  return authError(404, 'not_found', `No mock for ${req.method} ${route}`);
}

// REST proxy -----------------------------------------------------------------

function proxyRest(req, res, route) {
  const target = new URL(route + new URL(req.url, 'http://x').search, POSTGREST_URL);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];
  const upstream = http.request(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: e.message }));
  });
  req.pipe(upstream);
}

// Static web app ---------------------------------------------------------------

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
};

function serveStatic(req, res) {
  if (!STATIC_DIR) {
    res.writeHead(404);
    return res.end();
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(STATIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// Server -----------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, content-profile',
};

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);

    if (pathname.startsWith('/rest/v1')) return proxyRest(req, res, pathname.slice('/rest/v1'.length) || '/');

    if (pathname.startsWith('/auth/v1')) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
        const [status, payload] = await handleAuth(req, pathname.slice('/auth/v1'.length), body);
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(payload === null ? undefined : JSON.stringify(payload));
      } catch (e) {
        console.error(e);
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 500, msg: e.message }));
      }
    }

    serveStatic(req, res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`gateway listening on http://127.0.0.1:${PORT}`));
