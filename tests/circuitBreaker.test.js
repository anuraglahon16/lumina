import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../src/shared/circuitBreaker.js';

const failing = () => Promise.reject(new Error('upstream exploded'));
const working = () => Promise.resolve('ok');

test('a breaker opens after the threshold and then fails fast without calling', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 3, cooldownMs: 10_000 });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(cb.run(failing));
  }
  assert.equal(cb.state, 'open');

  // The point of opening: the dependency is not called at all.
  let called = false;
  await assert.rejects(
    cb.run(() => {
      called = true;
      return working();
    }),
    (err) => err.code === 'circuit_open',
  );
  assert.equal(called, false, 'an open circuit must not reach the dependency');
});

test('a caller fault leaves the breaker closed', async () => {
  // One malformed request must not trip a breaker shared by every caller.
  const cb = new CircuitBreaker('test', {
    failureThreshold: 2,
    countsAsFailure: (err) => err.message !== 'bad request',
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(cb.run(() => Promise.reject(new Error('bad request'))));
  }
  assert.equal(cb.state, 'closed');
  assert.equal(cb.failures, 0);
});

test('after the cooldown one probe is admitted and success closes the circuit', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 0 });
  await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'open');

  assert.equal(await cb.run(working), 'ok', 'the probe is allowed through');
  assert.equal(cb.state, 'closed', 'a successful probe closes the circuit');
  assert.equal(cb.snapshot().recovered, 1);
});

test('a failed probe reopens immediately rather than waiting for the threshold again', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 5, cooldownMs: 0 });
  for (let i = 0; i < 5; i += 1) await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'open');

  await assert.rejects(cb.run(failing)); // the probe
  assert.equal(cb.state, 'open', 'one failed probe is enough to reopen');
});

test('breaker state is reportable', async () => {
  const cb = new CircuitBreaker('anthropic', { failureThreshold: 1, cooldownMs: 30_000 });
  await assert.rejects(cb.run(failing));
  const snap = cb.snapshot();
  assert.equal(snap.state, 'open');
  assert.equal(snap.last_error, 'upstream exploded');
  assert.ok(snap.retry_after_ms > 0);
  assert.equal(snap.opened, 1);
});
