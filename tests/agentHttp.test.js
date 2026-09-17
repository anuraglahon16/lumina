import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';

// The agent needs a real provider key to answer at all. The suite does not load
// the environment on its own, and skipping silently would leave the one test
// that covers the whole path permanently green and permanently unrun.
dotenv.config();

/**
 * The path the diagnostic actually travels, run against a real agent.
 *
 * The bug this protects against lived between the pieces rather than inside
 * any of them: the run id arrives on an SSE event, the request is authorised by
 * one header and scoped by another, the write happens after the response, and
 * the record is fetched back by id. Every piece was correct on its own and the
 * path through them read runs belonging to "anonymous" and would have been
 * refused outright wherever INTERNAL_TOKEN is set.
 *
 * So this starts the agent as a separate process with a JSON store and a real
 * internal token, and drives the whole path over HTTP. It also covers the store
 * a developer without a database actually gets, which is where a silent zero
 * would otherwise have waited.
 */

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-agenthttp-'));
const TOKEN = 'test-token';
let agent = null;
let base = null;

/** Start the agent on an ephemeral port and wait for it to answer. */
async function startAgent() {
  const port = 8100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ['src/agent/server.js'], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MONGODB_URI: '',
      INTERNAL_TOKEN: TOKEN,
      AGENT_PORT: String(port),
      MEMORY_EXTRACT_ENABLED: 'false',
      EMBEDDING_PROVIDER: 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${url}/v1/health`);
      if (res.ok) return { child, url };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('the agent never became ready');
}

const headers = (userId, withToken = true) => ({
  'content-type': 'application/json',
  'x-user-id': userId,
  ...(withToken ? { 'x-internal-token': TOKEN } : {}),
});

test.before(async () => {
  const started = await startAgent();
  agent = started.child;
  base = started.url;
});

test.after(() => {
  agent?.kill();
});

test('a request without the internal token is refused', async () => {
  const res = await fetch(`${base}/v1/runs`, { headers: { 'x-user-id': 'someone' } });
  assert.equal(res.status, 403, 'the agent is only reachable through the gateway unless the token is presented');
});

test('health answers without a token, since it is how you find out the service is up', async () => {
  const res = await fetch(`${base}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.model, 'and it names the model serving answers');
});

test('the full diagnostic path: ask, capture the run id, fetch that exact run', { skip: !hasKey && 'needs ANTHROPIC_API_KEY' }, async () => {
  const userId = `httptest_${Math.random().toString(36).slice(2, 9)}`;

  const threadRes = await fetch(`${base}/v1/threads`, { method: 'POST', headers: headers(userId), body: JSON.stringify({ title: 'probe' }) });
  assert.equal(threadRes.ok, true, `POST /v1/threads -> ${threadRes.status}`);
  const { id: threadId } = await threadRes.json();

  const askRes = await fetch(`${base}/v1/query`, {
    method: 'POST',
    headers: headers(userId),
    body: JSON.stringify({ query: 'What is a write ahead log used for in database crash recovery?', mode: 'quick', thread_id: threadId }),
  });
  assert.equal(askRes.ok, true, `POST /v1/query -> ${askRes.status}`);

  // The run id arrives on run_start, which is the only place it is available:
  // the contract's answerId must match `ans_…`, so a run id cannot travel there.
  let runId = null;
  let event = null;
  let buffer = '';
  const reader = askRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ') && event === 'run_start') {
        runId = JSON.parse(line.slice(6)).run_id;
      }
    }
  }
  assert.ok(runId, 'the stream named its run');

  // The write is not awaited on the request path, so the read retries.
  let record = null;
  for (let i = 0; i < 20 && !record; i += 1) {
    const res = await fetch(`${base}/v1/runs/${runId}`, { headers: headers(userId) });
    if (res.ok) record = await res.json();
    else await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(record, `the exact run was retrievable: ${runId}`);
  assert.equal(record.id, runId, 'and it is that run, not whichever finished last');
  assert.equal(record.user_id, userId);

  // The fields the diagnostic depends on.
  assert.ok(record.citations, 'citations were recorded');
  assert.equal(typeof record.citations.cited_sentences, 'number', 'cited_sentences is present');
  assert.equal(typeof record.citations.supported_sentences, 'number', 'supported_sentences is present');
  assert.ok(Array.isArray(record.citations.sentence_results), 'and the per-sentence decisions');

  // Ownership. A run id is not an authorisation.
  const intruder = await fetch(`${base}/v1/runs/${runId}`, { headers: headers('someone_else') });
  assert.equal(intruder.status, 404, 'another user cannot read it');
});

test('an unknown run id is a 404 rather than an error', async () => {
  const res = await fetch(`${base}/v1/runs/run_does_not_exist`, { headers: headers('anyone') });
  assert.equal(res.status, 404);
});
