import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Two runs that look identical in the report and want opposite repairs.
 *
 * Both end with a relevant page read and an answer that cannot cover the
 * question, and the e2e0e46 review filed both as `passage_miss`. They are not
 * the same failure.
 *
 * In the TLS certificate pinning run, the right page was fetched in full —
 * nineteen thousand characters — and what came out of it was the table of
 * contents. The extraction picked the wrong text out of a page that had the
 * right text in it. That is fixed by query-aware passage selection.
 *
 * In the HTTP/2-versus-HTTP/3 run, the page that was read covers HTTP/2 only.
 * It satisfied the coverage rule, which stopped the pool and aborted the two
 * pages that compared HTTP/2 with HTTP/3 while they were still in flight.
 * Passage selection cannot fix that: the text it would select from was never
 * read. The component at fault is the one that called the evidence sufficient.
 *
 * This case only became classifiable once aborted losers were recorded as
 * `cancelled` rather than left at `attempted` — see fetchTermination.test.js.
 *
 * The first version of this file separated them by asking whether relevant
 * pages had been cancelled under a coverage stop, and a live probe against the
 * same two questions showed that was not enough: the TLS run has two cancelled
 * relevant pages as well. Coverage cancels losers on every healthy run, so its
 * presence carries no information. What separates them is whether extraction
 * gave up what the page it read actually contained, and both fixtures below now
 * carry the cancellations that made the old rule wrong.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-covmiss-'));
process.env.MONGODB_URI = '';

const { classifyRetrieval, RETRIEVAL_OUTCOME } = await import('../src/agent/core/funnel.js');

const candidate = (rank, url, title) => ({ candidate_id: `search_1_rank_${rank}`, search_attempt: 1, rank, url, title, snippet: '' });
const event = (rank, url, status, extra = {}) => ({
  event_id: `fetch_${rank}`,
  candidate_id: `search_1_rank_${rank}`,
  search_attempt: 1,
  rank,
  url,
  status,
  admitted_as_evidence: status === 'usable',
  ...extra,
});

/**
 * The TLS run: one relevant page, read in full, extraction gave headings.
 */
const TLS = {
  funnel: {
    candidates: [
      candidate(1, 'https://paloaltonetworks.test/certificate-pinning', 'What Is Certificate Pinning?'),
      candidate(2, 'https://other.test/pinning-guide', 'Certificate pinning guide'),
    ],
    fetch_events: [
      event(1, 'https://paloaltonetworks.test/certificate-pinning', 'usable', {
        extracted_chars: 19911,
        extracted_passages: ['Table of contents', 'What Is Certificate Pinning?', 'Related resources'],
      }),
      // The live probe reproduced this run with the other relevant page
      // cancelled by the same coverage stop. Coverage cancels losers on every
      // healthy run, so its presence proves nothing by itself — which is
      // exactly why the fixture carries it.
      event(2, 'https://other.test/pinning-guide', 'cancelled', { reason: 'cancelled' }),
    ],
    stop_reason: 'coverage_sufficient',
  },
  review: {
    relevant_urls: ['https://paloaltonetworks.test/certificate-pinning', 'https://other.test/pinning-guide'],
    extracted_passages_contain_answer: false,
    // The page held the answer; what came out of it was its table of contents.
    extraction_faithful: false,
  },
};

/**
 * The HTTP run: a partial page satisfied coverage and the comparative pages
 * were cancelled mid-flight.
 */
const HTTP = {
  funnel: {
    candidates: [
      candidate(1, 'https://http2.test/hol-blocking', 'Head-of-line blocking in HTTP/2'),
      candidate(2, 'https://quic.test/tcp-vs-quic', 'Head-of-Line Blocking: TCP vs QUIC / HTTP3'),
      candidate(3, 'https://cdn.test/mitigating-hol', 'Mitigating HOL in HTTP/2 and HTTP/3'),
    ],
    fetch_events: [
      event(1, 'https://http2.test/hol-blocking', 'usable', { extracted_chars: 8200, extracted_passages: ['HTTP/2 multiplexes streams over one TCP connection.'] }),
      event(2, 'https://quic.test/tcp-vs-quic', 'cancelled', { reason: 'cancelled' }),
      event(3, 'https://cdn.test/mitigating-hol', 'cancelled', { reason: 'cancelled' }),
    ],
    stop_reason: 'coverage_sufficient',
  },
  review: {
    relevant_urls: ['https://http2.test/hol-blocking', 'https://quic.test/tcp-vs-quic', 'https://cdn.test/mitigating-hol'],
    extracted_passages_contain_answer: false,
    // Extraction gave up what the page actually said. The page only said half.
    extraction_faithful: true,
  },
};

const classify = (fixture) => classifyRetrieval(fixture.funnel, { citedSentences: 1, supportedSentences: 0, review: fixture.review });

test('extraction that returned only headings is a passage miss, even with pages cancelled', () => {
  // The case a live probe caught. Both fixtures now have relevant pages
  // cancelled under a coverage stop, because both real runs did, so the
  // cancellation cannot be what decides between them.
  const outcome = classify(TLS);
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS);
  assert.match(outcome.flags[0], /extracted passages did not carry the answer/);
});

test('relevant pages cancelled by a coverage stop is a coverage miss', () => {
  const outcome = classify(HTTP);
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.COVERAGE_MISS);
  assert.match(outcome.flags[0], /extraction was faithful and coverage cancelled/);
  assert.match(outcome.flags[0], /2 relevant page/, 'and says how much evidence it let go of');
});

test('the two fixtures produce different outcomes', () => {
  // The point of the category. Before it, both of these read as passage_miss
  // and the reported fix — query-aware passage selection — would have done
  // nothing at all for the second.
  assert.notEqual(classify(TLS).primary, classify(HTTP).primary);
});

test('an undecided extraction judgement stays pending rather than guessing', () => {
  // With relevant pages cancelled under a coverage stop, the two categories are
  // genuinely ambiguous. Picking one would manufacture a confident label out of
  // a reviewer's silence, which is the mistake the whole review stage exists to
  // avoid.
  const { extraction_faithful, ...withoutJudgement } = HTTP.review;
  const outcome = classify({ funnel: HTTP.funnel, review: withoutJudgement });
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.PENDING_REVIEW);
  assert.match(outcome.flags[0], /whether extraction represented the page it read/);
});

test('extraction_faithful is not asked for when nothing relevant was cancelled', () => {
  // No ambiguity, so no extra question. Otherwise every existing review would
  // go pending for a distinction that does not arise in its run.
  const outcome = classify({
    funnel: { ...HTTP.funnel, fetch_events: [HTTP.funnel.fetch_events[0]] },
    review: { relevant_urls: ['https://http2.test/hol-blocking'], extracted_passages_contain_answer: false },
  });
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS);
});

test('a cancellation that was not a coverage stop is not a coverage miss', () => {
  // A deadline or a caller cancellation aborts losers too. Coverage is only to
  // blame when coverage is what stopped the pool.
  const outcome = classify({
    funnel: { ...HTTP.funnel, stop_reason: 'deadline_or_cancelled' },
    review: HTTP.review,
  });
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS, 'the deadline is not the coverage rule');
});

test('no cancelled relevant page means the coverage rule let nothing go', () => {
  const outcome = classify({
    funnel: { ...HTTP.funnel, fetch_events: [HTTP.funnel.fetch_events[0]] },
    review: { relevant_urls: ['https://http2.test/hol-blocking'], extracted_passages_contain_answer: false },
  });
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS);
});

test('coverage_miss is reached only after the earlier stages pass', () => {
  // Precedence still holds: a run whose search found nothing relevant is a
  // query miss even though its pool also stopped on coverage.
  const outcome = classifyRetrieval(HTTP.funnel, {
    citedSentences: 0,
    supportedSentences: 0,
    review: { relevant_urls: [], extracted_passages_contain_answer: false },
  });
  assert.equal(outcome.primary, RETRIEVAL_OUTCOME.QUERY_MISS);
});
