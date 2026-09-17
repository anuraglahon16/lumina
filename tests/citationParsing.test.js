import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger, citationStyle, locateSentences, splitSentences } from '../src/agent/core/evidence.js';

/**
 * Where a citation marker sits must not change what it means.
 *
 * "Claim. [1]" and "Claim [1]." are the same statement with the same citation,
 * and a run measured at 0.950 grounding contained seven of the first form. The
 * boundary rule broke each one into a claim counted as *uncited* and a bare
 * "[1]" counted as cited — and, having no words to check, counted as supported
 * for free. It moved grounding in one direction and completeness in the other,
 * and neither half of the damage was visible in any recorded per-sentence
 * decision, because the free support never wrote one.
 */

const page = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

/** A ledger with two sources whose text supports the claims used below. */
function ledgerWithSources() {
  const ledger = new EvidenceLedger();
  ledger.addWebSource(
    page(
      'https://a.test/columnar',
      'Columnar',
      'Columnar formats achieve better compression than row formats because individual columns contain far more self-similar data than rows do. '.repeat(
        4,
      ),
    ),
  );
  ledger.addWebSource(
    page(
      'https://b.test/rows',
      'Rows',
      'A row mixes different data types together and this heterogeneity means rows compress poorly in practice. '.repeat(4),
    ),
  );
  return ledger;
}

const CLAIM_A = 'Columnar formats achieve better compression than row formats because individual columns contain far more self-similar data than rows do';
const CLAIM_B = 'A row mixes different data types together and this heterogeneity means rows compress poorly in practice';

test('a marker after the terminal period stays with the claim it cites', () => {
  const sentences = locateSentences(`${CLAIM_A}. [1]`);
  assert.equal(sentences.length, 1, 'one claim, not a claim plus a stray marker');
  assert.equal(sentences[0].text, `${CLAIM_A}. [1]`);
  assert.ok(!sentences[0].orphan);
});

test('a marker before the terminal period is unchanged', () => {
  const sentences = locateSentences(`${CLAIM_A} [1].`);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, `${CLAIM_A} [1].`);
});

test('the two placements score identically', () => {
  const after = ledgerWithSources().validate(`${CLAIM_A}. [1]`);
  const before = ledgerWithSources().validate(`${CLAIM_A} [1].`);

  assert.equal(after.cited_sentences, 1);
  assert.equal(before.cited_sentences, 1);
  assert.equal(after.supported_sentences, before.supported_sentences);
  assert.equal(after.groundedness, before.groundedness);
  assert.equal(after.cited.length, 1, 'and the source counts as cited in both');
});

test('a multi-reference marker after the period reattaches whole', () => {
  const sentences = locateSentences(`${CLAIM_A}. [1, 2]`);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, `${CLAIM_A}. [1, 2]`);

  const result = ledgerWithSources().validate(`${CLAIM_A}. [1, 2]`);
  assert.equal(result.cited_sentences, 1);
  assert.deepEqual(result.sentence_results[0].refs, [1, 2], 'both references belong to the one claim');
});

test('a marker between two claims belongs to the one before it', () => {
  const sentences = locateSentences(`${CLAIM_A}. [1] ${CLAIM_B} [2].`);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].text, `${CLAIM_A}. [1]`);
  assert.equal(sentences[1].text, `${CLAIM_B} [2].`);
});

test('markdown bullets and numbered lists keep their citations', () => {
  const bullets = locateSentences(`- ${CLAIM_A}. [1]\n- ${CLAIM_B} [2].`);
  assert.equal(bullets.length, 2);
  assert.ok(bullets[0].text.endsWith('[1]'), `bullet kept its marker: ${bullets[0].text}`);
  assert.ok(bullets.every((s) => !s.orphan));

  // A numbered marker ends in a period, so "1." splits off as its own
  // fragment. It carries no citation and no content, so it changes no count —
  // what matters is that the claim beside it kept the marker it cites.
  const numbered = locateSentences(`1. ${CLAIM_A}. [1]\n2. ${CLAIM_B} [2].`);
  assert.ok(!numbered.some((s) => s.orphan), 'no marker was left standing alone');
  const first = numbered.find((s) => s.text.includes('self-similar'));
  assert.ok(first.text.endsWith('[1]'), `numbered item kept its marker: ${first.text}`);
});

test('a marker does not reach backwards across a paragraph break', () => {
  const sentences = locateSentences(`${CLAIM_A}.\n\n[1]`);
  assert.equal(sentences.length, 2);
  assert.ok(!sentences[0].orphan, 'the claim is a claim');
  assert.equal(sentences[1].orphan, true, 'a marker alone in its own paragraph cites nothing in particular');
});

test('a heading is not a claim its following marker can attach to', () => {
  const sentences = locateSentences(`## Compression\n\n${CLAIM_A}. [1]`);
  const claim = sentences.find((s) => s.text.includes('self-similar'));
  assert.ok(claim, 'the claim survived the heading');
  assert.ok(claim.text.endsWith('[1]'), 'and kept its marker');
});

test('a genuine orphan is reported and counted in neither direction', () => {
  const result = ledgerWithSources().validate(`${CLAIM_A}.\n\n[1]`);

  assert.equal(result.orphan_citations.length, 1, 'the orphan is reported rather than silently dropped');
  assert.deepEqual(result.orphan_citations[0].refs, [1]);
  assert.equal(result.cited_sentences, 0, 'an orphan marker cites no sentence');
  assert.equal(result.supported_sentences, 0, 'and above all it is not free support');
});

test('a cited sentence with nothing checkable in it is never free support', () => {
  // Every token is a stopword, so there is nothing to overlap against.
  const result = ledgerWithSources().validate('It is [1]');
  assert.equal(result.supported_sentences, 0, 'no content words means no support was demonstrated');
  assert.equal(result.cited_sentences, 0, 'and it is not counted as a judged sentence either');
  assert.equal(result.unscoreable_citations.length, 1, 'it is reported, since it did cite something');
});

test('every counted cited sentence carries the decision that counted it', () => {
  const answers = [
    `${CLAIM_A}. [1]`,
    `${CLAIM_A} [1].`,
    `${CLAIM_A}. [1, 2]`,
    `- ${CLAIM_A}. [1]\n- ${CLAIM_B} [2].`,
    `${CLAIM_A}.\n\n[1]`,
    `[1] ${CLAIM_B}.`,
    'It is [1]',
    `${CLAIM_A}. [1] ${CLAIM_B} [2].`,
  ];
  for (const answer of answers) {
    const result = ledgerWithSources().validate(answer);
    assert.equal(
      result.sentence_results.length,
      result.cited_sentences,
      `sentence_results must match cited_sentences for: ${JSON.stringify(answer)}`,
    );
    assert.ok(
      result.supported_sentences <= result.cited_sentences,
      `supported cannot exceed cited for: ${JSON.stringify(answer)}`,
    );
  }
});

test('the detached-marker answer that produced the seven free supports now scores once per claim', () => {
  // The shape verbatim from the e2e0e46 run's columnar-storage answer: every
  // paragraph ends with a period, a space, and a marker.
  const answer = `${CLAIM_A}. [1]\n\n${CLAIM_B} [2].\n\n${CLAIM_A}. [1]`;
  const result = ledgerWithSources().validate(answer);

  assert.equal(result.cited_sentences, 3, 'three claims, three cited sentences');
  assert.equal(result.orphan_citations.length, 0, 'and no marker left standing on its own');
  assert.equal(result.sentence_results.length, 3);
  for (const decision of result.sentence_results) {
    assert.ok(decision.sentence.replace(/\[[\d,\s]+\]/g, '').trim().length > 20, 'each decision is about a real claim');
    assert.ok(Array.isArray(decision.scored_against), 'and names what it was scored against');
  }
});

/* ------------------------------------------- the other placement convention */

/**
 * The synthesis prompt asks for bracketed numbers and does not say where to put
 * them, so answers differ. In the same twenty-question run, the columnar
 * storage answer trailed every marker and the write-ahead-log answer led every
 * one. A parser that assumes either convention gets the other systematically
 * wrong, and attaching a marker to the wrong claim is worse than leaving it
 * loose: it scores a sentence against a source nobody offered for it.
 */

test('an answer that leads with its markers is read as leading', () => {
  const answer = `[1] ${CLAIM_A}. [2] ${CLAIM_B}.`;
  assert.equal(citationStyle(answer), 'leading');

  const sentences = locateSentences(answer);
  assert.equal(sentences.length, 2);
  assert.ok(sentences[0].text.startsWith('[1]'), 'the first marker leads the first claim');
  assert.ok(sentences[1].text.startsWith('[2]'), 'and the second leads the second');
  assert.ok(!sentences.some((s) => s.orphan), 'neither is an orphan');
});

test('a leading marker is not stolen by the claim before it', () => {
  // The bug this prevents: under a trailing assumption, "[2]" here attaches to
  // the sentence about columnar formats, which source 2 does not support.
  const result = ledgerWithSources().validate(`[1] ${CLAIM_A}. [2] ${CLAIM_B}.`);
  assert.equal(result.cited_sentences, 2);

  const first = result.sentence_results.find((s) => s.sentence.includes('self-similar'));
  const second = result.sentence_results.find((s) => s.sentence.includes('heterogeneity'));
  assert.deepEqual(first.refs, [1], 'the columnar claim cites the columnar source alone');
  assert.deepEqual(second.refs, [2], 'and the row claim cites the row source alone');
});

test('the two conventions reach the same verdict on the same claims', () => {
  const trailing = ledgerWithSources().validate(`${CLAIM_A}. [1]\n\n${CLAIM_B} [2].`);
  const leading = ledgerWithSources().validate(`[1] ${CLAIM_A}.\n\n[2] ${CLAIM_B}.`);

  assert.equal(citationStyle(`${CLAIM_A}. [1]\n\n${CLAIM_B} [2].`), 'trailing');
  assert.equal(citationStyle(`[1] ${CLAIM_A}.\n\n[2] ${CLAIM_B}.`), 'leading');
  assert.equal(leading.cited_sentences, trailing.cited_sentences);
  assert.equal(leading.supported_sentences, trailing.supported_sentences);
  assert.equal(leading.groundedness, trailing.groundedness);
});

test('a block-opening marker leads even in an answer that otherwise trails', () => {
  // Nothing precedes it, so it cannot trail whatever the rest of the answer does.
  const answer = `${CLAIM_A}. [1]\n\n[2] ${CLAIM_B}.`;
  assert.equal(citationStyle(answer), 'trailing', 'one block ends with a marker, one begins with one');
  const sentences = locateSentences(answer);
  assert.ok(!sentences.some((s) => s.orphan));
  assert.ok(sentences[0].text.endsWith('[1]'));
  assert.ok(sentences[1].text.startsWith('[2]'));
});

test('a marker with nothing after it trails even in a leading answer', () => {
  const answer = `[1] ${CLAIM_A}.\n\n[2] ${CLAIM_B}. [1]`;
  assert.equal(citationStyle(answer), 'leading');
  const sentences = locateSentences(answer);
  assert.ok(!sentences.some((s) => s.orphan), 'a closing marker has only one place to go');
  assert.ok(sentences.at(-1).text.endsWith('[1]'));
});

test('splitSentences still returns plain strings for callers that want them', () => {
  const strings = splitSentences(`${CLAIM_A}. [1]`);
  assert.deepEqual(strings, [`${CLAIM_A}. [1]`]);
});
