import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Run accounting: cost arithmetic and the percentile maths.
 *
 * Every number anyone looks at comes from here. The evaluation report, the
 * footer under each answer, the decision about which model to route to, the
 * judgement of whether a change made things faster or cheaper. An error in this
 * file does not produce a broken system; it produces a system that reports
 * confidently and wrongly, which is worse, because the numbers are exactly what
 * you would use to check.
 *
 * The store is a module-level singleton reading DATA_DIR at import, so the
 * import is deferred until the environment points somewhere disposable.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-runlog-'));
process.env.MONGODB_URI = '';
const { RunRecorder, listRuns, runStats } = await import('../src/agent/store/runLog.js');
const { priceFor, PRICING } = await import('../src/shared/config.js');

const recorder = (over = {}) =>
  new RunRecorder({ requestId: 'req_1', userId: 'u1', threadId: null, mode: 'quick', query: 'q', model: 'claude-sonnet-5', ...over });

/* --------------------------------------------------------------- pricing */

test('a call is priced from its own model, not from a global default', () => {
  // Routing sends different purposes to different models, so a run's cost is a
  // sum over models. Pricing every call at one rate would misreport every
  // routed run.
  const r = recorder();
  const cost = r.recordLlmCall({
    model: 'claude-sonnet-5',
    purpose: 'research',
    usage: { input_tokens: 1000, output_tokens: 500 },
    durationMs: 10,
  });
  // sonnet-5: $2/MTok in, $10/MTok out
  assert.equal(Number(cost.toFixed(6)), Number(((1000 * 2 + 500 * 10) / 1e6).toFixed(6)));
});

test('cached tokens are priced at their own rates, not as fresh input', () => {
  const r = recorder();
  const cost = r.recordLlmCall({
    model: 'claude-sonnet-5',
    purpose: 'research',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 1_000 },
    durationMs: 1,
  });
  const p = PRICING['claude-sonnet-5'];
  assert.equal(Number(cost.toFixed(6)), Number(((10_000 * p.cacheRead + 1_000 * p.cacheWrite) / 1e6).toFixed(6)));
  assert.ok(cost > 0, 'a cache read is cheaper than input but is not free');
});

test('an unknown model is priced at the most expensive known rate', () => {
  // Overstating spend is visible and annoying; understating it hides real cost,
  // so an unrecognised id must never look cheap.
  const unknown = priceFor('claude-not-a-real-model');
  const dearest = Object.values(PRICING).reduce((a, b) => (b.output > a.output ? b : a));
  assert.deepEqual(unknown, dearest);
});

test('a run accumulates cost and tokens across several calls', () => {
  const r = recorder();
  r.recordLlmCall({ model: 'claude-sonnet-5', purpose: 'research', usage: { input_tokens: 1000, output_tokens: 100 }, durationMs: 5 });
  r.recordLlmCall({ model: 'claude-haiku-4-5', purpose: 'memory_extraction', usage: { input_tokens: 500, output_tokens: 50 }, durationMs: 5 });
  const snap = r.snapshot();
  assert.equal(snap.tokens.input, 1500);
  assert.equal(snap.tokens.output, 150);
  assert.equal(snap.llm_calls.length, 2);
  assert.ok(snap.cost_usd > 0);
  assert.equal(snap.llm_calls[1].model, 'claude-haiku-4-5', 'each call records the model that ran it');
});

test('a model call is timestamped, so a trace can order it against tool calls', () => {
  // Without this the reconstructed trace put every model call at t=0.
  const r = recorder();
  r.recordLlmCall({ model: 'claude-sonnet-5', purpose: 'research', usage: {}, durationMs: 5 });
  assert.equal(typeof r.snapshot().llm_calls[0].at_ms, 'number');
});

/* ------------------------------------------------------------ percentiles */

/**
 * finish() derives latency from the wall clock, so a seeded run is aged by
 * moving its start point back rather than by writing the field: setting it
 * directly would be overwritten, and the test would then be asserting against
 * whatever the machine happened to measure.
 */
async function seed(runs) {
  for (const spec of runs) {
    const r = recorder(spec.over || {});
    if (spec.latency !== undefined) r.t0 = performance.now() - spec.latency;
    if (spec.ttft !== undefined) r.run.ttft_ms = spec.ttft;
    if (spec.cost !== undefined) r.run.cost_usd = spec.cost;
    if (spec.cache) r.run.cache = { ...r.run.cache, ...spec.cache };
    r.run.user_id = spec.user || 'stats_user';
    await r.finish({ status: 'ok', terminationReason: spec.termination || 'completed' });
  }
}

test('percentiles are ordered and bounded by the data', async () => {
  await seed([10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => ({ latency: n * 10, ttft: n, cost: 0.01 })));
  const s = await runStats({ userId: 'stats_user' });
  assert.equal(s.runs, 10);
  assert.ok(s.latency_ms.p50 <= s.latency_ms.p95, 'p50 must not exceed p95');
  assert.ok(s.latency_ms.p95 <= s.latency_ms.max);
  assert.ok(s.latency_ms.max >= 990 && s.latency_ms.max <= 1100, `max should be about 1000, was ${s.latency_ms.max}`);
});

test('cost totals and averages agree with each other', async () => {
  const s = await runStats({ userId: 'stats_user' });
  assert.ok(Math.abs(s.cost_usd.total - s.cost_usd.avg * s.runs) < 0.01, 'avg times count should reconstruct the total');
});

test('cache hit rate is a ratio of hits to attempts, and null when nothing was attempted', async () => {
  await seed([
    { latency: 1, cache: { hits: 3, misses: 1 }, user: 'cache_user' },
    { latency: 1, cache: { hits: 1, misses: 3 }, user: 'cache_user' },
  ]);
  const s = await runStats({ userId: 'cache_user' });
  assert.equal(s.cache_hit_rate, 0.5, '4 hits of 8 attempts');

  await seed([{ latency: 1, user: 'nocache_user' }]);
  const none = await runStats({ userId: 'nocache_user' });
  assert.equal(none.cache_hit_rate, null, 'no attempts is not a zero hit rate');
});

test('an empty result is reported as zero runs, not as broken statistics', async () => {
  const s = await runStats({ userId: 'nobody_at_all' });
  assert.deepEqual(s, { runs: 0 });
});

test('runs missing a measurement do not corrupt the percentiles', async () => {
  // A run that errored before first token has no ttft. Treating that as 0 would
  // drag the percentile down and make the system look faster than it is.
  await seed([
    { latency: 100, ttft: 50, user: 'partial_user' },
    { latency: 200, user: 'partial_user' },
  ]);
  const s = await runStats({ userId: 'partial_user' });
  assert.ok(s.ttft_ms.p50 >= 50, 'the one real ttft is not diluted by a missing one');
  assert.equal(s.runs, 2);
});

test('stats are scoped by user, so one user never sees another’s numbers', async () => {
  const mine = await runStats({ userId: 'stats_user' });
  const theirs = await runStats({ userId: 'cache_user' });
  assert.notEqual(mine.runs, theirs.runs);
});

test('runs are grouped by mode and by why they stopped', async () => {
  await seed([
    { latency: 1, termination: 'completed', over: { mode: 'quick' }, user: 'group_user' },
    { latency: 1, termination: 'max_tool_calls_reached', over: { mode: 'quick' }, user: 'group_user' },
    { latency: 1, termination: 'completed', over: { mode: 'deep' }, user: 'group_user' },
  ]);
  const s = await runStats({ userId: 'group_user' });
  assert.equal(s.by_mode.quick, 2);
  assert.equal(s.by_mode.deep, 1);
  assert.equal(s.by_termination_reason.completed, 2);
  assert.equal(s.by_termination_reason.max_tool_calls_reached, 1);
});

test('listRuns filters rather than returning everything', async () => {
  const { items } = await listRuns({ userId: 'group_user', mode: 'deep' }, { limit: 50 });
  assert.ok(items.length >= 1);
  assert.ok(items.every((r) => r.mode === 'deep' && r.user_id === 'group_user'));
});
