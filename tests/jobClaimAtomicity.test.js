import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Two worker processes must not claim one job, and a full queue must not hide new work.
 *
 * Both of these were wrong, and my own test gave false confidence about the first.
 * `claimNext` serialises through `#claimChain`, a promise chain on the instance -
 * so eight concurrent callers inside one process do produce one winner, which is
 * what the existing test proved. It proves nothing about two processes. Across
 * machines the sequence is read, decide, write with no condition on the write:
 * both workers see the same `queued` row and both patch it to `running`. The lease
 * guards a *later* claim, never a concurrent one.
 *
 * The second is a paging bug. The candidate scan asks for the oldest 500 jobs of
 * any status, so once 500 jobs exist - and most of them will be `done` - the
 * window is full of finished work and a newly queued job is never seen. The queue
 * stops draining silently.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-claimatomic-'));
process.env.MONGODB_URI = '';

const { jobQueue } = await import('../src/agent/services/jobs.js');

test('a queued job is found even when hundreds of finished jobs are older', async () => {
  // Fill the window with completed work, as a long-lived deployment would.
  for (let i = 0; i < 520; i += 1) {
    const j = await jobQueue.enqueue('filler_type', { i });
    await jobQueue.complete(j.id, { ok: true });
  }
  const target = await jobQueue.enqueue('needle_type', { needle: true });

  const claim = await jobQueue.claimNext({ types: ['needle_type'], workerId: 'w1' });
  assert.ok(claim, 'the newest queued job was invisible behind 520 finished ones');
  assert.equal(claim.id, target.id);
});

/**
 * Cross-process atomicity is a property of the store, and only Mongo can offer it.
 *
 * The local JSON store keeps the collection in memory and writes the whole file;
 * two processes hold two snapshots and cannot be made to agree by serialising
 * inside either one. That is why the deployed path is Mongo and why this test
 * runs there - skipping, rather than pretending, when no database is configured.
 */
const MONGO = process.env.TEST_MONGODB_URI || '';

test('two separate processes cannot claim the same job (Mongo)', async (t) => {
  if (!MONGO) return t.skip('set TEST_MONGODB_URI to exercise cross-process claiming');

  const db = `lumina_claimtest_${Date.now().toString(36)}`;
  const env = { ...process.env, MONGODB_URI: MONGO, MONGODB_DB: db, DATA_DIR: process.env.DATA_DIR };

  const run = (code) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', () => resolve({ out: out.trim(), err: err.slice(0, 300) }));
    });

  const jobsPath = JSON.stringify(path.resolve('src/agent/services/jobs.js'));
  const seed = await run(`const { jobQueue } = await import(${jobsPath});
    const j = await jobQueue.enqueue('xproc_type', { n: 1 });
    // write *then* exit: exiting on the same tick truncates stdout.
    process.stdout.write(j.id, () => process.exit(0));`);
  // The child logs `mongo_connected` to stdout before the id, so the id is
  // extracted rather than anchored to the start.
  const seededId = (seed.out.match(/job_[a-z0-9]+/) || [])[0];
  assert.ok(seededId, `seeding failed. stdout: ${seed.out.slice(-200)} stderr: ${seed.err}`);

  const claimer = (tag) => run(`const { jobQueue } = await import(${jobsPath});
    const c = await jobQueue.claimNext({ types: ['xproc_type'], workerId: ${JSON.stringify(tag)} });
    // An open Mongo connection keeps the child alive and 'close' never fires;
    // exiting on the same tick as the write truncates stdout.
    process.stdout.write(JSON.stringify({ tag: ${JSON.stringify(tag)}, id: c && c.id }), () => process.exit(0));`);

  const [a, b] = await Promise.all([claimer('wA'), claimer('wB')]);
  const parse = (r) => {
    const line = r.out.split('\n').reverse().find((l) => l.trim().startsWith('{"tag"'));
    try { return JSON.parse(line); } catch { return { id: null, err: r.err, out: r.out.slice(-160) }; }
  };
  const results = [parse(a), parse(b)];
  const winners = results.filter((r) => r.id === seededId);
  assert.equal(winners.length, 1, `${winners.length} processes claimed the same job: ${JSON.stringify(results)}`);

  // Leave no test database behind.
  const { MongoClient } = await import('mongodb');
  const c = new MongoClient(MONGO);
  await c.connect();
  await c.db(db).dropDatabase();
  await c.close();
});

test('the JSON store is documented as single-process only', () => {
  // Saying so where someone would otherwise assume the guarantee is universal.
  const src = fs.readFileSync(new URL('../src/agent/store/jsonStore.js', import.meta.url), 'utf8');
  const claim = src.slice(src.indexOf('async claimOne('), src.indexOf('async claimOne(') + 900);
  assert.match(src.slice(0, src.indexOf('async claimOne(')) + claim, /single process|single-process/i,
    'jsonStore.claimOne must say that its guarantee is in-process only');
});
