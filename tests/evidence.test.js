import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger } from '../src/agent/core/evidence.js';
import { chunkPages, chunkPassages } from '../src/agent/services/chunker.js';

const fakePage = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

test('a search result is not citable until the page is actually fetched', () => {
  const ledger = new EvidenceLedger();
  ledger.noteCandidates([{ url: 'https://example.com/a', title: 'A', snippet: 'snippet only', domain: 'example.com' }]);
  assert.equal(ledger.citable.length, 0, 'snippets must never become evidence');
  assert.equal(ledger.publicCandidates().length, 1);

  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'The reactor output was 42 megawatts in the 2025 report.'.repeat(4)));
  assert.equal(ledger.citable.length, 1);
  assert.equal(ledger.publicCandidates().length, 0, 'a fetched candidate is promoted, not duplicated');
});

test('citations outside the ledger are stripped from the answer', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'The treaty was signed in Vienna in 1961 by twelve states.'.repeat(4)));

  const result = ledger.validate('The treaty was signed in Vienna in 1961 [1]. It had ninety signatories [7].');
  assert.deepEqual(result.cited, [1]);
  assert.deepEqual(result.invalid_citations, [7]);
  assert.ok(!result.answer.includes('[7]'), 'a hallucinated source number must never reach the user');
  assert.ok(result.answer.includes('[1]'));
});

test('groundedness falls when a sentence cites a source that does not support it', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://a.test/1', 'Solar', 'Solar photovoltaic capacity additions reached 450 gigawatts worldwide during 2024.'.repeat(4)));
  ledger.addWebSource(fakePage('https://b.test/2', 'Wind', 'Offshore wind installations in Europe expanded by 3.4 gigawatts across the year.'.repeat(4)));

  const grounded = ledger.validate('Solar photovoltaic capacity additions reached 450 gigawatts worldwide during 2024 [1].');
  assert.equal(grounded.groundedness, 1);

  const misattributed = ledger.validate('Nuclear fusion reactors achieved commercial breakeven across seventeen European facilities [2].');
  assert.ok(misattributed.groundedness < 0.5, `expected weak support, got ${misattributed.groundedness}`);
  assert.equal(misattributed.weak_citations.length, 1);
});

test('chunks never span pages, so page citations stay truthful', () => {
  const pages = [
    { page: 1, text: 'alpha '.repeat(400), label: 'p. 1' },
    { page: 2, text: 'beta '.repeat(400), label: 'p. 2' },
  ];
  const chunks = chunkPages(pages, { chunkChars: 500, overlap: 50 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    const pure = chunk.text.includes('alpha') !== chunk.text.includes('beta');
    assert.ok(pure, 'a chunk mixed content from two pages');
  }
  assert.deepEqual([...new Set(chunks.map((c) => c.page))], [1, 2]);
});

test('passage splitting keeps paragraphs whole and drops noise', () => {
  const text = ['x'.repeat(200), 'tiny', 'y'.repeat(200)].join('\n\n');
  const passages = chunkPassages(text, { maxChars: 250 });
  assert.ok(passages.length >= 2);
  assert.ok(!passages.includes('tiny'));
});

test('markdown headings do not hide sentence boundaries from citation scoring', () => {
  const ledger = new EvidenceLedger();
  const parksText = 'The city visitors bureau lists Coronado Historic Site among its attractions. '.repeat(4);
  ledger.addWebSource(fakePage('https://example.com/parks', 'Parks', parksText));

  // The capped-run disclaimer carries no citation of its own. Glued to the next
  // sentence by a naive splitter, its words are charged against [1] and drag
  // groundedness down precisely when the answer is most honest.
  const answer = [
    '*Research was cut short by the quick mode limit, so this answer may be partial.*',
    '',
    '**In and around the city**, the visitors bureau lists Coronado Historic Site [1].',
  ].join('\n');

  const result = ledger.validate(answer);
  assert.equal(result.cited_sentences, 1, 'the uncited disclaimer must not count as a cited claim');
  assert.equal(result.groundedness, 1, 'the one cited sentence is fully supported');
});

test('paragraph breaks split sentences even when the next one starts with emphasis', () => {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'Ramada covered picnic tables offer views of the Rio Grande valley below. '.repeat(4)));
  ledger.addWebSource(fakePage('https://example.com/b', 'B', 'Interactive maps of city parks and bike ways are published online. '.repeat(4)));

  const answer = 'Ramada covered picnic tables offer views of the Rio Grande [1].\n\n**Outdoors:** interactive maps of city parks and bike ways [2].';
  const result = ledger.validate(answer);
  assert.equal(result.cited_sentences, 2, 'two paragraphs are two sentences');
  assert.equal(result.weak_citations.length, 0, 'each claim is scored against its own source');
});

/* ------------------------------------ citing a source for what it cannot say */

test('a citation on a statement about the evidence’s own gaps is removed', () => {
  // The failure this prevents: asked an unanswerable question, the model
  // correctly reports that it found nothing and then attaches [1] to that
  // report. The marker invites the reader to check a page that, by
  // construction, cannot corroborate an absence.
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'Example Holdings BV is a private company registered in Amsterdam.'.repeat(4)));

  const result = ledger.validate('The sources do not disclose what was decided at the meeting [1].');
  assert.ok(!result.answer.includes('[1]'), 'the marker must not reach the reader');
  assert.equal(result.cited_sentences, 0, 'it is not a cited claim, so it is not scored as one');
  assert.deepEqual(result.cited, [], 'a source cited only there is not cited at all');
  assert.equal(result.stripped_for_absence.length, 1, 'the trace records that it happened');
});

test('a negative finding reported by a source keeps its citation', () => {
  // The distinction that matters: "the evidence does not say X" is about the
  // ledger, "the audit found no breach" is a claim the page can support. A
  // blanket negation rule would silently delete real citations.
  const ledger = new EvidenceLedger();
  const text = 'The audit found no evidence of a breach of customer records during the review period.'.repeat(4);
  ledger.addWebSource(fakePage('https://example.com/a', 'A', text));

  const result = ledger.validate('The audit found no evidence of a breach of customer records [1].');
  assert.ok(result.answer.includes('[1]'), 'a citable negative finding keeps its marker');
  assert.equal(result.cited_sentences, 1);
  assert.equal(result.groundedness, 1);
  assert.equal(result.stripped_for_absence.length, 0);
});

test('stripping a marker does not flatten the markdown around it', () => {
  // Rebuilding the answer by rejoining split sentences would turn lists and
  // paragraphs into one run-on line.
  const ledger = new EvidenceLedger();
  ledger.addWebSource(fakePage('https://example.com/a', 'A', 'Quarterly revenue rose to twelve million euros in the period.'.repeat(4)));

  const answer = [
    '- Quarterly revenue rose to twelve million euros [1].',
    '- The search results do not cover the board’s decision [1].',
  ].join('\n');

  const result = ledger.validate(answer);
  assert.ok(result.answer.includes('\n- '), 'the list survives');
  assert.match(result.answer, /revenue rose to twelve million euros \[1\]/, 'the real citation is untouched');
  assert.match(result.answer, /do not cover the board’s decision\.?$/m, 'the absence claim lost its marker');
  assert.deepEqual(result.cited, [1], 'the source is still cited by the sentence that can support it');
});
