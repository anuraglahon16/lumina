import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a deep run says about why it stopped.
 *
 * A2 ("the loop terminates because it finished") was failing on runs that had
 * finished, and passing on runs that had not. The cause was one expression:
 * `slots.exhausted ? slots.capReason : ...`. `exhausted` means the pool is
 * full; `capReason` means the pool refused someone. A run that took its 24th
 * slot and never asked for a 25th had the first true and the second null, so
 * the expression evaluated to null, `finish()` skipped the assignment, and the
 * run persisted with no reason at all — which the contract reads as `done`.
 *
 * Measured on the deployed benchmark, that inverted the report: the three runs
 * where all four branches hit their ceiling recorded `null` and counted as
 * finished, while three runs where only some branches hit it recorded `capped`.
 *
 * The rule under test: a full counter is not a cap. A refusal is.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deepterm-'));
process.env.MONGODB_URI = '';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
process.env.MEMORY_EXTRACT_ENABLED = 'false';
process.env.EMBEDDING_PROVIDER = 'local';

const { terminationFor } = await import('../src/agent/core/deep.js');
const { ToolSlots } = await import('../src/agent/core/budget.js');

/* --------------------------------------------------- the four cases, stated */

test('exactly 24 completed tool calls is done, not cap', () => {
  // The case that was reported backwards. Every slot used, nothing refused.
  const slots = new ToolSlots(24);
  for (let i = 0; i < 24; i += 1) {
    const permit = slots.tryClaim();
    assert.ok(permit, `claim ${i + 1} of 24 succeeded`);
    slots.settle(permit);
  }
  assert.equal(slots.claimed, 24);
  assert.equal(slots.exhausted, true, 'the pool is full');
  assert.equal(slots.capReason, null, 'and nobody was refused');

  assert.equal(terminationFor({ truncated: false, refusedReason: slots.capReason, curtailed: false }), 'completed');
});

test('a refused 25th call is a cap, and says which budget refused it', () => {
  const slots = new ToolSlots(24);
  for (let i = 0; i < 24; i += 1) slots.settle(slots.tryClaim());

  const refused = slots.tryClaim();
  assert.equal(refused, null, 'the 25th is refused');
  assert.equal(slots.capReason, 'deep_tool_budget_exhausted');

  assert.equal(terminationFor({ truncated: false, refusedReason: slots.capReason, curtailed: true }), 'deep_tool_budget_exhausted');
});

test('a deadline, or a sub-question never researched, is a cap', () => {
  // What curtails a run: the wall clock, or a planned branch that produced
  // nothing. A per-branch ceiling on its own is not here, deliberately - the
  // sub-question it bounded was still researched and synthesised.
  assert.equal(terminationFor({ truncated: false, refusedReason: null, curtailed: true }), 'capped');
  assert.equal(terminationFor({ truncated: false, refusedReason: null, curtailed: false }), 'completed');
});

test('a branch refused a further call makes the run a cap', () => {
  // `markCapped` fires only when a call was attempted and denied - by the
  // branch's own gate or by the shared pool - so a branch marked capped means
  // the run asked for more and was told no. That is the cap the label is for,
  // and it stays a cap even though the sub-question was still answered.
  assert.equal(terminationFor({ truncated: false, refusedReason: null, curtailed: true }), 'capped');
});

test('a token ceiling outranks everything below it', () => {
  assert.equal(terminationFor({ truncated: true, refusedReason: null, curtailed: false }), 'max_tokens');
  assert.equal(terminationFor({ truncated: true, refusedReason: 'deep_tool_budget_exhausted', curtailed: true }), 'max_tokens');
});

test('a genuine failure stays an error, set by the catch and not by this rule', () => {
  // `error` is not one of this function's outcomes: a run that threw has no
  // budget story to tell, and deep.js records it directly. Pinned so that a
  // later refactor does not route failures through here and lose them.
  const source = fs.readFileSync(new URL('../src/agent/core/deep.js', import.meta.url), 'utf8');
  assert.match(source, /recorder\.finish\(\{ status: 'error', terminationReason: 'error' \}\)/);
  for (const out of ['completed', 'capped', 'max_tokens', 'deep_tool_budget_exhausted']) {
    assert.notEqual(out, 'error');
  }
});

/* ------------------------------------------------------ and never undefined */

test('the rule always names a reason', () => {
  // The defect was a null reason, which persisted as "no reason recorded" and
  // read as done. Every combination must produce a string.
  for (const truncated of [true, false]) {
    for (const refusedReason of [null, undefined, 'deep_tool_budget_exhausted']) {
      for (const curtailed of [true, false]) {
        const out = terminationFor({ truncated, refusedReason, curtailed });
        assert.equal(typeof out, 'string', `null reason for ${JSON.stringify({ truncated, refusedReason, curtailed })}`);
        assert.ok(out.length > 0);
      }
    }
  }
});

test('the old expression really did produce null, so this is not a theory', () => {
  const slots = new ToolSlots(24);
  for (let i = 0; i < 24; i += 1) slots.settle(slots.tryClaim());
  // Exactly what deep.js used to evaluate.
  const old = false ? 'max_tokens' : slots.exhausted ? slots.capReason : false ? 'capped' : 'completed';
  assert.equal(old, null, 'the previous rule returned null for a run that finished');
  assert.equal(terminationFor({ truncated: false, refusedReason: slots.capReason, curtailed: false }), 'completed');
});
