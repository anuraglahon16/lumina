import { HttpError } from './errors.js';

/**
 * Circuit breaker: closed, open, half-open.
 *
 * The SDK already retries transient failures, and retrying is the right move
 * for a blip. It is the wrong move for a dependency that is actually down: the
 * retries themselves become the load, every caller waits the full timeout, and
 * a Deep Search with five parallel branches eats five of them before failing.
 *
 * So this sits above retry rather than replacing it. Once a dependency has
 * failed repeatedly it fails fast, with a reason, until a single probe shows it
 * is back.
 *
 * The distinction that makes it safe is `countsAsFailure`. A 400 caused by a
 * malformed request says nothing about the dependency's health, and letting one
 * bad request trip a shared breaker would take the system down on our own bug.
 * Only faults attributable to the dependency count.
 */

const registry = new Map();

export class CircuitBreaker {
  /**
   * @param {string} name identifies this breaker in health output
   * @param {object} opts
   * @param {number} opts.failureThreshold consecutive dependency faults before opening
   * @param {number} opts.cooldownMs how long to stay open before probing
   * @param {(err: unknown) => boolean} opts.countsAsFailure dependency fault vs caller fault
   */
  constructor(name, { failureThreshold = 5, cooldownMs = 30000, countsAsFailure = () => true } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.countsAsFailure = countsAsFailure;

    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.probeInFlight = false;
    this.stats = { rejected: 0, opened: 0, recovered: 0 };
  }

  get retryAfterMs() {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - Date.now());
  }

  /** Move open to half-open once the cooldown has elapsed. */
  #refresh() {
    if (this.state === 'open' && this.retryAfterMs === 0) {
      this.state = 'half_open';
      this.probeInFlight = false;
    }
  }

  #open(err) {
    if (this.state !== 'open') this.stats.opened += 1;
    this.state = 'open';
    this.openedAt = Date.now();
    this.lastError = err?.message ? String(err.message).slice(0, 200) : String(err || 'unknown');
  }

  #close() {
    if (this.state !== 'closed') this.stats.recovered += 1;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = null;
    this.lastError = null;
    this.probeInFlight = false;
  }

  /**
   * Run `fn` under the breaker.
   * @throws {HttpError} 503 without calling `fn` when the circuit is open.
   */
  async run(fn) {
    this.#refresh();

    // Half-open admits exactly one probe; the rest keep failing fast so a
    // recovering dependency is not immediately flooded.
    if (this.state === 'open' || (this.state === 'half_open' && this.probeInFlight)) {
      this.stats.rejected += 1;
      throw new HttpError(
        503,
        'circuit_open',
        `${this.name} is failing and calls are paused for ${Math.ceil(this.retryAfterMs / 1000)}s. Last error: ${this.lastError}`,
        { circuit: this.name, retry_after_ms: this.retryAfterMs, last_error: this.lastError },
      );
    }

    const probing = this.state === 'half_open';
    if (probing) this.probeInFlight = true;

    try {
      const result = await fn();
      this.#close();
      return result;
    } catch (err) {
      if (!this.countsAsFailure(err)) {
        // A caller fault leaves the breaker exactly as it was: it is evidence
        // about the request, not about the dependency.
        if (probing) this.probeInFlight = false;
        throw err;
      }
      this.failures += 1;
      // A failed probe reopens immediately; there is no point waiting for the
      // threshold again when the dependency just proved it is still down.
      if (probing || this.failures >= this.failureThreshold) this.#open(err);
      throw err;
    }
  }

  snapshot() {
    this.#refresh();
    return {
      state: this.state,
      failures: this.failures,
      threshold: this.failureThreshold,
      retry_after_ms: this.retryAfterMs,
      last_error: this.lastError,
      ...this.stats,
    };
  }
}

/** Named breakers, so health can report every one without threading references. */
export function breaker(name, opts) {
  if (!registry.has(name)) registry.set(name, new CircuitBreaker(name, opts));
  return registry.get(name);
}

/** Only breakers that are not healthy, plus a count, to keep /health readable. */
export function breakerReport() {
  const all = [...registry.values()];
  const unhealthy = all.filter((b) => b.snapshot().state !== 'closed');
  return {
    tracked: all.length,
    open: unhealthy.length,
    ...(unhealthy.length ? { circuits: Object.fromEntries(unhealthy.map((b) => [b.name, b.snapshot()])) } : {}),
  };
}

/** Test seam: drop all registered breakers. */
export function resetBreakers() {
  registry.clear();
}
