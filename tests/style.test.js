import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswerStyle } from '../src/agent/core/style.js';

test('dashes are removed from the answer by the harness, not merely discouraged in the prompt', () => {
  const out = normalizeAnswerStyle('Rio Rancho sits north of Albuquerque — including Santa Fe [2].');
  assert.equal(out.text, 'Rio Rancho sits north of Albuquerque, including Santa Fe [2].');
  assert.equal(out.replaced, 1);
});

test('a paired dash construction collapses to commas without doubling them', () => {
  const out = normalizeAnswerStyle('It was fast — very fast — and cheap.');
  assert.equal(out.text, 'It was fast, very fast, and cheap.');
  assert.ok(!out.text.includes(',,'));
});

test('a dash between numbers is a range, so it becomes "to" rather than a comma', () => {
  assert.equal(normalizeAnswerStyle('The study ran 2020–2024.').text, 'The study ran 2020 to 2024.');
  assert.equal(normalizeAnswerStyle('Open 8:00 a.m.–1:00 p.m.').text, 'Open 8:00 a.m. to 1:00 p.m.');
});

test('quoted material is never repunctuated, because the quote must stay faithful', () => {
  // Rewriting inside quotation marks would misreport what a source said, which
  // is the one thing a citation-grounded product must never do.
  const quoted = 'The paper says "the model — as trained — fails here" [1].';
  assert.equal(normalizeAnswerStyle(quoted).text, quoted);
});

test('code spans and URLs keep their dashes', () => {
  const code = 'Run `npm run dev --flag —value` first.';
  assert.equal(normalizeAnswerStyle(code).text, code);
  const url = 'See https://example.com/a—b for details.';
  assert.equal(normalizeAnswerStyle(url).text, url);
});

test('normalisation never mistakes ordinary numbers for internal placeholders', () => {
  // A naive implementation that stashes protected spans behind bare numeric
  // markers corrupts prose like "page 7" on restore.
  const text = 'See `code` on page 7 and "a quote" on page 12 — both matter.';
  const out = normalizeAnswerStyle(text);
  assert.ok(out.text.includes('page 7'), 'a real page number survived');
  assert.ok(out.text.includes('"a quote"'), 'the quoted span was restored in place');
  assert.ok(out.text.includes('`code`'));
  assert.ok(!/[—–]/.test(out.text.replace(/"[^"]*"|`[^`]*`/g, '')));
});

test('an answer with no dashes is returned untouched', () => {
  const clean = 'Plain prose with a well-formed compound word and [1] a citation.';
  const out = normalizeAnswerStyle(clean);
  assert.equal(out.changed, false);
  assert.equal(out.text, clean);
});
