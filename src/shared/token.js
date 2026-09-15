import crypto from 'node:crypto';

/**
 * Minimal signed tokens (JWT-shaped, HS256).
 *
 * Written against node:crypto rather than a JWT library on purpose: the project
 * keeps its dependency list short, and the surface needed here is one algorithm
 * with no key negotiation. HS256 with a rejected `alg` field closes the
 * algorithm-confusion hole that makes hand-rolled JWT verification risky.
 *
 * This proves *which id a bearer was issued*, not who a person is. That is
 * exactly what the rate limiter needs: without a signature, `x-user-id` is a
 * free-form string and every limit resets on a header change.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (str) => Buffer.from(str, 'base64url');

const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/**
 * @param {object} claims payload claims; `sub` is the user id
 * @param {string} secret signing secret
 * @param {number} ttlSeconds lifetime; 0 means no expiry
 */
export function signToken(claims, secret, ttlSeconds = 0) {
  if (!secret) throw new Error('signToken requires a secret');
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now };
  if (ttlSeconds > 0) payload.exp = now + ttlSeconds;
  const body = `${HEADER}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(hmac(secret, body))}`;
}

/**
 * @returns {{ valid: true, claims: object } | { valid: false, reason: string }}
 */
export function verifyToken(token, secret) {
  if (!secret) return { valid: false, reason: 'no_secret' };
  if (typeof token !== 'string') return { valid: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [header, payload, signature] = parts;

  // Reject the algorithm the token claims rather than trusting it. A token
  // asking for "none" or a different alg must never be honoured.
  let parsedHeader;
  try {
    parsedHeader = JSON.parse(unb64url(header).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (parsedHeader?.alg !== 'HS256') return { valid: false, reason: 'bad_algorithm' };

  const expected = hmac(secret, `${header}.${payload}`);
  const actual = unb64url(signature);
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims;
  try {
    claims = JSON.parse(unb64url(payload).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (claims.exp && Math.floor(Date.now() / 1000) >= claims.exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
