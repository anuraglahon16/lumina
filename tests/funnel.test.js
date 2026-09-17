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

/** Build a funnel with results already recorded, for classification tests. */
function funnelWith(results, shape = () => ({})) {
  const f = createFunnel({ question: QUERY, enabled: true });
  f.search({ query: QUERY, provider: 'tavily', cached: false, durationMs: 100, results });
  for (const r of results) {
    const s = shape(r);
    if (!s || !Object.keys(s).length) continue;
    if (s.attempted) f.attempted(r.url);
    if (s.status) {
      f.fetched(r.url, {
        status: s.status,
        httpStatus: s.httpStatus ?? 200,
        durationMs: 10,
        chars: s.chars ?? 0,
        selected: s.status === 'usable' && s.selected !== false,
        reason: s.reason ?? s.status,
      });
    }
  }
  return f;
}

/* ------------------------------------------------- the eight primary outcomes */

test('nothing relevant in the results is a query miss', () => {
  const f = funnelWith(leads(6));
  const c = classifyRetrieval(f, { relevantUrls: [] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.QUERY_MISS);
  assert.equal(c.provisional, true, 'relevance is a judgement, so the label says so');
});

test('no results at all is also a query miss', () => {
  const f = funnelWith([]);
  assert.equal(classifyRetrieval(f, {}).primary, RETRIEVAL_OUTCOME.QUERY_MISS);
});

test('a relevant result below everything attempted is a ranking miss', () => {
  // It was there. Nothing looked that far down.
  const results = leads(6);
  const f = funnelWith(results, (r) => (/site[12]\./.test(r.url) ? { attempted: true, status: 'usable', chars: 2000 } : {}));
  const c = classifyRetrieval(f, { relevantUrls: ['https://site5.example/p'] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.RANKING_MISS);
  assert.match(c.flags.join(' '), /rank 5.*rank 2/);
});

test('a relevant result inside the attempted range but never tried is a selection miss', () => {
  // Ranked above pages that were read, and skipped anyway — a different fault
  // from it ranking too low, and a different fix.
  const results = leads(6);
  const f = funnelWith(results, (r) => (/site[13]\./.test(r.url) ? { attempted: true, status: 'usable', chars: 2000 } : {}));
  const c = classifyRetrieval(f, { relevantUrls: ['https://site2.example/p'] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SELECTION_MISS);
});

test('a relevant page that would not load is a fetch failure', () => {
  const results = leads(4);
  const f = funnelWith(results, (r) => (r.url.includes('site1.') ? { attempted: true, status: 'failed', httpStatus: 503 } : {}));
  const c = classifyRetrieval(f, { relevantUrls: ['https://site1.example/p'] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.FETCH_FAILURE);
});

test('a relevant page that extracted too little text is a fetch failure', () => {
  // A page that returns a hundred characters of navigation has not given up its
  // evidence, and the fix is in fetching and extraction rather than in how
  // passages are chosen from good text.
  const results = leads(4);
  const f = funnelWith(results, (r) =>
    r.url.includes('site1.') ? { attempted: true, status: 'too_thin', chars: 90, selected: false } : {},
  );
  const c = classifyRetrieval(f, { relevantUrls: ['https://site1.example/p'] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.FETCH_FAILURE);
});

test('a relevant page read in full but yielding no evidence is a passage miss', () => {
  // The page loaded, the text is there, and what was extracted from it does not
  // carry the answer. That is a question about passage selection, and it is the
  // one case where selecting passages differently would help.
  const results = leads(4);
  const f = funnelWith(results, (r) =>
    r.url.includes('site1.') ? { attempted: true, status: 'usable', chars: 8000, selected: false } : {},
  );
  const c = classifyRetrieval(f, { relevantUrls: ['https://site1.example/p'] });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.PASSAGE_MISS);
});

test('evidence gathered and nothing cited is a synthesis omission', () => {
  const results = leads(4);
  const f = funnelWith(results, (r) => (r.url.includes('site1.') ? { attempted: true, status: 'usable', chars: 3000 } : {}));
  const c = classifyRetrieval(f, { relevantUrls: ['https://site1.example/p'], evidenceCount: 2, citedSentences: 0 });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION);
  assert.equal(c.provisional, false, 'this one is observed, not judged');
});

test('evidence cited but unsupported is a citation failure', () => {
  const results = leads(4);
  const f = funnelWith(results, (r) => (r.url.includes('site1.') ? { attempted: true, status: 'usable', chars: 3000 } : {}));
  const c = classifyRetrieval(f, {
    relevantUrls: ['https://site1.example/p'],
    evidenceCount: 2,
    citedSentences: 5,
    supportedSentences: 3,
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.CITATION_FAILURE);
  assert.match(c.flags.join(' '), /2 of 5/);
});

test('the whole path working is a successful retrieval', () => {
  const results = leads(4);
  const f = funnelWith(results, (r) => (r.url.includes('site1.') ? { attempted: true, status: 'usable', chars: 3000 } : {}));
  const c = classifyRetrieval(f, {
    relevantUrls: ['https://site1.example/p'],
    evidenceCount: 2,
    citedSentences: 4,
    supportedSentences: 4,
  });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL);
});

/* --------------------------------------------- one outcome, never several */

test('an earlier failure wins over a later one', () => {
  // A run whose query found nothing also cites nothing. Counting it in both
  // places makes twenty runs produce forty outcomes and no way to read them.
  const f = funnelWith(leads(4));
  const c = classifyRetrieval(f, { relevantUrls: [], evidenceCount: 0, citedSentences: 0 });
  assert.equal(c.primary, RETRIEVAL_OUTCOME.QUERY_MISS, 'not synthesis_omission as well');
});

test('every run gets exactly one primary outcome, so the totals add up', () => {
  const shapes = [
    { relevantUrls: [] },
    { relevantUrls: ['https://site1.example/p'] },
    { relevantUrls: ['https://site1.example/p'], evidenceCount: 1, citedSentences: 0 },
    { relevantUrls: ['https://site1.example/p'], evidenceCount: 1, citedSentences: 3, supportedSentences: 3 },
  ];
  const outcomes = shapes.map((s) => {
    const f = funnelWith(leads(4), (r) => (r.url.includes('site1.') ? { attempted: true, status: 'usable', chars: 3000 } : {}));
    return classifyRetrieval(f, s).primary;
  });
  assert.equal(outcomes.length, shapes.length, 'one per run');
  assert.ok(outcomes.every((o) => Object.values(RETRIEVAL_OUTCOME).includes(o)), 'and each is one of the eight');
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
  const ledger = new EvidenceLedger();
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger,
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
    funnel,
  });
  assert.equal(searches, 1, 'one search, as without tracing');
  assert.ok(fetches <= 3, `and no extra fetches (${fetches})`);
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
  assert.equal(funnel.searches[0].cached, true, 'a cached search does not masquerade as a live one');
  assert.equal(funnel.searches[0].provider, 'tavily');
});

test('a cancelled fetch is a cancellation, not a failure', async () => {
  // The pool aborts its losers on every successful run. Filing those as
  // failures would make a healthy system look like one whose fetches mostly
  // fail, and would send work at the fetcher.
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

  const statuses = funnel.candidates.filter((c) => c.fetch_attempted).map((c) => c.fetch_status);
  assert.ok(statuses.includes('usable'), 'the winners are usable');
  assert.ok(!statuses.includes('failed'), `no cancellation was filed as a failure: ${statuses.join(', ')}`);
});

test('a candidate never tried is distinguishable from one that failed', async () => {
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

  const untried = funnel.candidates.filter((c) => !c.fetch_attempted);
  const failed = funnel.candidates.filter((c) => c.fetch_status === 'failed');
  assert.ok(untried.length > 0, 'some leads were never reached');
  assert.ok(failed.length > 0, 'and one was reached and failed');
  assert.ok(untried.every((c) => c.fetch_status === null), 'an untried candidate has no fetch status at all');
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
  assert.ok(funnel.coverage_events.length >= 1, 'with the coverage decision behind it');
  assert.ok('sufficient' in funnel.coverage_events[0]);
});

test('a rewrite is recorded only when it changed the question', () => {
  const f = createFunnel({ question: QUERY, enabled: true });
  f.rewrote(QUERY);
  assert.equal(f.toJSON().effective_question, undefined, 'an unchanged question is not a rewrite');
  f.rewrote('postgresql vacuum throughput');
  assert.equal(f.toJSON().effective_question, 'postgresql vacuum throughput');
});
