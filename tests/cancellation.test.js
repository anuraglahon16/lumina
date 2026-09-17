import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';

/**
 * What a cancellation has to be for the rest of the system to treat it as one.
 *
 * The retrieval tests inject the network, which is right for testing what the
 * pool decides and wrong for testing what an abort *is*. These go to the real
 * circuit breaker and the real classification rule, because that is where the
 * defect lived: the pool aborted with `new Error('retrieval_complete')`, which
 * is not an abort to anything that inspects it. The breaker asks whether a
 * failure was the host's fault by looking for an AbortError, saw a plain Error,
 * and counted it — so cancelling the losers of a perfectly healthy pool would
 * have tripped the breaker against the hosts that answered fastest.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-cancel-'));
process.env.MONGODB_URI = '';

const { abortReason, deadlineSignal } = await import('../src/agent/core/budget.js');
const { isHostFault, raceSignal } = await import('../src/agent/services/fetcher.js');
const { breaker } = await import('../src/shared/circuitBreaker.js');

/* ------------------------------------------------ the reason must classify */

test('the cancellation reason is an abort everything downstream recognises', () => {
  const reason = abortReason('retrieval_complete');
  assert.equal(reason.name, 'AbortError', 'name is what the breaker checks');
  assert.equal(reason.message, 'retrieval_complete', 'and it still says why it happened');
});

test('a plain Error is not a cancellation, which is what went wrong', () => {
  assert.equal(isHostFault(new Error('retrieval_complete')), true, 'the old reason counted as a host failure');
  assert.equal(isHostFault(abortReason('retrieval_complete')), false, 'the new one does not');
});

test('both ways of marking an abort are recognised', () => {
  assert.equal(isHostFault({ name: 'AbortError' }), false);
  assert.equal(isHostFault({ code: 'ABORT_ERR' }), false);
  assert.equal(isHostFault(new Error('HTTP 503')), true, 'a real failure is still a real failure');
});

/* ------------------------------------------- through the real breaker */

test('repeatedly cancelling a healthy host never opens its breaker', async () => {
  // The real breaker, configured exactly as the fetcher configures it. A pool
  // that reaches coverage early cancels its losers on every request; if those
  // counted, the fastest hosts would be the first to be skipped.
  const host = breaker('test:fetch:cancellation', { failureThreshold: 3, cooldownMs: 60_000, countsAsFailure: isHostFault });

  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() => host.run(async () => { throw abortReason('retrieval_complete'); }));
  }

  assert.equal(host.snapshot().state, 'closed', 'ten cancellations left the circuit closed');
  assert.equal(host.snapshot().failures, 0, 'and recorded no host failures at all');
});

test('a host that genuinely fails still opens its breaker', async () => {
  // The other half: excluding cancellations must not disarm the protection.
  const host = breaker('test:fetch:realfailure', { failureThreshold: 3, cooldownMs: 60_000, countsAsFailure: isHostFault });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => host.run(async () => { throw new Error('HTTP 503'); }));
  }
  assert.equal(host.snapshot().state, 'open', 'three real failures opened it');
});

test('a mixture counts only the real failures', async () => {
  const host = breaker('test:fetch:mixed', { failureThreshold: 3, cooldownMs: 60_000, countsAsFailure: isHostFault });
  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(() => host.run(async () => { throw abortReason('retrieval_complete'); }));
  }
  await assert.rejects(() => host.run(async () => { throw new Error('HTTP 500'); }));
  assert.equal(host.snapshot().state, 'closed', 'one real failure among eight cancellations is not three');
  assert.equal(host.snapshot().failures, 1);
});

/* ------------------------------------------- waiting on shared work */

test('a cancelled caller stops waiting without cancelling the shared work', async () => {
  // Robots lookups are cached per origin and several runs wait on one promise.
  // Cancelling it for one of them would cancel it for all, so the caller leaves
  // and the lookup carries on to populate the cache for everyone else.
  let settled = false;
  const shared = new Promise((resolve) => setTimeout(() => { settled = true; resolve('rules'); }, 120));

  const leaving = new AbortController();
  const waiting = raceSignal(shared, leaving.signal, 'aborted while waiting for robots.txt');
  setTimeout(() => leaving.abort(abortReason('client_disconnected')), 20);

  const started = Date.now();
  await assert.rejects(() => waiting, (err) => err.name === 'AbortError');
  assert.ok(Date.now() - started < 100, 'the caller left promptly rather than waiting out the lookup');

  assert.equal(await shared, 'rules', 'and the shared lookup still completed');
  assert.equal(settled, true);
});

test('another caller still receives the shared result', async () => {
  const shared = new Promise((resolve) => setTimeout(() => resolve('rules'), 80));
  const leaving = new AbortController();
  const a = raceSignal(shared, leaving.signal, 'aborted');
  const b = raceSignal(shared, AbortSignal.timeout(5000), 'aborted');

  leaving.abort(abortReason('client_disconnected'));
  await assert.rejects(() => a);
  assert.equal(await b, 'rules', 'B was unaffected by A leaving');
});

test('an already-aborted caller does not wait at all', async () => {
  const controller = new AbortController();
  controller.abort(abortReason('client_disconnected'));
  const shared = new Promise((resolve) => setTimeout(() => resolve('rules'), 5000));
  await assert.rejects(() => raceSignal(shared, controller.signal, 'aborted'), (err) => err.name === 'AbortError');
});

test('the abort listener is removed once the race settles', async () => {
  // A long-lived signal shared across many fetches would otherwise accumulate
  // one listener per page for the life of the request.
  //
  // The first version of this asked `signal.listenerCount?.('abort')`, which is
  // undefined on an AbortSignal, so it compared zero with zero and would have
  // passed against any leak at all. getEventListeners actually counts them.
  const controller = new AbortController();
  const count = () => getEventListeners(controller.signal, 'abort').length;
  const before = count();
  for (let i = 0; i < 20; i += 1) await raceSignal(Promise.resolve(i), controller.signal, 'aborted');
  assert.equal(count(), before, `twenty races left no listeners behind (${before} -> ${count()})`);
});

/* --------------------------------------------- reasons from outside */

test('a caller aborting with a plain Error still produces an AbortError downstream', () => {
  // Nothing in this codebase does it today, but a composed signal that forwards
  // whatever it is handed is one caller away from the classification bug
  // returning: the breaker would read the plain Error as the host's fault.
  const outer = new AbortController();
  const { signal, release } = deadlineSignal(60_000, outer.signal);
  try {
    outer.abort(new Error('client_disconnected'));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'AbortError', 'the class is corrected');
    assert.equal(signal.reason.message, 'client_disconnected', 'and the reason is kept');
    assert.equal(isHostFault(signal.reason), false, 'so the breaker does not count it');
  } finally {
    release();
  }
});

test('an outer signal that already carries an AbortError is passed through unchanged', () => {
  const outer = new AbortController();
  const original = abortReason('client_disconnected');
  outer.abort(original);
  const { signal, release } = deadlineSignal(60_000, outer.signal);
  try {
    assert.equal(signal.reason, original, 'a correct reason is not rewrapped');
  } finally {
    release();
  }
});

test('an outer signal aborted before composition is still normalised', () => {
  const outer = new AbortController();
  outer.abort(new Error('too late'));
  const { signal, release } = deadlineSignal(60_000, outer.signal);
  try {
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'AbortError');
    assert.equal(isHostFault(signal.reason), false);
  } finally {
    release();
  }
});
