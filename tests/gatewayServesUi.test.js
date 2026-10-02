import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * The gateway serves the UI, from the same origin as the API and the SSE stream.
 *
 * It served `src/gateway/public` - the original vanilla UI - while the provided
 * React app was deployed separately to Vercel, so the page and the API it talked
 * to came from two origins and two commits. The React app is the acceptance
 * test; the gateway is where it has to be served from, and the image builds it
 * (Dockerfile stage 1) so the container contains it.
 *
 * `api/index.js` - the whole application as one Vercel function, provider keys
 * included - is gone, and the root `vercel.json` with it.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ui-'));
process.env.MONGODB_URI = '';
process.env.GATEWAY_PORT = '0';
process.env.DEMO_PASSWORD = '';

/** A stub agent: the gateway proxies contract paths, and that is not what this file tests. */
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', suites: [] }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
process.env.AGENT_URL = `http://127.0.0.1:${upstream.address().port}`;

const { server, uiRoot } = await import('../src/gateway/server.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  upstream.close();
});

const get = (p, accept = 'text/html') => fetch(`${BASE}${p}`, { headers: { accept } });

test('the gateway serves the built React app', async () => {
  assert.ok(uiRoot.endsWith('web/dist'), `expected web/dist, got ${uiRoot} — run \`npm run build -w @lumina/web\``);
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="root">/, 'the React mount point, not the vanilla UI');
});

test('a client route is handed to the app, not 404ed', async () => {
  // `/evals` is the page a grader opens and it is routed client-side, so the
  // server has to answer it with index.html.
  for (const p of ['/evals', '/some/deep/client/route']) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} reached the app`);
    assert.match(await res.text(), /<div id="root">/, `${p} is served the app shell`);
  }
});

test('an API-shaped path still returns JSON rather than the app shell', async () => {
  // The SPA fallback must not swallow a typo'd endpoint: a client asking for
  // /threadz wants an error it can read.
  const res = await get('/threadz', 'application/json');
  assert.match(res.headers.get('content-type') ?? '', /json/, 'a JSON client gets JSON');
  assert.equal(res.status, 404);
});

test('a contract path is proxied, not served from disk', async () => {
  const res = await get('/evals/report.json', 'application/json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /json/);
});

test('health says which UI is live', async () => {
  const body = await (await get('/health.internal', 'application/json')).json();
  assert.equal(body.ui, 'web/dist', 'the fallback is a different application and must be distinguishable');
});

test('the Vercel backend is gone, and the image builds the UI instead', () => {
  const root = new URL('../', import.meta.url);
  assert.ok(!fs.existsSync(new URL('api/index.js', root)), 'the single-process function is gone');
  assert.ok(!fs.existsSync(new URL('vercel.json', root)), 'and the rewrite that pointed every path at it');

  const dockerfile = fs.readFileSync(new URL('Dockerfile', root), 'utf8');
  assert.match(dockerfile, /FROM node:22-slim AS web/, 'a build stage exists');
  assert.match(dockerfile, /RUN npm run build -w @lumina\/web/, 'which builds the UI');
  assert.match(dockerfile, /COPY --from=web \/app\/web\/dist \.\/web\/dist/, 'and the runtime stage takes its output');
  assert.ok(!/COPY api \.\/api/.test(dockerfile), 'and no longer copies the removed function');
});

test('the built UI is not tracked in git', () => {
  // AGENTS.md requires web/dist ignored, and it was committed - so a commit
  // carried a bundle built from whatever the working tree held at the time.
  const ignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^web\/dist\/$/m, 'web/dist is ignored');
  assert.match(ignore, /^reports\/\*$/m, 'and generated reports are too');
  // `reports/` would exclude the directory and make the negations below dead.
  assert.ok(!/^reports\/$/m.test(ignore), 'as reports/* so the negations for hand-written evidence apply');
  assert.match(ignore, /^!reports\/\*\/\*\.md$/m, 'hand-written evidence stays committable');
});
