import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * An SSE forward bounds how long it waits for the agent to start answering.
 *
 * Measured in the deployed benchmark: 36 of 40 web asks produced a run record
 * and 4 produced none, and the phase stalled for five minutes - from 12:45:41 to
 * 12:51, ending exactly at bench's 300s client abort. The gateway's ask
 * forwarder creates an AbortController and only aborts it on `res.on('close')`,
 * so the upstream fetch had no deadline of its own: the gateway waited for the
 * agent indefinitely and the client's timeout was the only thing that ended it.
 * Every sibling upstream call is bounded - 60s, 120s, 3s for health - and this
 * one was not.
 *
 * The bound is on time-to-first-byte, not on the stream. A deep answer
 * legitimately streams for minutes; what must not be unbounded is the wait
 * before the agent says anything at all.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-deadline-'));
process.env.MONGODB_URI = '';
process.env.GATEWAY_PORT = '0';
process.env.DEMO_PASSWORD = '';
// Short enough to assert against in a test; the default is what production uses.
process.env.AGENT_TTFB_TIMEOUT_MS = '1500';

/** An agent that accepts the connection and then says nothing, ever. */
let holdOpen = true;
const stalled = http.createServer((req, res) => {
  if (!holdOpen) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: done\ndata: {"answerId":"a"}\n\n');
    return res.end();
  }
  // Headers deliberately never sent.
});
await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
process.env.AGENT_URL = `http://127.0.0.1:${stalled.address().port}`;

const { server } = await import('../src/gateway/server.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  stalled.close();
});

test('a stalled agent fails the ask promptly instead of hanging', async () => {
  const started = Date.now();
  const res = await fetch(`${BASE}/threads/thr_test/ask`, {
    method: 'POST',
    headers: { 'x-user-id': 'u1', 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query: 'anything', depth: 'quick' }),
    // Far longer than the bound under test: if the gateway hangs, this is what
    // the client would be left waiting for, which is the defect.
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 10000, `the gateway must not wait indefinitely; took ${elapsed}ms`);
  assert.ok(
    res.status >= 500 || /error/i.test(body),
    `a stalled upstream must surface as an error, got ${res.status}: ${body.slice(0, 120)}`,
  );
});

test('the bound is configurable and defaults to something sane', async () => {
  const { config } = await import('../src/shared/config.js');
  assert.ok(config.gateway.agentTtfbTimeoutMs > 0, 'there is a bound');
  assert.equal(config.gateway.agentTtfbTimeoutMs, 1500, 'this file set it');
});

test('both SSE forwarders bound the wait before the first byte', () => {
  for (const f of ['src/gateway/routes/contract.js', 'src/gateway/routes/proxy.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /agentTtfbTimeoutMs/, `${f} bounds time-to-first-byte`);
    // And clears it once headers arrive, so a long stream is not cut off.
    assert.match(src, /clearTimeout\(/, `${f} releases the bound once the agent answers`);
  }
});

test('a healthy upstream is not cut off by the bound', async () => {
  // The other half: the deadline must not break a stream that does answer.
  holdOpen = false;
  const res = await fetch(`${BASE}/threads/thr_ok/ask`, {
    method: 'POST',
    headers: { 'x-user-id': 'u2', 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query: 'anything', depth: 'quick' }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  assert.equal(res.status, 200, `a responsive agent streams normally, got ${res.status}`);
  assert.match(body, /event: done/, 'and its events reach the client');
});
