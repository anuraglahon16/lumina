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
