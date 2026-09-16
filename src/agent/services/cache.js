import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { cacheKey } from '../../shared/ids.js';

/**
 * TTL + LRU cache with an optional disk tier. Search results and fetched pages
 * are the expensive, repeatable things in this system, so both go through here
 * and every lookup is reported to the run recorder as hit/miss/write.
 */
class Cache {
  constructor({ maxEntries, dir }) {
    this.maxEntries = maxEntries;
    this.dir = dir;
    this.mem = new Map(); // insertion order doubles as the LRU list
    this.stats = { hits: 0, misses: 0, writes: 0, evictions: 0, expired: 0 };

    // The disk tier is an optimisation, not a requirement, so a filesystem that
    // refuses to be written to costs the tier rather than the service. A
    // serverless bundle is read-only apart from /tmp, and creating this
    // directory at import time took the whole function down on first request.
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.diskEnabled = true;
    } catch {
      this.diskEnabled = false;
    }
  }

  #diskPath(key) {
    return path.join(this.dir, `${key.replace(/[^a-z0-9]+/gi, '_')}.json`);
  }

  #touch(key, entry) {
    this.mem.delete(key);
    this.mem.set(key, entry);
  }

  #evict() {
    while (this.mem.size > this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      this.mem.delete(oldest);
      this.stats.evictions += 1;
    }
  }

  async get(key) {
    const now = Date.now();
    const hit = this.mem.get(key);
    if (hit) {
      if (hit.expires_at > now) {
        this.#touch(key, hit);
        this.stats.hits += 1;
        return { value: hit.value, tier: 'memory', age_ms: now - hit.stored_at };
      }
      this.mem.delete(key);
      this.stats.expired += 1;
    }
    // Disk tier survives restarts, which matters for cost during development.
    // Skipped where the filesystem refused to be written to at all.
    try {
      if (!this.diskEnabled) throw new Error('disk tier disabled');
      const raw = await fsp.readFile(this.#diskPath(key), 'utf8');
      const entry = JSON.parse(raw);
      if (entry.expires_at > now) {
        this.mem.set(key, entry);
        this.#evict();
        this.stats.hits += 1;
        return { value: entry.value, tier: 'disk', age_ms: now - entry.stored_at };
      }
      this.stats.expired += 1;
      await fsp.unlink(this.#diskPath(key)).catch(() => {});
    } catch {
      /* cache miss */
    }
    this.stats.misses += 1;
    return null;
  }

  async set(key, value, ttlMs) {
    const entry = { key, value, stored_at: Date.now(), expires_at: Date.now() + ttlMs };
    this.mem.set(key, entry);
    this.#evict();
    this.stats.writes += 1;
    await fsp.writeFile(this.#diskPath(key), JSON.stringify(entry)).catch(() => {});
  }

  summary() {
    const total = this.stats.hits + this.stats.misses;
    return { ...this.stats, entries: this.mem.size, hit_rate: total ? Number((this.stats.hits / total).toFixed(3)) : null };
  }
}

export const cache = new Cache({
  maxEntries: config.cache.maxEntries,
  dir: config.cache.dir || path.join(config.agent.dataDir, 'cache'),
});

/**
 * Memoize an async producer. `recorder` (optional) gets the hit/miss so the run
 * log can show cache behaviour per namespace.
 *
 * `shouldCache` guards against poisoning: a failed fetch or an empty search
 * result must not be served for the next half hour. Transient failures are the
 * exact thing you least want to memoize.
 */
export async function cached(namespace, keyPayload, ttlMs, producer, recorder, shouldCache = () => true) {
  if (!config.cache.enabled) return { value: await producer(), cached: false };
  const key = cacheKey(namespace, keyPayload);
  const hit = await cache.get(key);
  if (hit) {
    recorder?.recordCache({ namespace, hit: true });
    return { value: hit.value, cached: true, tier: hit.tier, age_ms: hit.age_ms };
  }
  recorder?.recordCache({ namespace, hit: false });
  const value = await producer();
  if (shouldCache(value)) {
    await cache.set(key, value, ttlMs);
    recorder?.recordCache({ namespace, write: true });
  }
  return { value, cached: false };
}
