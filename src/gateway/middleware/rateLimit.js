import { config } from '../../shared/config.js';
import { tooManyRequests } from '../../shared/errors.js';

/**
 * Per-user token buckets. Separate buckets per class because the costs differ by
 * orders of magnitude: a Deep Search is minutes of compute and dozens of model
 * calls, a thread listing is a map lookup.
 */
class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    // Whether limits are set correctly is an empirical question, so the
    // limiter counts what it does instead of only reporting it per response.
    this.stats = { allowed: 0, blocked: 0 };
    const sweep = setInterval(() => this.#sweep(), 10 * 60 * 1000);
    sweep.unref?.();
  }

  #sweep() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(key);
  }

  take(key, cost = 1) {
    const now = Date.now();
    const bucket = this.buckets.get(key) || { tokens: this.capacity, updated: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.updated) / 1000) * this.refillPerSec);
    bucket.updated = now;

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      this.stats.blocked += 1;
      const deficit = cost - bucket.tokens;
      return { allowed: false, retryAfterSec: Math.ceil(deficit / this.refillPerSec), remaining: 0 };
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    this.stats.allowed += 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
  }
}

const buckets = Object.fromEntries(
  Object.entries(config.gateway.rateLimits).map(([name, limits]) => [name, new TokenBucket(limits)]),
);

/**
 * Charge one identity issuance against the caller's address. Signed identity
 * stops impersonation; this stops the cheaper attack of simply asking for a new
 * identity on every request to reset a per-user limit.
 */
export function takeIdentityIssuance(addressKey) {
  const bucket = buckets.identity;
  if (!bucket) return { allowed: true, retryAfterSec: 0, remaining: 0 };
  return bucket.take(`identity:${addressKey}`, 1);
}

/** Per-class allowed/blocked counts, plus how many distinct keys are tracked. */
export function rateLimitStats() {
  return Object.fromEntries(
    Object.entries(buckets).map(([name, b]) => [
      name,
      {
        capacity: b.capacity,
        refill_per_sec: b.refillPerSec,
        allowed: b.stats.allowed,
        blocked: b.stats.blocked,
        block_rate: b.stats.allowed + b.stats.blocked ? Number((b.stats.blocked / (b.stats.allowed + b.stats.blocked)).toFixed(3)) : null,
        tracked_keys: b.buckets.size,
      },
    ]),
  );
}

export function rateLimit(className, cost = 1) {
  return (req, res, next) => {
    const bucket = buckets[className];
    if (!bucket) return next();
    const key = `${className}:${req.userId}`;
    const result = bucket.take(key, cost);

    res.set('x-ratelimit-limit', String(bucket.capacity));
    res.set('x-ratelimit-remaining', String(result.remaining));
    res.set('x-ratelimit-class', className);

    if (!result.allowed) {
      res.set('retry-after', String(result.retryAfterSec));
      return next(
        tooManyRequests(`Rate limit reached for ${className} requests. Retry in ${result.retryAfterSec}s.`, {
          class: className,
          retry_after_s: result.retryAfterSec,
        }),
      );
    }
    next();
  };
}

/** Deep Search costs more than one token; classes let us price per route. */
export const rateLimitFor = (req) => (req.body?.mode === 'deep' ? 'deep' : 'quick');
