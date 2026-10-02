import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * The evaluation page is the one thing a human grader is asked to open.
 *
 * It was behind the demo password: `/evals` returned 401 to anyone without the
 * shared credential, which is the wrong gate on the wrong page — the rubric
 * expects a grader to follow a link and read it, and the contract probe expects
 * `GET /evals/report.json` to answer with no user header at all.
 *
 * The password exists so a public URL is not an open bill on someone's model
 * credits. That reasoning covers asking questions; it does not cover reading a
 * static report. So exactly two paths open, and the tests below pin both sides:
 * the report is readable by anyone, and threads, memory and Spaces are not.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-evalspublic-'));
process.env.MONGODB_URI = '';
process.env.DEMO_PASSWORD = 'a-password-nobody-sending-these-requests-has';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

/**
 * Driven against the gateway, which is now the only entry point.
 *
 * This imported `api/index.js` - the single Vercel function that was the whole
 * application in one process, provider keys included. That file is gone, and
 * with it the possibility of these two paths behaving differently: there is one
 * place where /evals is served and one place where the password gate decides
 * what it covers.
 *
 * The gateway listens on import, so the port it chose is what the tests use
 * rather than a second server wrapping the same app.
 */
process.env.GATEWAY_PORT = '0';

/**
 * A stub agent, because these tests are about the gateway's password gate.
 *
 * `/evals/report.json` is a contract path, so the gateway proxies it rather than
 * answering it - under `api/index.js` the agent's routers ran in the same
 * process and there was nothing to proxy to. Pointing AGENT_URL at a closed port
 * made the gate test fail with 502, which is the proxy working, not the gate.
 * The stub answers that one path so the assertions are about who is let through.
 */
const upstream = http.createServer((req, res) => {
  // The gateway forwards to `/contract/evals/report.json`, not `/v1/...`:
  // src/gateway/routes/contract.js names the upstream path explicitly.
  if (req.url?.startsWith('/contract/evals/report.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ generatedAt: new Date().toISOString(), suites: [], target: 'stub' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
process.env.AGENT_URL = `http://127.0.0.1:${upstream.address().port}`;
test.after(() => upstream.close());

const { server } = await import('../src/gateway/server.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/** No password, no user id: what a stranger with the link sends. */
const anonymous = (p) => fetch(`${BASE}${p}`, { headers: { accept: 'text/html,application/json' } });

test('GET /evals is readable without the demo password', async () => {
  const res = await anonymous('/evals');
  assert.notEqual(res.status, 401, 'the page a grader is asked to open must not ask for a password');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<div id="root">/, 'and it is the React app, which routes /evals client-side');
});

test('GET /evals/report.json is readable without a user header', async () => {
  const res = await anonymous('/evals/report.json');
  assert.equal(res.status, 200, 'the contract probe sends no X-User-Id');
  const body = await res.json();
  assert.equal(typeof body, 'object');
});

test('the report carries no secret', async () => {
  // Opening it to the world is only safe if there is nothing in it.
  const body = await (await anonymous('/evals/report.json')).text();
  const secrets = [
    [/mongodb(\+srv)?:\/\//i, 'a connection string'],
    [/sk-ant-[A-Za-z0-9]/, 'an Anthropic key'],
    [/tvly-[A-Za-z0-9]{8}/, 'a Tavily key'],
    [/pa-[A-Za-z0-9]{16}/, 'a Voyage key'],
    [/"?(ANTHROPIC_API_KEY|TAVILY_API_KEY|VOYAGE_API_KEY|AUTH_SECRET|DEMO_PASSWORD|MONGODB_URI)"?\s*[:=]\s*["'][^"']{6,}/i, 'an inlined credential'],
  ];
  for (const [re, what] of secrets) assert.ok(!re.test(body), `the public report contains ${what}`);
});

test('user data is still protected', async () => {
  // The whole point of opening two paths is that the rest stay shut. A change
  // that widened the rule would show up here rather than in production.
  for (const p of ['/threads', '/memory', '/spaces']) {
    const res = await anonymous(p);
    assert.equal(res.status, 401, `${p} must still refuse an anonymous caller`);
  }
});

test('the project API is still behind the demo password', async () => {
  const res = await anonymous('/api/limits');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(JSON.stringify(body), /password/i, 'and it is the password gate refusing, not a missing user');
});

test('a sibling path is not opened by accident', async () => {
  // `/evals` must not become a prefix that lets anything through.
  const res = await anonymous('/evalsomething');
  assert.equal(res.status, 401, 'only /evals and /evals/report.json open');
});
