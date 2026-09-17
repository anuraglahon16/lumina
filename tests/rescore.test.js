import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Re-scoring a finished run has to grade the same evidence the run graded.
 *
 * A diagnostic that rebuilds its own version of the evidence is not correcting
 * the system, it is measuring a different one — that mistake once reported 0.19
 * for a system measuring 0.86, because it scored against four-hundred character
 * snippets instead of the passages the validator actually used.
 *
 * So the ledger is rebuilt from the saved `extracted_passages`, which are
 * exactly what `addWebSource` stored, through the ledger's own restore method.
 * And the whole path is offline: if any part of it reached the network, the
 * numbers would come from somewhere other than the run being corrected.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-rescore-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { rescore, rescoreRun, rebuildLedger, passagesBySource, summarise } = await import('../tools/rescore-run.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { chunkPassages } = await import('../src/agent/services/chunker.js');

const TEXT = 'Columnar formats achieve better compression than row formats because individual columns contain far more self-similar data than rows do. '.repeat(4);
const CLAIM = 'Columnar formats achieve better compression than row formats because individual columns contain far more self-similar data than rows do';

/** A saved run in the shape the diagnostic writes, with the defect in it. */
function savedRun({ answer, sentenceResults = [], cited = 0, supported = 0 } = {}) {
  return {
    commit: 'abc1234',
    ran_at: '2026-09-17T00:00:00.000Z',
    runs: [
      {
        query: 'how do columnar formats compress',
        answer,
        sources: [{ n: 1, kind: 'web', title: 'Columnar', url: 'https://a.test/columnar', snippet: TEXT.slice(0, 400) }],
        cited_sentences: cited,
        supported_sentences: supported,
        groundedness: cited ? supported / cited : null,
        sentence_results: sentenceResults,
        funnel: {
          searches: [{ attempt: 1, query: 'columnar compression', results: [{ candidate_id: 'search_1_rank_1', rank: 1, url: 'https://a.test/columnar', title: 'Columnar', snippet: '' }] }],
          fetch_events: [
            {
              event_id: 'fetch_1',
              candidate_id: 'search_1_rank_1',
              rank: 1,
              url: 'https://a.test/columnar',
              status: 'usable',
              extracted_chars: TEXT.length,
              extracted_passages: chunkPassages(TEXT).slice(0, 8),
            },
          ],
          stop_reason: 'coverage_sufficient',
        },
      },
    ],
  };
}

test('the rebuilt ledger scores a claim exactly as the live ledger does', () => {
  // The whole correction rests on this. If the rebuilt term set differs at all
  // from the one the run used, every number after it describes something else.
  const live = new EvidenceLedger();
  live.addWebSource({ ok: true, url: 'https://a.test/columnar', title: 'Columnar', text: TEXT, fetched_at: new Date().toISOString() });
  const liveResult = live.validate(`${CLAIM}. [1]`);

  const { ledger, missing } = rebuildLedger(savedRun({ answer: `${CLAIM}. [1]` }).runs[0]);
  assert.deepEqual(missing, [], 'every source was rebuilt');
  const rebuiltResult = ledger.validate(`${CLAIM}. [1]`);

  assert.deepEqual(
    [...ledger.sources[0]._terms].sort(),
    [...live.sources[0]._terms].sort(),
    'the term set is identical, not merely similar',
  );
  assert.equal(rebuiltResult.cited_sentences, liveResult.cited_sentences);
  assert.equal(rebuiltResult.supported_sentences, liveResult.supported_sentences);
  assert.equal(rebuiltResult.groundedness, liveResult.groundedness);
  assert.equal(rebuiltResult.sentence_results[0].best_score, liveResult.sentence_results[0].best_score);
});

test('passages are recovered for a source whose sentences were never recorded', () => {
  // The runs the defect damaged are precisely the ones with no sentence_results
  // to recover passages from, so the funnel has to supply them.
  const run = savedRun({ answer: `${CLAIM}. [1]`, cited: 3, supported: 3, sentenceResults: [] });
  const found = passagesBySource(run.runs[0]);
  assert.ok(found.has(1), 'the usable fetch event supplied them');
  assert.ok(found.get(1).join(' ').includes('self-similar'));
});

test('a run whose passages were never saved is reported, not scored', () => {
  const run = savedRun({ answer: `${CLAIM}. [1]` }).runs[0];
  run.funnel.fetch_events = [];
  run.sentence_results = [];

  const result = rescoreRun(run);
  assert.equal(result.status, 'not_rescorable');
  assert.match(result.reason, /no saved passages/);
  assert.equal(result.after, undefined, 'and it is given no number at all');
});

test('the detached-marker run is rescored rather than merely discounted', () => {
  // Three free supports recorded as cited and supported with no decision
  // behind them. Deleting them would give 0/0; the claims have to be scored.
  const answer = `${CLAIM}. [1]\n\n${CLAIM}. [1]\n\n${CLAIM}. [1]`;
  const report = rescore(savedRun({ answer, cited: 3, supported: 3, sentenceResults: [] }));

  const run = report.runs[0];
  assert.equal(run.status, 'rescored');
  assert.equal(run.before.recorded_decisions, 0, 'the run recorded no decision for its three cited sentences');
  assert.equal(run.after.cited, 3, 'the three claims are still three claims');
  assert.equal(run.after.recorded_decisions, 3, 'and now each carries the decision that counted it');
  for (const decision of run.sentence_results) {
    assert.ok(decision.sentence.includes('self-similar'), 'each decision is about a real claim, not a bare marker');
  }
});

test('the summary reports before and after without rounding twice', () => {
  // 96/101 is 0.9505. Rounded to four places and then to three it reads 0.951,
  // which does not match the 0.950 the same figure was first published as, and
  // a discrepancy that is only arithmetic reads as a real change.
  const s = summarise([
    { status: 'rescored', before: { cited: 101, supported: 96, groundedness: 0.9 }, after: { cited: 100, supported: 91, groundedness: 0.9 }, factual: { factual_sentences: 0, factual_sentences_cited: 0, uncited_factual_sentences: [] } },
  ]);
  assert.equal(Number(s.pooled_grounding.before.toFixed(3)), 0.95, 'matches what was published');
  assert.ok(s.pooled_grounding.before > s.pooled_grounding.after, 'and the correction lowered it');
});

test('rescoring makes no network or model call', async () => {
  // Enforced rather than asserted. "One clean run" only means one run if the
  // correction does not quietly take a second sample.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('rescoring must not reach the network');
  };
  try {
    const report = rescore(savedRun({ answer: `${CLAIM}. [1]`, cited: 1, supported: 1 }));
    assert.equal(report.runs[0].status, 'rescored', 'it still produced a result');
    assert.equal(calls, 0, 'and reached the network zero times');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uncited factual sentences are preserved for classification, not counted away', () => {
  const answer = `${CLAIM}. [1]\n\nThis second paragraph asserts something checkable and cites nothing at all.`;
  const report = rescore(savedRun({ answer, cited: 1, supported: 1 }));
  const audit = report.runs[0].factual;

  assert.equal(audit.factual_sentences, 2);
  assert.equal(audit.factual_sentences_cited, 1);
  assert.equal(audit.uncited_factual_sentences.length, 1, 'the uncited one is kept');
  assert.match(audit.uncited_factual_sentences[0].sentence, /second paragraph/, 'with its text, so it can be read');
  assert.equal(audit.uncited_factual_sentences[0].category, null, 'and no category guessed for it');
});
