import { createHash } from 'node:crypto';
import { mongoDb, mongoEnabled } from '../../store/mongo.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('searchcache');

/**
 * The durable half of the two-tier search cache.
 *
 * The in-process LRU is in services/cache.js and dies with the process. This is
 * the tier that survives a restart, a redeploy, and a second machine: a query
 * answered on one gateway is free on the next. Before this existed the
 * `searchCache` collection the spec names was never written at all — every
 * restart paid full price for questions already answered.
 *
 * Documents match `SearchCacheDoc` in packages/contract/src/db.ts field for
 * field, including `_id` as the hash and camelCase keys, which differ from the
 * snake_case the rest of this codebase uses. The contract wins where it speaks.
 */

const COLLECTION = 'searchCache';

/**
 * sha256 of the normalised query and the provider, with the provider explicit.
 *
 * Two providers answering the same question are two different answers, so they
 * are two different rows. Keying on the query alone would serve Tavily's results
 * as SerpAPI's.
 */
export function searchCacheId(normalizedQuery, provider) {
  return createHash('sha256').update(`${normalizedQuery}\u0000${provider}`).digest('hex');
}

async function col() {
  return (await mongoDb()).collection(COLLECTION);
}

/**
 * A live row, or null.
 *
 * `expiresAt` is checked here as well as by the TTL index. Mongo's sweep runs
 * about once a minute, so a row can outlive its own expiry by up to that long;
 * trusting the index alone would serve it.
 */
export async function readSearchCache(id) {
  if (!mongoEnabled()) return null;
  try {
    const doc = await (await col()).findOne({ _id: id });
    if (!doc) return null;
    if (!doc.expiresAt || Date.parse(doc.expiresAt) <= Date.now()) return null;
    return doc;
  } catch (err) {
    // A cache that cannot be read is a slow search, not a failed one.
    log.warn('search_cache_read_failed', { err: err.message });
    return null;
  }
}

/** Write through. Callers must not call this for an empty or failed search. */
export async function writeSearchCache({ id, provider, query, results, ttlMs }) {
  if (!mongoEnabled()) return false;
  if (!results?.length) return false;
  const now = new Date();
  const doc = {
    _id: id,
    provider,
    query,
    results,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    createdAt: now.toISOString(),
  };
  try {
    await (await col()).replaceOne({ _id: id }, doc, { upsert: true });
    return true;
  } catch (err) {
    log.warn('search_cache_write_failed', { err: err.message });
    return false;
  }
}

/** Only for tests that need a clean slate. */
export async function clearSearchCache() {
  if (!mongoEnabled()) return 0;
  const res = await (await col()).deleteMany({});
  return res.deletedCount ?? 0;
}
