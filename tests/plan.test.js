import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, fallbackPlan, repairInstruction, PLAN_ORIGIN } from '../src/agent/core/plan.js';

/**
 * The plan a deep run is allowed to act on.
 *
 * The benchmark scores the *minimum* sub-question count across runs, so one
 * thin plan in four is worth as much as a run that never happened — and the
 * old fallback handed back the user's own question as a single sub-question,
 * which is how a deep run reported zero. Everything here is about refusing to
 * proceed with a plan that is not one.
 */

const QUERY = 'what is the current evidence that retrieval-augmented generation reduces hallucination';
const q = (question, extra = {}) => ({ question, why: 'because', ...extra });

const goodPlan = {
  interpretation: 'evidence on RAG and hallucination',
  answer_shape: 'claim, evidence, caveats',
  sub_questions: [
    q('which benchmarks measure hallucination in generated answers'),
    q('what do controlled studies report when retrieval is added'),
    q('under what conditions does retrieval fail to help'),
  ],
};

/* --------------------------------------------------------- what is refused */

test('empty planner output is refused', () => {
  for (const raw of [null, undefined, '', 0]) {
    const r = validatePlan(raw, { query: QUERY });
    assert.equal(r.ok, false);
    assert.ok(r.problems.length > 0, 'and says why');
  }
});

test('output that is not an object, or has no sub_questions, is refused', () => {
  assert.equal(validatePlan({ interpretation: 'x' }, { query: QUERY }).ok, false);
  assert.equal(validatePlan({ sub_questions: 'three of them' }, { query: QUERY }).ok, false);
  assert.equal(validatePlan([], { query: QUERY }).ok, false);
});

test('a one-question plan is refused, because that is a quick search', () => {
  const r = validatePlan({ sub_questions: [q('what is RAG')] }, { query: QUERY });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /at least 3/);
});

test('duplicates do not count towards the minimum', () => {
  // Three entries, one distinct question. A planner repeating itself produces
  // a plan that looks the right size and researches one thing.
  const r = validatePlan(
    { sub_questions: [q('how is hallucination measured'), q('How is hallucination measured?'), q('how is  hallucination   measured')] },
    { query: QUERY },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /same thing/);
});

test('a sub-question that restates the whole question is refused', () => {
  const r = validatePlan({ sub_questions: [q(QUERY), q('what benchmarks exist'), q('what are the limits')] }, { query: QUERY });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /restates the original/);
});

test('empty and contentless sub-questions are dropped', () => {
  const r = validatePlan({ sub_questions: [q(''), q('   '), q('?!'), ...goodPlan.sub_questions] }, { query: QUERY });
  assert.equal(r.ok, true, 'the three real ones still make a plan');
  assert.equal(r.plan.sub_questions.length, 3);
});

/* --------------------------------------------------------- what is accepted */

test('a valid three to five question plan passes and is renumbered', () => {
  const r = validatePlan(goodPlan, { query: QUERY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.sub_questions.map((x) => x.id), ['q1', 'q2', 'q3']);
  assert.equal(r.plan.interpretation, 'evidence on RAG and hallucination');
});

test('more than the maximum is trimmed rather than refused', () => {
  const topics = ['benchmarks', 'latency', 'corpus freshness', 'reranking', 'citation accuracy', 'chunk size', 'embedding choice', 'query rewriting', 'evaluation cost'];
  const many = { sub_questions: topics.map((t) => q(`how does ${t} affect retrieval quality`)) };
  const r = validatePlan(many, { query: QUERY, max: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.plan.sub_questions.length, 5);
});

test('long questions and reasons are truncated, not rejected', () => {
  const r = validatePlan(
    { sub_questions: [q('a'.repeat(900) + ' benchmarks'), q('b'.repeat(900) + ' studies', { why: 'c'.repeat(900) }), q('third distinct angle here')] },
    { query: QUERY },
  );
  assert.equal(r.ok, true);
  for (const sq of r.plan.sub_questions) {
    assert.ok(sq.question.length <= 240);
    if (sq.why) assert.ok(sq.why.length <= 200);
  }
});

/* ------------------------------------------------------------- the fallback */

test('the fallback is a real decomposition, not the question repeated', () => {
  const p = fallbackPlan(QUERY);
  assert.ok(p.sub_questions.length >= 3, 'it meets the floor the gate measures');
  const keys = new Set(p.sub_questions.map((s) => s.question.toLowerCase()));
  assert.equal(keys.size, p.sub_questions.length, 'and its questions differ from each other');
  assert.ok(!p.sub_questions.some((s) => s.question.toLowerCase().trim() === QUERY.toLowerCase().trim()));
});

test('the fallback validates against the same rules it exists to satisfy', () => {
  // If the harness's own plan could not pass validation, the fallback would
  // just be a different way to fail.
  assert.equal(validatePlan(fallbackPlan(QUERY), { query: QUERY }).ok, true);
});

test('the fallback works for a question with nothing to work with', () => {
  for (const input of ['', '   ', null, undefined]) {
    const p = fallbackPlan(input);
    assert.ok(p.sub_questions.length >= 3);
    assert.ok(p.sub_questions.every((s) => s.question.trim().length > 0));
  }
});

test('the fallback carries nothing specific to any particular question', () => {
  // A fallback tuned to the questions being graded would be answering the
  // benchmark instead of the user.
  const a = fallbackPlan('how do tides work');
  const b = fallbackPlan('what causes inflation');
  const shape = (p) => p.sub_questions.map((s) => s.question.replace(/how do tides work|what causes inflation/gi, '<q>'));
  assert.deepEqual(shape(a), shape(b), 'the same template, with only the subject swapped');
});

/* ------------------------------------------------------------- the repair */

test('the repair instruction names the problems it wants fixed', () => {
  const r = validatePlan({ sub_questions: [q('only one')] }, { query: QUERY });
  const instruction = repairInstruction(r.problems);
  assert.match(instruction, /at least 3/);
  assert.match(instruction, /sub_questions/);
  assert.ok(instruction.length < 2000, 'short enough to prepend to a retry');
});

test('the three origins are distinct values', () => {
  const values = new Set(Object.values(PLAN_ORIGIN));
  assert.equal(values.size, 3);
  assert.ok(values.has('model') && values.has('repair') && values.has('fallback'));
});
