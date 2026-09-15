import crypto from 'node:crypto';
import { config } from '../../shared/config.js';

/**
 * A shared-password gate for demo deployments.
 *
 * The gateway has identity but no authentication (see identity.js): a caller
 * picks its own user id, so an open deployment lets anyone spend the operator's
 * model credits. This middleware is the minimum that makes a public URL safe to
 * hand out: one password, over HTTP Basic so the browser handles the prompt and
 * replays the credential on API and SSE requests without any UI change.
 *
 * It is deliberately not a login system. Real multi-user auth belongs in
 * identity.js, where everything downstream already keys off req.userId.
 *
 * Disabled when DEMO_PASSWORD is unset, so local development is unaffected.
 */

const REALM = 'LUMINA';
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;

// Compared as digests so the comparison is timing-safe regardless of length.
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

const failures = new Map();

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.first > LOCKOUT_WINDOW_MS) {
    failures.set(ip, { count: 1, first: now });
    return;
  }
  entry.count += 1;
}

function lockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOCKOUT_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= LOCKOUT_THRESHOLD;
}

/** Credentials may arrive as `Basic base64(user:pass)`; the username is ignored. */
function presentedPassword(req) {
  const header = req.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (!/^basic$/i.test(scheme || '') || !encoded) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return idx === -1 ? decoded : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

export function demoAuth(log) {
  const expected = config.gateway.demoPassword;
  if (!expected) return (req, res, next) => next();

  const expectedDigest = digest(expected);

  return (req, res, next) => {
    // Health stays open so platform and container health checks still pass.
    if (req.path === '/health') return next();

    const ip = req.ip || 'unknown';

    if (lockedOut(ip)) {
      res.set('retry-after', String(Math.ceil(LOCKOUT_WINDOW_MS / 1000)));
      return res.status(429).json({
        error: { code: 'too_many_attempts', message: 'Too many failed password attempts. Try again later.' },
      });
    }

    const presented = presentedPassword(req);
    if (presented !== null && crypto.timingSafeEqual(digest(presented), expectedDigest)) {
      failures.delete(ip);
      return next();
    }

    if (presented !== null) {
      recordFailure(ip);
      log?.warn('demo_auth_failed', { request_id: req.requestId, ip, path: req.path });
    }

    res.set('www-authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    return res.status(401).json({
      error: { code: 'unauthorized', message: 'This LUMINA deployment is password protected.' },
    });
  };
}
