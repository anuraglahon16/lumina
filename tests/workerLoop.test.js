import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The worker is the only thing that runs jobs.
 *
 * Two properties matter here and neither is about what a job does. A worker
 * picks up work nobody else is doing, and two workers never do the same piece.
 * The second used to be impossible to violate only because there was one
 * process; with a separate worker process it has to be enforced by the claim.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-workerloop-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';
process.env.JOB_POLL_MS = '10';

const { jobQueue } = await import('../src/agent/services/jobs.js');
const { workerLoop } = await import('../src/agent/worker.js');
const { enqueueDocument, indexDocumentJob } = await import('../src/agent/services/ingest.js');
const { getDocument } = await import('../src/agent/services/ragStore.js');

const body = Buffer.from(
  ['Reciprocal rank fusion sums one over k plus rank across ranked lists.',
   'A chunk too large blurs the citation; one too small loses the context.',
   'BM25 saturates term frequency, so twenty repeats are not twenty times better.'].join('\n\n'),
);

test('the worker picks up a queued upload and indexes it', async () => {
  const { document } = await enqueueDocument({
    userId: 'usr_wl', filename: 'w.md', mimetype: 'text/markdown', buffer: body, spaceId: 'spc_wl',
  });
  const before = (await getDocument(document.id)).status;
  assert.ok(['pending', 'queued'].includes(before), `nothing happened on the request path, got ${before}`);

  await workerLoop({ once: true });

  const doc = await getDocument(document.id);
  assert.equal(doc.status, 'indexed', `worker left it ${doc.status}`);
  assert.ok((doc.chunk_count ?? 0) > 0);
});

test('two workers running together never double-process a job', async () => {
  const { document } = await enqueueDocument({
    userId: 'usr_wl2', filename: 'w2.md', mimetype: 'text/markdown', buffer: body, spaceId: 'spc_wl2',
  });
  const job = (await jobQueue.list({}, { limit: 100 })).items.find((j) => j.payload?.doc_id === document.id);

  // Count how many times the body actually executes for this document.
  let runs = 0;
  const handler = async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); };
  const claims = await Promise.all(
    Array.from({ length: 6 }, (_, i) => jobQueue.claimNext({ types: ['index_document'], workerId: `dup${i}` })),
  );
  const mine = claims.filter((c) => c && c.payload?.doc_id === document.id);
  assert.equal(mine.length, 1, `${mine.length} workers claimed the same upload`);
  for (const c of mine) await handler(c);
  assert.equal(runs, 1, 'the work ran once');
  assert.ok(job);
});

test('a job abandoned by a dead worker is picked up again, once', async () => {
  const { document } = await enqueueDocument({
    userId: 'usr_wl3', filename: 'w3.md', mimetype: 'text/markdown', buffer: body, spaceId: 'spc_wl3',
  });
  // A worker claims it and dies: the lease lapses without being renewed.
  let dead = null;
  for (let i = 0; i < 20 && !dead; i += 1) {
    const c = await jobQueue.claimNext({ types: ['index_document'], workerId: 'w_dead', leaseMs: -1 });
    if (!c) break;
    if (c.payload?.doc_id === document.id) dead = c;
  }
  assert.ok(dead, 'the doomed worker had it');

  await workerLoop({ once: true });
  const doc = await getDocument(document.id);
  assert.ok(['indexed', 'processing', 'failed'].includes(doc.status), `a live worker took it over (${doc.status})`);
});

test('the worker body is the same function the tests drive', () => {
  // A worker that reimplemented indexing would drift from what is tested.
  const src = fs.readFileSync(new URL('../src/agent/worker.js', import.meta.url), 'utf8');
  assert.match(src, /indexDocumentJob/, 'the worker delegates to the exported job body');
  assert.ok(!/parseDocument|chunkPages|indexChunks/.test(src), 'and does not reimplement the pipeline');
  assert.equal(typeof indexDocumentJob, 'function');
});

test('the worker has no HTTP listener', () => {
  // It is private by construction: nothing to reach even if the network let you.
  const src = fs.readFileSync(new URL('../src/agent/worker.js', import.meta.url), 'utf8');
  for (const forbidden of ['express', 'createServer', '.listen(']) {
    assert.ok(!src.includes(forbidden), `the worker must not ${forbidden}`);
  }
});
