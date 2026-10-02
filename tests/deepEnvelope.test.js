import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The engine's deep envelope is the one the grader enforces.
 *
 * They had drifted. `config.budgets.deep.wallClockMs` was 420000 while
 * `expectations.json` declares `budget.maxWallClockSec: 240`, and
 * `quality/check.mjs` fails any run over it - so a deep run lasting between four
 * and seven minutes satisfied its own deadline and failed the grader, having
 * spent the whole time to get there. `expectations.json` is the authority and is
 * not ours to edit, so these read it rather than restating its numbers.
 *
 * The synthesis ceiling was 300000, larger than the whole envelope, which made
 * it no ceiling at all: a stalled synthesis would have been ended by the run
 * deadline instead, later and under a different name.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-envelope-'));
process.env.MONGODB_URI = '';

const { config } = await import('../src/shared/config.js');
const expectations = JSON.parse(fs.readFileSync(new URL('../expectations.json', import.meta.url), 'utf8'));

test('the deep wall clock does not exceed what quality/check.mjs allows', () => {
  const cap = expectations.budget?.maxWallClockSec;
  assert.ok(Number.isFinite(cap), 'expectations.json declares the cap');
  assert.ok(
    config.budgets.deep.wallClockMs <= cap * 1000,
    `deep may run ${config.budgets.deep.wallClockMs / 1000}s against a graded ceiling of ${cap}s`,
  );
});

test('the deep tool-call pool does not exceed what the grader allows', () => {
  const cap = expectations.budget?.maxToolCalls;
  if (!Number.isFinite(cap)) return;
  assert.ok(
    config.budgets.deep.maxToolCallsTotal <= cap,
    `the pool allows ${config.budgets.deep.maxToolCallsTotal} against a graded ceiling of ${cap}`,
  );
});

test('the quick envelope stays inside its own, tighter numbers', () => {
  // bench.mjs holds quick to 8 tool calls and sla.json to answer_p95_ms.
  const sla = JSON.parse(fs.readFileSync(new URL('../benchmark/sla.json', import.meta.url), 'utf8')).sla;
  assert.ok(config.budgets.quick.maxToolCalls <= 8, `quick may make ${config.budgets.quick.maxToolCalls} tool calls against a checked envelope of 8`);
  assert.ok(
    config.budgets.quick.wallClockMs <= expectations.budget.maxWallClockSec * 1000,
    'and cannot outlast the deep envelope either',
  );
  assert.ok(Number.isFinite(sla.answer_p95_ms), 'sla.json still declares the quick latency target');
});

test('a ceiling inside the run is smaller than the run', () => {
  const d = config.budgets.deep;
  assert.ok(d.synthesisCeilingMs < d.wallClockMs, `synthesis ceiling ${d.synthesisCeilingMs}ms is not inside a ${d.wallClockMs}ms run`);
  assert.ok(d.planCeilingMs < d.wallClockMs, 'and neither is the plan ceiling');
  const q = config.budgets.quick;
  assert.ok(q.synthesisCeilingMs <= q.wallClockMs, `quick synthesis ceiling ${q.synthesisCeilingMs}ms is not inside a ${q.wallClockMs}ms run`);
});

/* ------------------------------------------- the ceiling is measured from now */

/**
 * A ceiling inside a run has to be measured against the run's deadline.
 *
 * Both synthesis calls passed the bare configured ceiling, which starts counting
 * whenever research happens to finish. For quick that ceiling is 90000 - exactly
 * the whole quick envelope - so research spending 60s and synthesis then being
 * allowed its full 90s is a 150s run against a 90s budget. For deep it is 180s
 * inside a 240s envelope, so research spending 100s makes a 280s run. Neither
 * overran any individual limit; the run overran.
 *
 * Driven with a research phase that deliberately eats most of the budget, and a
 * synthesis that would happily run far past the end if it were allowed to.
 */

test('the ceiling handed to synthesis is the time remaining, not the configured value', () => {
  for (const [f, needle] of [
    ['src/agent/core/quick.js', /ceilingMs: Math\.min\(config\.budgets\.quick\.synthesisCeilingMs, budget\.remainingMs\)/],
    ['src/agent/core/deep.js', /ceilingMs: Math\.min\(limits\.synthesisCeilingMs, Math\.max\(0, deadline - Date\.now\(\)\)\)/],
  ]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, needle, `${f} bounds the ceiling by what the run has left`);
  }
});
