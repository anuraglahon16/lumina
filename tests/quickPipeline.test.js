import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Quick retrieval phase end to end, with the network faked.
 *
 * The unit tests cover classification and coverage as functions. What they
 * cannot see is the orchestration: whether the pool really stops when the
 * evidence is enough, whether a failed page brings in the next lead, whether a
 * URL is ever tried twice, and — the one that was wrong while being claimed as
 * right — whether the fetches still running when the phase ends are actually
 * cancelled or merely ignored.
 *
 * "Ignored" and "cancelled" look identical from outside unless something
 * asserts on the difference, which is why this file exists.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-quickpipe-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');
const { gatherFromWeb, rescueRetrieval } = await import('../src/agent/core/retrieve.js');

const QUERY = 'what does a write ahead log record before a change is applied for recovery replay';

const budget = (over = {}) =>
  new Budget({ maxIterations: 4, maxToolCalls: 10, maxFetches: 7, maxSearches: 3, wallClockMs: 60_000, ...over });

const page = (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `Title for ${url}`,
  text: 'Write ahead logging records every change before it is applied so recovery can replay the log. '.repeat(24),
  paragraphs: [],
  published_at: null,
  fetched_at: new Date().toISOString(),
  duration_ms: 10,
  timings: {},
});

const dead = (url, error = 'HTTP 500') => ({ ok: false, url, error, duration_ms: 5 });

const leads = (n) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://site${i + 1}.example/page`, title: `R${i + 1}`, snippet: 'lead' }));

const searchReturning = (results, cached = false) => async () => ({ results, cached });

const collect = () => {
  const events = [];
  const recorded = [];
  return {
    events,
    recorded,
    emit: (event, data) => events.push({ event, data }),
    recorder: { recordToolCall: (c) => recorded.push(c) },
  };
};

/** A fetch that never settles on its own, and reports whether it was aborted. */
const hangingFetch = (aborts, fast = /site[12]\./) =>
  async (url, { signal } = {}) => {
    if (fast.test(url)) return page(url);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(page(url)), 5000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          aborts.push(url);
          resolve({ ok: false, url, error: 'aborted', aborted: true, duration_ms: 1 });
        },
        { once: true },
      );
    });
  };

function harness(over) {
  const ledger = new EvidenceLedger();
  const io = collect();
  const call = (opts = {}) =>
    gatherFromWeb({
      query: QUERY,
      ledger,
      budget: budget(),
      emit: io.emit,
      recorder: io.recorder,
      pages: 2,
      ...over,
      ...opts,
    });
  return { ledger, io, call };
}

/* ------------------------------------------------- the pool's stopping rule */

test('the pool stops once the evidence covers the question', async () => {
  const fetched = [];
  const { ledger, call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => {
      fetched.push(url);
      return page(url);
    },
  });
  const out = await call();
  assert.equal(out.coverage.ok, true, out.coverage.reasons.join('; '));
  assert.ok(ledger.citable.length >= 1, 'it read something');
  // Six leads were available. Stopping well short of them is the point: a page
  // that already covers the question makes the next one latency for nothing.
  assert.ok(fetched.length < 6, `it stopped rather than reading everything (read ${fetched.length} of 6)`);
});

test('a page too thin to be evidence is rejected', async () => {
  // A fetch can succeed and return navigation furniture. Accepting that is how
  // a run ends up holding a source it cannot cite.
  const { ledger, io, call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => (url.includes('site1.') ? { ...page(url), text: 'Cookies. Menu. Home.' } : page(url)),
  });
  await call();
  assert.ok(!ledger.citable.some((s) => s.url.includes('site1.')), 'the thin page never became a source');
  assert.ok(
    io.events.some((e) => e.event === 'tool_result' && !e.data.ok && /characters extracted/.test(e.data.detail || '')),
    'and it is reported as a failure rather than dropped in silence',
  );
});

test('a failed page brings in the next unused candidate', async () => {
  const tried = [];
  const { call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => {
      tried.push(url);
      return /site[123]\./.test(url) ? dead(url, 'HTTP 503') : page(url);
    },
  });
  const out = await call();
  assert.ok(tried.length > 3, 'it kept going past the failures');
  assert.equal(out.coverage.ok, true, 'and reached coverage on later leads');
});

test('no url is ever attempted twice', async () => {
  const tried = [];
  const { call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => {
      tried.push(url);
      return dead(url);
    },
  });
  await call();
  assert.equal(new Set(tried).size, tried.length, `each attempt was a distinct url: ${tried.join(', ')}`);
});

test('the fetch budget bounds the pool', async () => {
  const tried = [];
  const { call } = harness({
    webSearch: searchReturning(leads(8)),
    fetchPage: async (url) => {
      tried.push(url);
      return dead(url);
    },
  });
  await call({ budget: budget({ maxFetches: 3, maxRefunds: 0 }) });
  assert.ok(tried.length <= 3, `the budget bounded it (${tried.length} attempts)`);
});

test('a search that finds nothing leaves the run without evidence', async () => {
  const { ledger, call } = harness({ webSearch: searchReturning([]), fetchPage: async (url) => page(url) });
  const out = await call();
  assert.equal(ledger.citable.length, 0);
  assert.equal(out.coverage.ok, false);
});

/* ------------------------------------------------------------ cancellation */

test('sufficient evidence aborts the fetches still running', async () => {
  // The assertion that failed against the previous implementation, which
  // cleared its timer on the way out and left the losers running to completion,
  // unobserved. A signal nobody aborts is not a cancellation.
  const aborts = [];
  const { call } = harness({ webSearch: searchReturning(leads(6)), fetchPage: hangingFetch(aborts) });

  const started = Date.now();
  const out = await call();
  const elapsed = Date.now() - started;

  assert.equal(out.coverage.ok, true);
  assert.ok(elapsed < 3000, `it did not wait out the losers (${elapsed}ms)`);
  assert.ok(aborts.length > 0, 'the outstanding fetch was aborted, not merely ignored');
});

test('nothing lands in the ledger after the phase returns', async () => {
  // The race this closes: a fetch resolving in the gap between the phase
  // deciding it is finished and the phase returning, adding a source to
  // evidence the answer was already written from.
  const { ledger, call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url, { signal } = {}) => {
      if (/site[12]\./.test(url)) return page(url);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(page(url)), 40);
        // Resolves as a success even on abort: were the pool still listening,
        // this would slip into the ledger behind the answer's back.
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(page(url));
          },
          { once: true },
        );
      });
    },
  });

  await call();
  const settled = ledger.citable.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ledger.citable.length, settled, 'the ledger is closed once the phase is over');
});

test('a client disconnect ends the phase', async () => {
  const aborts = [];
  const controller = new AbortController();
  const { call } = harness({ webSearch: searchReturning(leads(6)), fetchPage: hangingFetch(aborts, /never/) });
  setTimeout(() => controller.abort(), 40);
  const started = Date.now();
  await call({ signal: controller.signal });
  assert.ok(Date.now() - started < 3000, 'the phase ended with the client rather than outliving it');
  assert.ok(aborts.length > 0, 'and the work in flight was actually cancelled');
});

test('the retrieval deadline ends the phase', async () => {
  const aborts = [];
  const { call } = harness({ webSearch: searchReturning(leads(6)), fetchPage: hangingFetch(aborts, /never/) });
  const started = Date.now();
  await call({ deadlineMs: 200 });
  assert.ok(Date.now() - started < 2500, 'the deadline bounded it');
  assert.ok(aborts.length > 0, 'outstanding requests were cancelled at the deadline');
});

/* --------------------------------------------------------- the rescue rule */

test('a rescue reuses untried leads instead of searching again', async () => {
  let searches = 0;
  const webSearch = async () => {
    searches += 1;
    return { results: leads(6), cached: false };
  };
  const fetchPage = async (url) => (/site[12]\./.test(url) ? dead(url) : page(url));

  const ledger = new EvidenceLedger();
  const io = collect();
  const first = await gatherFromWeb({
    query: QUERY,
    ledger,
    budget: budget({ maxFetches: 2, maxRefunds: 0 }),
    emit: io.emit,
    pages: 2,
    webSearch,
    fetchPage,
  });
  assert.equal(ledger.citable.length, 0, 'the first pass found nothing citable');

  searches = 0;
  await rescueRetrieval({
    query: QUERY,
    route: 'standalone_web',
    ledger,
    budget: budget(),
    emit: io.emit,
    candidates: first.candidates,
    webSearch,
    fetchPage,
  });
  assert.equal(searches, 0, 'it did not repeat a search whose results it already held');
  assert.ok(ledger.citable.length > 0, 'and found evidence among leads it had not tried');
});

test('a rescue searches again only when nothing untried is left', async () => {
  let searches = 0;
  const webSearch = async () => {
    searches += 1;
    return { results: leads(2), cached: false };
  };
  const fetchPage = async (url) => dead(url);

  const ledger = new EvidenceLedger();
  const io = collect();
  const first = await gatherFromWeb({ query: QUERY, ledger, budget: budget(), emit: io.emit, pages: 2, webSearch, fetchPage });
  searches = 0;
  await rescueRetrieval({
    query: QUERY,
    route: 'standalone_web',
    ledger,
    budget: budget(),
    emit: io.emit,
    candidates: first.candidates,
    webSearch,
    fetchPage,
  });
  assert.equal(searches, 1, 'with every lead exhausted, a fresh search is the only move left');
});

/* ------------------------------------------------- what the caller observes */

test('every step is streamed and recorded, with the real cache flags', async () => {
  const { io, call } = harness({
    webSearch: searchReturning(leads(4), true),
    fetchPage: async (url) => ({ ...page(url), cached: true }),
  });
  await call();

  const streamed = io.events.filter((e) => e.event === 'tool_result');
  assert.ok(streamed.length > 0, 'the reader sees the steps');
  assert.equal(io.recorded.length, streamed.length, 'and the run log holds the same ones');

  assert.equal(io.recorded.find((c) => c.name === 'web_search').cached, true, 'a cached search reports as cached');
  assert.ok(io.recorded.filter((c) => c.name === 'fetch_page').every((c) => c.cached === true));
});

test('a fetch reports its own duration, not the batch it belonged to', async () => {
  // The first lead fails, so at least two fetches happen and their recorded
  // durations can be compared. Copying one batch elapsed time onto every member
  // proved only that the batch waited for its slowest.
  const { io, call } = harness({
    webSearch: searchReturning(leads(4)),
    fetchPage: async (url) =>
      url.includes('site1.') ? { ...dead(url, 'HTTP 503'), duration_ms: 11 } : { ...page(url), duration_ms: 222 },
  });
  await call();
  const fetches = io.recorded.filter((c) => c.name === 'fetch_page');
  assert.ok(fetches.length >= 2, `at least two fetches were recorded (got ${fetches.length})`);
  const durations = fetches.map((f) => f.durationMs);
  assert.ok(durations.includes(11) && durations.includes(222), `each page kept its own duration: ${durations.join(', ')}`);
});

test('a fetch records which lead it was and which attempt', async () => {
  const { io, call } = harness({ webSearch: searchReturning(leads(6)), fetchPage: async (url) => page(url) });
  await call();
  const fetches = io.recorded.filter((c) => c.name === 'fetch_page');
  assert.ok(fetches.every((f) => typeof f.meta?.candidate_rank === 'number'), 'candidate rank is recorded');
  assert.ok(fetches.every((f) => typeof f.meta?.attempt === 'number'), 'attempt number is recorded');
});

test('a source is only ever built from a page that was actually read', async () => {
  // The rule the whole system rests on: a search result is a lead, never
  // evidence. Six leads, one readable page, one citable source.
  const { ledger, call } = harness({
    webSearch: searchReturning(leads(6)),
    fetchPage: async (url) => (url.includes('site3.') ? page(url) : dead(url, 'HTTP 404')),
  });
  await call();
  assert.equal(ledger.citable.length, 1);
  assert.ok(ledger.citable[0].url.includes('site3.'));
  assert.ok(ledger.citable[0].snippet.length > 0, 'and its snippet came from the text that was read');
});
