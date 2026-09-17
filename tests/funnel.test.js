import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a retrieval went wrong, told apart from the six other places it could
 * have gone wrong in exactly the same way from the outside.
 *
 * A thin answer looks the same whether the query found nothing, the right page
 * ranked below what was tried, a good candidate was passed over, the page would
 * not load, it loaded without the needed passage, the evidence arrived and the
 * answer ignored it, or the answer used it and cited it badly. Seven repairs,
 * one symptom. The point of a funnel is to make the difference visible before
 * anything is changed on the strength of one example.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-funnel-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { createFunnel, classifyRetrieval, RETRIEVAL_OUTCOME } = await import('../src/agent/core/funnel.js');
const { applyReview, summarise, fingerprint: fp } = await import('../tools/apply-review.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');
const { gatherFromWeb } = await import('../src/agent/core/retrieve.js');

const QUERY = 'what does a write ahead log record before a change is applied for recovery replay';

const budget = (over = {}) =>
  new Budget({ maxIterations: 4, maxToolCalls: 10, maxFetches: 7, maxSearches: 3, wallClockMs: 60_000, ...over });

const page = (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `T ${url}`,
  text: 'Write ahead logging records every change before it is applied so recovery can replay the log. '.repeat(24),
  published_at: null,
  fetched_at: new Date().toISOString(),
  duration_ms: 10,
  timings: {},
});

const dead = (url, error = 'HTTP 500') => ({ ok: false, url, status: 500, error, duration_ms: 5 });
const leads = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://site${i + 1}.example/p`, title: `R${i + 1}`, snippet: 'lead' }));
const searchReturning = (results, extra = {}) => async () => ({ results, cached: false, provider: 'tavily', ...extra });

/** A funnel with results and fetch outcomes already recorded. */
function funnelWith(results, shape = () => ({})) {
  const f = createFunnel({ question: QUERY, enabled: true });
  const recorded = f.search({ query: QUERY, provider: 'tavily', cached: false, durationMs: 100, results });
  // Driven through the funnel's own occurrences, exactly as retrieval does, so
  // each attempt carries the search and rank that supplied it.
  for (const candidate of recorded.results) {
    const spec = shape(candidate);
    if (!spec || !Object.keys(spec).length) continue;
    const event = f.attempted({ candidateId: candidate.candidate_id, url: candidate.url });
    if (spec.status) {
      f.fetched(
        { eventId: event.event_id },
        {
          status: spec.status,
          httpStatus: spec.httpStatus ?? 200,
          durationMs: 10,
          chars: spec.chars ?? 0,
          admitted: spec.status === 'usable',
          reason: spec.status,
          passages: spec.status === 'usable' ? ['extracted text about the topic'] : undefined,
        },
      );
    }
  }
  return f;
}

const reviewed = (over = {}) => ({ relevant_urls: ['https://site1.example/p'], ...over });

/* ------------------------------------- nothing is classified without a review */

test('without a relevance review the outcome is pending, not a guess', () => {
  // The guesses available here are wrong in an expensive direction. A search
  // returning pages about something else, followed by an answer that honestly
  // declines to use them, records identically to an answer ignoring good
  // evidence — and acting on the wrong one means rewriting the part that
  // behaved correctly.
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 3000 } : {}));
  const c = classifyRetrieval(f, { citedSentences: 0, supportedSentences: 0 });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.PENDING_REVIEW);
  assert.equal(c.reviewed, false);
});

test('an honest refusal to use irrelevant pages is a query miss, not a synthesis failure', () => {
  // The bloom filter case: the search returned pages about something else, the
  // pages read fine, and the answer said the evidence did not cover the
  // question. Synthesis did exactly the right thing.
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 0,
    supportedSentences: 0,
    review: { relevant_urls: [] },
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.QUERY_MISS, 'the query is at fault, not the answer');
});

/* ------------------------------------------------- the eight primary outcomes */

test('no relevant url among the results is a query miss', () => {
  const f = funnelWith(leads(6));
  const c = classifyRetrieval(f, { review: { relevant_urls: [] } });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.QUERY_MISS);
});

test('a relevant result below everything tried is a ranking miss', () => {
  const f = funnelWith(leads(6), (r) => (/site[12]\./.test(r.url) ? { status: 'usable', chars: 2000 } : {}));
  const c = classifyRetrieval(f, { review: { relevant_urls: ['https://site5.example/p'] } });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.RANKING_MISS);
  assert.match(c.flags.join(' '), /rank 5.*rank 2/);
});

test('a relevant result inside the tried range and passed over is a selection miss', () => {
  const f = funnelWith(leads(6), (r) => (/site[13]\./.test(r.url) ? { status: 'usable', chars: 2000 } : {}));
  const c = classifyRetrieval(f, { review: { relevant_urls: ['https://site2.example/p'] } });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SELECTION_MISS);
});

test('a relevant page that would not load is a fetch failure', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'failed', httpStatus: 503 } : {}));
  assert.equal(classifyRetrieval(f, { review: reviewed() }).primary, RETRIEVAL_OUTCOME.FETCH_FAILURE);
});

test('a relevant page extracting too little text is a fetch failure', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'too_thin', chars: 90 } : {}));
  assert.equal(classifyRetrieval(f, { review: reviewed() }).primary, RETRIEVAL_OUTCOME.FETCH_FAILURE);
});

test('a cancelled loser is not a fetch failure when another relevant page supplied evidence', () => {
  // The pool cancels its losers on every successful run.
  const f = funnelWith(leads(4), (r) =>
    r.url.includes('site1.') ? { status: 'usable', chars: 4000 } : r.url.includes('site2.') ? { status: 'cancelled' } : {},
  );
  const c = classifyRetrieval(f, {
    citedSentences: 3,
    supportedSentences: 3,
    review: {
      relevant_urls: ['https://site1.example/p', 'https://site2.example/p'],
      extracted_passages_contain_answer: true,
      answer_addressed_question: true,
      answer_complete: true,
    },
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
});

test('a relevant page read in full whose passages lacked the answer is a passage miss', () => {
  // Recorded as the real instrumentation records it — usable and admitted —
  // and separated from an irrelevant page only by the reviewer, who read the
  // passages the record kept.
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 9000 } : {}));
  const c = classifyRetrieval(f, {
    review: reviewed({ extracted_passages_contain_answer: false }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS);
});

test('evidence that reached the ledger and went unused is a synthesis omission', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 0,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: true }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION);
});

test('an answer that cites perfectly but addresses a different question is not a success', () => {
  // Supported citations to an off-topic answer. Grounding cannot see this; only
  // a reader can.
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: false, answer_complete: false }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION);
  assert.notEqual(c.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
});

test('an answer that addresses the question with unsupported citations is a citation failure', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 5,
    supportedSentences: 3,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: true }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.CITATION_FAILURE);
});

test('the whole path working is a successful retrieval', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: true }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
});

/* --------------------------------------------- attribution across searches */

test('search results are never modified by what happens to them afterwards', () => {
  const f = funnelWith(leads(3), () => ({ status: 'usable', chars: 2000 }));
  for (const s of f.searches) {
    for (const r of s.results) {
      assert.deepEqual(
        Object.keys(r).sort(),
        ['candidate_id', 'rank', 'search_attempt', 'snippet', 'title', 'url'],
        'a result carries its identity and nothing about what later happened to it',
      );
    }
  }
  assert.equal(f.fetch_events.length, 3, 'outcomes live in their own events');
});

/* ------------------------------------------ deduplication, where it happens */

test('a candidate skipped for sharing a publisher is recorded as such', async () => {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning([
      { url: 'https://example.com/one', title: 'A', snippet: '' },
      { url: 'https://docs.example.com/two', title: 'B', snippet: '' },
      { url: 'https://other.example/three', title: 'C', snippet: '' },
    ]),
    fetchPage: async (url) => page(url),
    funnel,
  });

  const dupe = funnel.deduplications.find((d) => d.url === 'https://docs.example.com/two');
  assert.ok(dupe, 'the skipped candidate is recorded rather than silently absent');
  assert.match(dupe.reason, /publisher/);
  assert.equal(dupe.kept_url, 'https://example.com/one', 'naming the one that was kept instead');
  assert.equal(dupe.rank, 2, 'and where it came from');
});

/* ----------------------------------- passages kept for every page that read */

test('a usable page keeps its extracted passages even when nothing cites it', async () => {
  // The set a reviewer needs to tell an irrelevant page from a relevant page
  // whose extraction missed the answer. It cannot be recovered after the run.
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(4)),
    fetchPage: async (url) => page(url),
    funnel,
  });

  const usable = funnel.fetch_events.filter((e) => e.status === 'usable');
  assert.ok(usable.length >= 1);
  for (const e of usable) {
    assert.ok(Array.isArray(e.extracted_passages) && e.extracted_passages.length > 0, 'the extracted text is kept');
    assert.ok(e.extracted_passages.join(' ').length > 100, 'and it is the text, not a character count');
  }
});

/* --------------------------------------------- applying a review is offline */

test('applying a review makes no network or model call', async () => {
  // It reads two files and writes two. That is what makes "one clean run" mean
  // one run, and what makes the classification reproducible from what is saved.
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    throw new Error('the review step must not reach the network');
  };
  try {
    const run = {
      commit: 'abc',
      runs: [
        {
          query: QUERY,
          cited_sentences: 3,
          supported_sentences: 3,
          factual_sentences: 4,
          factual_sentences_cited: 3,
          groundedness: 1,
          funnel: {
            searches: [{ attempt: 1, query: QUERY, results: [{ rank: 1, url: 'https://site1.example/p', title: 'A', snippet: '' }] }],
            fetch_events: [{ search_attempt: 1, rank: 1, url: 'https://site1.example/p', status: 'usable', admitted_as_evidence: true }],
          },
        },
      ],
    };
    const { fingerprint } = await import('../tools/apply-review.js');
    const review = {
      run_fingerprint: fingerprint(run),
      questions: [
        {
          question: QUERY,
          relevant_urls: ['https://site1.example/p'],
          extracted_passages_contain_answer: true,
          answer_addressed_question: true,
          answer_complete: true,
        },
      ],
    };

    const out = applyReview(run, review);
    assert.equal(called, 0, 'nothing was fetched');
    assert.equal(out.runs[0].retrieval_outcome.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
    assert.equal(out.runs[0].retrieval_outcome.reviewed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every reviewed run gets exactly one outcome, and the totals add up', () => {
  const mk = (query, cited, supported) => ({
    query,
    cited_sentences: cited,
    supported_sentences: supported,
    factual_sentences: 4,
    factual_sentences_cited: cited,
    groundedness: cited ? supported / cited : null,
    funnel: {
      searches: [{ attempt: 1, query, results: [{ rank: 1, url: 'https://site1.example/p', title: 'A', snippet: '' }] }],
      fetch_events: [{ search_attempt: 1, rank: 1, url: 'https://site1.example/p', status: 'usable', admitted_as_evidence: true }],
    },
  });
  const run = { commit: 'abc', ran_at: 'now', runs: [mk('q1', 3, 3), mk('q2', 4, 2), mk('q3', 0, 0)] };
  const decided = { extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: true };
  const review = {
    run_fingerprint: fp(run),
    questions: [
      { question: 'q1', relevant_urls: ['https://site1.example/p'], ...decided },
      { question: 'q2', relevant_urls: ['https://site1.example/p'], ...decided },
      { question: 'q3', relevant_urls: [] },
    ],
  };

  const s = summarise(applyReview(run, review));
  assert.equal(s.runs, 3);
  assert.equal(Object.values(s.outcomes).reduce((a, b) => a + b, 0), 3, 'the outcomes sum to the runs');
  assert.equal(s.outcomes[RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL], 1);
  assert.equal(s.outcomes[RETRIEVAL_OUTCOME.CITATION_FAILURE], 1);
  assert.equal(s.outcomes[RETRIEVAL_OUTCOME.QUERY_MISS], 1);
});

test('an unreviewed question stays pending rather than joining a failure category', () => {
  const run = {
    commit: 'abc',
    ran_at: 'now',
    runs: [{ query: 'q1', cited_sentences: 2, supported_sentences: 2, funnel: { searches: [], fetch_events: [] } }],
  };
  const s = summarise(applyReview(run, { run_fingerprint: fp(run), questions: [] }));
  assert.equal(s.outcomes[RETRIEVAL_OUTCOME.PENDING_REVIEW], 1, 'unreviewed is not a kind of failure');
});

/* ------------------------------------------- tracing observes, never changes */

test('tracing off produces no funnel at all', () => {
  assert.equal(createFunnel({ question: QUERY, enabled: false }), null);
});

test('retrieval behaves identically with tracing on and off', async () => {
  const run = async (funnel) => {
    const fetched = [];
    const ledger = new EvidenceLedger();
    const out = await gatherFromWeb({
      query: QUERY,
      ledger,
      budget: budget(),
      emit: () => {},
      pages: 2,
      webSearch: searchReturning(leads(6)),
      fetchPage: async (url) => {
        fetched.push(url);
        return /site[12]\./.test(url) ? dead(url) : page(url);
      },
      funnel,
    });
    return { fetched, sources: ledger.citable.map((s) => s.url), ok: out.coverage.ok };
  };

  const off = await run(null);
  const on = await run(createFunnel({ question: QUERY, enabled: true }));
  assert.deepEqual(on.fetched, off.fetched, 'the same pages, in the same order');
  assert.deepEqual(on.sources, off.sources, 'the same evidence');
  assert.equal(on.ok, off.ok, 'and the same coverage decision');
});

test('tracing adds no searches and no fetches', async () => {
  let searches = 0;
  let fetches = 0;
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: async () => {
      searches += 1;
      return { results: leads(6), cached: false, provider: 'tavily' };
    },
    fetchPage: async (url) => {
      fetches += 1;
      return page(url);
    },
    funnel: createFunnel({ question: QUERY, enabled: true }),
  });
  assert.equal(searches, 1);
  assert.ok(fetches <= 3, `no extra fetches (${fetches})`);
});

test('a cached search is recorded as cached', async () => {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(4), { cached: true }),
    fetchPage: async (url) => page(url),
    funnel,
  });
  assert.equal(funnel.searches[0].cached, true);
  assert.equal(funnel.searches[0].provider, 'tavily');
});

test('a cancelled fetch is recorded as a cancellation', async () => {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url, { signal } = {}) => {
      if (/site[12]\./.test(url)) return page(url);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(page(url)), 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve({ ok: false, url, error: 'aborted', aborted: true, duration_ms: 1 });
        }, { once: true });
      });
    },
    funnel,
  });
  const statuses = funnel.fetch_events.map((e) => e.status);
  assert.ok(statuses.includes('usable'));
  assert.ok(!statuses.includes('failed'), `no cancellation filed as a failure: ${statuses.join(', ')}`);
});

test('a candidate never tried has no fetch event at all', async () => {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => (url.includes('site1.') ? dead(url) : page(url)),
    funnel,
  });
  const tried = new Set(funnel.fetch_events.map((e) => e.url));
  const untried = funnel.candidates.filter((c) => !tried.has(c.url));
  assert.ok(untried.length > 0, 'some leads were never reached');
  assert.ok(funnel.fetch_events.some((e) => e.status === 'failed'), 'and one was reached and failed');
});

test('the funnel records why it stopped', async () => {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => page(url),
    funnel,
  });
  assert.equal(funnel.stop_reason, 'coverage_sufficient');
  assert.ok(funnel.coverage_events.length >= 1);
});

test('a rewrite is recorded only when it changed the question', () => {
  const f = createFunnel({ question: QUERY, enabled: true });
  f.rewrote(QUERY);
  assert.equal(f.toJSON().effective_question, undefined);
  f.rewrote('postgresql vacuum throughput');
  assert.equal(f.toJSON().effective_question, 'postgresql vacuum throughput');
});

/* --------------------------------- an unfinished review stays unfinished */

test('a review that names relevant urls and nothing else stays pending', () => {
  // "I have not decided" and "no" are different. Letting the missing one fall
  // through manufactures a confident label out of a reviewer's silence — and
  // this exact shape used to reach successful_retrieval.
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: { relevant_urls: ['https://site1.example/p'] },
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.PENDING_REVIEW);
  assert.match(c.flags.join(' '), /extracted passages/);
});

test('a review missing only the answer judgements stays pending', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: reviewed({ extracted_passages_contain_answer: true }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.PENDING_REVIEW);
  assert.match(c.flags.join(' '), /addressed the question/);
});

test('a judgement is only asked for once the run reached the stage that needs it', () => {
  // A question whose search returned nothing relevant needs no opinion about
  // its answer; demanding one would leave every such row unreviewable.
  const f = funnelWith(leads(4));
  const c = classifyRetrieval(f, { review: { relevant_urls: [] } });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.QUERY_MISS);
  assert.equal(c.reviewed, true, 'and it is decided, not pending');
});

/* ------------------------------------------------ a partial answer is not a success */

test('an answer that addressed the question but left part out is not a success', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: false }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION);
  assert.match(c.flags.join(' '), /omitted a required part/);
});

test('a complete answer with supported citations is a success', () => {
  const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { status: 'usable', chars: 5000 } : {}));
  const c = classifyRetrieval(f, {
    citedSentences: 4,
    supportedSentences: 4,
    review: reviewed({ extracted_passages_contain_answer: true, answer_addressed_question: true, answer_complete: true }),
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
});

/* ------------------------------- a fetch names the occurrence that supplied it */

test('a fetch from the second search is attributed to the second search', () => {
  // The previous version of this test asserted the opposite and I offered it as
  // proof: locate(url) always returned the first occurrence, so a rescue fetch
  // was permanently filed under the original search and any claim about ranking
  // was fiction.
  const f = createFunnel({ question: QUERY, enabled: true });
  f.search({ query: 'first', provider: 'tavily', durationMs: 10, results: leads(5) });
  f.search({ query: 'second', provider: 'tavily', durationMs: 10, results: [{ url: 'https://site4.example/p', title: 'again', snippet: '' }] });

  // The occurrence actually queued is the one from the second search.
  const fromSecond = f.searches[1].results[0];
  assert.equal(fromSecond.candidate_id, 'search_2_rank_1');

  const event = f.attempted({ candidateId: fromSecond.candidate_id, url: fromSecond.url });
  f.fetched({ eventId: event.event_id }, { status: 'usable', chars: 3000, admitted: true, durationMs: 20, passages: ['text'] });

  const [recorded] = f.fetch_events;
  assert.equal(recorded.search_attempt, 2, 'the search that supplied it');
  assert.equal(recorded.rank, 1, 'at the rank it held there');
  assert.equal(recorded.candidate_id, 'search_2_rank_1');
  assert.equal(recorded.status, 'usable');

  // Both search rows are untouched.
  assert.equal(f.searches[0].results.length, 5);
  assert.equal(f.searches[0].results[3].rank, 4, 'the first occurrence keeps its own rank');
  assert.equal(f.searches[1].results.length, 1);
});

test('a fetch from the first search is still attributed to the first', () => {
  const f = createFunnel({ question: QUERY, enabled: true });
  f.search({ query: 'first', provider: 'tavily', durationMs: 10, results: leads(5) });
  f.search({ query: 'second', provider: 'tavily', durationMs: 10, results: [{ url: 'https://site4.example/p', title: 'again', snippet: '' }] });

  const fromFirst = f.searches[0].results[3];
  const event = f.attempted({ candidateId: fromFirst.candidate_id, url: fromFirst.url });
  f.fetched({ eventId: event.event_id }, { status: 'usable', chars: 3000, admitted: true, passages: ['text'] });

  assert.equal(f.fetch_events[0].search_attempt, 1, 'identity is carried, not guessed from the url');
  assert.equal(f.fetch_events[0].rank, 4);
});

/* ------------------------------------------- a review belongs to one run */

test('a review from a different run is refused', async () => {
  const { applyReview: apply, fingerprint } = await import('../tools/apply-review.js');
  const mkRun = (ranAt) => ({
    commit: 'abc',
    ran_at: ranAt,
    runs: [{ query: 'q1', cited_sentences: 1, supported_sentences: 1, funnel: { searches: [], fetch_events: [] } }],
  });

  const first = mkRun('2026-01-01T00:00:00.000Z');
  const second = mkRun('2026-01-02T00:00:00.000Z');
  const reviewOfFirst = { run_fingerprint: fingerprint(first), questions: [{ question: 'q1', relevant_urls: [] }] };

  // Same commit, same questions, different run. The web moved between them.
  assert.throws(() => apply(second, reviewOfFirst), /different run/);
  assert.doesNotThrow(() => apply(first, reviewOfFirst), 'and the run it was written for is fine');
});

test('a review with no fingerprint at all is refused', async () => {
  const { applyReview: apply } = await import('../tools/apply-review.js');
  const run = { commit: 'abc', ran_at: 'now', runs: [{ query: 'q1', funnel: { searches: [], fetch_events: [] } }] };
  assert.throws(() => apply(run, { questions: [] }), /no run_fingerprint/);
});

test('a generated template carries the fingerprint of the run it came from', async () => {
  const { reviewTemplate, applyReview: apply, fingerprint } = await import('../tools/apply-review.js');
  const run = {
    commit: 'abc',
    ran_at: 'now',
    runs: [{ query: 'q1', cited_sentences: 0, funnel: { searches: [], fetch_events: [] } }],
  };
  const template = reviewTemplate(run);
  assert.equal(template.run_fingerprint, fingerprint(run));
  assert.doesNotThrow(() => apply(run, template), 'a freshly generated review applies to its own run');
});

/* ------------------------------------ text from a page that read too thin */

test('a page that read but gave too little keeps its text', async () => {
  // Ninety characters of navigation, a paywall notice and a partly useful
  // extraction are identical as a number and want different answers.
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages: 2,
    webSearch: searchReturning(leads(4)),
    fetchPage: async (url) =>
      url.includes('site1.') ? { ...page(url), text: 'Accept cookies. Sign in to continue reading this article.' } : page(url),
    funnel,
  });

  const thin = funnel.fetch_events.find((e) => e.status === 'too_thin');
  assert.ok(thin, 'the thin page has an event');
  assert.ok(thin.extracted_excerpt, 'and the text it did return');
  assert.match(thin.extracted_excerpt, /Sign in to continue/, 'so a reviewer can see it was a paywall');
  assert.equal(thin.admitted_as_evidence, false, 'while still not being evidence');
});
