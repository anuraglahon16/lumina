import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Two tiers, and the durable one has to actually be written.
 *
 * It never was. The spec names a `searchCache` collection with a TTL index;
 * `grep -rn searchCache src` found only a statistics label. The real cache was an
 * in-process Map plus an optional *disk* tier, so every restart and every
 * redeploy paid full price for questions already answered, and a second machine
 * shared nothing.
 *
 * Read order is LRU, then the collection, then the provider. A hit in the
 * collection fills the LRU on the way back. Nothing empty or failed is ever
 * written to either.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-searchtiers-'));
const MONGO = process.env.TEST_MONGODB_URI || '';
process.env.MONGODB_URI = MONGO;
process.env.MONGODB_DB = `lumina_sctest_${Date.now().toString(36)}`;
process.env.CACHE_ENABLED = 'true';

const { searchCacheId, readSearchCache, writeSearchCache, clearSearchCache } = await import('../src/agent/services/search/searchCache.js');
const { searchCacheKey } = await import('../src/agent/services/search/index.js');

const results = [{ url: 'https://example.test/a', title: 'A', snippet: 'alpha' }];

test('the key is sha256 of the normalised query and the provider, provider explicit', () => {
  const q = searchCacheKey('What is Reciprocal Rank Fusion?');
  const a = searchCacheId(q, 'tavily');
  const b = searchCacheId(q, 'serpapi');
  assert.equal(a.length, 64, 'sha256 hex');
  assert.notEqual(a, b, 'two providers answering one question are two rows');
  assert.equal(a, searchCacheId(q, 'tavily'), 'and it is stable');
});

test('a differently phrased question shares the key', () => {
  // The normaliser is what makes the cache worth having; keying the raw string
  // made one question three paid searches.
  assert.equal(
    searchCacheId(searchCacheKey('what is reciprocal rank fusion'), 'tavily'),
    searchCacheId(searchCacheKey('What is reciprocal rank fusion?'), 'tavily'),
  );
});

test('the durable tier survives an LRU that has forgotten everything', async (t) => {
  if (!MONGO) return t.skip('set TEST_MONGODB_URI to exercise the durable tier');
  await clearSearchCache();
  const id = searchCacheId(searchCacheKey('durable tier probe'), 'tavily');
  assert.equal(await writeSearchCache({ id, provider: 'tavily', query: 'durable tier probe', results, ttlMs: 60_000 }), true);

  // A fresh import is a fresh process as far as the in-memory tier is concerned.
  const fresh = await import(`../src/agent/services/search/searchCache.js?restart=${Date.now()}`);
  const hit = await fresh.readSearchCache(id);
  assert.ok(hit, 'the row outlived the process that wrote it');
  assert.equal(hit.provider, 'tavily');
  assert.deepEqual(hit.results, results);
});

test('the stored row matches SearchCacheDoc field for field', async (t) => {
  if (!MONGO) return t.skip('needs Mongo');
  const id = searchCacheId(searchCacheKey('shape probe'), 'tavily');
  await writeSearchCache({ id, provider: 'tavily', query: 'shape probe', results, ttlMs: 60_000 });
  const doc = await readSearchCache(id);
  assert.deepEqual(Object.keys(doc).sort(), ['_id', 'createdAt', 'expiresAt', 'provider', 'query', 'results'].sort());
  assert.equal(doc._id, id, '_id is the hash, as the contract says');
  assert.ok(!Number.isNaN(Date.parse(doc.expiresAt)), 'expiresAt is an ISO date');
});

test('an expired row is not served, even before the TTL sweep runs', async (t) => {
  if (!MONGO) return t.skip('needs Mongo');
  const id = searchCacheId(searchCacheKey('expiry probe'), 'tavily');
  // Mongo sweeps roughly once a minute, so a row can outlive its own expiry.
  // Trusting the index alone would serve it; the code checks too.
  await writeSearchCache({ id, provider: 'tavily', query: 'expiry probe', results, ttlMs: -1000 });
  assert.equal(await readSearchCache(id), null, 'a lapsed row is a miss, not a hit');
});

test('nothing empty or failed is ever written', async (t) => {
  if (!MONGO) return t.skip('needs Mongo');
  const id = searchCacheId(searchCacheKey('empty probe'), 'tavily');
  assert.equal(await writeSearchCache({ id, provider: 'tavily', query: 'empty probe', results: [], ttlMs: 60_000 }), false);
  assert.equal(await readSearchCache(id), null, 'a failed search must not be memoised');
});

test('searchCached is false when any search in the request missed', async () => {
  // The per-request flag lives in the contract mapper: it starts unset, is ANDed
  // with every web_search result, and a single miss makes the answer uncached.
  const { contractStream } = await import('../src/gateway/contract/events.js');
  const frames = [];
  const emit = contractStream({ send: (event, data) => frames.push({ event, data }), depth: 'quick', answerId: 'a' });

  emit('tool_call', { tool: 'web_search', input: { query: 'one' } });
  emit('tool_result', { tool: 'web_search', ok: true, cached: true });
  emit('tool_call', { tool: 'web_search', input: { query: 'two' } });
  emit('tool_result', { tool: 'web_search', ok: true, cached: false });
  emit('sources', { sources: [] });
  emit('done', {});

  const done = frames.find((f) => f.event === 'done').data;
  assert.equal(done.searchCached, false, 'one miss means the request was not served from cache');
});

test('searchCached is true only when every search hit', async () => {
  const { contractStream } = await import('../src/gateway/contract/events.js');
  const frames = [];
  const emit = contractStream({ send: (event, data) => frames.push({ event, data }), depth: 'quick', answerId: 'a' });
  emit('tool_call', { tool: 'web_search', input: { query: 'one' } });
  emit('tool_result', { tool: 'web_search', ok: true, cached: true });
  emit('tool_call', { tool: 'web_search', input: { query: 'two' } });
  emit('tool_result', { tool: 'web_search', ok: true, cached: true });
  emit('sources', { sources: [] });
  emit('done', {});
  assert.equal(frames.find((f) => f.event === 'done').data.searchCached, true);
});

test.after(async () => {
  if (!MONGO) return;
  const { MongoClient } = await import('mongodb');
  const c = new MongoClient(MONGO);
  await c.connect();
  await c.db(process.env.MONGODB_DB).dropDatabase();
  await c.close();
});
