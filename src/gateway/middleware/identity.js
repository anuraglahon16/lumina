import { newId } from '../../shared/ids.js';
import { config } from '../../shared/config.js';
import { tooManyRequests } from '../../shared/errors.js';
import { signToken, verifyToken } from '../../shared/token.js';
import { takeIdentityIssuance } from './rateLimit.js';

const USER_COOKIE = 'lumina_uid';
const TOKEN_COOKIE = 'lumina_token';
/**
 * Identity can also travel in a header the page sends back itself.
 *
 * A cookie is the right default, but inside a cross-site frame browsers are
 * entitled to drop it however it is labelled, and then every request is a new
 * user: the thread you just created cannot be reopened, and your runs belong to
 * someone else. The page keeps the issued credential in localStorage (which
 * does survive there) and replays it on this header, so identity holds whether
 * or not the cookie makes it.
 *
 * Security is unchanged: in signed mode the value is the same signed token a
 * cookie would carry and is verified identically; in unsigned mode it is a bare
 * id, exactly as forgeable as the x-user-id header already is.
 */
const TOKEN_HEADER = 'x-lumina-token';
const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{3,64}$/;

/**
 * Every request gets a request id (for correlating gateway to agent to run log)
 * and a user id.
 *
 * Two modes, chosen by whether AUTH_SECRET is configured:
 *
 * Unsigned (no secret, the default for local development). The user id comes
 * from an explicit header for API clients, otherwise from a cookie the gateway
 * issues, so a browser user keeps their threads, memories, and documents
 * without signing in. Convenient, and trivially forgeable.
 *
 * Signed (AUTH_SECRET set). The id must arrive inside a token this gateway
 * signed, as `Authorization: Bearer` or a cookie; a bare `x-user-id` header is
 * ignored. This matters most for rate limiting: an unsigned id is a free-form
 * string, so every per-user limit resets when the caller changes one header.
 * Signing makes the limiter's key mean something.
 *
 * This is still identity rather than authentication of a person: the gateway
 * will mint an id for a new visitor. What it prevents is impersonating or
 * inventing ids at will. A deployment that needs real accounts replaces the
 * issuing step with a login and sets `req.userId` from the verified subject;
 * everything downstream already keys off `req.userId`.
 */
export function identity(req, res, next) {
  // A proxy may send x-request-id more than once, and Express joins repeated
  // headers with ", ". Taking the first value keeps the id a single token
  // instead of logging "abc123, abc123" and breaking correlation.
  req.requestId = (req.get('x-request-id') || '').split(',')[0].trim() || newId('req');
  res.set('x-request-id', req.requestId);

  const secret = config.gateway.authSecret;
  const cookies = parseCookies(req.get('cookie'));

  let userId = null;
  let issue = false;

  if (secret) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const presented = req.get(TOKEN_HEADER) || bearer || cookies[TOKEN_COOKIE];
    const result = verifyToken(presented, secret);
    if (result.valid && USER_ID_PATTERN.test(result.claims.sub || '')) {
      userId = result.claims.sub;
    } else {
      // An absent or unusable token means a new identity, not an error: the
      // gateway hands out ids, it just refuses to accept unsigned ones.
      userId = newId('usr');
      issue = true;
      req.identityRejected = presented ? result.reason : null;
    }
  } else {
    userId = req.get(TOKEN_HEADER) || req.get('x-user-id') || cookies[USER_COOKIE];
    if (!userId || !USER_ID_PATTERN.test(userId)) {
      userId = newId('usr');
      issue = true;
    }
  }

  if (issue) {
    const maxAge = 365 * 24 * 60 * 60 * 1000;
    if (secret) {
      // Signing stops one caller claiming another's id. On its own it does not
      // stop them discarding their token and asking for a fresh one on every
      // request, which resets every per-user limit, so issuance is charged
      // against the address.
      const issuance = takeIdentityIssuance(req.ip || 'unknown');
      if (!issuance.allowed) {
        res.set('retry-after', String(issuance.retryAfterSec));
        return next(
          tooManyRequests(`Too many new identities from this address. Retry in ${issuance.retryAfterSec}s.`, {
            class: 'identity',
            retry_after_s: issuance.retryAfterSec,
          }),
        );
      }
      const token = signToken({ sub: userId }, secret, config.gateway.authTtlSeconds);
      setCookie(req, res, TOKEN_COOKIE, token, maxAge);
      res.set(TOKEN_HEADER, token);
    } else {
      setCookie(req, res, USER_COOKIE, userId, maxAge);
      res.set(TOKEN_HEADER, userId);
    }
  }

  req.userId = userId;
  res.set('x-user-id', userId);
  next();
}

/**
 * SameSite=Lax is the right default: it keeps the cookie off cross-site
 * requests. But when a host page frames the app, every request from inside that
 * frame *is* cross-site, so Lax drops the cookie and the caller gets a fresh
 * identity each time: a question asked in the frame lands under one user and
 * the run list is read as another, so threads, memories and runs all look empty.
 *
 * Relaxing to None requires Secure, which requires HTTPS, so the check is made
 * per request rather than assumed. Over plain HTTP the cookie stays Lax, since
 * a Secure cookie there would simply be discarded.
 */
function setCookie(req, res, name, value, maxAgeMs) {
  const https = req.secure || req.get('x-forwarded-proto') === 'https';
  const crossSite = config.gateway.embedded && https;
  const sameSite = crossSite ? 'none' : 'lax';
  const attrs = { httpOnly: true, sameSite, secure: crossSite, maxAge: maxAgeMs, path: '/' };
  if (res.cookie) return res.cookie(name, value, attrs);
  res.setHeader(
    'set-cookie',
    `${name}=${value}; Path=/; HttpOnly; SameSite=${crossSite ? 'None; Secure' : 'Lax'}; Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  );
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
