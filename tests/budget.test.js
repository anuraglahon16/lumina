import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, deadlineSignal } from '../src/agent/core/budget.js';

test('budget refuses tool calls past its limits and names the reason', () => {
  const budget = new Budget({ maxIterations: 3, maxToolCalls: 2, maxFetches: 1, maxSearches: 2, wallClockMs: 60000 });
  assert.equal(budget.allows('fetch_page').ok, true);
  budget.consume('fetch_page');
  assert.equal(budget.allows('fetch_page').reason, 'max_fetches_reached');
  budget.consume('web_search');
  assert.equal(budget.allows('web_search').reason, 'max_tool_calls_reached');
  assert.equal(budget.checkStop(), 'max_tool_calls_reached');
  // Spending the allocation is not the same event as being refused. `capped`
  // is reserved for a call that was attempted and denied, or for the wall
  // clock; a loop that stops because it has done what it planned finished.
  assert.equal(budget.snapshot().capped, null, 'an allocation spent in full is not a cap');
  assert.equal(budget.allocationSpent, true);

  // And the refusal path still marks it, which is what `cap` is for.
  budget.markCapped('max_tool_calls_reached');
  assert.equal(budget.snapshot().capped, 'max_tool_calls_reached');
});

test('the wall clock is curtailment and is marked as such', () => {
  const budget = new Budget({ maxIterations: 9, maxToolCalls: 9, maxFetches: 9, wallClockMs: -1 });
  assert.equal(budget.checkStop(), 'wall_clock_exceeded');
  assert.equal(budget.snapshot().capped, 'wall_clock_exceeded', 'time taken away is a cap');
  assert.equal(budget.allocationSpent, false);
});

test('wall-clock exhaustion stops a run even with budget left', () => {
  const budget = new Budget({ maxIterations: 9, maxToolCalls: 9, maxFetches: 9, wallClockMs: -1 });
  assert.equal(budget.checkStop(), 'wall_clock_exceeded');
});

test('a failed fetch is refunded, so a blocked site cannot truncate a run', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 3, maxFetches: 3, maxSearches: 3, wallClockMs: 60000 });

  budget.consume('fetch_page');
  assert.equal(budget.refund('fetch_page', 'failed: HTTP 403'), true);
  assert.equal(budget.counts.tool_calls, 0, 'a 403 bought nothing and should cost nothing');
  assert.equal(budget.counts.fetches, 0);

  // A successful call is never refunded: it is what the budget exists to limit.
  budget.consume('fetch_page');
  budget.consume('fetch_page');
  budget.consume('fetch_page');
  assert.equal(budget.allows('fetch_page').ok, false, 'three good fetches must still exhaust the cap');
});

test('refunds are themselves capped, so repeated failures cannot buy unlimited retries', () => {
  const budget = new Budget({ maxIterations: 9, maxToolCalls: 9, maxFetches: 9, maxSearches: 9, wallClockMs: 60000, maxRefunds: 2 });
  for (let i = 0; i < 5; i += 1) {
    budget.consume('fetch_page');
    budget.refund('fetch_page', 'failed: HTTP 403');
  }
  assert.equal(budget.refunds.length, 2, 'only maxRefunds slots are ever returned');
  assert.equal(budget.counts.tool_calls, 3, 'the three unrefunded failures still cost their slot');
  assert.equal(budget.snapshot().refunded, 2);
});

test('the wall clock is never refunded, so the loop always terminates', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60000 });
  budget.deadline = Date.now() - 1;
  budget.consume('fetch_page');
  budget.refund('fetch_page', 'failed: HTTP 403');
  assert.equal(budget.checkStop(), 'wall_clock_exceeded', 'time spent is never returned');
});

test('non-tool budget dimensions are not refundable', () => {
  const budget = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60000 });
  budget.consume('search_documents');
  assert.equal(budget.refund('search_documents', 'no hits'), false);
  assert.equal(budget.counts.tool_calls, 1);
});

/* ------------------------------------------------- the wall clock as a signal */

test('the deadline signal fires on its own, without anything else pending', async () => {
  // AbortSignal.timeout's handle is unref'd, so a signal built on it can fail to
  // fire in a process that has nothing else keeping the event loop open. The
  // timer here is owned for exactly that reason.
  const { signal } = deadlineSignal(30);
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.aborted, true);
});

test('releasing the deadline leaves no timer behind', async () => {
  let expired = false;
  const { release } = deadlineSignal(20, undefined, () => {
    expired = true;
  });
  release();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired, false, 'a call that returned must not later be reported as timed out');
});

test('a caller’s own signal still cancels, before the deadline', () => {
  const outer = new AbortController();
  const { signal } = deadlineSignal(60_000, outer.signal);
  outer.abort();
  assert.equal(signal.aborted, true, 'a disconnected client does not wait out the wall clock');
});

test('a budget’s deadline signal caps the budget when it fires', async () => {
  const b = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 25 });
  const { signal } = b.deadlineSignal();
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(b.capped, 'wall_clock_exceeded', 'the run knows why it stopped, not just that it did');
  assert.equal(b.allows('web_search').ok, false, 'and nothing further is affordable');
});

/* ------------------------------- a cap decided is a cap, not a clock reading */

test('a capped budget refuses every tool, without re-reading the clock', () => {
  // The race this closes: the deadline timer fires and records its cause, and
  // for a moment `Date.now()` is still a hair before the deadline it fired for.
  // A budget that re-derives the answer from the clock then reports a capped
  // run as having room for another search. It showed up as a test that passed
  // alone and failed under load, which is what that shape of bug looks like.
  const b = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 60_000 });
  assert.equal(b.allows('web_search').ok, true, 'plenty of room by every counter');

  // Exactly what the deadline callback does, while the clock still says there
  // is time left.
  b.capped = 'wall_clock_exceeded';
  assert.ok(b.remainingMs > 0, 'the clock has not caught up yet');

  const verdict = b.allows('web_search');
  assert.equal(verdict.ok, false, 'and the budget refuses anyway');
  assert.equal(verdict.reason, 'wall_clock_exceeded', 'naming the cause it recorded');
  assert.equal(b.allows('fetch_page').ok, false, 'for every tool, not just the one that capped it');
});

test('a cap recorded by the deadline signal is what the run reports', async () => {
  // The signal knows why it fired. Asking the clock again a moment later can
  // land just before the deadline and call a wall-clock stop a disconnection.
  const b = new Budget({ maxIterations: 4, maxToolCalls: 6, maxFetches: 4, maxSearches: 3, wallClockMs: 30 });
  const { signal, release } = b.deadlineSignal();
  try {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(b.capped, 'wall_clock_exceeded', 'the cause is recorded at the moment it happens');
    assert.equal(b.allows('web_search').reason, 'wall_clock_exceeded');
  } finally {
    release();
  }
});
