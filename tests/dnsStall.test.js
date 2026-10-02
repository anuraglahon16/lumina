import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A lookup that never answers must fail the fetch, not hold the run.
 *
 * `dns.lookup` is getaddrinfo on libuv's four-thread pool: it takes no signal,
 * has no timeout, and holds a thread while it waits. Eight quick runs in a
 * deployed benchmark sat in retrieval for 295-300 seconds because an aborted
 * fetch was stuck there and `Promise.allSettled` could not drain - and the
 * failures arrived in clusters, which is what a consumed threadpool looks like
 * from outside: a held thread delays DNS for Mongo and every provider too.
 *
 * c-ares does its own UDP on the event loop, so it takes a real timeout, can be
 * cancelled, and touches no thread.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-dns-'));
process.env.MONGODB_URI = '';
process.env.FETCH_DNS_TIMEOUT_MS = '400';
process.env.FETCH_DRAIN_GRACE_MS = '300';

const { config } = await import('../src/shared/config.js');
const { resolveHost } = await import('../src/agent/services/fetcher.js');

test('the DNS bound is configured and short', () => {
  assert.equal(config.fetcher.dnsTimeoutMs, 400, 'this file set it');
  assert.ok(config.fetcher.dnsTries >= 1);
  assert.equal(config.fetcher.drainGraceMs, 300);
});

test('a resolver that never answers fails within the timeout', async () => {
  // A stub with the Resolver shape: resolve4/resolve6 never settle.
  const never = () => new Promise(() => {});
  let cancelled = false;
  const stub = {
    resolve4: never,
    resolve6: never,
    cancel: () => {
      cancelled = true;
    },
  };

  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 200);
  // No outer race: resolveHost itself must reject on abort. An earlier version
  // of this test raced it against a 3s timer, which let a hanging resolveHost
  // "pass" by rejecting from the timer instead of from the code under test.
  await assert.rejects(
    resolveHost('nowhere.invalid', { signal: ac.signal, resolver: stub }),
    /aborted during dns/,
    'a lookup that never answers must not hang the caller',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `and must fail promptly, took ${elapsed}ms`);
  assert.ok(cancelled, 'the resolver is cancelled rather than left running');
});

test('a DNS failure is a failed fetch with a non-empty error', async () => {
  const { fetchPage } = await import('../src/agent/services/fetcher.js');
  // `.invalid` is reserved and cannot resolve, so this exercises the real path.
  const page = await fetchPage('https://this-host-cannot-exist.invalid/x', {});
  assert.equal(page.ok, false, 'a DNS failure is a failure');
  assert.ok(String(page.error ?? '').trim().length > 0, `and carries an error: ${JSON.stringify(page.error)}`);
  assert.match(String(page.error), /dns|resolve|ENOTFOUND|EAI_AGAIN/i, `named honestly: ${page.error}`);
});

test('an IP literal needs no resolution at all', async () => {
  const addrs = await resolveHost('93.184.216.34');
  assert.deepEqual(addrs, [{ address: '93.184.216.34', family: 4 }]);
});

test('the connection uses only addresses the SSRF check approved', () => {
  const src = fs.readFileSync(new URL('../src/agent/services/fetcher.js', import.meta.url), 'utf8');
  assert.match(src, /function dispatcherFor\(addrs\)/, 'there is a dispatcher built from the approved addresses');
  assert.match(src, /lookup: \(_hostname, _opts, cb\) => cb\(null, addrs/, 'and it answers undici with those addresses');
  assert.match(src, /dispatcher,/, 'the fetch uses it');
  // The old unbounded call must not come back.
  assert.ok(!/await dns\.lookup\(/.test(src), 'getaddrinfo is no longer on the fetch path');
});

test('retrieval stops waiting for a fetch that will not settle', () => {
  const src = fs.readFileSync(new URL('../src/agent/core/retrieve.js', import.meta.url), 'utf8');
  const fin = src.slice(src.indexOf('pool.abort(abortReason(\'retrieval_complete\'))'), src.indexOf('inFlight.clear();'));
  assert.match(fin, /Promise\.race\(/, 'the drain is bounded');
  assert.match(fin, /config\.fetcher\.drainGraceMs/, 'by a configured grace period');
  assert.match(fin, /ledger\.close\(\)/, 'and the ledger is closed when it gives up');
  assert.match(fin, /status: 'cancelled'/, 'abandoned fetches are recorded as cancelled');
  assert.ok(!/await Promise\.allSettled\(\[\.\.\.inFlight\.values\(\)\]\);/.test(src), 'the unbounded wait is gone');
});

test('the ledger rejects a source added after it closes', async () => {
  const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
  const ledger = new EvidenceLedger();
  const page = {
    ok: true,
    url: 'https://example.test/a',
    final_url: 'https://example.test/a',
    status: 200,
    title: 'A page',
    text: 'Rank fusion merges two ordered candidate lists. '.repeat(10),
    fetched_at: new Date().toISOString(),
    duration_ms: 5,
  };
  const before = ledger.addWebSource(page, { query: 'q' });
  assert.ok(before, 'a source lands while the ledger is open');
  assert.equal(ledger.sources.length, 1);

  ledger.close();
  const after = ledger.addWebSource(
    { ...page, url: 'https://example.test/late', final_url: 'https://example.test/late' },
    { query: 'q' },
  );
  assert.equal(after, null, 'a straggler is refused');
  assert.equal(ledger.sources.length, 1, 'and cannot reach an answer already being written');
});
