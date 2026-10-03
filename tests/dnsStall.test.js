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

/**
 * The connection goes to the approved addresses, and nowhere else.
 *
 * This used to assert the shape of `dispatcherFor` against the file's own text,
 * including `lookup: (_hostname, _opts, cb)` — and that ignored `_hostname` was
 * the bug: the dispatcher answered with the approved addresses whatever host it
 * was asked about, so a redirect to another host was delivered to the original
 * host's address. A test that pins the defect in place is worse than no test,
 * so this one asks the dispatcher instead of reading it.
 */
test('the dispatcher answers only for the host that passed the SSRF check', async () => {
  const { pinnedLookup } = await import('../src/agent/services/fetcher.js');
  const approved = [{ address: '93.184.216.34', family: 4 }];
  const lookup = pinnedLookup('news.example.com', approved);

  const ask = (host) => new Promise((resolve) => lookup(host, {}, (err, addrs) => resolve({ err, addrs })));

  const same = await ask('news.example.com');
  assert.equal(same.err, null, 'the approved host is answered');
  assert.deepEqual(same.addrs, approved, 'with exactly the approved addresses');

  // Same host, two other legal spellings.
  assert.deepEqual((await ask('NEWS.example.com')).addrs, approved, 'case is not a different host');
  assert.deepEqual((await ask('news.example.com.')).addrs, approved, 'the FQDN dot is not a different host');

  for (const other of ['evil.example.com', '169.254.169.254', 'lumina-al-agent.internal']) {
    const res = await ask(other);
    assert.ok(res.err instanceof Error, `${other} is refused, not answered`);
    assert.match(res.err.message, /refusing to connect/);
    assert.equal(res.addrs, undefined, `${other} gets no addresses`);
  }
});

// No comment stripping here, deliberately.
//
// The first version of this test stripped block comments with a non-greedy
// /\/\*...\*\//g before searching, and that regex ate real code: the `accept`
// header's value contains a star-slash-star wildcard, so the match ran from an
// earlier comment opener all the way through it and took the `redirect:` lines
// with it -- 14k of 30k characters gone, and an assertion failing for a reason
// that had nothing to do with the fetcher. (Written as line comments, because
// spelling that wildcard inside a block comment closes the block comment --
// which is how the first attempt at this very note failed to parse.)
//
// `dns.lookup(` with its parenthesis appears only in code; the prose in
// fetcher.js writes `dns.lookup` without one, which is what the second
// assertion pins.
test('the unbounded getaddrinfo call is not on the fetch path', () => {
  const src = fs.readFileSync(new URL('../src/agent/services/fetcher.js', import.meta.url), 'utf8');
  assert.ok(!/dns\.lookup\(/.test(src), 'the unbounded threadpool call must not come back');
  assert.match(src, /dns\.lookup/, 'but the comment explaining why is still there (so this is not vacuous)');
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
