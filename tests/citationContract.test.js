import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The citation contract, stated in the prompt and measured in the validator.
 *
 * Two halves, and both have to hold or the change is not worth making. The
 * prompt has to *say* the rule — that a citation does not carry over to the
 * next sentence, and where the marker goes — because the previous prompt said
 * neither, and forty of sixty-four uncited factual sentences in the e2e0e46 run
 * were continuation sentences under a cited opener, every one of them supported
 * by evidence the answer already had.
 *
 * And the validator has to *measure* an answer written that way as complete. A
 * contract the measurement cannot see is a contract that cannot be verified,
 * and asking a model to follow one is then just hoping.
 *
 * The shapes below are what answers actually look like: two sentences sharing a
 * source, claims drawn from different sources, list stems and their items,
 * paragraph boundaries, and the evidence-gap sentence that is supposed to carry
 * no citation at all.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-contract-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { synthesisSystem } = await import('../src/agent/core/prompts.js');
const { EvidenceLedger, locateSentences } = await import('../src/agent/core/evidence.js');
const { factualAudit } = await import('../tools/rescore-run.js');

const quickPrompt = () =>
  synthesisSystem({ mode: 'quick', capped: false, capReason: null, budget: {}, memories: [], evidenceCount: 2, evidenceLimited: false, evidenceGaps: '' });

/* ------------------------------------------------------- the prompt says it */

test('the prompt forbids a citation carrying over to the next sentence', () => {
  const prompt = quickPrompt();
  assert.match(prompt, /never carries over from one sentence to the next/i);
  assert.match(prompt, /including when the sentence before it cited the same block/i);
});

test('the prompt names one canonical marker placement', () => {
  const prompt = quickPrompt();
  assert.match(prompt, /just before the full stop/i, 'it says where the marker goes');
  assert.match(prompt, /gradually \[1\]\./, 'and shows the form rather than only describing it');
  assert.match(prompt, /never leave a marker standing on its own/i);
  assert.match(prompt, /never start a sentence with one/i);
});

test('the prompt extends the rule to list items', () => {
  // The other half of the pattern: a cited stem followed by uncited bullets.
  assert.match(quickPrompt(), /each list item carries its own marker/i);
  assert.match(quickPrompt(), /does not cover the items under it/i);
});

test('the prompt refuses citations added merely to satisfy the rule', () => {
  // Without this, a per-sentence rule buys completeness with unsupported
  // citations: a worse answer that measures better.
  assert.match(quickPrompt(), /do not add a marker to a sentence merely to satisfy this rule/i);
});

test('the prompt still exempts evidence-gap disclosures', () => {
  assert.match(quickPrompt(), /reporting that the evidence does not cover something carries no citation/i);
});

test('Deep keeps the prompt it was measured with', () => {
  // One variable at a time. Deep's numbers came from the old contract, and
  // changing both at once makes the next comparison uninterpretable.
  const deep = synthesisSystem({ mode: 'deep', capped: false, capReason: null, budget: {}, memories: [], evidenceCount: 2, evidenceLimited: false, evidenceGaps: '' });
  assert.ok(!/never carries over from one sentence to the next/i.test(deep), 'Deep does not get the granularity rule yet');
  assert.match(deep, /Every factual claim, number, date, name, and quotation needs a citation/, 'but keeps the rule it had');
});

/* --------------------------------------------- the validator measures it */

const page = (url, title, text) => ({ ok: true, url, title, text, fetched_at: new Date().toISOString() });

function ledger() {
  const l = new EvidenceLedger();
  l.addWebSource(
    page('https://a.test/columnar', 'Columnar', 'Columnar formats compress better than row formats because a column holds values of one type that repeat or change gradually. '.repeat(4)),
  );
  l.addWebSource(
    page('https://b.test/rows', 'Rows', 'A row mixes different data types together and this heterogeneity means rows compress poorly in practice. '.repeat(4)),
  );
  return l;
}

const COL_A = 'Columnar formats compress better than row formats because a column holds values of one type';
const COL_B = 'A column holds values of one type that repeat or change gradually';
const ROW_A = 'A row mixes different data types together and this heterogeneity means rows compress poorly';

/** Grounding and completeness for one answer, measured the way the run is. */
function measure(answer) {
  const l = ledger();
  const validation = l.validate(answer);
  const audit = factualAudit(answer, validation, l);
  return {
    cited: validation.cited_sentences,
    supported: validation.supported_sentences,
    orphans: validation.orphan_citations.length,
    factual: audit.factual_sentences,
    factualCited: audit.factual_sentences_cited,
    completeness: audit.factual_sentences ? audit.factual_sentences_cited / audit.factual_sentences : null,
  };
}

test('two factual sentences in one paragraph from the same source both count as cited', () => {
  // The exact shape the old prompt produced half of. Under the contract both
  // sentences carry the marker, and completeness has to see both.
  const contract = measure(`${COL_A} [1]. ${COL_B} [1].`);
  assert.equal(contract.factual, 2);
  assert.equal(contract.factualCited, 2, 'both sentences are cited');
  assert.equal(contract.completeness, 1);
  assert.equal(contract.cited, 2, 'and both are scored');
  assert.equal(contract.orphans, 0);

  // What the old prompt produced instead, measured the same way.
  const inherited = measure(`${COL_A} [1]. ${COL_B}.`);
  assert.equal(inherited.factualCited, 1, 'the continuation sentence reads as uncited');
  assert.equal(inherited.completeness, 0.5);
});

test('claims from different sources keep their own markers', () => {
  const m = measure(`${COL_A} [1]. ${ROW_A} [2].`);
  assert.equal(m.cited, 2);
  assert.equal(m.supported, 2, 'each is scored against the source it names');
  assert.equal(m.completeness, 1);

  // And a marker pointing at the wrong source is still caught. This is the
  // guard that stops the granularity rule being satisfied by guessing.
  const wrong = ledger().validate(`${ROW_A} [1].`);
  assert.equal(wrong.supported_sentences, 0, 'the row claim is not supported by the columnar source');
});

test('a list stem and its items each carry their own citation', () => {
  const answer = `The evidence gives two reasons [1].\n- ${COL_B} [1].\n- ${ROW_A} [2].`;
  const m = measure(answer);
  assert.equal(m.orphans, 0);
  assert.equal(m.factualCited, m.factual, 'no item is left uncited');

  // The old shape: a cited stem covering uncited items.
  const inherited = measure(`The evidence gives two reasons [1].\n- ${COL_B}.\n- ${ROW_A}.`);
  assert.ok(inherited.factualCited < inherited.factual, 'the items read as uncited, which is the pattern being removed');
});

test('a citation at a paragraph boundary belongs to its own sentence', () => {
  const m = measure(`${COL_A} [1].\n\n${ROW_A} [2].`);
  assert.equal(m.orphans, 0, 'the canonical form cannot produce an orphan at a boundary');
  assert.equal(m.cited, 2);
  assert.equal(m.completeness, 1);

  const sentences = locateSentences(`${COL_A} [1].\n\n${ROW_A} [2].`);
  assert.equal(sentences.length, 2);
  assert.ok(sentences.every((s) => !s.orphan));
});

test('an evidence-gap disclosure is uncited by design and not counted against completeness', () => {
  // The prompt requires these to carry no citation. Counting them as uncited
  // factual sentences marks the answer down for obeying its instructions.
  const answer = `${COL_A} [1]. The sources do not say how the encoding is chosen.`;
  const l = ledger();
  const validation = l.validate(answer);
  const audit = factualAudit(answer, validation, l);

  const disclosure = audit.uncited_factual_sentences.find((s) => /do not say/.test(s.sentence));
  assert.ok(disclosure, 'the disclosure is preserved');
  assert.equal(disclosure.is_absence_disclosure, true, 'and recognised as one');
  assert.equal(audit.factual_sentences_excluding_disclosures, audit.factual_sentences - 1, 'so it can leave the denominator');
});

test('the canonical form produces no standalone markers in any shape', () => {
  const shapes = [
    `${COL_A} [1].`,
    `${COL_A} [1]. ${COL_B} [1].`,
    `${COL_A} [1].\n\n${ROW_A} [2].`,
    `- ${COL_B} [1].\n- ${ROW_A} [2].`,
    `1. ${COL_B} [1].\n2. ${ROW_A} [2].`,
    `## Heading\n\n${COL_A} [1, 2].`,
    `${COL_A} [1]. The sources do not cover the encoding.`,
  ];
  for (const answer of shapes) {
    const validation = ledger().validate(answer);
    assert.equal(validation.orphan_citations.length, 0, `no orphan for: ${JSON.stringify(answer)}`);
    assert.equal(validation.unscoreable_citations.length, 0, `nothing unscoreable for: ${JSON.stringify(answer)}`);
    assert.equal(
      validation.sentence_results.length,
      validation.cited_sentences,
      `every counted sentence recorded for: ${JSON.stringify(answer)}`,
    );
  }
});

test('a citation on a sentence the cited block does not support still fails', () => {
  // The rule the granularity push must not be allowed to break. Completeness
  // bought with unsupported citations is a worse answer measuring better.
  const answer = `${COL_A} [1]. Columnar formats were first standardised by the international committee in 1994 [1].`;
  const m = measure(answer);
  assert.equal(m.cited, 2, 'both sentences are cited');
  assert.equal(m.completeness, 1, 'and completeness is satisfied');
  assert.equal(m.supported, 1, 'but grounding catches the invented one');
});

/* ------------------------------------- the second iteration: lists and formulas */

/**
 * Structures the first contract named but did not demonstrate.
 *
 * Classifying all fifty-one remaining misses by shape corrected a guess I had
 * made from fourteen of them: three are list items, thirty-seven are ordinary
 * continuation sentences in prose. Both rules are stated, and the examples show
 * the prose case first because that is where the misses are.
 */

test('the prompt requires a marker on formulas, variables and numeric values', () => {
  assert.match(quickPrompt(), /every formula, variable definition, numeric value and specification/i);
});

test('the prompt refuses citations on headings and announcements', () => {
  // A cited heading inflates completeness without citing a claim, and a line
  // that only announces what follows asserts nothing to support.
  assert.match(quickPrompt(), /do not cite a heading/i);
  assert.match(quickPrompt(), /only job is to announce what follows/i);
});

test('the prompt demonstrates the rule rather than only stating it', () => {
  const prompt = quickPrompt();
  // Consecutive prose sentences, which is 37 of the 51 remaining misses.
  assert.match(prompt, /repeat or change gradually \[1\]\. That repetition is what compression exploits \[1\]\./);
  // And a list whose stem is cited and whose items are cited separately.
  assert.match(prompt, /- If SMSS is above 2190 bytes, the initial window is 2 \* SMSS \[2\]\./);
});

test('a cited stem with uncited items is measured as incomplete', () => {
  const stem = 'The evidence gives two reasons for the difference [1].';
  const withItems = `${stem}\n- ${COL_B} [1].\n- ${ROW_A} [2].`;
  const withoutItems = `${stem}\n- ${COL_B}.\n- ${ROW_A}.`;

  assert.equal(measure(withItems).completeness, 1, 'each item carrying its own marker is complete');
  assert.ok(measure(withoutItems).completeness < 1, 'a cited stem does not cover the items below it');
});

test('a nested list item carries its own citation', () => {
  const answer = `The layout differs [1].\n- ${COL_B} [1].\n  - ${ROW_A} [2].`;
  const m = measure(answer);
  assert.equal(m.orphans, 0);
  assert.equal(m.factualCited, m.factual, 'the nested item is cited too');
});

test('a numbered list of specifications is measured item by item', () => {
  const answer = `Three cases apply [1].\n1. ${COL_B} [1].\n2. ${ROW_A} [2].`;
  const m = measure(answer);
  assert.equal(m.orphans, 0);
  assert.equal(m.factualCited, m.factual);
});

test('a formula line and its variable definition each count as a cited sentence', () => {
  // Specification lines are short, so they sit near the six-word threshold that
  // decides what counts as factual. What must hold either way is that a cited
  // one is never counted as uncited.
  const answer = 'The initial window depends on the sender maximum segment size [1].\n- If SMSS is above 2190 bytes, the initial window is 2 * SMSS [1].\n- Otherwise the initial window is 4 times SMSS [1].';
  const m = measure(answer);
  assert.equal(m.orphans, 0);
  assert.equal(m.factualCited, m.factual, 'no specification line reads as uncited');
});

test('a markdown table row with a citation is not read as an orphan', () => {
  const answer = `Two layouts differ [1].\n\n| layout | behaviour |\n|---|---|\n| columnar | ${COL_B} [1]. |\n| row | ${ROW_A} [2]. |`;
  const validation = ledger().validate(answer);
  assert.equal(validation.orphan_citations.length, 0);
  assert.equal(validation.sentence_results.length, validation.cited_sentences);
});

test('a list mixing supported and unsupported items scores each on its own', () => {
  // The guard rail inside a list. Citing every item is only worth anything if
  // an item the block does not support still fails.
  const answer = `Two findings [1].\n- ${COL_B} [1].\n- The format was ratified by the standards committee in 1994 [1].`;
  const m = measure(answer);
  assert.equal(m.completeness, 1, 'both items are cited');
  assert.ok(m.supported < m.cited, 'and the invented one is still caught');
});

test('the prompt did not grow much for this', () => {
  // Prompt length is paid on every Quick request, before the first token.
  const legacy = synthesisSystem({ mode: 'quick', capped: false, capReason: null, budget: {}, memories: [], evidenceCount: 2, evidenceLimited: false, evidenceGaps: '', contract: 'legacy' });
  const growth = quickPrompt().length - legacy.length;
  assert.ok(growth < 1200, `the citation contract adds ${growth} characters, which is more than it should`);
});
