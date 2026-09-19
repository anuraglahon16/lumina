import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which runs the quality gates read, and whether each is described honestly.
 *
 * Two separate things can go wrong here and only one of them is about scoping.
 *
 * The population can be wrong: `quality/check.mjs` asks whether the loop
 * terminates because it finished, and the store holds ad-hoc diagnostic
 * scripts, development traffic from days earlier, and a window when the
 * provider account was out of credit. Judging this build on those judges it on
 * someone else's trajectory.
 *
 * And the records can be wrong. That is the more dangerous one, because it
 * looks like success. `capped` and `max_tokens` were not in the cap list, so 59
 * runs that stopped because they ran out were written to disk as `done` — in
 * the very file A2 reads to find runs that stopped because they ran out. A
 * mapper that hides a rule's subject from the rule defeats it while appearing
 * to satisfy it.
 *
 * Scoping is legitimate. Relabelling is not.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { toRunLog, terminatedOf } = await import('../tools/export-runlogs.mjs');

/* --------------------------------------------- the records describe themselves */

test('a run that ran out of budget is never written as done', () => {
  for (const reason of [
    'capped',
    'max_tokens',
    'max_tool_calls_reached',
    'max_searches_reached',
    'max_iterations_reached',
    'wall_clock_exceeded',
    'deep_tool_budget_exhausted',
  ]) {
    assert.equal(terminatedOf({ status: 'ok', termination_reason: reason }), 'cap', `${reason} is a cap`);
  }
});

test('a run that finished is done, including one that found little', () => {
  assert.equal(terminatedOf({ status: 'ok', termination_reason: 'sufficient_evidence' }), 'done');
  assert.equal(terminatedOf({ status: 'ok', termination_reason: 'completed' }), 'done');
  // Thin evidence is a result, not a cap: the run searched, found little, and
  // said so. Calling that a cap would report honest reporting as failure.
  assert.equal(terminatedOf({ status: 'ok', termination_reason: 'evidence_limited' }), 'done');
});

test('an errored run is never reported as successful', () => {
  assert.equal(terminatedOf({ status: 'error', termination_reason: 'completed' }), 'error', 'status wins over reason');
  assert.equal(terminatedOf({ status: 'ok', errors: [{ where: 'llm', message: 'boom' }] }), 'error', 'a recorded error is an error');
});

test('a failed tool call always carries a non-empty error string', () => {
  // A1 is a red line and reads exactly this. A failure indistinguishable from
  // an empty result is the bug the rule exists to catch, so a record that lost
  // the message says so rather than emitting '' and passing.
  const log = toRunLog({
    status: 'ok',
    termination_reason: 'completed',
    tool_calls: [
      { name: 'web_search', ok: true, duration_ms: 10 },
      { name: 'fetch_page', ok: false, duration_ms: 5 },
      { name: 'fetch_page', ok: false, duration_ms: 5, error: 'HTTP 403' },
    ],
  });
  const failures = log.toolCalls.filter((t) => !t.ok);
  assert.equal(failures.length, 2);
  for (const f of failures) assert.ok(f.error && f.error.trim().length > 0, 'every failure names itself');
  assert.equal(failures[1].error, 'HTTP 403', 'and keeps the real message when there is one');
});

/* ------------------------------------------------- the population is auditable */

test('the exported population is described on disk, not left to be guessed', () => {
  const provenance = path.join(ROOT, 'reports', 'run-population.md');
  assert.ok(fs.existsSync(provenance), 'reports/run-population.md records which runs were evaluated and why');
  const text = fs.readFileSync(provenance, 'utf8');
  assert.match(text, /bench/, 'it names the objective identifier used');
  assert.match(text, /\d{4}-\d{2}-\d{2}T/, 'and the window');
});

test('failures are preserved rather than deleted', () => {
  // runs/failing/ exists so the P1 trajectory stays readable and the count of
  // genuine failures stays reportable. It is not a place failures go to be
  // forgotten: build-report reads it, and this asserts it is populated.
  const failing = path.join(ROOT, 'runs', 'failing');
  assert.ok(fs.existsSync(failing), 'the directory exists');
  const files = fs.readdirSync(failing).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'and genuine failures are kept in it');

  for (const f of files.slice(0, 20)) {
    const log = JSON.parse(fs.readFileSync(path.join(failing, f), 'utf8'));
    assert.equal(log.terminated, 'error', `${f} is there because it errored, not because it was inconvenient`);
  }
});

test('the evaluated population contains no run that errored', () => {
  // Errors live in runs/failing/. A run in runs/ claiming `error` would mean
  // the split silently failed and the gates are reading a mixed population.
  const dir = path.join(ROOT, 'runs');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'there is a population to check');

  const errored = files.filter((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).terminated === 'error');
  assert.deepEqual(errored, [], 'errors belong in runs/failing/');
});

test('the population is the benchmark window, not everything in the store', () => {
  // The store holds well over a thousand runs across several days. A population
  // the size of the store means the scope flag was not used and the gates are
  // reading development traffic.
  const files = fs.readdirSync(path.join(ROOT, 'runs')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length < 500, `${files.length} runs is the whole store, not one evaluation`);
});
