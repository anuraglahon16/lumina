import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One fetch that never settles must not hold the run.
 *
 * Eight quick runs in a deployed benchmark ran 295-300 seconds against a
 * 90-second envelope: an aborted fetch was stuck in an uncancellable
 * `dns.lookup`, and the pool's `await Promise.allSettled(...)` waited for it.
 * The deadline could not help - it aborted the pool, and an uncancellable
 * lookup does not notice an abort.
 *
 * Driven through `gatherFromWeb` with an injected fetcher, because this is about
 * the pool's drain rather than about any model.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-hang-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';
process.env.FETCH_DRAIN_GRACE_MS = '300';

const { config } = await import('../src/shared/config.js');
const { gatherFromWeb } = await import('../src/agent/core/retrieve.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');
const { RunRecorder } = await import('../src/agent/store/runLog.js');

const BODY = 'Rank fusion merges two ordered candidate lists, and reranking adds latency. '.repeat(8);

const page = (url) => ({
  ok: true,
  url,
  final_url: url,
  status: 200,
  title: `page ${url}`,
  text: BODY,
  fetched_at: new Date().toISOString(),
  duration_ms: 5,
  timings: {},
});

test('the grace period is short in this fixture', () => {
  assert.equal(config.fetcher.drainGraceMs, 300);
});

test('a fetch that never settles does not stop the run finishing', async () => {
  const search = async () => ({
    results: [
      { url: 'https://good-1.test/a', title: 'one', snippet: 'lead' },
      { url: 'https://hangs.test/a', title: 'two', snippet: 'lead' },
      { url: 'https://good-2.test/a', title: 'three', snippet: 'lead' },
      { url: 'https://good-3.test/a', title: 'four', snippet: 'lead' },
    ],
    provider: 'stub',
    cached: false,
  });

  let hangStarted = false;
  /**
   * Released at the end of the test, not left pending.
   *
   * `new Promise(() => {})` models getaddrinfo exactly, and Node's test runner
   * then reports "Promise resolution is still pending but the event loop has
   * already resolved" - the fixture's own litter, not a product failure. It
   * hangs for the duration of the assertion and is let go afterwards.
   */
  const releases = [];
  const fetchPage = async (url) => {
    if (url.includes('hangs.test')) {
      hangStarted = true;
      return new Promise((resolve) => releases.push(() => resolve(page(url))));
    }
    return page(url);
  };

  const ledger = new EvidenceLedger();
  const budget = new Budget({ ...config.budgets.quick, wallClockMs: 8000 }, { label: 'quick' });
  const recorder = new RunRecorder({ requestId: 'req_hang', userId: 'u', threadId: null, mode: 'quick', query: 'q', model: 'm' });

  const started = Date.now();
  await gatherFromWeb({
    query: 'how does rank fusion work',
    ledger,
    budget,
    recorder,
    emit: () => {},
    webSearch: search,
    fetchPage,
  });
  const elapsed = Date.now() - started;

  assert.ok(hangStarted, 'the hanging fetch was actually started');
  assert.ok(elapsed < 8000, `retrieval returned inside the envelope, took ${elapsed}ms`);
  assert.ok(ledger.sources.length > 0, 'and with evidence from the fetches that did return');
  for (const r of releases) r();
  await new Promise((r) => setTimeout(r, 30));
});

test('after the drain gives up, a straggler cannot become a source', async () => {
  // The guarantee that moved: it used to be "every fetch has settled", which an
  // uncancellable fetch makes unreachable. Now it is "nothing more can be added".
  let release;
  const search = async () => ({
    results: [
      { url: 'https://quick-1.test/a', title: 'one', snippet: 'lead' },
      { url: 'https://late.test/a', title: 'two', snippet: 'lead' },
      { url: 'https://quick-2.test/a', title: 'three', snippet: 'lead' },
    ],
    provider: 'stub',
    cached: false,
  });
  const fetchPage = async (url) => {
    if (url.includes('late.test')) return new Promise((resolve) => { release = () => resolve(page(url)); });
    return page(url);
  };

  const ledger = new EvidenceLedger();
  const budget = new Budget({ ...config.budgets.quick, wallClockMs: 8000 }, { label: 'quick' });
  const recorder = new RunRecorder({ requestId: 'req_late', userId: 'u', threadId: null, mode: 'quick', query: 'q', model: 'm' });

  await gatherFromWeb({
    query: 'how does rank fusion work',
    ledger,
    budget,
    recorder,
    emit: () => {},
    webSearch: search,
    fetchPage,
  });

  const before = ledger.sources.length;
  assert.ok(before > 0, 'the run has its evidence');
  // The straggler lands after retrieval returned.
  release?.();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ledger.sources.length, before, 'and the late page did not join it');
});
