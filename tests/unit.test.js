import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger } from '../src/agent/core/evidence.js';
import { Budget } from '../src/agent/core/budget.js';
import { chunkPages, chunkPassages } from '../src/agent/services/chunker.js';
import { parseJsonLoose, baseParams } from '../src/agent/core/llm.js';
import { normalizeAnswerStyle } from '../src/agent/core/style.js';
import { signToken, verifyToken } from '../src/shared/token.js';
import { CircuitBreaker } from '../src/shared/circuitBreaker.js';
import { validateToolInput } from '../src/agent/core/tools.js';

const working = () => Promise.resolve('ok');
const failing = () => Promise.reject(new Error('upstream exploded'));

const fakePage = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

test('the same URL fetched twice yields one source number', () => {
  const ledger = new EvidenceLedger();
  const text = 'Shared evidence paragraph with enough length to survive the passage filter for chunking.'.repeat(2);
  const first = ledger.addWebSource(fakePage('https://example.com/x', 'X', text));
  const second = ledger.addWebSource(fakePage('https://example.com/x', 'X', text));
  assert.equal(first.n, second.n);
  assert.equal(ledger.citable.length, 1);
});

test('loose JSON parsing survives fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here is the plan: {"sub_questions":[{"id":"q1"}]} then done'), {
    sub_questions: [{ id: 'q1' }],
  });
  assert.equal(parseJsonLoose('no json at all'), null);
});

test('a request is shaped for the model it is routed to, not for one model family', () => {
  // Regression: every memory extraction failed with "adaptive thinking is not
  // supported on this model" because the request was built for the Opus/Sonnet
  // shape and sent to Haiku. The extractor swallowed the error, so the feature
  // was silently dead rather than visibly broken.
  const haiku = baseParams({ model: 'claude-haiku-4-5', messages: [], maxTokens: 500 });
  assert.equal(haiku.thinking, undefined, 'haiku rejects adaptive thinking');
  assert.equal(haiku.output_config, undefined, 'haiku rejects output_config.effort');
  assert.equal(haiku.model, 'claude-haiku-4-5');

  const sonnet = baseParams({ model: 'claude-sonnet-5', messages: [], effort: 'high' });
  assert.deepEqual(sonnet.thinking, { type: 'adaptive' });
  assert.deepEqual(sonnet.output_config, { effort: 'high' });
});

test('the system prompt keeps its cache breakpoint regardless of model', () => {
  for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
    const p = baseParams({ model, system: 'stable prefix', messages: [] });
    assert.equal(p.system[0].cache_control.type, 'ephemeral', `${model} lost its cache breakpoint`);
  }
});

test('a success resets the failure count, so scattered failures never accumulate', async () => {
  const cb = new CircuitBreaker('test', { failureThreshold: 3, cooldownMs: 10_000 });
  await assert.rejects(cb.run(failing));
  await assert.rejects(cb.run(failing));
  await cb.run(working);
  await assert.rejects(cb.run(failing));
  await assert.rejects(cb.run(failing));
  assert.equal(cb.state, 'closed', 'only consecutive failures should open it');
});
