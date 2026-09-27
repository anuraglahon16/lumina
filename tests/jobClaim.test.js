import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A job belongs to exactly one worker at a time.
 *
 * The queue had no claim at all. `enqueue` pushed the id onto an in-process
 * array and whoever enqueued it also ran it, which works only while there is
 * one process and it outlives the response - neither of which is true of the
 * architecture this is moving to. Two workers pulling the same queue would both
 * parse the same PDF and both write its chunks.
 *
 * So claiming is a single atomic transition, `queued → running`, carrying a
 * lease. A worker that dies stops renewing and the job returns to the queue
 * when the lease expires; a worker that is merely slow keeps renewing and keeps
 * the job. Retries stay bounded, and exhausting them is a visible `failed`
 * rather than a silent requeue.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-jobclaim-'));
process.env.MONGODB_URI = '';

const { jobQueue } = await import('../src/agent/services/jobs.js');

test('a queued job can be claimed once', async () => {
  const job = await jobQueue.enqueue('noop_test', { n: 1 }, { userId: 'usr_a' });
  const claim = await jobQueue.claimNext({ types: ['noop_test'], workerId: 'w1' });
  assert.ok(claim, 'a worker got it');
  assert.equal(claim.id, job.id);
  assert.equal(claim.status, 'running');
  assert.equal(claim.worker_id, 'w1');
  assert.ok(claim.lease_until, 'and it carries a lease');
});

test('a second worker cannot claim the same job', async () => {
  await jobQueue.enqueue('solo_test', { n: 2 });
  const a = await jobQueue.claimNext({ types: ['solo_test'], workerId: 'w1' });
  const b = await jobQueue.claimNext({ types: ['solo_test'], workerId: 'w2' });
  assert.ok(a, 'the first claim succeeded');
  assert.equal(b, null, 'the second found nothing to claim');
});

test('concurrent claims hand the job to exactly one worker', async () => {
  // The race the design has to survive: several workers waking together.
  await jobQueue.enqueue('race_test', { n: 3 });
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, i) => jobQueue.claimNext({ types: ['race_test'], workerId: `w${i}` })),
  );
  const won = claims.filter(Boolean);
  assert.equal(won.length, 1, `${won.length} workers claimed the same job`);
});

test('an expired lease returns the job to the queue', async () => {
  await jobQueue.enqueue('lease_test', { n: 4 });
  const first = await jobQueue.claimNext({ types: ['lease_test'], workerId: 'w_dead', leaseMs: -1 });
  assert.ok(first, 'claimed with an already-expired lease, as a dead worker leaves it');
  const second = await jobQueue.claimNext({ types: ['lease_test'], workerId: 'w_live' });
  assert.ok(second, 'another worker may take it over');
  assert.equal(second.id, first.id);
  assert.equal(second.worker_id, 'w_live');
});

test('a live worker keeps its job by renewing', async () => {
  await jobQueue.enqueue('renew_test', { n: 5 });
  const mine = await jobQueue.claimNext({ types: ['renew_test'], workerId: 'w_slow', leaseMs: 50 });
  await new Promise((r) => setTimeout(r, 30));
  await jobQueue.renew(mine.id, { workerId: 'w_slow', leaseMs: 5000 });
  const stolen = await jobQueue.claimNext({ types: ['renew_test'], workerId: 'w_thief' });
  assert.equal(stolen, null, 'a renewed lease is not stealable');
});

test('a claim only takes the types the worker asked for', async () => {
  await jobQueue.enqueue('type_a', {});
  const wrong = await jobQueue.claimNext({ types: ['type_b'], workerId: 'w1' });
  assert.equal(wrong, null);
  const right = await jobQueue.claimNext({ types: ['type_a'], workerId: 'w1' });
  assert.ok(right);
});

test('a failed job retries up to its bound, then fails visibly', async () => {
  const job = await jobQueue.enqueue('retry_test', {}, { maxAttempts: 2 });

  const a = await jobQueue.claimNext({ types: ['retry_test'], workerId: 'w1' });
  await jobQueue.fail(a.id, new Error('first attempt exploded'));
  let after = await jobQueue.get(job.id);
  assert.equal(after.status, 'queued', 'it goes back for another attempt');
  assert.equal(after.attempts, 1);

  const b = await jobQueue.claimNext({ types: ['retry_test'], workerId: 'w2' });
  assert.ok(b, 'and can be claimed again');
  await jobQueue.fail(b.id, new Error('second attempt exploded'));
  after = await jobQueue.get(job.id);
  assert.equal(after.status, 'failed', 'the bound is respected');
  assert.equal(after.attempts, 2);
  assert.match(after.error, /second attempt exploded/, 'and the reason is visible');

  const again = await jobQueue.claimNext({ types: ['retry_test'], workerId: 'w3' });
  assert.equal(again, null, 'a failed job is not silently retried forever');
});

test('a completed job is not reclaimable', async () => {
  const job = await jobQueue.enqueue('done_test', {});
  const claim = await jobQueue.claimNext({ types: ['done_test'], workerId: 'w1' });
  await jobQueue.complete(claim.id, { ok: true });
  const after = await jobQueue.get(job.id);
  assert.equal(after.status, 'done');
  assert.deepEqual(after.result, { ok: true });
  assert.equal(await jobQueue.claimNext({ types: ['done_test'], workerId: 'w2' }), null);
});

test('a queued job survives a restart of the process that enqueued it', async () => {
  // Durability is the whole reason the queue is in the store rather than an
  // array. A fresh module instance must still see the work.
  const job = await jobQueue.enqueue('survive_test', { n: 9 });
  const fresh = await import(`../src/agent/services/jobs.js?restart=${Date.now()}`);
  const claim = await fresh.jobQueue.claimNext({ types: ['survive_test'], workerId: 'w_new' });
  assert.ok(claim, 'the restarted worker found the queued job');
  assert.equal(claim.id, job.id);
});
