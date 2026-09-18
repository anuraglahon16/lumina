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

/* --------------------------------------------- precedence and visibility */

test('a legacy LUMINA_MODEL does not drag the split roles back with it', async () => {
  // The failure this prevents shipped: a deployment already carrying
  // LUMINA_MODEL=claude-sonnet-5 read the new role-aware code, logged the new
  // role names, and routed every one of them back to Sonnet. The split existed
  // only in environments that had never configured anything.
  const before = process.env.LUMINA_MODEL;
  process.env.LUMINA_MODEL = 'claude-sonnet-5';
  try {
    const fresh = await import(`../src/shared/config.js?precedence=${Date.now()}`);
    assert.match(fresh.config.llm.quickModel, /haiku/i, 'quick stays small');
    assert.match(fresh.config.llm.plannerModel, /haiku/i, 'planning stays small');
    assert.match(fresh.config.llm.branchModel, /haiku/i, 'branches stay small');
    assert.match(fresh.config.llm.deepSynthesisModel, /sonnet/i, 'but the answer model is still honoured where it means something');
  } finally {
    if (before === undefined) delete process.env.LUMINA_MODEL;
    else process.env.LUMINA_MODEL = before;
  }
});

test('an explicit role variable wins over everything', async () => {
  const before = process.env.LUMINA_QUICK_MODEL;
  process.env.LUMINA_QUICK_MODEL = 'claude-opus-5';
  try {
    const fresh = await import(`../src/shared/config.js?explicit=${Date.now()}`);
    assert.equal(fresh.config.llm.quickModel, 'claude-opus-5');
  } finally {
    if (before === undefined) delete process.env.LUMINA_QUICK_MODEL;
    else process.env.LUMINA_QUICK_MODEL = before;
  }
});

test('the role map reports what this process is configured to do', async () => {
  // Health and the done event read from here, so the deployment's real routing
  // is observable rather than inferred from the code's defaults.
  const { modelRoles } = await import('../src/agent/core/quick.js');
  const roles = modelRoles();
  assert.deepEqual(Object.keys(roles).sort(), ['branch', 'deepSynthesis', 'memory', 'planner', 'queryRewrite', 'quick']);
  for (const [role, model] of Object.entries(roles)) {
    assert.ok(typeof model === 'string' && model.length > 0, `${role} names a model`);
  }
  assert.equal(roles.quick, config.llm.quickModel);
  assert.equal(roles.deepSynthesis, config.llm.deepSynthesisModel);
});

/* ------------------------------------------- degradation is not failure */

test('a recovered degradation is a warning, not an error', async () => {
  // The benchmark computes an error rate from runs that failed. A plan that was
  // repaired and then answered perfectly well is not one of those, and folding
  // it in would report the system as broken for recovering cleanly.
  const r = recorder();
  r.recordWarning('plan', 'plan_repaired', 'the first attempt returned one question');
  const snap = r.snapshot();
  assert.equal(snap.errors.length, 0, 'nothing was counted as an error');
  assert.equal(snap.warnings.length, 1);
  assert.equal(snap.warnings[0].code, 'plan_repaired');
  assert.equal(snap.warnings[0].where, 'plan');
  assert.equal(typeof snap.warnings[0].at_ms, 'number');
});

test('a real failure is still an error', () => {
  const r = recorder();
  r.recordError('llm:synthesis', new Error('the provider refused'));
  const snap = r.snapshot();
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.warnings.length, 0, 'and is not quietly downgraded');
});
