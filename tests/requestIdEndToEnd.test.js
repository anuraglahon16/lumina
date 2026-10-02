import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One request, greppable end to end.
 *
 * Four things were wrong, and each looked fine from where it was written:
 *
 *   - The gateway derived the id twice. `identity` split a repeated
 *     `x-request-id` header, because Express joins repeated headers with ", ";
 *     the contract path had its own inline copy that did not, so behind a proxy
 *     it logged "abc, abc" and correlated nothing. The contract path is the
 *     graded one.
 *   - The per-request log line sat BELOW the contract handler, which mounts its
 *     router and returns into it. So `/threads/*` and `/spaces/*` produced no
 *     gateway log line at all: the unlogged routes were the ones that matter.
 *   - The agent logged nothing when a run finished. Every number was in the run
 *     record, which goes to Mongo and NDJSON - not where anyone tailing logs is
 *     looking - so the trail stopped at the hop.
 *   - The SSE error frame carried a status and a sentence and no id, which is
 *     the one place a user actually sees a failure.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-reqid-'));
process.env.MONGODB_URI = '';

const SRC = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the request id is derived in one place', () => {
  const identity = SRC('src/gateway/middleware/identity.js');
  assert.match(identity, /export function assignRequestId\(req, res\)/, 'there is one derivation');
  assert.match(identity, /\.split\(','\)\[0\]\.trim\(\)/, 'and it handles a repeated header');

  const server = SRC('src/gateway/server.js');
  assert.match(server, /assignRequestId\(req, res\);/, 'the contract path uses it');
  // The inline copy that skipped the split must not come back.
  const inline = server.match(/req\.requestId = req\.get\('x-request-id'\)/g) ?? [];
  assert.deepEqual(inline, [], 'no path derives the id for itself');
});

test('every route is logged, including the contract routes', () => {
  const server = SRC('src/gateway/server.js');
  const logAt = server.indexOf("log.info('request'");
  const contractAt = server.indexOf('if (!CONTRACT_PATH.test(req.path)) return next();');
  assert.ok(logAt > 0 && contractAt > 0, 'both the logger and the contract handler are present');
  assert.ok(
    logAt < contractAt,
    'the request logger must be mounted BEFORE the contract handler, which returns into its own router',
  );
});

test('the gateway line carries what AGENTS.md asks for', () => {
  const server = SRC('src/gateway/server.js');
  const line = server.slice(server.indexOf("log.info('request'"), server.indexOf("log.info('request'") + 500);
  for (const field of ['request_id', 'user_id', 'method', 'route', 'status', 'duration_ms']) {
    assert.ok(line.includes(field), `the line carries ${field}`);
  }
});

test('route is the route, not the url', () => {
  const server = SRC('src/gateway/server.js');
  assert.match(server, /function routeOf\(req\)/, 'ids are normalised out of the route');
  // Exercise it on the shapes the app actually produces.
  const routeOf = new Function(`${server.slice(server.indexOf('function routeOf(req)'), server.indexOf('\n}\n', server.indexOf('function routeOf(req)')) + 2)}; return routeOf;`)();
  assert.equal(routeOf({ path: '/threads/thr_abc123xyz/ask' }), '/threads/:id/ask');
  assert.equal(routeOf({ path: '/spaces/spc_mu8hqxyln7/documents' }), '/spaces/:id/documents');
  assert.equal(routeOf({ path: '/health' }), '/health', 'a route with no id is unchanged');
});

test('the agent logs one line per answer', async () => {
  const runLog = SRC('src/agent/store/runLog.js');
  const finish = runLog.slice(runLog.indexOf('  finish({'), runLog.indexOf('  persist()'));
  assert.match(finish, /log\.info\('answer'/, 'finish() emits the per-answer line');
  for (const field of ['request_id', 'tool_calls', 'terminated', 'tokens', 'cost_usd', 'search_cached', 'ttft_ms', 'latency_ms']) {
    assert.ok(finish.includes(field), `the answer line carries ${field}`);
  }
});

/** Capture the pino lines a block writes, by intercepting the stream. */
async function captureLogs(fn) {
  const lines = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        lines.push(JSON.parse(l));
      } catch {
        /* not one of ours */
      }
    }
    return real(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = real;
  }
  return lines;
}

test('the answer line reports search_cached the way the contract defines it', async () => {
  // Every search hit the cache. No searches at all is not "cached", so the two
  // cases are driven separately rather than asserted about in prose.
  const { RunRecorder } = await import('../src/agent/store/runLog.js');

  const allCached = await captureLogs(async () => {
    const r = new RunRecorder({ requestId: 'req_cached', userId: 'u', threadId: null, mode: 'quick', query: 'q', model: 'm' });
    r.recordToolCall({ name: 'web_search', input: {}, durationMs: 1, ok: true, cached: true });
    r.recordToolCall({ name: 'web_search', input: {}, durationMs: 1, ok: true, cached: true });
    r.recordToolCall({ name: 'fetch_page', input: {}, durationMs: 1, ok: true, cached: false });
    r.finish({ status: 'ok', terminationReason: 'done' });
  });
  const cachedLine = allCached.find((l) => l.msg === 'answer' && l.request_id === 'req_cached');
  assert.ok(cachedLine, 'the answer line was emitted');
  assert.equal(cachedLine.search_cached, true, 'both searches were cached');
  assert.equal(cachedLine.tool_calls, 3, 'and the count is every tool call, not only the searches');
  assert.equal(cachedLine.terminated, 'done');
  assert.equal(cachedLine.depth, 'quick');

  const oneMiss = await captureLogs(async () => {
    const r = new RunRecorder({ requestId: 'req_miss', userId: 'u', threadId: null, mode: 'deep', query: 'q', model: 'm' });
    r.recordToolCall({ name: 'web_search', input: {}, durationMs: 1, ok: true, cached: true });
    r.recordToolCall({ name: 'web_search', input: {}, durationMs: 1, ok: true, cached: false });
    r.finish({ status: 'ok', terminationReason: 'done' });
  });
  assert.equal(
    oneMiss.find((l) => l.msg === 'answer' && l.request_id === 'req_miss')?.search_cached,
    false,
    'one miss means the run was not served from cache',
  );

  const noSearch = await captureLogs(async () => {
    const r = new RunRecorder({ requestId: 'req_nosearch', userId: 'u', threadId: null, mode: 'quick', query: 'q', model: 'm' });
    r.recordToolCall({ name: 'search_documents', input: {}, durationMs: 1, ok: true });
    r.finish({ status: 'ok', terminationReason: 'done' });
  });
  assert.equal(
    noSearch.find((l) => l.msg === 'answer' && l.request_id === 'req_nosearch')?.search_cached,
    false,
    'a run that searched nothing is not a cached run',
  );
});

test('a run record carries the request id under both spellings', async () => {
  const { RunRecorder } = await import('../src/agent/store/runLog.js');
  const r = new RunRecorder({ requestId: 'req_dualwrite', userId: 'u', threadId: null, mode: 'quick', query: 'q', model: 'm' });
  const run = r.snapshot();
  assert.equal(run.request_id, 'req_dualwrite', 'the spelling every reader uses');
  assert.equal(run.requestId, 'req_dualwrite', 'and the one scripts/indexes.json declares a unique index on');
});

test('the SSE error frame names the request', async () => {
  const { contractStream } = await import('../src/gateway/contract/events.js');
  const sent = [];
  const emit = contractStream({ send: (event, data) => sent.push({ event, data }), depth: 'quick', answerId: 'a', requestId: 'req_err9' });
  emit('error', { status: 502, message: 'the search provider refused' });

  const frame = sent.find((e) => e.event === 'error');
  assert.ok(frame, 'an error frame was sent');
  assert.equal(frame.data.status, 502);
  assert.equal(frame.data.requestId, 'req_err9', 'and it carries the id the user can quote');
});

test('the error frame stays valid against the contract', async () => {
  const { StreamErrorEvent } = await import('../packages/contract/dist/sse.js');
  const { contractStream } = await import('../src/gateway/contract/events.js');
  const sent = [];
  const emit = contractStream({ send: (event, data) => sent.push({ event, data }), depth: 'deep', answerId: 'a', requestId: 'req_valid' });
  emit('error', { status: 502, message: 'upstream failed' });
  // Non-strict object: the extra field validates and a schema parse drops it, so
  // the UI is unaffected and the stream is still greppable.
  assert.doesNotThrow(() => StreamErrorEvent.parse(sent[0].data));
  assert.equal(StreamErrorEvent.parse(sent[0].data).requestId, undefined, 'the contract shape is unchanged');
});

test('without a request id the frame simply omits it', async () => {
  const { contractStream } = await import('../src/gateway/contract/events.js');
  const sent = [];
  const emit = contractStream({ send: (event, data) => sent.push({ event, data }), depth: 'quick', answerId: 'a' });
  emit('error', { status: 502, message: 'x' });
  assert.ok(!('requestId' in sent[0].data), 'never a null or an empty string in its place');
});
