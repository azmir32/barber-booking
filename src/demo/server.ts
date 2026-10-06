// A pretend Supabase that lives inside the page. The app's Supabase client
// sends its requests here instead of over the network, so the demo build is
// the real app, screen for screen, with no account or server behind it.
//
//   /auth/v1/*   sign up, sign in, refresh, sign out, user, password reset
//   /rest/v1/*   tables and booking functions (postgrest.ts, functions.ts)

import { insertRow, newId, now, PgError, resetTables, tables, transaction, type Row } from './db.ts';
import { callFunction } from './functions.ts';
import { handleRest, type Caller } from './postgrest.ts';
import { DEMO_BARBER_EMAIL, DEMO_CUSTOMER_EMAIL, DEMO_PASSWORD } from './seed.ts';

export { DEMO_BARBER_EMAIL, DEMO_CUSTOMER_EMAIL, DEMO_PASSWORD };

export const DEMO_URL = 'https://demo.potongku.invalid';
export const DEMO_ANON_KEY = 'demo-anon-key';
/** No email is sent in the demo, so password reset takes this code. */
export const DEMO_RESET_CODE = '123456';

// Tokens -----------------------------------------------------------------------

function base64url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(part: string): string {
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Shaped like a Supabase JWT so the client can read it; there is nothing to sign. */
function accessToken(user: Row, issuedAt: number) {
  const claims = {
    sub: user.id,
    role: 'authenticated',
    aud: 'authenticated',
    email: user.email,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.demo`;
}

function callerFrom(headers: Headers): Caller {
  const token = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  try {
    const sub = (JSON.parse(fromBase64url(token.split('.')[1] ?? '')) as { sub?: string }).sub;
    if (sub && tables().users.some((u) => u.id === sub)) return { uid: sub };
  } catch {
    // The anon key, or a token from before a reset.
  }
  return { uid: null };
}

function toUser(row: Row) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    email_confirmed_at: row.created_at,
    user_metadata: row.user_metadata ?? {},
    app_metadata: { provider: 'email', providers: ['email'] },
    created_at: row.created_at,
    updated_at: row.created_at,
  };
}

function session(user: Row) {
  const issuedAt = Math.floor(now() / 1000);
  return {
    access_token: accessToken(user, issuedAt),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: issuedAt + 3600,
    refresh_token: `${String(user.id)}.${newId()}`,
    user: toUser(user),
  };
}

// Responses ------------------------------------------------------------------

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function toResponse({ status, body, headers }: Reply, method: string): Response {
  const empty = body === undefined || status === 204 || method === 'HEAD';
  return new Response(empty ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const authError = (status: number, code: string, msg: string): Reply => ({
  status,
  body: { code: status, error_code: code, msg },
});

// Auth -------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const recoveryRequested = new Set<string>();
const findUser = (email: unknown) =>
  tables().users.find((u) => u.email === String(email ?? '').trim().toLowerCase());

function handleAuth(method: string, route: string, url: URL, headers: Headers, body: Row): Reply {
  if (method === 'POST' && route === '/signup') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) {
      return authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    }
    if (String(body.password ?? '').length < 6) {
      return authError(422, 'weak_password', 'Password should be at least 6 characters.');
    }
    if (findUser(email)) return authError(422, 'user_already_exists', 'User already registered');
    const user = transaction(() =>
      insertRow('users', { email, password: String(body.password), user_metadata: body.data ?? {} }),
    );
    return { status: 200, body: session(user) };
  }

  if (method === 'POST' && route === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const user = findUser(body.email);
      if (!user || user.password !== String(body.password ?? '')) {
        return authError(400, 'invalid_credentials', 'Invalid login credentials');
      }
      return { status: 200, body: session(user) };
    }
    if (grant === 'refresh_token') {
      const userId = String(body.refresh_token ?? '').split('.')[0];
      const user = tables().users.find((u) => u.id === userId);
      if (!user) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      return { status: 200, body: session(user) };
    }
  }

  if (method === 'POST' && route === '/logout') return { status: 204 };

  // Like Supabase, answers the same whether or not the email has an account.
  if (method === 'POST' && route === '/recover') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    if (findUser(email)) recoveryRequested.add(email);
    return { status: 200, body: {} };
  }

  if (method === 'POST' && route === '/verify' && body.type === 'recovery') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const user = findUser(email);
    if (!user || !recoveryRequested.has(email) || String(body.token ?? '').trim() !== DEMO_RESET_CODE) {
      return authError(403, 'otp_expired', 'Token has expired or is invalid');
    }
    recoveryRequested.delete(email);
    return { status: 200, body: session(user) };
  }

  if (route === '/user' && (method === 'GET' || method === 'PUT')) {
    const { uid } = callerFrom(headers);
    const user = tables().users.find((u) => u.id === uid);
    if (!user) return authError(401, 'bad_jwt', 'invalid JWT');
    if (method === 'PUT' && body.password !== undefined) {
      if (String(body.password).length < 6) {
        return authError(422, 'weak_password', 'Password should be at least 6 characters.');
      }
      if (String(body.password) === user.password) {
        return authError(422, 'same_password', 'New password should be different from the old password.');
      }
      transaction(() => {
        tables().users.find((u) => u.id === uid)!.password = String(body.password);
      });
    }
    return { status: 200, body: toUser(tables().users.find((u) => u.id === uid)!) };
  }

  return authError(404, 'not_found', `The demo can't do ${method} ${route} yet.`);
}

// The fetch the Supabase client uses --------------------------------------------

/** In the browser, pause briefly like a real network so loading states show. */
const latency = () =>
  new Promise((resolve) => setTimeout(resolve, typeof window === 'undefined' ? 0 : 80 + Math.random() * 120));

export async function demoFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  await latency();
  let body: unknown;
  try {
    body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined;
  } catch {
    return toResponse({ status: 400, body: { code: 'PGRST102', message: 'Empty or invalid json' } }, method);
  }

  try {
    if (url.pathname.startsWith('/auth/v1/')) {
      return toResponse(
        handleAuth(method, url.pathname.slice('/auth/v1'.length), url, headers, (body ?? {}) as Row),
        method,
      );
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      const caller = callerFrom(headers);
      const path = url.pathname.slice('/rest/v1/'.length);
      const reply = transaction(() =>
        path.startsWith('rpc/')
          ? callFunction(path.slice(4), (body ?? {}) as Record<string, unknown>, caller)
          : handleRest(method, decodeURIComponent(path), url.searchParams, headers, body, caller),
      );
      return toResponse(reply, method);
    }
    return toResponse({ status: 404, body: { message: `Nothing at ${url.pathname} in the demo.` } }, method);
  } catch (e) {
    if (e instanceof PgError) {
      return toResponse(
        { status: e.status ?? 400, body: { code: e.code, message: e.message, details: e.details, hint: e.hint } },
        method,
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return toResponse({ status: 500, body: { code: 'XX000', message, details: null, hint: null } }, method);
  }
}

/** Puts every shop, booking and account back the way the demo started. */
export function resetDemo() {
  resetTables();
}

// Session storage that never throws, for browsers that block localStorage.
const memory = new Map<string, string>();
export const demoStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // Kept in memory instead.
    }
  },
  removeItem(key: string) {
    memory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing stored.
    }
  },
};
