import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

/**
 * The fetcher pulls URLs the model chose, so every hop is an SSRF decision.
 *
 * Three holes this file pins shut, each of them real in the deployed build:
 *
 *  1. `redirect: 'follow'` let undici walk the chain internally, so the SSRF
 *     check only ever saw the URL the model asked for. `Location:
 *     http://169.254.169.254/latest/meta-data/` was followed with nothing in
 *     the way, because `net.connect` skips DNS for an IP literal and never
 *     consults the dispatcher's pinned `lookup` at all.
 *  2. That pinned `lookup` ignored the hostname it was handed, so a hop to
 *     another host was answered with the *original* host's addresses — a
 *     request delivered to one server wearing another's `Host` header.
 *  3. The private-range check used string prefixes, which is the wrong tool for
 *     v6: `fe80::/10` is fe80-febf so `startsWith('fe80')` missed `febf::1`,
 *     and an IPv4-mapped address like `::ffff:169.254.169.254` is the metadata
 *     endpoint written in v6 and matched no prefix at all.
 */

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ssrf-'));
process.env.MONGODB_URI = '';
process.env.FETCH_MAX_REDIRECTS = '3';

const { config } = await import('../src/shared/config.js');
const { isPrivateAddress, isBlockedHostname, normalizeHostname, followRedirects, fetchPage } = await import(
  '../src/agent/services/fetcher.js'
);

/* ─── the premise the whole design rests on ─────────────────────────────── */

test('a custom lookup is consulted for a hostname and skipped for an IP literal', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const probe = (host) =>
    new Promise((resolve) => {
      let consulted = false;
      const socket = net.connect({
        host,
        port,
        lookup: (_h, _o, cb) => {
          consulted = true;
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      });
      const done = () => {
        socket.destroy();
        resolve(consulted);
      };
      socket.on('connect', done);
      socket.on('error', done);
    });

  const forLiteral = await probe('127.0.0.1');
  const forHostname = await probe('pinned.invalid');
  server.close();

  // If this ever flips, the comment in fetcher.js is stale and hop 1 of a
  // redirect chain to an IP literal is being validated after all.
  assert.equal(forLiteral, false, 'an IP literal bypasses the lookup — which is why every hop must be checked');
  assert.equal(forHostname, true, 'a hostname does go through the lookup (so the test is not vacuous)');
});

/* ─── the address blocklist ─────────────────────────────────────────────── */

const MUST_BLOCK = [
  ['10.0.0.1', 'RFC1918'],
  ['172.16.0.1', 'RFC1918 lower edge'],
  ['172.31.255.255', 'RFC1918 upper edge'],
  ['192.168.1.1', 'RFC1918'],
  ['127.0.0.1', 'loopback'],
  ['0.0.0.0', 'unspecified'],
  ['169.254.169.254', 'cloud metadata'],
  ['100.64.0.1', 'carrier NAT'],
  ['198.18.0.1', 'benchmark range'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['::1', 'v6 loopback'],
  ['::', 'v6 unspecified'],
  ['fc00::1', 'ULA fc00::/7'],
  ['fd00::1', 'ULA fd00::/8'],
  ['fdaa:0:1::3', "Fly's 6PN private network"],
  ['fe80::1', 'link-local, low end'],
  ['febf::1', 'link-local, high end — the prefix check missed this'],
  ['fea9::1', 'link-local, middle — the prefix check missed this'],
  ['fe80::1%eth0', 'link-local with a zone id'],
  ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918 — missed entirely'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback — missed entirely'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata — missed entirely'],
  ['::ffff:0:10.0.0.1', 'SIIT-translated RFC1918'],
  ['::10.0.0.1', 'IPv4-compatible RFC1918'],
  ['64:ff9b::a00:1', 'NAT64 of 10.0.0.1'],
  ['ff02::1', 'v6 multicast'],
  ['not-an-address', 'unparseable is not safe'],
];

const MUST_ALLOW = [
  ['93.184.216.34', 'a public v4 host'],
  ['1.1.1.1', 'a public resolver'],
  ['172.32.0.1', 'just above RFC1918'],
  ['192.169.0.1', 'just above 192.168/16'],
  ['100.128.0.1', 'just above carrier NAT'],
  ['2606:2800:220:1::', 'a public v6 host'],
  ['2001:4860:4860::8888', 'a public v6 resolver'],
  ['::ffff:93.184.216.34', 'IPv4-mapped public address'],
  ['64:ff9b::5db8:d822', 'NAT64 of a public address'],
];

test('every private, loopback, link-local and mapped address is refused', () => {
  for (const [ip, why] of MUST_BLOCK) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked (${why})`);
  }
});

test('public addresses are still allowed, so the blocklist is not just "no"', () => {
  for (const [ip, why] of MUST_ALLOW) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed (${why})`);
  }
  // A blocklist that refuses everything would pass the test above on its own.
  assert.ok(MUST_ALLOW.length >= 5, 'enough allowed cases to make the pair meaningful');
});

/* ─── the hostname blocklist, which runs before any resolution ──────────── */

test("Fly's .internal names are refused by name, before resolution", () => {
  assert.equal(isBlockedHostname('lumina-al-agent.internal'), true);
  assert.equal(isBlockedHostname('lumina-al-gateway.internal'), true);
  assert.equal(isBlockedHostname('top1.nearest.of.lumina-al-agent.internal'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('LOCALHOST'), true);
  assert.equal(isBlockedHostname('printer.local'), true);
  // The trailing dot is the same name fully qualified; /\.internal$/ did not match it.
  assert.equal(isBlockedHostname('lumina-al-agent.internal.'), true, 'the FQDN spelling is the same host');
  assert.equal(normalizeHostname('Lumina-AL-Agent.Internal.'), 'lumina-al-agent.internal');
  // Not a blanket refusal.
  assert.equal(isBlockedHostname('example.com'), false);
  assert.equal(isBlockedHostname('internal'), false, 'a bare label is not a .internal name');
});

test('fetching the agent service by its .internal name is refused without resolving it', async () => {
  const out = await fetchPage('http://lumina-al-agent.internal:8787/health');
  assert.equal(out.ok, false);
  // 'blocked host' can only come from the name check; 'resolves to a private
  // address' would mean we had already sent the name to a resolver.
  assert.match(out.error, /blocked host: lumina-al-agent\.internal/);
  assert.doesNotMatch(out.error, /resolves to/, 'it must be refused before resolution, not after');
  assert.equal(out.status, null);
});

/* ─── redirects: every hop re-checked ──────────────────────────────────── */

const redirectTo = (location, status = 302) => ({
  status,
  ok: false,
  headers: new Headers({ location }),
  body: null,
});

const finalPage = () => ({
  status: 200,
  ok: true,
  headers: new Headers({ 'content-type': 'text/html' }),
  body: null,
});

/** A doFetch that replays a scripted chain and records what it was asked for. */
function scriptedFetch(steps) {
  const seen = [];
  const inits = [];
  const fn = async (url, init) => {
    seen.push(url.toString());
    inits.push(init);
    const step = steps[seen.length - 1];
    if (!step) throw new Error(`unscripted fetch of ${url}`);
    return step;
  };
  fn.seen = seen;
  fn.inits = inits;
  return fn;
}

/** Stands in for the resolver+range check, approving any host it is given. */
const approveAll = async (url) => ({ parsed: new URL(url), addrs: [{ address: '93.184.216.34', family: 4 }] });

for (const [target, why] of [
  ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata service as a bare IP'],
  ['http://10.0.0.5/admin', 'an RFC1918 address'],
  ['http://127.0.0.1:8000/contract/health', 'the agent service on loopback'],
  ['http://[::ffff:169.254.169.254]/latest/meta-data/', 'metadata written as an IPv4-mapped v6 literal'],
  ['http://[fdaa:0:1::3]:8787/health', "a Fly 6PN address"],
]) {
  test(`a redirect to ${why} is refused`, async () => {
    const doFetch = scriptedFetch([redirectTo(target)]);
    await assert.rejects(
      followRedirects({
        start: new URL('https://news.example.com/article'),
        doFetch,
        makeDispatcher: () => null,
        // The REAL check — not a stub. That is the point of the test.
      }),
      (err) => {
        assert.match(err.message, /private address|blocked host|blocked scheme/, `refused with a reason, got: ${err.message}`);
        return true;
      },
    );
    assert.deepEqual(doFetch.seen, ['https://news.example.com/article'], 'it must never connect to the redirect target');
  });
}

test('a redirect to a .internal name is refused by name', async () => {
  const doFetch = scriptedFetch([redirectTo('http://lumina-al-agent.internal:8787/health')]);
  await assert.rejects(
    followRedirects({ start: new URL('https://news.example.com/a'), doFetch, makeDispatcher: () => null }),
    /blocked host: lumina-al-agent\.internal/,
  );
  assert.equal(doFetch.seen.length, 1, 'the .internal host was never fetched');
});

test('a redirect to a non-http scheme is refused', async () => {
  const doFetch = scriptedFetch([redirectTo('file:///etc/passwd')]);
  await assert.rejects(
    followRedirects({ start: new URL('https://news.example.com/a'), doFetch, makeDispatcher: () => null }),
    /blocked scheme: file:/,
  );
});

test('the hop limit ends a redirect loop', async () => {
  const steps = Array.from({ length: 12 }, () => redirectTo('https://loop.example.com/next'));
  const doFetch = scriptedFetch(steps);
  await assert.rejects(
    followRedirects({ start: new URL('https://loop.example.com/next'), doFetch, validate: approveAll, makeDispatcher: () => null }),
    /too many redirects \(max 3\)/,
  );
  // maxRedirects hops followed, plus the request that produced the hop too far.
  assert.equal(doFetch.seen.length, config.fetcher.maxRedirects + 1);
});

test('a legitimate redirect chain is still followed, with a dispatcher per hop', async () => {
  const doFetch = scriptedFetch([
    redirectTo('https://www.example.com/article', 301),
    redirectTo('/article/final', 302), // relative, resolved against the current URL
    finalPage(),
  ]);
  const dispatchers = [];
  const { res, finalUrl, redirectChain } = await followRedirects({
    start: new URL('https://example.com/article'),
    doFetch,
    validate: approveAll,
    makeDispatcher: (hostname) => {
      const d = { hostname };
      dispatchers.push(d);
      return d;
    },
  });

  assert.equal(res.status, 200, 'the chain ended on a real response');
  assert.equal(finalUrl, 'https://www.example.com/article/final');
  assert.deepEqual(redirectChain, ['https://www.example.com/article', 'https://www.example.com/article/final']);
  assert.deepEqual(doFetch.seen, [
    'https://example.com/article',
    'https://www.example.com/article',
    'https://www.example.com/article/final',
  ]);
  // One fresh dispatcher per hop: reusing the first would send hop 2 to hop 1's address.
  assert.equal(dispatchers.length, 2, 'a new pinned dispatcher for each hop');
  // The whole point: undici must not be following the chain for us.
  for (const init of doFetch.inits) assert.equal(init.redirect, 'manual', 'every request is issued with manual redirects');
});

test('a 3xx with no Location is a response, not a hop', async () => {
  const doFetch = scriptedFetch([{ status: 302, ok: false, headers: new Headers({}), body: null }]);
  const { res, redirectChain } = await followRedirects({
    start: new URL('https://example.com/a'),
    doFetch,
    validate: approveAll,
  });
  assert.equal(res.status, 302);
  assert.deepEqual(redirectChain, []);
});

/**
 * An IPv6 literal as the URL the model asked for — not as a redirect.
 *
 * This hole predates the redirect work: `URL.hostname` keeps the brackets, so
 * `net.isIP` returned 0 and the literal was passed to the resolver as a name
 * instead of being judged by `isPrivateAddress`. It failed closed on EBADNAME,
 * so nothing leaked, but the refusal said "dns failure" where it should say
 * "blocked private address" — and a check that is never reached is a check
 * that cannot be relied on.
 */
test('a bracketed IPv6 literal is judged as an address, not resolved as a name', async () => {
  // The hostname is whatever the URL parser canonicalised it to, which is not
  // always the spelling we wrote: `::ffff:169.254.169.254` comes back as
  // `::ffff:a9fe:a9fe`. Same address, hex instead of dotted-quad.
  for (const url of [
    'http://[fdaa:0:1::3]:8787/health',
    'http://[::1]:8000/contract/health',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[fe80::1]/',
  ]) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const out = await fetchPage(url);
    assert.equal(out.ok, false, `${url} must be refused`);
    assert.equal(out.error, `blocked private address: ${host}`, `${url} refused as an address, by its own reason`);
    // The old behaviour. If this reappears the literal is reaching a resolver.
    assert.doesNotMatch(out.error, /dns failure/, 'it must not be sent to the resolver as a name');
  }
});

test('a public IPv6 literal still resolves to itself, so the bracket fix is not a blanket refusal', async () => {
  const { resolveHost } = await import('../src/agent/services/fetcher.js');
  const addrs = await resolveHost('[2606:2800:220:1::]');
  assert.deepEqual(addrs, [{ address: '2606:2800:220:1::', family: 6 }]);
});
