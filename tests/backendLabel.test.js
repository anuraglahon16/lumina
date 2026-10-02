import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The backend label names what served the query.
 *
 * It named what was configured. `/health`, `/stats` and the eval report all
 * claimed `atlas-vector-search` while no `$vectorSearch` had ever run -
 * `nearestChunks` has no callers and the dense half of retrieval is a cosine
 * scan in this process, blended with BM25. The contract asks for the live name
 * precisely because "a recall number is not comparable without it", and recall@5
 * of 0.967 was earned by BM25 and an in-process scan, not by a vector index.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-backendlabel-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { configuredVectorBackend, retrievalBackend, noteRetrievalBackend } = await import('../src/agent/services/vectorStore.js');

test('configured and observed are different questions', () => {
  assert.equal(typeof configuredVectorBackend(), 'string');
  assert.equal(typeof retrievalBackend(), 'string');
});

test('before any retrieval the label says it has not been exercised', async () => {
  const fresh = await import(`../src/agent/services/vectorStore.js?fresh=${Date.now()}`);
  assert.match(fresh.retrievalBackend(), /unverified/, 'an unexercised claim must not read as fact');
});

test('once a retrieval runs, the label is what ran', () => {
  noteRetrievalBackend('hybrid-bm25-cosine');
  assert.equal(retrievalBackend(), 'hybrid-bm25-cosine');
});

test('a label of "none" is not treated as an observation', () => {
  // searchChunks returns backend 'none' when there is nothing to search; that is
  // the absence of a retrieval, not evidence about how one would be served.
  const before = retrievalBackend();
  noteRetrievalBackend('none');
  assert.equal(retrievalBackend(), before);
});

test('health and stats report the observed backend, not the configured one', () => {
  for (const f of ['src/agent/routes/contract.js', 'src/agent/routes/observability.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /retrievalBackend\(\)/, `${f} must report the observed backend`);
    assert.ok(!/vectorStore: configuredVectorBackend\(\)|vector_backend: configuredVectorBackend\(\)/.test(src),
      `${f} must not report the configured value as fact`);
  }
});

test('retrieval reports the dense path it actually used', () => {
  // Pinned against the source so that wiring $vectorSearch in later must also
  // change what the label says, rather than leaving the old claim behind.
  const src = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  assert.match(src, /backend = 'hybrid-bm25-cosine'/, 'the JS cosine path says so');
  assert.match(src, /noteRetrievalBackend\(backend\)/, 'and records it for health to read');
});
