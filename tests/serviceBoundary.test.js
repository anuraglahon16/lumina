import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The boundary has to be physical, not only tidy.
 *
 * The deployed system put the Gateway and the Agent in one serverless function,
 * so the public edge process held ANTHROPIC_API_KEY and TAVILY_API_KEY. They
 * were never in the browser bundle, but "not in the bundle" is a weaker claim
 * than "not in the public-facing process": the split existed in the module
 * graph and nowhere in the deployment.
 *
 * These tests walk the Gateway's real import graph from its entry point. If the
 * Gateway ever reaches a provider client, orchestration or a parser, it fails
 * here rather than in a deployment review.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every first-party module reachable from an entry point. */
function importGraph(entry) {
  const seen = new Set();
  const queue = [path.resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      let target = path.resolve(path.dirname(file), m[1]);
      if (!target.endsWith('.js')) target += '.js';
      queue.push(target);
    }
  }
  return [...seen].map((f) => path.relative(ROOT, f));
}

const gateway = importGraph('src/gateway/server.js');
const agent = importGraph('src/agent/server.js');
const worker = importGraph('src/agent/worker.js');

test('the gateway never reaches a provider client', () => {
  const forbidden = [
    'src/agent/core/llm.js',
    'src/agent/services/search/index.js',
    'src/agent/services/embeddings.js',
    'src/agent/services/parsers.js',
  ];
  const reached = forbidden.filter((f) => gateway.includes(f));
  assert.deepEqual(reached, [], `the public gateway imports ${reached.join(', ')}`);
});

test('the gateway never reaches orchestration', () => {
  const forbidden = ['src/agent/core/quick.js', 'src/agent/core/deep.js', 'src/agent/core/synthesize.js', 'src/agent/services/ingest.js'];
  const reached = forbidden.filter((f) => gateway.includes(f));
  assert.deepEqual(reached, [], `the public gateway imports ${reached.join(', ')}`);
});

test('the gateway reads no provider credential', () => {
  // config.js is shared, so the test is about what the gateway's own files
  // reference rather than what the config object could hold.
  const secrets = ['ANTHROPIC_API_KEY', 'TAVILY_API_KEY', 'VOYAGE_API_KEY', 'OPENAI_API_KEY', 'BRAVE_API_KEY'];
  const offenders = [];
  for (const file of gateway.filter((f) => f.startsWith('src/gateway/'))) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const s of secrets) if (src.includes(s)) offenders.push(`${file} mentions ${s}`);
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});

test('the gateway talks to the agent over a configured address', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/gateway/routes/proxy.js'), 'utf8');
  assert.match(src, /config\.gateway\.agentUrl/, 'the upstream is configuration, not a hard-coded host');
  const cfg = fs.readFileSync(path.join(ROOT, 'src/shared/config.js'), 'utf8');
  assert.match(cfg, /AGENT_URL/, 'and it comes from AGENT_URL');
});

test('the agent and worker do hold the provider clients', () => {
  // The other half: the boundary is only meaningful if the work moved rather
  // than disappeared.
  assert.ok(agent.includes('src/agent/core/llm.js'), 'the agent reaches the model client');
  assert.ok(agent.includes('src/agent/services/search/index.js'), 'and web search');
  assert.ok(worker.includes('src/agent/services/ingest.js'), 'the worker reaches the indexing pipeline');
  assert.ok(worker.includes('src/agent/services/parsers.js'), 'and the parser');
});

test('the worker is not reachable over HTTP', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/worker.js'), 'utf8');
  for (const forbidden of ['express', 'createServer', '.listen(']) {
    assert.ok(!src.includes(forbidden), `the worker must not ${forbidden}`);
  }
});
