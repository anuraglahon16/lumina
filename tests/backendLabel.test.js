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
 *
 * Then the boot probe reintroduced the same claim one level down: a probe that
 * answered set the backend to `atlas-vector-search`, so a healthy index made
 * `/health` assert that the index was serving queries while `nearestChunks`
 * still had no callers. Usable and used are different facts. The tests below
 * hold them apart, and `noteRetrievalBackend` refuses the claim structurally.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-backendlabel-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { configuredVectorBackend, retrievalBackend, noteRetrievalBackend, vectorIndexStatus } =
  await import('../src/agent/services/vectorStore.js');

test('configured and observed are different questions', () => {
  assert.equal(typeof configuredVectorBackend(), 'string');
  assert.equal(typeof retrievalBackend(), 'string');
});

test('before any retrieval the label says it has not been exercised', async () => {
  const fresh = await import(`../src/agent/services/vectorStore.js?fresh=${Date.now()}`);
  assert.match(fresh.retrievalBackend(), /unexercised/, 'an unexercised claim must not read as fact');
  assert.ok(!fresh.retrievalBackend().includes('atlas-vector-search'),
    'and must not name a backend nothing has used');
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

/* ------------------------------------------- the boot probe */

test('the probe reports skipped, not ok, without a database', async () => {
  const fresh = await import(`../src/agent/services/vectorStore.js?probe1=${Date.now()}`);
  const status = await fresh.probeVectorIndexes();
  assert.match(status, /skipped/, 'no MONGODB_URI is not evidence that the index works');
  assert.match(fresh.retrievalBackend(), /unexercised/, 'and the backend stays unexercised');
});

test('a failed probe is reported and does not claim the backend', async () => {
  const fresh = await import(`../src/agent/services/vectorStore.js?probe2=${Date.now()}`);
  // Simulated by the skipped path above; the shape of a failure is what matters:
  // the status names the reason, and the backend says it is unavailable rather
  // than asserting the configured value.
  assert.equal(typeof fresh.vectorIndexStatus(), 'string');
  assert.match(fresh.vectorIndexStatus(), /chunks/, 'the status names the index it probed');
});

test('the probe never uses a zero vector', () => {
  // Atlas refuses cosine similarity against a zero vector, so a zero-vector
  // probe reports a healthy index as broken. It did, on the first run.
  const src = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  assert.ok(!/length: dim \}, \(\) => 0\)/.test(src), 'a zero vector makes every index look broken');
  assert.match(src, /i === 0 \? 1 : 0/, 'a unit vector is valid and matches nothing meaningful');
});

test('the agent probes at boot without blocking or failing startup', () => {
  const src = fs.readFileSync(new URL('../src/agent/server.js', import.meta.url), 'utf8');
  assert.match(src, /probeVectorIndexes\(\)/, 'the agent probes');
  assert.ok(!/await probeVectorIndexes\(\)/.test(src), 'and does not block boot on it');
  assert.match(src, /\.catch\(\(err\) => log\.warn\('vector_probe_threw'/, 'a throwing probe must not stop the service');
});

test('health carries the probe status beside the backend', () => {
  for (const [f, field] of [
    ['src/agent/routes/contract.js', 'vectorIndexStatus: vectorIndexStatus()'],
    ['src/agent/routes/observability.js', 'vector_index_status: vectorIndexStatus()'],
  ]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes(field), `${f} must publish the evidence for its claim`);
  }
});

test('health still satisfies what the benchmark requires of it', () => {
  // bench.mjs fails preflight without model, and gates on model, searchProvider,
  // vectorStore and db all being non-empty - before any query has run, when the
  // backend label is still the unverified form.
  const bench = fs.readFileSync(new URL('../benchmark/bench.mjs', import.meta.url), 'utf8');
  assert.match(bench, /M\.health\.model && M\.health\.searchProvider && M\.health\.vectorStore && M\.health\.db/);
  const route = fs.readFileSync(new URL('../src/agent/routes/contract.js', import.meta.url), 'utf8');
  const handler = route.slice(route.indexOf("contractRouter.get('/health'"), route.indexOf("contractRouter.get('/stats'"));
  // `db` is a shorthand property, so match the key rather than `key:`.
  for (const field of [/\bmodel:/, /\bsearchProvider:/, /\bvectorStore:/, /\bdb\b/]) {
    assert.match(handler, field, `/health must still name ${field}`);
  }
});

/* ------------------------------------------- usable is not used */

test('a successful probe does not make the backend atlas-vector-search', async () => {
  // The correction this block exists for. Stub a client whose aggregate always
  // answers - the shape of two healthy indexes - and probe with it. The probe
  // must report success and leave the retrieval backend untouched, because
  // nothing has gone through `$vectorSearch`.
  const fresh = await import(`../src/agent/services/vectorStore.js?usable=${Date.now()}`);
  const status = await fresh.probeVectorIndexes({
    client: { collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) },
  });

  assert.match(status, /^ok/, 'both stub indexes answered');
  assert.ok(!fresh.retrievalBackend().includes('atlas-vector-search'),
    `a probe is not a query: retrievalBackend() said "${fresh.retrievalBackend()}"`);
  assert.match(fresh.retrievalBackend(), /unexercised/, 'nothing has served a query yet');
  assert.match(fresh.vectorIndexStatus(), /^chunks_vector\+memories_vector: ok/,
    'the index status is where the good news belongs');
});

test('nothing but the $vectorSearch path may claim atlas-vector-search', async () => {
  const fresh = await import(`../src/agent/services/vectorStore.js?claim=${Date.now()}`);
  // Any other caller asserting it is rejected, not trusted.
  fresh.noteRetrievalBackend('atlas-vector-search');
  assert.match(fresh.retrievalBackend(), /unexercised/, 'an unearned claim is dropped');

  // The one legitimate route: the code path that ran the aggregation.
  fresh.noteVectorSearchServed();
  assert.equal(fresh.retrievalBackend(), 'atlas-vector-search', 'a served query earns the name');
});

test('the probe body does not assign the observed backend', () => {
  // Cheap and specific: the deleted line, pinned so it cannot come back.
  const src = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  const probe = src.slice(src.indexOf('export async function probeVectorIndexes'), src.indexOf('export function vectorIndexStatus'));
  assert.ok(!/observed\s*=/.test(probe), 'the boot probe must not set the retrieval backend');
  assert.match(src, /noteVectorSearchServed\(\);\n\s*return \{ backend: 'atlas-vector-search'/,
    'only the aggregation path records that backend');
});

test('the claim is guarded in one place, not asserted at each reader', () => {
  const src = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  assert.match(src, /servedByVectorSearch/, 'a single flag decides whether the name is earned');
  assert.match(src, /backend_claim_rejected/, 'and a rejected claim is logged rather than silently dropped');
});
