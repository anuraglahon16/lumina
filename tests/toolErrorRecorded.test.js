import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A failed tool call records why it failed.
 *
 * `error` was never passed to `recordToolCall` on the normal return path, so
 * only a tool that *threw* stored a reason. A tool that returned
 * `{ ok: false }` put its reason in `summary` and left `error` null — and the
 * exporter then wrote "error not recorded in the run log" into the trajectory.
 * Seven fetch_page failures in a 90-run benchmark looked like that, with
 * `summary: "failed: HTTP 403"` sitting in the same document. A non-empty
 * string that passes rule A1 and tells a reader nothing is the Live Translate
 * failure in miniature: the shape of a record without its content.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-toolerr-'));
process.env.MONGODB_URI = '';

const { toolCallsOf } = await import('../tools/export-runlogs.mjs');
const { createToolExecutor } = await import('../src/agent/core/tools.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');

test('the exporter prefers the stored error', () => {
  const [call] = toolCallsOf({ tool_calls: [{ name: 'fetch_page', ok: false, error: 'HTTP 403', summary: 'failed: HTTP 403' }] });
  assert.equal(call.error, 'HTTP 403');
});

test('the exporter recovers a reason the writer left in the summary', () => {
  const rows = toolCallsOf({
    tool_calls: [
      { name: 'fetch_page', ok: false, error: null, summary: 'failed: HTTP 403' },
      { name: 'fetch_page', ok: false, error: null, summary: 'failed: disallowed by robots.txt' },
      { name: 'web_search', ok: false, error: null, summary: '0 results (tavily)' },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.error),
    ['HTTP 403', 'disallowed by robots.txt', '0 results (tavily)'],
  );
  for (const r of rows) assert.doesNotMatch(r.error, /not recorded/, 'the reason was there to be found');
});

test('a failure with nothing recorded anywhere says so, rather than passing quietly', () => {
  const [call] = toolCallsOf({ tool_calls: [{ name: 'fetch_page', ok: false, error: null, summary: null }] });
  assert.equal(call.error, 'error not recorded in the run log');
  assert.ok(call.error.length > 0, 'never an empty string, which rule A1 would read as a silent failure');
});

test('a successful call carries no error field', () => {
  const [call] = toolCallsOf({ tool_calls: [{ name: 'web_search', ok: true, summary: '7 results via tavily' }] });
  assert.equal(call.ok, true);
  assert.ok(!('error' in call), 'no error key on a call that worked');
});

/**
 * The writer side. Driven through the real executor rather than asserted
 * against the source, because the bug was a field that was simply not passed —
 * exactly the kind of thing a source-reading test misses and a round trip
 * catches.
 */
const executorWith = (fetchPage, recorded) =>
  createToolExecutor({
    ledger: new EvidenceLedger(),
    budget: new Budget({ maxToolCalls: 8, maxWallClockMs: 90000 }),
    recorder: {
      recordToolCall: (c) => recorded.push(c),
      recordRefusal: () => {},
      recordLlmCall: () => {},
      noteSearch: () => {},
    },
    userId: 'u_test',
    fetchPage,
  });

test('a tool that returns ok:false has its reason recorded, not just summarised', async () => {
  const recorded = [];
  // A page that fails the way a real 403 fails: a reason, and no exception.
  const execute = executorWith(async (url) => ({ ok: false, url, status: 403, error: 'HTTP 403', cached: false }), recorded);

  const result = await execute('fetch_page', { url: 'https://paywalled.example.com/a', reason: 'testing' });
  assert.equal(result.ok, false);

  assert.equal(recorded.length, 1, 'the call was recorded');
  const [call] = recorded;
  assert.equal(call.ok, false);
  assert.equal(call.error, 'HTTP 403', 'the reason reaches the error field, not only the summary');
  assert.match(call.summary, /HTTP 403/, 'and the summary still says it too');

  // The whole point: the exporter must not have to invent anything.
  const [exported] = toolCallsOf({ tool_calls: [{ ...call, duration_ms: call.durationMs }] });
  assert.equal(exported.error, 'HTTP 403');
});

test('a tool that throws still records its reason', async () => {
  const recorded = [];
  const execute = executorWith(async () => {
    throw new Error('socket hang up');
  }, recorded);

  await execute('fetch_page', { url: 'https://broken.example.com/a', reason: 'testing' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ok, false);
  assert.equal(recorded[0].error, 'socket hang up');
});

test('a fetch that fails with no message still produces a usable reason', async () => {
  const recorded = [];
  const execute = executorWith(async (url) => ({ ok: false, url, status: null, error: null, cached: false }), recorded);
  await execute('fetch_page', { url: 'https://silent.example.com/a', reason: 'testing' });
  assert.equal(recorded[0].error, 'fetch failed with no reason given', 'stated, not left null for the exporter to guess at');
});
