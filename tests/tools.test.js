import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInput } from '../src/agent/core/tools.js';

test('model-supplied tool arguments are validated at the boundary', () => {
  // input_schema tells the model what to send; nothing enforced that it did.
  // A missing query used to reach web_search as undefined and search for the
  // literal string "undefined".
  assert.equal(validateToolInput('web_search', { query: 'ok' }).ok, true);
  assert.equal(validateToolInput('web_search', {}).ok, false);
  assert.equal(validateToolInput('web_search', { query: '   ' }).ok, false);
  assert.equal(validateToolInput('fetch_page', { url: 123 }).ok, false);
  assert.equal(validateToolInput('remember', { content: 'x', kind: 'bogus' }).ok, false);
  assert.equal(validateToolInput('no_such_tool', {}).ok, false);
});

test('a validation failure explains itself, so the model can correct the call', () => {
  const result = validateToolInput('web_search', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /query/, 'the message must name the offending field');
});

test('validation passes through the parsed value, not the raw input', () => {
  const result = validateToolInput('web_search', { query: '  spaced  ', recency: 'recent' });
  assert.equal(result.ok, true);
  assert.equal(result.value.query, 'spaced', 'trimmed on the way through');
  assert.equal(result.value.recency, 'recent');
});
