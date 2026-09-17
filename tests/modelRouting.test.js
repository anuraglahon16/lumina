import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One model per role, and a bill that says which model spent what.
 *
 * Most calls in a run are not writing the answer: choosing which page to read,
 * decomposing a question, noticing a durable fact about the user. None of that
 * reaches the reader as prose, and all of it was being served by the model
 * chosen for the one job that does.
 *
 * The risk in splitting them is not quality, it is accounting. A run that
 * prices every call at the headline model's rate reports a number that is
 * wrong in whichever direction the split went, and that number is what the
 * cost gate is measured on.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-models-'));
process.env.MONGODB_URI = '';

const { config, PRICING, priceFor } = await import('../src/shared/config.js');
const { RunRecorder } = await import('../src/agent/store/runLog.js');

/* ------------------------------------------------------------- selection */

test('every role resolves to a model', () => {
  for (const role of ['quickModel', 'plannerModel', 'branchModel', 'deepSynthesisModel', 'queryRewriteModel', 'memoryModel']) {
    assert.ok(typeof config.llm[role] === 'string' && config.llm[role].length > 0, `${role} is set`);
  }
});

test('the roles that do mechanical work default to the small model', () => {
  // Deliberate, and the reason the split exists: these turns are tool choices
  // and bookkeeping, not prose anyone reads.
  for (const role of ['plannerModel', 'branchModel', 'queryRewriteModel', 'memoryModel']) {
    assert.match(config.llm[role], /haiku/i, `${role} should default to the small model`);
  }
});

test('deep synthesis keeps the larger model', () => {
  // The one call that earns it: merging many sources into an answer that stays
  // honest about where they disagree.
  assert.match(config.llm.deepSynthesisModel, /sonnet|opus/i);
});

test('no role is routed to a model outside the priced set', () => {
  // priceFor falls back to the dearest known rate for anything unrecognised, so
  // an unpriced model does not go unnoticed — but it does make every cost
  // figure for that role a guess.
  for (const role of ['quickModel', 'plannerModel', 'branchModel', 'deepSynthesisModel', 'queryRewriteModel', 'memoryModel']) {
    assert.ok(PRICING[config.llm[role]], `${config.llm[role]} (${role}) has a published rate`);
  }
});

test('no role is routed to Fable', () => {
  for (const role of ['quickModel', 'plannerModel', 'branchModel', 'deepSynthesisModel', 'queryRewriteModel', 'memoryModel']) {
    assert.ok(!/fable/i.test(config.llm[role]), `${role} must not use Fable in the graded benchmark`);
  }
});

/* ------------------------------------------------------- cost accounting */

const recorder = () =>
  new RunRecorder({ requestId: 'req_m', userId: 'u_models', threadId: null, mode: 'deep', query: 'q', model: config.llm.deepSynthesisModel });

test('a mixed-model run is priced per call, not at the run’s headline rate', () => {
  const r = recorder();
  // A realistic deep shape: a cheap plan, cheap branches, one expensive merge.
  r.recordLlmCall({ model: 'claude-haiku-4-5', purpose: 'plan', usage: { input_tokens: 2000, output_tokens: 400 }, durationMs: 1 });
  r.recordLlmCall({ model: 'claude-haiku-4-5', purpose: 'research:q1', usage: { input_tokens: 8000, output_tokens: 300 }, durationMs: 1 });
  r.recordLlmCall({ model: 'claude-sonnet-5', purpose: 'synthesis', usage: { input_tokens: 20000, output_tokens: 1500 }, durationMs: 1 });

  const h = PRICING['claude-haiku-4-5'];
  const s = PRICING['claude-sonnet-5'];
  const expected =
    (2000 * h.input + 400 * h.output) / 1e6 + (8000 * h.input + 300 * h.output) / 1e6 + (20000 * s.input + 1500 * s.output) / 1e6;

  const snap = r.snapshot();
  assert.equal(Number(snap.cost_usd.toFixed(6)), Number(expected.toFixed(6)));

  // The same usage priced entirely at the headline rate would be materially
  // higher, which is the error this guards against.
  const allSonnet = (30000 * s.input + 2200 * s.output) / 1e6;
  assert.ok(snap.cost_usd < allSonnet, 'routing cheap work to a cheap model shows up in the bill');
});

test('each call records the model that actually made it', () => {
  const r = recorder();
  r.recordLlmCall({ model: 'claude-haiku-4-5', purpose: 'plan', usage: {}, durationMs: 1 });
  r.recordLlmCall({ model: 'claude-sonnet-5', purpose: 'synthesis', usage: {}, durationMs: 1 });
  const calls = r.snapshot().llm_calls;
  assert.deepEqual(calls.map((c) => [c.purpose, c.model]), [
    ['plan', 'claude-haiku-4-5'],
    ['synthesis', 'claude-sonnet-5'],
  ]);
});

test('an unpriced model is charged at the dearest known rate', () => {
  // Overstating spend is visible and annoying; understating it hides real cost,
  // so a model nobody added a rate for must never look free.
  const dearest = Object.values(PRICING).reduce((a, b) => (b.output > a.output ? b : a));
  assert.deepEqual(priceFor('claude-something-unreleased'), dearest);
});

test('a run’s token totals sum across models', () => {
  const r = recorder();
  r.recordLlmCall({ model: 'claude-haiku-4-5', purpose: 'plan', usage: { input_tokens: 100, output_tokens: 10 }, durationMs: 1 });
  r.recordLlmCall({ model: 'claude-sonnet-5', purpose: 'synthesis', usage: { input_tokens: 200, output_tokens: 20 }, durationMs: 1 });
  const snap = r.snapshot();
  assert.equal(snap.tokens.input, 300);
  assert.equal(snap.tokens.output, 30);
});
