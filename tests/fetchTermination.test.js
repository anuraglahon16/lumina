import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every fetch that starts must end somewhere the trace can see.
 *
 * The outcome used to be written by the loop that consumes results, which sees
 * only the fetches it gets to. Once coverage was met the loop broke, the pool
 * aborted its losers, and nothing recorded what became of them: a twenty
 * question run left thirty of sixty-eight events frozen at `attempted`.
 *
 * Three things went wrong at once, and none of them was visible in the file.
 * "Never recorded" and "still running" look identical afterwards. The
 * fetch-success denominator became a guess, because a third of the attempts had
 * no outcome. And `classifyRetrieval`'s cancelled branch — the one that decides
 * whether a relevant page was aborted before another supplied evidence — was
 * unreachable in practice, because nothing was ever written as cancelled.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-fetchterm-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';

const { createFunnel } = await import('../src/agent/core/funnel.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');
const { gatherFromWeb } = await import('../src/agent/core/retrieve.js');

const QUERY = 'what does a write ahead log record before a change is applied for recovery replay';
const TERMINAL = new Set(['usable', 'too_thin', 'failed', 'cancelled']);

const budget = (over = {}) =>
  new Budget({ maxIterations: 4, maxToolCalls: 20, maxFetches: 12, maxSearches: 3, wallClockMs: 60_000, ...over });

const body = 'Write ahead logging records every change before it is applied so recovery can replay the log. '.repeat(24);
const page = (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `T ${url}`,
  text: body,
  published_at: null,
  fetched_at: new Date().toISOString(),
  duration_ms: 10,
  timings: {},
});

const leads = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://site${i + 1}.example/p`, title: `R${i + 1}`, snippet: 'lead' }));
const searchReturning = (results) => async () => ({ results, cached: false, provider: 'tavily' });

/**
 * One page answers at once; the rest hang until their signal aborts.
 *
 * This is the shape that produced the thirty frozen events: coverage is reached
 * from the first page to land while several others are still in flight.
 */
function oneFastManySlow(fastUrl) {
  return (url, { signal } = {}) => {
    if (url === fastUrl) return Promise.resolve(page(url));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
}

async function run({ fetchPage, results = leads(6), pages = 1 }) {
  const funnel = createFunnel({ question: QUERY, enabled: true });
  await gatherFromWeb({
    query: QUERY,
    ledger: new EvidenceLedger(),
    budget: budget(),
    emit: () => {},
    pages,
    webSearch: searchReturning(results),
    fetchPage,
    funnel,
  });
  return funnel;
}

test('a loser still in flight when coverage is reached is recorded as cancelled', async () => {
  const funnel = await run({ fetchPage: oneFastManySlow('https://site1.example/p') });

  const cancelled = funnel.fetch_events.filter((e) => e.status === 'cancelled');
  assert.ok(cancelled.length > 0, 'the aborted losers are recorded, not left blank');
  assert.ok(
    funnel.fetch_events.some((e) => e.status === 'usable'),
    'and the page that supplied the evidence is still usable',
  );
  for (const event of cancelled) {
    assert.equal(event.admitted_as_evidence, false);
    assert.equal(event.reason, 'cancelled', 'named as a cancellation rather than an error');
    assert.ok(event.url, 'and it says which page');
  }
});

test('no fetch event remains at attempted once retrieval returns', async () => {
  const funnel = await run({ fetchPage: oneFastManySlow('https://site1.example/p') });

  const unfinished = funnel.fetch_events.filter((e) => e.status === 'attempted');
  assert.deepEqual(unfinished, [], 'every started fetch reached a terminal status');
  for (const event of funnel.fetch_events) {
    assert.ok(TERMINAL.has(event.status), `${event.url} ended as ${event.status}`);
  }
});

test('cancellation is not counted as fetch failure', async () => {
  const funnel = await run({ fetchPage: oneFastManySlow('https://site1.example/p') });

  assert.equal(
    funnel.fetch_events.filter((e) => e.status === 'failed').length,
    0,
    'aborting the losers of a healthy pool must not read as a run whose fetches mostly fail',
  );
});

test('a page that genuinely fails is still recorded as failed', async () => {
  // The distinction is only worth anything if a real failure still lands as one.
  const funnel = await run({
    fetchPage: async (url) =>
      url === 'https://site1.example/p' ? { ok: false, url, status: 500, error: 'HTTP 500', duration_ms: 5 } : page(url),
    results: leads(2),
  });

  const failed = funnel.fetch_events.filter((e) => e.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].url, 'https://site1.example/p');
  assert.match(failed[0].reason, /500/);
});

test('every terminal status the pool can produce is one of the four', async () => {
  const thin = { ok: true, url: 'https://site2.example/p', final_url: 'https://site2.example/p', status: 200, title: 't', text: 'short', duration_ms: 4, timings: {} };
  const funnel = await run({
    fetchPage: async (url) => {
      if (url === 'https://site1.example/p') return { ok: false, url, status: 503, error: 'HTTP 503', duration_ms: 3 };
      if (url === 'https://site2.example/p') return thin;
      return page(url);
    },
    results: leads(3),
  });

  const statuses = new Set(funnel.fetch_events.map((e) => e.status));
  for (const status of statuses) assert.ok(TERMINAL.has(status), `${status} is a terminal status`);
  assert.ok(statuses.has('too_thin'), 'a page that read too little is distinguishable from one that failed');
});
