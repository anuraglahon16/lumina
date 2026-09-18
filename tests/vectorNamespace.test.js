import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Vectors are only ever compared to vectors from the same model.
 *
 * Different widths are the easy half: cosine already returns 0 when the lengths
 * disagree, so those chunks simply never match. That costs recall and is worth
 * fixing, but it is not dangerous.
 *
 * The dangerous half is two models of the *same* width — two 1024-dimension
 * embedders, or the same embedder before and after a change to how text is
 * chunked. There the arithmetic succeeds and returns a plausible number between
 * -1 and 1 that means nothing at all, and it outranks genuinely relevant
 * passages. Nothing throws, nothing logs, and the only symptom is answers drawn
 * from the wrong place.
 *
 * So the rule is enforced on identity, never on dimensions happening to agree:
 * provider, model, dimension and a version of how text becomes a vector must
 * all match before two vectors are compared.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ns-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { embeddingNamespace, EMBEDDING_VERSION, modelFor, embedBatch } = await import('../src/agent/services/embeddings.js');
const { createDocument, indexChunks, searchChunks, updateDocument } = await import('../src/agent/services/ragStore.js');
const { collection } = await import('../src/agent/store/jsonStore.js');

/* ----------------------------------------------------------- the namespace */

test('a namespace distinguishes everything that makes vectors incomparable', () => {
  const base = { provider: 'voyage', model: 'voyage-3.5', dim: 1024 };
  const ns = embeddingNamespace(base);
  assert.notEqual(ns, embeddingNamespace({ ...base, provider: 'openai' }), 'a different provider is a different space');
  assert.notEqual(ns, embeddingNamespace({ ...base, model: 'voyage-3.5-lite' }), 'a different model is a different space');
  assert.notEqual(ns, embeddingNamespace({ ...base, dim: 512 }), 'a different dimension is a different space');
});

test('the namespace carries a version, so a change in how text is prepared invalidates old vectors', () => {
  // Two vectors from the same model still describe different things if the
  // chunking or cleaning that produced their text has changed underneath them.
  assert.match(embeddingNamespace({ provider: 'local', model: 'local-512', dim: 512 }), new RegExp(`:v${EMBEDDING_VERSION}$`));
});

test('embedBatch reports the space its vectors belong to', async () => {
  const r = await embedBatch(['a passage of text about ledgers'], {});
  assert.ok(r.namespace, 'every batch says where its vectors live');
  assert.equal(r.namespace, embeddingNamespace({ provider: r.provider, model: r.model, dim: r.dim }));
  assert.equal(r.model, modelFor(r.provider));
  assert.equal(r.dim, r.vectors[0].length);
});

/* -------------------------------------------------- a document is atomic */

const body = (topic) =>
  `The ${topic} pipeline validates every incoming record against a published schema before the ledger accepts it. `.repeat(8);

async function indexDoc({ userId, spaceId, filename, topic, chunkCount = 3 }) {
  const doc = await createDocument({ userId, filename, mimetype: 'text/plain', size: 400, spaceId });
  const docChunks = Array.from({ length: chunkCount }, (_, i) => ({
    index: i,
    text: `${body(topic)} section ${i}`,
    page: i + 1,
    page_label: `p. ${i + 1}`,
  }));
  const res = await indexChunks(doc, docChunks);
  await updateDocument(doc.id, { status: 'indexed', embedding_provider: res.provider });
  return { doc, res };
}

test('every chunk of a document lands in one namespace', async () => {
  // The bug was per-slice fallback: a long document whose provider was rate
  // limited halfway through was written part in one space and part in another.
  const { doc, res } = await indexDoc({ userId: 'usr_ns_1', spaceId: 'spc_ns_1', filename: 'a.txt', topic: 'alpha', chunkCount: 7 });
  assert.ok(res.namespace, 'indexing reports the namespace it used');

  const chunks = collection('chunks');
  const written = await chunks.all({ doc_id: doc.id });
  assert.ok(written.length >= 7);
  const spaces = new Set(written.map((c) => c.embedding_namespace));
  assert.equal(spaces.size, 1, 'one document, one vector space');
  assert.equal([...spaces][0], res.namespace);

  const dims = new Set(written.map((c) => c.embedding.length));
  assert.equal(dims.size, 1, 'and therefore one dimension');
});

test('a chunk records the model that embedded it, not just the vector', async () => {
  const { doc } = await indexDoc({ userId: 'usr_ns_2', spaceId: 'spc_ns_2', filename: 'b.txt', topic: 'beta' });
  const [chunk] = await collection('chunks').all({ doc_id: doc.id });
  for (const field of ['embedding_namespace', 'embedding_provider', 'embedding_model', 'embedding_dimension']) {
    assert.ok(chunk[field] != null, `${field} is recorded`);
  }
  assert.equal(chunk.embedding_dimension, chunk.embedding.length);
});

/* ------------------------------------- a Space holding two vector spaces */

test('a mixed Space searches each namespace and never across them', async () => {
  // The realistic case: one document indexed while the remote provider worked,
  // another after it started refusing. Both are good; neither can be scored
  // against the other's query vector.
  const userId = 'usr_ns_mixed';
  const spaceId = 'spc_mixed';
  const { doc: normal } = await indexDoc({ userId, spaceId, filename: 'normal.txt', topic: 'ledger validation' });

  // Forge a second document in a different, incompatible space.
  const alien = await createDocument({ userId, filename: 'alien.txt', mimetype: 'text/plain', size: 200, spaceId });
  const chunks = collection('chunks');
  await chunks.put({
    id: 'chk_alien_1',
    chunk_id: `${alien.id}:0`,
    doc_id: alien.id,
    user_id: userId,
    space_id: spaceId,
    filename: 'alien.txt',
    index: 0,
    page: 1,
    page_label: 'p. 1',
    text: `${body('ledger validation')} alien copy`,
    tokens: ['ledger', 'validation', 'schema', 'pipeline', 'record', 'alien'],
    // Deliberately a different width, from a model this process cannot produce.
    embedding: new Array(99).fill(0.01),
    embedding_namespace: 'someprovider:some-model:99:v1',
    embedding_provider: 'someprovider',
    embedding_model: 'some-model',
    embedding_dimension: 99,
  });
  await chunks.flush();
  await updateDocument(alien.id, { status: 'indexed' });

  // The assertion that matters is that this returns at all, and returns
  // sensible results, rather than throwing on a length mismatch or silently
  // scoring a 99-wide vector against a 512-wide one.
  const out = await searchChunks('ledger validation schema pipeline', { userId, spaceId });
  assert.ok(out.results.length > 0, 'the searchable namespace still answers');

  const fromNormal = out.results.filter((r) => r.doc_id === normal.id);
  assert.ok(fromNormal.length > 0, 'the document in a reachable space is found');

  // The assertion this file exists for. A chunk whose vectors this process
  // cannot produce a comparable query for must never receive a dense score.
  // Any non-zero value here is a cosine computed across two models, which is
  // the silent corruption the namespaces prevent.
  for (const r of out.results.filter((x) => x.doc_id === alien.id)) {
    assert.equal(r.dense_score, 0, 'an unreachable namespace is never scored densely');
  }
  // And the reachable one must actually be scored densely, or the test would
  // also pass with dense retrieval switched off entirely.
  assert.ok(fromNormal.some((r) => r.dense_score > 0), 'the reachable namespace is scored densely');

  for (const r of out.results) assert.ok(Number.isFinite(r.score) && r.score > 0, 'every score is a real number');
});

test('a corpus whose embedder cannot be reached is still searchable lexically', async () => {
  // BM25 needs no vectors, so it is the floor under the whole scheme: losing
  // the embedding provider costs quality, not the ability to answer.
  const userId = 'usr_ns_lex';
  const spaceId = 'spc_lex';
  const alien = await createDocument({ userId, filename: 'only.txt', mimetype: 'text/plain', size: 200, spaceId });
  const chunks = collection('chunks');
  await chunks.put({
    id: 'chk_lex_1',
    chunk_id: `${alien.id}:0`,
    doc_id: alien.id,
    user_id: userId,
    space_id: spaceId,
    filename: 'only.txt',
    index: 0,
    page: 1,
    page_label: 'p. 1',
    text: 'Quarterly reconciliation compares the append only ledger against the settlement file.',
    tokens: ['quarterly', 'reconciliation', 'append', 'ledger', 'settlement', 'file'],
    embedding: new Array(77).fill(0.02),
    embedding_namespace: 'unreachable:model-x:77:v1',
    embedding_provider: 'unreachable',
    embedding_model: 'model-x',
    embedding_dimension: 77,
  });
  await chunks.flush();
  await updateDocument(alien.id, { status: 'indexed' });

  const out = await searchChunks('quarterly reconciliation settlement ledger', { userId, spaceId });
  assert.ok(out.results.length > 0, 'lexical retrieval reaches a corpus no query vector can');
  assert.equal(out.results[0].doc_id, alien.id);
  assert.equal(out.results[0].dense_score, 0, 'and it got there on words alone, not on a bogus vector comparison');
  assert.ok(out.results[0].lexical_score > 0);
});

test('two models of the same width are still never compared', async () => {
  // The case that matters, and the one a dimension check cannot catch: same
  // number of dimensions, different model. Cosine succeeds and returns a
  // confident number describing nothing.
  const userId = 'usr_ns_samewidth';
  const spaceId = 'spc_samewidth';
  const { doc: real, res } = await indexDoc({ userId, spaceId, filename: 'real.txt', topic: 'settlement ledger' });
  const width = res.dim;

  const twin = await createDocument({ userId, filename: 'twin.txt', mimetype: 'text/plain', size: 200, spaceId });
  const chunks = collection('chunks');
  await chunks.put({
    id: 'chk_twin_1',
    chunk_id: `${twin.id}:0`,
    doc_id: twin.id,
    user_id: userId,
    space_id: spaceId,
    filename: 'twin.txt',
    index: 0,
    page: 1,
    page_label: 'p. 1',
    text: 'An unrelated passage about migratory birds and their seasonal routes.',
    tokens: ['unrelated', 'migratory', 'birds', 'seasonal', 'routes'],
    // Exactly the width this process produces, from a different model. Weighted
    // so that a naive comparison would score it highly.
    embedding: new Array(width).fill(1 / Math.sqrt(width)),
    embedding_namespace: `othervendor:other-model:${width}:v1`,
    embedding_provider: 'othervendor',
    embedding_model: 'other-model',
    embedding_dimension: width,
  });
  await chunks.flush();
  await updateDocument(twin.id, { status: 'indexed' });

  const out = await searchChunks('settlement ledger schema validation', { userId, spaceId });
  const twinHits = out.results.filter((r) => r.doc_id === twin.id);
  for (const r of twinHits) {
    assert.equal(r.dense_score, 0, 'a same-width foreign model is still never scored densely');
  }
  assert.ok(out.results.some((r) => r.doc_id === real.id && r.dense_score > 0), 'the real corpus is still scored densely');
});
