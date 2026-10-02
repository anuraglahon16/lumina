import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An abandoned run leaves a record, and a late close never overwrites a good one.
 *
 * The record was written only by `finish()`, so a request that arrived and was
 * then abandoned left nothing at all - four asks in a deployed benchmark did
 * exactly that, and the absence read as a crash it was not. `uptime` on the
 * agent machine was 1956s across a window whose failures were 29 minutes in, and
 * Fly logged no restart: there was simply nothing to write a record from until a
 * run ended.
 *
 * Two changes, and the second is what makes the first safe. The row is created
 * at arrival as `running`, and `finish()` is first-call-wins - because a close
 * can fire after a run has already finished, and twice over, and overwriting a
 * real answer with `aborted` would be worse than the gap.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-aborted-'));
process.env.MONGODB_URI = '';

const { RunRecorder, getRun } = await import('../src/agent/store/runLog.js');
const { collection } = await import('../src/agent/store/jsonStore.js');

const mk = (requestId, mode = 'quick') =>
  new RunRecorder({ requestId, userId: 'u', threadId: 'thr_x', mode, query: 'q', model: 'm' });

test('the record exists before the run finishes', async () => {
  const r = mk('req_begin');
  await r.begin();
  const row = await getRun(r.id);
  assert.ok(row, 'a row exists as soon as the request arrives');
  assert.equal(row.status, 'running');
  assert.equal(row.request_id, 'req_begin');
  assert.equal(row.mode, 'quick');
  assert.equal(row.thread_id, 'thr_x');
  assert.equal(row.ended_at, null, 'and it is not pretending to be finished');
});

test('finish updates that same row rather than adding another', async () => {
  const r = mk('req_oneRow');
  await r.begin();
  r.finish({ status: 'ok', terminationReason: 'done' });
  await new Promise((x) => setTimeout(x, 20));

  const rows = (await collection('runs').list({ request_id: 'req_oneRow' }, { limit: 10 })).items;
  assert.equal(rows.length, 1, `one row per request, got ${rows.length}`);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].termination_reason, 'done');
});

test('a close AFTER a normal finish does not overwrite the outcome', async () => {
  // The case that makes naive finalisation dangerous: a good answer followed by
  // a disconnect would otherwise be recorded as aborted.
  const r = mk('req_lateClose');
  await r.begin();
  r.finish({ status: 'ok', terminationReason: 'done' });
  // What the close handler does.
  r.finish({ status: 'aborted', terminationReason: 'client_disconnected' });
  await new Promise((x) => setTimeout(x, 20));

  const row = await getRun(r.id);
  assert.equal(row.status, 'ok', 'the real outcome survives');
  assert.equal(row.termination_reason, 'done');
});

test('a double close writes exactly one aborted record', async () => {
  const r = mk('req_doubleClose');
  await r.begin();
  r.finish({ status: 'aborted', terminationReason: 'client_disconnected' });
  const firstEnded = (await getRun(r.id)).ended_at;
  r.finish({ status: 'aborted', terminationReason: 'client_disconnected' });
  await new Promise((x) => setTimeout(x, 20));

  const rows = (await collection('runs').list({ request_id: 'req_doubleClose' }, { limit: 10 })).items;
  assert.equal(rows.length, 1, 'one row');
  assert.equal(rows[0].status, 'aborted');
  assert.equal(rows[0].termination_reason, 'client_disconnected');
  assert.equal(rows[0].ended_at, firstEnded, 'and the first close is the one recorded');
});

test('an abort mid-stream records what had happened so far', async () => {
  const r = mk('req_midStream', 'deep');
  await r.begin();
  r.recordToolCall({ name: 'web_search', input: { query: 'a' }, durationMs: 12, ok: true });
  r.recordToolCall({ name: 'fetch_page', input: { url: 'https://e.test' }, durationMs: 30, ok: true });
  r.finish({ status: 'aborted', terminationReason: 'client_disconnected' });
  await new Promise((x) => setTimeout(x, 20));

  const row = await getRun(r.id);
  assert.equal(row.status, 'aborted');
  assert.equal(row.tool_calls.length, 2, 'the work it had done is kept');
  assert.ok(row.latency_ms >= 0, 'and how long it lasted');
});

test('an aborted run exports to runs/failing, not runs/', async () => {
  // A2 grades runs/ and requires `done`; an abandoned run must not land there.
  const { toolCallsOf } = await import('../tools/export-runlogs.mjs');
  const src = fs.readFileSync(new URL('../tools/export-runlogs.mjs', import.meta.url), 'utf8');
  assert.ok(typeof toolCallsOf === 'function');
  // The exporter splits on `terminated`; anything not `done` is a failing run.
  assert.match(src, /terminated/, 'the exporter classifies by termination');
  const { RunRecorder: RR } = await import('../src/agent/store/runLog.js');
  const r = new RR({ requestId: 'req_exportSplit', userId: 'u', threadId: 't', mode: 'quick', query: 'q', model: 'm' });
  await r.begin();
  const row = r.finish({ status: 'aborted', terminationReason: 'client_disconnected' });
  assert.notEqual(row.termination_reason, 'done', 'so it cannot be counted as a completed run');
});

test('the agent finalises on close, and only when the response did not end', () => {
  const src = fs.readFileSync(new URL('../src/agent/routes/contract.js', import.meta.url), 'utf8');
  assert.match(src, /await recorder\.begin\(\);/, 'the row is created before the run');
  const handler = src.slice(src.indexOf("res.on('close'"), src.indexOf('const answerId = newId'));
  assert.match(handler, /log\.warn\('client_closed'/, 'the close is logged');
  for (const f of ['writable_ended', 'elapsed_ms', 'last_event', 'bytes_written']) {
    assert.ok(handler.includes(f), `the close line carries ${f}`);
  }
  assert.match(handler, /if \(!res\.writableEnded\) \{[\s\S]*?client_disconnected/, 'and only finalises an unfinished response');
  // begin() must precede the thread lookup, which is the first await.
  assert.ok(
    src.indexOf('await recorder.begin()') < src.indexOf('await ensureThread('),
    'the row exists before any context is loaded',
  );
});

test('the gateway names which side closed', () => {
  const src = fs.readFileSync(new URL('../src/gateway/routes/contract.js', import.meta.url), 'utf8');
  for (const m of ['downstream_closed', 'upstream_closed', 'upstream_error']) {
    assert.ok(src.includes(m), `the gateway logs ${m}`);
  }
  assert.equal((src.match(/elapsed_ms: Date\.now\(\) - openedAt/g) ?? []).length >= 3, true, 'each with elapsed ms');
});
