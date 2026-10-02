import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A ceiling inside a run is measured against the run's deadline, not from
 * whenever the previous phase happened to finish.
 *
 * Both synthesis calls passed the bare configured ceiling. For quick that
 * ceiling is 90000 — exactly the whole quick envelope — so research spending 60s
 * and synthesis then being allowed its full 90s is a 150s run against a 90s
 * budget. For deep it was 180s inside a 240s envelope, so research spending 100s
 * makes a 280s run. Neither phase overran a limit of its own; the run overran.
 *
 * Two things this file had to learn the hard way:
 *
 *   - `config` is a module singleton read at import, so the envelope has to be
 *     shortened before anything imports it. Set after the import, it changes a
 *     fresh copy and not the one the run uses — which made an earlier version
 *     "fail" at 5553ms against a 1200ms envelope while measuring the real 90s
 *     budget.
 *   - `runQuickQuery` has no injection seams, so the quick path cannot be driven
 *     without a network. Deep has them, the arithmetic is the same, and quick's
 *     is asserted against a real Budget instead of a fake run.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-envdeadline-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'unused';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';
// Small, so "research ate most of the budget" costs a second of real time
// rather than four minutes. The arithmetic under test is scale-free.
const ENVELOPE_MS = 3000;
process.env.DEEP_WALL_CLOCK_MS = String(ENVELOPE_MS);

const { config } = await import('../src/shared/config.js');
const { Budget } = await import('../src/agent/core/budget.js');
const { runDeepQuery } = await import('../src/agent/core/deep.js');

const PAGE = 'Independent streams at the transport layer remove head-of-line blocking. '.repeat(6);

test('the fixture really shortened the envelope', () => {
  assert.equal(config.budgets.deep.wallClockMs, ENVELOPE_MS, 'otherwise the test measures the real budget');
  assert.ok(
    config.budgets.deep.synthesisCeilingMs > ENVELOPE_MS,
    `the configured ceiling (${config.budgets.deep.synthesisCeilingMs}ms) is larger than the envelope, which is the case that bites`,
  );
});

test('a deep run whose research ate the budget still ends inside the envelope', async () => {
  const PLAN = {
    interpretation: 'a multi-part question',
    sub_questions: [
      { id: 'q1', question: 'how ranking fusion combines two ordered candidate lists', why: 'because' },
      { id: 'q2', question: 'what latency cost a reranking stage adds to retrieval', why: 'also' },
      { id: 'q3', question: 'which chunk size preserves citation precision', why: 'and' },
    ],
  };

  let handed = null;
  let handedAt = null;
  const startedAt = Date.now();

  /** Slow enough that research consumes most of the envelope. */
  const slowSearch = async (query) => {
    await new Promise((r) => setTimeout(r, Math.round(ENVELOPE_MS * 0.25)));
    return { results: [{ url: `https://example.test/${encodeURIComponent(query).slice(0, 12)}`, title: query, snippet: 'lead' }], provider: 'stub', cached: false };
  };
  const fetchPage = async (url) => ({
    ok: true, url, final_url: url, status: 200, title: 'a page',
    text: PAGE, fetched_at: new Date().toISOString(), duration_ms: 1, timings: {},
  });

  const seen = new Map();
  /** Plans, researches, then synthesises — honouring whatever ceiling it is given. */
  const model = async (params) => {
    const purpose = params.purpose || '';
    if (purpose === 'plan') return { content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: {} };
    if (purpose.startsWith('research:')) {
      const b = purpose.slice('research:'.length);
      const n = (seen.get(b) ?? 0) + 1;
      seen.set(b, n);
      if (n === 1) return { content: [{ type: 'tool_use', id: `s${b}`, name: 'web_search', input: { query: `lead ${b}` } }], stop_reason: 'tool_use', usage: {} };
      return { content: [{ type: 'text', text: `notes ${b}` }], stop_reason: 'end_turn', usage: {} };
    }
    // Synthesis. Record the ceiling it was handed and respect it, the way the
    // real streamComplete does by composing it into an AbortSignal.
    handed = params.ceilingMs;
    handedAt = Date.now() - startedAt;
    params.onText?.('The merged answer [1]');
    await new Promise((r) => setTimeout(r, Math.min(params.ceilingMs ?? 60_000, 60_000)));
    return { content: [{ type: 'text', text: 'The merged answer [1]' }], stop_reason: 'end_turn', usage: {} };
  };

  await runDeepQuery({
    query: 'a genuinely multi-part question',
    userId: `usr_env_${Math.random().toString(36).slice(2, 8)}`,
    threadId: null,
    requestId: `req_env_${Math.random().toString(36).slice(2, 8)}`,
    complete: model,
    webSearch: slowSearch,
    fetchPage,
    emit: () => {},
  }).catch(() => {});
  const elapsed = Date.now() - startedAt;

  assert.ok(handed !== null, 'synthesis was reached and handed a ceiling');
  assert.ok(
    handed < config.budgets.deep.synthesisCeilingMs,
    `the configured ${config.budgets.deep.synthesisCeilingMs}ms was passed through unchanged`,
  );
  // The point: the ceiling plus the time already spent fits in the envelope.
  assert.ok(
    handedAt + handed <= ENVELOPE_MS + 100,
    `synthesis started at ${handedAt}ms with a ${handed}ms ceiling, ending at ${handedAt + handed}ms against a ${ENVELOPE_MS}ms envelope`,
  );
  assert.ok(elapsed < ENVELOPE_MS + 3000, `the run took ${elapsed}ms against a ${ENVELOPE_MS}ms envelope`);
});

test("quick's ceiling is bounded by what its budget has left", () => {
  // runQuickQuery takes no seams, so the expression is exercised against a real
  // Budget rather than a faked run. This is the same `Math.min` the call site
  // uses, with the same inputs.
  const budget = new Budget({ ...config.budgets.quick, wallClockMs: 1000 }, { label: 'quick' });
  const ceiling = config.budgets.quick.synthesisCeilingMs;

  assert.ok(ceiling > 1000, 'the configured ceiling exceeds this budget, which is the case that bites');
  assert.ok(budget.remainingMs <= 1000, 'a fresh budget has its envelope left');
  assert.equal(Math.min(ceiling, budget.remainingMs), budget.remainingMs, 'so the remaining time is what wins');

  // And once the budget is spent, synthesis gets nothing rather than a fresh 90s.
  budget.deadline = Date.now() - 1;
  assert.equal(budget.remainingMs, 0);
  assert.equal(Math.min(ceiling, budget.remainingMs), 0, 'a spent run does not get a new ceiling');
});

test('both call sites bound the ceiling by the deadline', () => {
  for (const [f, needle] of [
    ['src/agent/core/quick.js', /ceilingMs: Math\.min\(config\.budgets\.quick\.synthesisCeilingMs, budget\.remainingMs\)/],
    ['src/agent/core/deep.js', /ceilingMs: Math\.min\(limits\.synthesisCeilingMs, Math\.max\(0, deadline - Date\.now\(\)\)\)/],
  ]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, needle, `${f} bounds the ceiling by what the run has left`);
  }
});
