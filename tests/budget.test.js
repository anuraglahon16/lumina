import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/agent/core/budget.js';

test('budget refuses tool calls past its limits and names the reason', () => {
  const budget = new Budget({ maxIterations: 3, maxToolCalls: 2, maxFetches: 1, maxSearches: 2, wallClockMs: 60000 });
  assert.equal(budget.allows('fetch_page').ok, true);
  budget.consume('fetch_page');
  assert.equal(budget.allows('fetch_page').reason, 'max_fetches_reached');
  budget.consume('web_search');
  assert.equal(budget.allows('web_search').reason, 'max_tool_calls_reached');
  assert.equal(budget.checkStop(), 'max_tool_calls_reached');
  assert.equal(budget.snapshot().capped, 'max_tool_calls_reached');
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
