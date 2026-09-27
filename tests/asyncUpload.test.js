import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The upload request stores the file and creates the job. Nothing else.
 *
 * It used to parse, chunk, embed and index inside the HTTP request - on the
 * deployed function by necessity, because `enqueue` ran the job in whichever
 * process called it and that process froze the moment it answered. The 202 was
 * therefore a lie about what had already happened, the request held a PDF
 * parser open, and a restart between accepting and indexing lost the bytes
 * outright: they lived in a `Map`.
 *
 * What the request may now do: authenticate, validate, store the bytes
 * durably, create the document record, enqueue a durable job, answer 202.
 * Parsing, chunking, embedding, the vector write and the read-after-write
 * verification all belong to the worker, after the response.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-asyncup-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { enqueueDocument, indexDocumentJob } = await import('../src/agent/services/ingest.js');
const { jobQueue } = await import('../src/agent/services/jobs.js');
const { getDocument } = await import('../src/agent/services/ragStore.js');
const { getFile } = await import('../src/agent/services/fileStore.js');

const text = Buffer.from(
  ['# Retrieval', '', 'Reciprocal rank fusion sums one over k plus rank across ranked lists.', '',
   'A chunk that is too large blurs the citation, and one too small loses the context.', '',
   'BM25 saturates term frequency so a word repeated twenty times is not twenty times better.'].join('\n'),
);

/** Claim the job belonging to one document: the tests share a queue. */
async function claimFor(docId, workerId = 'w') {
  for (let i = 0; i < 20; i += 1) {
    const claim = await jobQueue.claimNext({ types: ['index_document'], workerId: `${workerId}${i}` });
    if (!claim) return null;
    if (claim.payload?.doc_id === docId) return claim;
  }
  return null;
}

const accept = (over = {}) =>
  enqueueDocument({ userId: 'usr_up', filename: 'notes.md', mimetype: 'text/markdown', buffer: text, spaceId: 'spc_up', ...over });

test('the request returns before any indexing happens', async () => {
  let acceptedAt = null;
  const { document } = await accept({ onAccepted: () => { acceptedAt = Date.now(); } });
  assert.ok(acceptedAt, 'the 202 was sent');
  const doc = await getDocument(document.id);
  // Whatever the record calls "accepted but untouched", it must not be past it.
  assert.ok(['pending', 'queued'].includes(doc.status), `status is ${doc.status}, past acceptance`);
  assert.equal(doc.chunk_count ?? 0, 0, 'nothing was chunked on the request path');
  const job = (await jobQueue.list({}, { limit: 50 })).items.find((j) => j.payload?.doc_id === document.id);
  assert.ok(job, 'a durable job exists');
  assert.equal(job.status, 'queued', 'and it is waiting for a worker, not already running');
});

test('no parser or embedding call happens on the request path', async () => {
  // Proven by substitution rather than by reading the code: if the request
  // touched either of these, the counters would move before the worker runs.
  let parses = 0;
  let embeds = 0;
  const { document } = await accept({
    parseDocument: async () => { parses += 1; return { pages: [{ page: 1, text: 'x', label: 'p. 1' }], meta: { page_count: 1 } }; },
    indexChunks: async () => { embeds += 1; return { provider: 'local' }; },
  });
  assert.equal(parses, 0, 'the request parsed the file');
  assert.equal(embeds, 0, 'the request embedded the file');
  assert.ok(document.id, 'and it still accepted the upload');
});

test('the bytes are durable before the response, not held in memory', async () => {
  const { document } = await accept();
  const stored = await getFile(document.id);
  assert.ok(stored, 'the file is in the store');
  assert.ok(stored.equals(text), 'byte for byte');
});

test('the worker indexes it after the fact', async () => {
  const { document } = await accept();
  const claim = await claimFor(document.id, 'wa');
  assert.ok(claim, 'the worker claimed the job');
  await indexDocumentJob(claim.payload, { progress: async () => {} });
  const doc = await getDocument(document.id);
  assert.equal(doc.status, 'indexed');
  assert.ok((doc.chunk_count ?? 0) > 0, 'with chunks');
  assert.equal(doc.embedding_provider, 'local');
});

test('a document cannot reach indexed before the verification probe succeeds', async () => {
  // Marking a document searchable without checking that it is searchable is how
  // one of them sat at 95% "embedding" on the deployment with no error: the
  // write appeared to succeed and nothing read it back.
  const { document } = await accept();
  const claim = await claimFor(document.id, 'wb');
  assert.ok(claim, 'claimed');
  await assert.rejects(
    () => indexDocumentJob(claim.payload, { progress: async () => {} , verify: async () => 0 }),
    /verif/i,
    'a probe that finds nothing must fail the job',
  );
  const doc = await getDocument(document.id);
  assert.notEqual(doc.status, 'indexed', `status is ${doc.status}, which must not be indexed`);
});

test('exhausted retries leave the document failed with a visible reason', async () => {
  const { document } = await accept();
  const job = (await jobQueue.list({}, { limit: 50 })).items.find((j) => j.payload?.doc_id === document.id);
  for (let i = 0; i < (job.max_attempts ?? 2); i += 1) {
    const claim = await claimFor(document.id, `wc${i}`);
    assert.ok(claim, `attempt ${i + 1} was claimable`);
    await jobQueue.fail(claim.id, new Error('embedding provider refused'));
  }
  const after = await jobQueue.get(job.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /embedding provider refused/);
  assert.equal(await claimFor(document.id, 'wz'), null, 'and this job stops retrying');
});

test('a queued upload survives the agent restarting', async () => {
  const { document } = await accept();
  // A restart reconciles: running jobs with dead leases come back, queued work
  // is left alone. Neither may destroy the pending upload.
  await jobQueue.reconcile();
  const job = (await jobQueue.list({}, { limit: 50 })).items.find((j) => j.payload?.doc_id === document.id);
  assert.equal(job.status, 'queued', `a restart left the job ${job.status}`);
  assert.ok(await getFile(document.id), 'and the bytes are still there to index');
});

test('runInline indexes before the response, for a platform with no worker', async () => {
  // A Vercel invocation ends when its response is flushed, so work awaited after
  // res.json() never ran: documents sat at `queued` with zero attempts. Where
  // there is no worker the job runs before the caller is told anything, which is
  // slower and true rather than fast and false.
  let statusAtAccept = null;
  const { document } = await accept({
    runInline: true,
    onAccepted: (doc) => { statusAtAccept = doc.status; },
  });
  const doc = await getDocument(document.id);
  assert.equal(doc.status, 'indexed', `inline upload left it ${doc.status}`);
  assert.ok((doc.chunk_count ?? 0) > 0, 'with chunks, before the response was sent');
  assert.ok(statusAtAccept, 'and the accept callback still fired');
});

test('without runInline nothing is indexed on the request path', async () => {
  // The default, and what every deployment with a worker uses.
  const { document } = await accept();
  const doc = await getDocument(document.id);
  assert.ok(['pending', 'queued'].includes(doc.status), `status is ${doc.status}`);
  assert.equal(doc.chunk_count ?? 0, 0);
});
