import crypto from 'node:crypto';

/** Signs an HS256 JWT, the same kind Supabase issues. */
export function signJwt(claims, secret) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  return `${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** Returns the claims of a valid, unexpired HS256 JWT, or null. */
export function verifyJwt(token, secret) {
  const [header, body, sig] = (token ?? '').split('.');
  if (!sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  return claims.exp > Date.now() / 1000 ? claims : null;
}
