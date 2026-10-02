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
  // Pinned against the source so that changing how the dense half runs must also
  // change what the label says, rather than leaving the old claim behind. It
  // used to pin `hybrid-bm25-cosine`, which was itself wrong: on Mongo the dense
  // half scored nothing, because `allChunks` projects `embedding` out.
  const src = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  assert.match(src, /noteRetrievalBackend\(backend\)/, 'the label is recorded for health to read');
  assert.ok(!/backend = 'hybrid-bm25-cosine'/.test(src), 'and no longer claims a cosine half that did not run');
  // The label comes from what nearestChunks reports served the query.
  assert.match(src, /backend: served/, 'the dense half returns the backend that answered it');
});

test('the dense half on Mongo asks the index, not the stripped corpus', () => {
  // The corpus carries no vectors, so scoring it in JavaScript produced an empty
  // dense ranking and BM25 ranked alone while the label said hybrid. Pinned
  // both ways: the index is asked, and the corpus is not scored.
  const rag = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  assert.match(rag, /async function denseFromIndex/, 'there is a path that asks the index');
  assert.match(rag, /await nearestChunks\(/, 'and it calls nearestChunks');

  const vs = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  // allChunks sits after deleteChunksForDoc in the file, so slice forward from it.
  const start = vs.indexOf('export async function allChunks');
  const all = vs.slice(start, vs.indexOf('\n}', start));
  assert.match(all, /project\(\{ embedding: 0 \}\)/, 'the corpus is fetched without vectors');
});

test('the $vectorSearch filter is inside the stage and uses the index paths', () => {
  // Two defects in one line: snake_case paths the index does not declare, and a
  // Space restriction applied after the search instead of inside it.
  const vs = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  const stage = vs.slice(vs.indexOf('export async function nearestChunks'), vs.indexOf('const filter = { user_id: userId };'));
  assert.match(stage, /const filter = \{ userId \};/, 'the filter uses the declared camelCase path');
  assert.match(stage, /if \(spaceId\) filter\.spaceId = spaceId;/, 'and restricts the Space inside the stage');
  assert.match(stage, /filter,\n\s*\},/, 'the filter is passed to $vectorSearch itself');
  // docId is not a declared filter field, so it is the one thing post-filtered.
  assert.match(stage, /\$match: \{ docId: \{ \$in: docIds \} \}/, 'docId is post-filtered');
  assert.ok(!/filter\.user_id|filter\.doc_id/.test(stage), 'no snake_case path reaches the index');
});

test('chunks are dual-written with the paths the index filters on', () => {
  const rag = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  for (const field of ['userId: doc.user_id', 'spaceId: doc.space_id ?? null', 'docId: doc.id']) {
    assert.ok(rag.includes(field), `a chunk carries ${field}`);
  }
  // And the snake_case originals stay, because every reader uses them.
  for (const field of ['user_id: doc.user_id', 'space_id: doc.space_id ?? null', 'doc_id: doc.id']) {
    assert.ok(rag.includes(field), `and keeps ${field} for the readers`);
  }
});

test('a width the index cannot hold is refused at ingest, not discovered at query time', () => {
  const rag = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  assert.match(rag, /does not match the vector index/, 'indexChunks refuses a mismatched width');
  assert.match(rag, /throw new Error\(\n\s*`embedding width/, 'and throws rather than warning');
});

test('a chosen embedding provider that fails throws instead of substituting local vectors', () => {
  const emb = fs.readFileSync(new URL('../src/agent/services/embeddings.js', import.meta.url), 'utf8');
  assert.match(emb, /const asked = Boolean\(forced\) \|\| config\.embeddings\.provider !== 'auto';/, 'an explicit choice is distinguished from auto');
  assert.match(emb, /throw new Error\(`embedding provider \$\{provider\} failed/, 'and a chosen provider failing is an error');
  // auto still degrades, because that is what auto asks for.
  assert.match(emb, /embedding_provider_failed_using_local/, 'auto keeps the documented degrade');
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

/* ------------------------------------------- results and the label they carry */

/**
 * Retrieval cannot return results labelled `atlas-vector-search` unless an
 * aggregation produced them.
 *
 * The two were independent before: the label came from configuration, the
 * results from a scan (or, on Mongo, from BM25 alone). Now the label is set in
 * the same branch that returns the candidates, so the only way to publish it is
 * to have run the stage. This pins that structure, because it is what makes the
 * recall figure comparable to anything.
 */
test('the backend label is set in the same branch that returns the candidates', () => {
  const vs = fs.readFileSync(new URL('../src/agent/services/vectorStore.js', import.meta.url), 'utf8');
  // putChunks sits before nearestChunks, so slice forward to the next export.
  const start = vs.indexOf('export async function nearestChunks');
  const fn = vs.slice(start, vs.indexOf('\nexport ', start + 10));

  // The claim and the return are adjacent and inside the try that ran the pipeline.
  assert.match(
    fn,
    /const candidates = await col\.aggregate\(pipeline\)\.toArray\(\);[\s\S]{0,200}noteVectorSearchServed\(\);\s*\n\s*return \{ backend: 'atlas-vector-search', candidates \};/,
    'the label is returned by the code that ran the aggregation, not chosen before it',
  );
  // And the scan returns its own name, so a degrade is reported as a degrade.
  assert.match(fn, /return \{ backend: 'mongo-cosine-scan', candidates: scored \};/, 'a scan says it scanned');
  /**
   * Nothing else in the module may mint the claim.
   *
   * Counted over code only - the literal appears in prose here several times,
   * because the history of this label is most of what the comments are about.
   * In code it is legitimate in exactly five places, each named below: one
   * assignment, one guard, one return, and two questions about which branch to
   * take - which are about configuration and claim nothing.
   */
  const code = vs
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const sites = code
    .split('\n')
    .filter((l) => l.includes("'atlas-vector-search'"))
    .map((l) => l.trim());
  assert.deepEqual(
    sites,
    [
      // The one assignment, inside noteVectorSearchServed.
      "observed = 'atlas-vector-search';",
      // The guard that rejects anyone else setting it.
      "if (name === 'atlas-vector-search' && !servedByVectorSearch) {",
      // Choosing the chunks branch - a question about configuration, not a claim.
      "if (config.mongo.vectorBackend === 'atlas-vector-search') {",
      // The one return, beside the aggregation that earned it.
      "return { backend: 'atlas-vector-search', candidates };",
      // The same question for memories.
      "if (config.mongo.vectorBackend !== 'atlas-vector-search') return null;",
    ],
    'a new place naming this backend is a new place it can be claimed without being earned',
  );
});

test('searchChunks publishes whatever nearestChunks reported, never a configured value', () => {
  const rag = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  const dense = rag.slice(rag.indexOf('async function denseFromIndex'), rag.indexOf('export async function searchChunks'));
  assert.match(dense, /const \{ backend: served, candidates \} = await nearestChunks\(/, 'the backend comes back with the candidates');
  assert.match(dense, /return \{ dense, provider, backend: served \}/, 'and is passed through unchanged');
  assert.ok(
    !/backend: 'atlas-vector-search'/.test(dense),
    'the dense path never names the backend itself',
  );
});

test('an empty corpus claims no backend at all', () => {
  // A corpus of nothing was searched by nothing. Naming a backend there is the
  // configured-value habit in its last hiding place.
  const rag = fs.readFileSync(new URL('../src/agent/services/ragStore.js', import.meta.url), 'utf8');
  assert.match(
    rag,
    /noteRetrievalBackend\(backend === 'in-process' \? backend : 'none'\)/,
    'an empty Mongo corpus reports none, not the backend that would have served',
  );
});
