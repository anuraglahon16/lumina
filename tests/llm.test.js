import test from 'node:test';
import assert from 'node:assert/strict';
import { baseParams, parseJsonLoose } from '../src/agent/core/llm.js';

const failing = () => Promise.reject(new Error('upstream exploded'));

/**
 * Request shaping, per model.
 *
 * This file exists because of a bug that lived for the whole life of the
 * project: every automatic memory extraction failed with "adaptive thinking is
 * not supported on this model", because the request was built for the
 * Opus/Sonnet shape and routed to Haiku. The extractor swallowed its own
 * errors, so the feature was not broken in any visible way. It simply never
 * worked, and nothing said so.
 *
 * The lesson is not about one parameter. The moment more than one model family
 * is in play, request shape is a property of the routing, and routing is
 * configuration, so the shape has to be asserted rather than assumed.
 */

test('haiku is sent neither adaptive thinking nor an effort setting', () => {
  const p = baseParams({ model: 'claude-haiku-4-5', messages: [], maxTokens: 500 });
  assert.equal(p.thinking, undefined, 'adaptive thinking is a 400 on this model');
  assert.equal(p.output_config, undefined, 'effort is a 400 on this model');
  assert.equal(p.model, 'claude-haiku-4-5');
  assert.equal(p.max_tokens, 500);
});

test('the sonnet and opus families get adaptive thinking and effort', () => {
  for (const model of ['claude-sonnet-5', 'claude-opus-5']) {
    const p = baseParams({ model, messages: [], effort: 'high' });
    assert.deepEqual(p.thinking, { type: 'adaptive' }, `${model} should think adaptively`);
    assert.deepEqual(p.output_config, { effort: 'high' }, `${model} should carry effort`);
  }
});

test('an unknown model gets the default shape rather than nothing', () => {
  // A new model id must not silently lose thinking; the conservative default is
  // the shape the current families use.
  const p = baseParams({ model: 'claude-something-new', messages: [] });
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.ok(p.output_config);
});

test('effort defaults rather than being omitted when the caller says nothing', () => {
  const p = baseParams({ model: 'claude-sonnet-5', messages: [] });
  assert.equal(p.output_config.effort, 'medium');
});

test('the system prompt carries the cache breakpoint on every model', () => {
  // The system prompt is the stable prefix. Losing the breakpoint on one model
  // would quietly stop caching for whatever that model handles.
  for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
    const p = baseParams({ model, system: 'stable prefix', messages: [] });
    assert.equal(p.system[0].cache_control.type, 'ephemeral', `${model} lost its cache breakpoint`);
    assert.equal(p.system[0].text, 'stable prefix');
  }
});

test('caching can be turned off for a prompt that is not stable', () => {
  const p = baseParams({ model: 'claude-sonnet-5', system: 'varies', messages: [], cacheSystem: false });
  assert.equal(p.system[0].cache_control, undefined);
});

test('tools are only attached when there are some', () => {
  const without = baseParams({ model: 'claude-sonnet-5', messages: [] });
  assert.equal(without.tools, undefined, 'an empty tool list must not be sent as []');
  const with_ = baseParams({ model: 'claude-sonnet-5', messages: [], tools: [{ name: 'web_search' }] });
  assert.equal(with_.tools.length, 1);
});

/* ----------------------------------------------------- loose JSON recovery */

test('JSON is recovered from fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here is the plan: {"sub_questions":[{"id":"q1"}]} — done'), {
    sub_questions: [{ id: 'q1' }],
  });
  assert.equal(parseJsonLoose('no json at all'), null);
});

test('a brace inside a string does not end the object early', () => {
  // Naive brace counting truncates here, and the planner then loses its last
  // sub-question rather than failing loudly.
  const parsed = parseJsonLoose('{"note": "a } inside a string", "n": 2}');
  assert.equal(parsed.n, 2);
  assert.equal(parsed.note, 'a } inside a string');
});

test('malformed input returns null instead of throwing', () => {
  for (const bad of ['', null, undefined, '{unclosed', '{"a":']) {
    assert.equal(parseJsonLoose(bad), null, `${String(bad)} should parse to null`);
  }
});
