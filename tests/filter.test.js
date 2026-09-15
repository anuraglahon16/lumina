import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, compact } from '../src/agent/store/filter.js';

const failing = () => Promise.reject(new Error('upstream exploded'));

/**
 * The filter language is the seam between the two stores: the JSON store
 * evaluates it in memory, MongoDB runs it as a query. If the two ever disagree,
 * a user sees another user's data or none of their own, so the semantics are
 * pinned here rather than inferred from whichever backend is configured.
 */

test('equality matches on value, and a missing field never matches', () => {
  assert.equal(matchesFilter({ user_id: 'u1' }, { user_id: 'u1' }), true);
  assert.equal(matchesFilter({ user_id: 'u2' }, { user_id: 'u1' }), false);
  assert.equal(matchesFilter({}, { user_id: 'u1' }), false);
});

test('an empty filter matches everything, which is what list() with no filter means', () => {
  assert.equal(matchesFilter({ a: 1 }, {}), true);
  assert.equal(matchesFilter({}, {}), true);
});

test('multiple fields are a conjunction, never a disjunction', () => {
  const item = { user_id: 'u1', mode: 'quick' };
  assert.equal(matchesFilter(item, { user_id: 'u1', mode: 'quick' }), true);
  assert.equal(matchesFilter(item, { user_id: 'u1', mode: 'deep' }), false, 'one mismatch must reject the item');
});

test('$in and $nin', () => {
  assert.equal(matchesFilter({ doc_id: 'd1' }, { doc_id: { $in: ['d1', 'd2'] } }), true);
  assert.equal(matchesFilter({ doc_id: 'd9' }, { doc_id: { $in: ['d1', 'd2'] } }), false);
  assert.equal(matchesFilter({ status: 'queued' }, { status: { $nin: ['failed'] } }), true);
  assert.equal(matchesFilter({ status: 'failed' }, { status: { $nin: ['failed'] } }), false);
});

test('$ne, $exists and the range operators', () => {
  assert.equal(matchesFilter({ status: 'ok' }, { status: { $ne: 'failed' } }), true);
  assert.equal(matchesFilter({ job_id: 'j1' }, { job_id: { $exists: true } }), true);
  assert.equal(matchesFilter({}, { job_id: { $exists: false } }), true);
  assert.equal(matchesFilter({ n: 5 }, { n: { $gte: 5 } }), true);
  assert.equal(matchesFilter({ n: 4 }, { n: { $gte: 5 } }), false);
  assert.equal(matchesFilter({ n: 4 }, { n: { $lt: 5 } }), true);
});

test('an unsupported operator throws rather than matching everything', () => {
  // Silently ignoring one would return rows the caller did not ask for, which
  // is worse than failing: it looks like the filter worked.
  assert.throws(() => matchesFilter({ a: 1 }, { a: { $regex: 'x' } }), /unsupported filter operator/);
});

test('compact drops absent constraints so "no filter on this field" is expressible', () => {
  assert.deepEqual(compact({ user_id: 'u1', mode: undefined, thread_id: null }), { user_id: 'u1' });
  assert.deepEqual(compact(undefined), {});
  // A falsy-but-real value must survive, or filtering on 0 or "" breaks.
  assert.deepEqual(compact({ count: 0, name: '' }), { count: 0, name: '' });
});
