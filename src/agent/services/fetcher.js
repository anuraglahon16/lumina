import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';
import * as cheerio from 'cheerio';
import { config } from '../../shared/config.js';
import { safeSlice } from '../../shared/text.js';
import { deadlineSignal, abortReason } from '../core/budget.js';
import { cached } from './cache.js';
import { createLogger } from '../../shared/logger.js';
import { breaker } from '../../shared/circuitBreaker.js';

const log = createLogger('fetcher');

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

/**
 * A hostname in the form the checks expect.
 *
 * Two spellings of the same host were getting past these checks.
 *
 * `example.internal.` is the same name as `example.internal` — the trailing dot
 * only says "already fully qualified" — but `/\.internal$/` does not match it,
 * so the fully-qualified spelling walked past the name check. On Fly the
 * address check caught it anyway, because the name resolves into `fdaa::/16`,
 * but relying on that makes the name check decorative.
 *
 * The brackets were worse. `new URL('http://[fdaa:0:1::3]/').hostname` is
 * `"[fdaa:0:1::3]"`, brackets included, and `net.isIP` says 0 for that — so the
 * IP-literal branch of `assertFetchable` never fired for *any* v6 literal, and
 * no v6 literal was ever handed to `isPrivateAddress`. It was still refused,
 * but only because c-ares returns EBADNAME for a bracketed name: a
 * fail-closed accident one normalisation away from being a hole, and the test
 * that caught it was asserting on the reason rather than just the refusal.
 */
export const normalizeHostname = (hostname) =>
  String(hostname ?? '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

/** Is this hostname one we refuse to resolve at all? */
export const isBlockedHostname = (hostname) => BLOCKED_HOST.test(normalizeHostname(hostname));

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it will not parse. */
function hextets(ip) {
  let rest = ip.split('%')[0];
  let tail4 = null;
  const lastColon = rest.lastIndexOf(':');
  const maybeV4 = rest.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (!net.isIPv4(maybeV4)) return null;
    const o = maybeV4.split('.').map(Number);
    tail4 = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    rest = rest.slice(0, lastColon + 1) + '0:0';
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(fill).fill('0'), ...tail];
  const out = groups.map((g) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return NaN;
    return parseInt(g, 16);
  });
  if (out.some(Number.isNaN)) return null;
  if (tail4) {
    out[6] = tail4[0];
    out[7] = tail4[1];
  }
  return out;
}

/**
 * Is this address somewhere we must never connect?
 *
 * String prefixes are the wrong tool for v6 and this used them. Three families
 * walked through: `fe80::/10` is `fe80`–`febf`, so `startsWith('fe80')` missed
 * `febf::1`; an IPv4-mapped address like `::ffff:169.254.169.254` is the cloud
 * metadata endpoint written in v6 and matched none of the prefixes at all; and
 * `ff00::/8` multicast was never considered. So the groups are parsed and
 * compared as numbers, and any address carrying an embedded IPv4 one — mapped,
 * compatible, or NAT64 — is judged on that IPv4 address as well as its prefix.
 */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const h = hextets(ip.toLowerCase());
  // Unparseable is not safe. Refusing to connect is the conservative failure.
  if (!h) return true;

  if (h.every((g) => g === 0)) return true; // ::
  if (h.slice(0, 7).every((g) => g === 0) && h[7] === 1) return true; // ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 — ULA, incl. Fly's fdaa::/16
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 — multicast

  // The embedded-IPv4 forms: ::a.b.c.d, ::ffff:a.b.c.d, ::ffff:0:a.b.c.d and
  // 64:ff9b::/96 (NAT64) all deliver traffic to an IPv4 destination.
  const embedded = () => `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
  const zeroHead = h.slice(0, 5).every((g) => g === 0);
  if (zeroHead && (h[5] === 0 || h[5] === 0xffff)) return isPrivateV4(embedded());
  if (h.slice(0, 4).every((g) => g === 0) && h[4] === 0xffff && h[5] === 0) return isPrivateV4(embedded()); // ::ffff:0:a.b.c.d
  if (h[0] === 0x0064 && h[1] === 0xff9b) return isPrivateV4(embedded());

  return false;
}

/**
 * Resolution that cannot hang, and cannot starve anything else.
 *
 * This used `dns.lookup`, which is `getaddrinfo` on libuv's threadpool: it takes
 * no signal, has no timeout, and occupies one of four threads while it waits.
 * Eight quick runs in a deployed benchmark stalled for 295-300 seconds inside
 * retrieval because an aborted fetch was stuck there and `Promise.allSettled`
 * could not drain - and because the threadpool was being consumed, the failures
 * arrived in clusters: a stuck lookup delays DNS for Mongo, Anthropic and the
 * search provider too.
 *
 * `Resolver` is c-ares. It does its own UDP I/O on the event loop, so it touches
 * no thread, takes a real timeout, and can be cancelled. A and AAAA are queried
 * together because a host with only one of them must still resolve.
 */
const resolverFor = () => {
  const r = new Resolver({ timeout: config.fetcher.dnsTimeoutMs, tries: config.fetcher.dnsTries });
  return r;
};

/** Addresses for a host, bounded and cancellable. Throws rather than hanging. */
export async function resolveHost(rawHostname, { signal, resolver = null } = {}) {
  // A v6 literal arrives from `URL.hostname` wrapped in brackets, which is not
  // an IP as far as `net.isIP` is concerned and is not a name either.
  const hostname = normalizeHostname(rawHostname);
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  const r = resolver ?? resolverFor();
  let onAbort = null;
  try {
    /**
     * Cancelled AND raced.
     *
     * `cancel()` is what stops the queries, and the real c-ares resolver rejects
     * its pending promises when it is called. But a resolver that ignores cancel
     * would leave this awaiting forever - which is the whole failure being fixed,
     * reintroduced one layer up. A stub that never answers proved it: the abort
     * fired, `cancelled` was set, and the caller still hung. So the abort also
     * loses the race on its own.
     */
    const aborted = new Promise((_, reject) => {
      if (signal?.aborted) return reject(abortReason('aborted before dns'));
      onAbort = () => {
        r.cancel?.();
        reject(abortReason('aborted during dns'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    // Both families, and a failure of one is not a failure of the host.
    const [v4, v6] = await Promise.race([
      Promise.allSettled([r.resolve4(hostname), r.resolve6(hostname)]),
      aborted,
    ]);
    const addrs = [
      ...(v4.status === 'fulfilled' ? v4.value.map((a) => ({ address: a, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((a) => ({ address: a, family: 6 })) : []),
    ];
    if (!addrs.length) {
      const why = [v4, v6].map((x) => (x.status === 'rejected' ? x.reason?.code ?? x.reason?.message : null)).filter(Boolean).join('/');
      throw new Error(`dns failure for ${hostname}${why ? `: ${why}` : ''}`);
    }
    return addrs;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
};

/**
 * The agent fetches URLs the model chose, so every fetch is an SSRF risk.
 * Scheme allowlist + DNS resolution + private-range rejection before any request.
 *
 * Returns the validated addresses as well as the URL, so the connection can be
 * made to an address that passed this check rather than resolving again. A
 * second resolution is a second answer, and the gap between them is the TOCTOU
 * window this check otherwise leaves open.
 */
async function assertFetchable(url, { signal } = {}) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`blocked scheme: ${parsed.protocol}`);
  // Normalised first: a v6 literal's brackets and a FQDN's trailing dot both
  // hid the host from the checks below.
  const host = normalizeHostname(parsed.hostname);
  if (isBlockedHostname(host)) throw new Error(`blocked host: ${host}`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`blocked private address: ${host}`);
  const addrs = await resolveHost(host, { signal });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('host resolves to a private address');
  return { parsed, addrs };
}

/**
 * A dispatcher that connects only to the addresses the SSRF check approved.
 *
 * undici would otherwise resolve the hostname itself, through `getaddrinfo` -
 * putting the unbounded lookup back on the threadpool after all the work above,
 * and resolving a second time to an answer nobody validated.
 */
/**
 * A `lookup` that answers for one host and refuses every other.
 *
 * The old version ignored its `hostname` argument and handed back the approved
 * addresses whatever it was asked about. That is wrong in both directions on a
 * redirect: a hop to another host would have been sent to the original host's
 * address wearing the new host's `Host` header, and a hop whose host was never
 * validated would have been answered as though it had been. Refusing is the
 * only safe answer, and it is loud.
 *
 * Exported because it is the security boundary, and reaching it through an
 * `Agent`'s internals is not a test of anything stable.
 */
export function pinnedLookup(hostname, addrs) {
  const approved = normalizeHostname(hostname);
  const answer = addrs.map((a) => ({ address: a.address, family: a.family }));
  return (host, _opts, cb) => {
    if (normalizeHostname(host) !== approved)
      return cb(new Error(`refusing to connect to ${host}: only ${approved} passed the SSRF check`));
    cb(null, answer);
  };
}

export function dispatcherFor(hostname, addrs) {
  return new Agent({
    connect: { lookup: pinnedLookup(hostname, addrs) },
    connectTimeout: config.fetcher.connectTimeoutMs,
  });
}

/**
 * The statuses that carry a `Location` we are willing to follow.
 *
 * All of these are followed as GET: this fetcher only ever issues GET, so the
 * 303-vs-307 method-rewriting distinction does not arise.
 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const robotsCache = new Map();

async function robotsAllows(parsed, { signal, dispatcher = null } = {}) {
  if (!config.fetcher.respectRobots) return true;
  if (signal?.aborted) throw abortReason('aborted before robots.txt');
  const origin = parsed.origin;
  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      (async () => {
        try {
          // Its own short bound, composed with the caller's: robots is cached
          // per origin and shared between concurrent runs, so one caller
          // hanging up must not cancel the lookup another is waiting on. The
          // caller's own abort is checked above and after.
          const robotsBound = deadlineSignal(5000, undefined);
          let res;
          try {
            res = await fetch(`${origin}/robots.txt`, {
              headers: { 'user-agent': config.fetcher.userAgent },
              signal: robotsBound.signal,
              ...(dispatcher ? { dispatcher } : {}),
            });
          } finally {
            robotsBound.release();
          }
          if (!res.ok) return [];
          const text = (await res.text()).slice(0, 200000);
          const rules = [];
          let appliesToUs = false;
          for (const rawLine of text.split('\n')) {
            const line = rawLine.split('#')[0].trim();
            if (!line) continue;
            const [rawKey, ...rest] = line.split(':');
            const key = rawKey.trim().toLowerCase();
            const val = rest.join(':').trim();
            if (key === 'user-agent') appliesToUs = val === '*' || /lumina/i.test(val);
            else if (appliesToUs && (key === 'disallow' || key === 'allow') && val) rules.push({ type: key, path: val });
          }
          return rules;
        } catch {
          return [];
        }
      })(),
    );
  }
  /**
   * One lookup per origin, shared; one wait per caller, not shared.
   *
   * The lookup is cached per origin and several concurrent runs wait on the
   * same promise, so cancelling it on one caller's behalf would cancel it for
   * the others. But that caller should not keep waiting either: it raced the
   * shared promise against its own signal, so it leaves immediately while the
   * lookup carries on and still populates the cache for everyone else.
   */
  const shared = robotsCache.get(origin);
  const rules = await (signal ? raceSignal(shared, signal, 'aborted while waiting for robots.txt') : shared);
  const path = parsed.pathname + parsed.search;
  // Longest-match wins, as per the robots.txt convention.
  let best = null;
  for (const rule of rules) {
    if (path.startsWith(rule.path) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  return !best || best.type === 'allow';
}

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts.
 *
 * The promise is left running on purpose: this is for work that is shared with
 * other callers, where leaving is the caller's business and cancelling would be
 * everyone's. The listener is removed either way so a long-lived signal does
 * not accumulate them.
 */
export function raceSignal(promise, signal, message) {
  if (signal.aborted) return Promise.reject(abortReason(message));
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(abortReason(message));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * Was this failure the host's fault?
 *
 * A cancellation is this system changing its mind, not the host failing, and
 * counting it would let a run that found its evidence early trip the breaker
 * against the very hosts that answered fastest. Exported because it is the rule
 * the breaker is configured with, and a rule worth testing directly.
 */
export function isHostFault(err) {
  return !(err?.name === 'AbortError' || err?.code === 'ABORT_ERR');
}

/** Strip chrome and pull the main readable text out of an HTML document. */
/**
 * A space wherever markup was.
 *
 * Cheerio's `.text()` concatenates descendant text nodes with nothing between
 * them, so `<a>New</a><span>Meet Geopits</span>` extracts as "NewMeet Geopits".
 * A page whose banner and navigation are built from adjacent inline elements
 * comes out as "MumbaiRead More", "UsServicesTechnologyPartnersProductsAbout"
 * and, further in, "onSeptember", "uploadDate", "flexibilityHigh".
 *
 * Three things break at once. The fused token is not a word, so the embedding
 * model and the citation validator both see an unknown one and the passage
 * scores worse than it should. The snippet shown to a reader has words run
 * together. And the benchmark's provenance check, which strips tags by
 * replacing each with a space, looks for a contiguous twelve-token window of
 * our snippet in its own text and cannot find one across the join — sixteen of
 * eighty citations failed that way, which is the citation-grounding gate.
 *
 * Inserting the space in the source, before parsing, makes our tokenisation
 * agree with the grader's by construction rather than by coincidence. It costs
 * the occasional deliberate fusion — `<b>anti</b>disestablishment` becomes two
 * words — but the grader splits those too, so agreement holds, and HTML element
 * boundaries are word boundaries far more often than not.
 */
export const spaceElementBoundaries = (html) => String(html ?? '').replace(/<[^>]+>/g, (tag) => ` ${tag} `);

function extractArticle(html, url) {
  const $ = cheerio.load(spaceElementBoundaries(html));
  $('script, style, noscript, svg, iframe, form, nav, header, footer, aside, [aria-hidden="true"]').remove();

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    new URL(url).hostname;

  const published =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    null;

  const author = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || null;
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || null;

  // Score candidate containers by text density; fall back to <body>.
  const candidates = ['article', 'main', '[role="main"]', '#content', '.post-content', '.article-body', 'body'];
  let best = { text: '', score: 0 };
  for (const selector of candidates) {
    $(selector).each((_, el) => {
      const node = $(el);
      const text = node.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const linkChars = node.find('a').text().length;
      const density = text.length ? 1 - linkChars / text.length : 0;
      const score = text.length * Math.max(0.15, density);
      if (score > best.score) best = { text, score };
    });
  }

  const paragraphs = best.text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40);

  return {
    title: safeSlice(title.replace(/\s+/g, ' ').trim(), 300),
    published_at: published,
    author,
    description,
    text: safeSlice(paragraphs.join('\n\n'), config.fetcher.maxChars),
    paragraphs,
  };
}

/** Read the body with a hard byte ceiling so one huge page can't exhaust memory. */
/**
 * Read a body, stopping at a byte ceiling or on cancellation.
 *
 * Checked between chunks rather than only at the end: a cancelled request that
 * keeps draining a large response has not been cancelled, it has been ignored
 * with extra steps, and the reader is what holds the socket open.
 */
async function readLimited(res, maxBytes, signal) {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw abortReason('aborted while reading the body');
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks.map(Buffer.from))), truncated };
}

/**
 * Follow a redirect chain, checking every hop.
 *
 * `redirect: 'follow'` let undici walk the chain internally, which meant
 * `assertFetchable` only ever saw the URL the model asked for. Two ways out of
 * the SSRF check followed from that. A hop to another hostname was answered by
 * the dispatcher's pinned `lookup`, which ignored the name it was handed — so
 * the request went to the original host's address wearing the new host's `Host`
 * header. Worse, a hop to a bare IP literal never consults `lookup` at all:
 * `net.connect` skips DNS when the host is already an address, so
 * `Location: http://169.254.169.254/latest/meta-data/` connected straight to
 * the metadata service with nothing in the way. That is measured rather than
 * reasoned about — a custom `lookup` is called for a hostname and is not called
 * for an IP literal.
 *
 * So each hop is resolved through the bounded resolver, re-checked against the
 * same rules as the first URL, and given its own dispatcher pinned to the
 * addresses that just passed. A hop that fails throws, and `fetchPage` turns
 * that into `{ ok: false, error }`: a failed fetch with a reason, never a
 * silent connection.
 *
 * The dependencies are arguments because this is the security boundary, and a
 * boundary that can only be exercised by reaching the real internet is a
 * boundary nobody tests. Production passes the real three.
 */
export async function followRedirects({
  start,
  dispatcher,
  signal,
  onDispatcher = () => {},
  maxRedirects = config.fetcher.maxRedirects,
  doFetch = fetch,
  validate = assertFetchable,
  makeDispatcher = dispatcherFor,
} = {}) {
  let current = start;
  const redirectChain = [];
  for (;;) {
    const res = await doFetch(current, {
      headers: {
        'user-agent': config.fetcher.userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5',
        'accept-language': 'en',
      },
      redirect: 'manual',
      signal,
      dispatcher,
    });

    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null;
    if (!location) return { res, finalUrl: current.toString(), redirectChain };

    // A redirect's body is not evidence, and leaving it holds the socket.
    await res.body?.cancel().catch(() => {});

    // Checked before resolving the next hop, so a redirect loop ends here
    // rather than being followed forever by a check that keeps passing.
    if (redirectChain.length >= maxRedirects)
      throw new Error(`too many redirects (max ${maxRedirects}) starting at ${start.toString()}`);

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`unparseable redirect to "${location}"`);
    }

    // The same gate as the first URL: scheme, name, resolution, ranges.
    const hop = await validate(next.toString(), { signal });
    dispatcher = makeDispatcher(hop.parsed.hostname, hop.addrs);
    onDispatcher(dispatcher);
    current = hop.parsed;
    redirectChain.push(current.toString());
  }
}

/**
 * Fetch one URL and return cleaned, citable evidence.
 * Cached by URL, so repeated runs over the same source cost nothing.
 */
export async function fetchPage(url, { recorder, maxChars = config.fetcher.maxChars, signal } = {}) {
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);

  /**
   * The caller's cancellation and this fetch's own timeout, composed once and
   * held for the whole operation.
   *
   * It used to be released as soon as the response headers arrived, which left
   * the body read and the extraction — the expensive part of a large page —
   * outside both the timeout and the caller's control. A cancelled request went
   * on downloading.
   *
   * This now covers resolution too: `resolveHost` takes the signal, cancels the
   * c-ares queries on abort and loses the race to the abort besides, so there is
   * no longer a window where an abort is noticed only after DNS returns.
   */
  const bound = deadlineSignal(config.fetcher.timeoutMs, signal);
  // Where the time inside one fetch actually goes. Without this, a slow page is
  // just slow; with it, a slow resolver and a slow server and a heavy document
  // are three different problems with three different answers.
  const timings = { resolve_ms: null, robots_ms: null, headers_ms: null, body_ms: null, extract_ms: null };
  /**
   * Declared outside the try, because the finally closes it.
   *
   * As a `const` inside the try it was in the temporal dead zone whenever
   * resolution threw first - so a DNS failure would have been replaced by a
   * ReferenceError from the cleanup, which is the worst possible place to lose
   * the real error.
   */
  let dispatcher = null;

  try {
  const resolveStart = performance.now();
  /**
   * A failure here is a failed fetch, not an exception.
   *
   * `assertFetchable` sits outside the `cached(...).catch(...)` below, so a DNS
   * failure propagated out of `fetchPage` as a rejection while every other
   * failure came back as `{ ok: false, error }`. The caller then had two shapes
   * to handle for one outcome, and the funnel recorded the thrown one as an
   * attempt that never reached a terminal status.
   */
  let parsed;
  let addrs;
  try {
    ({ parsed, addrs } = await assertFetchable(url, { signal: bound.signal }));
  } catch (err) {
    timings.resolve_ms = Math.round(performance.now() - resolveStart);
    return {
      ok: false,
      url,
      status: null,
      aborted: err?.name === 'AbortError' || err?.code === 'ABORT_ERR',
      error: err.message || 'could not resolve or validate the url',
      duration_ms: at(),
      timings,
    };
  }
  timings.resolve_ms = Math.round(performance.now() - resolveStart);
  // Connect only to what the check approved, and never resolve a second time.
  dispatcher = dispatcherFor(parsed.hostname, addrs);

  const robotsStart = performance.now();
  // robots.txt goes to the same approved addresses: it is a fetch to the same
  // host, and leaving it on getaddrinfo would leave the hazard in place for it.
  const allowed = await robotsAllows(parsed, { signal: bound.signal, dispatcher });
  timings.robots_ms = Math.round(performance.now() - robotsStart);
  if (!allowed) {
    return { ok: false, url, error: 'disallowed by robots.txt', status: null, duration_ms: at(), timings };
  }

  // Per host, because health is a property of the host rather than the URL. A
  // host that times out on every page would otherwise be retried page after
  // page, and each attempt spends a fetch from the run's budget.
  const hostBreaker = breaker(`fetch:${parsed.hostname}`, {
    failureThreshold: 3,
    cooldownMs: 120000,
    countsAsFailure: isHostFault,
  });

  const { value, cached: wasCached } = await cached(
    'fetch',
    { url: parsed.toString(), maxChars },
    config.cache.fetchTtlMs,
    async () => hostBreaker.run(async () => {
      const hopStart = performance.now();
      let res;
      let current;
      let redirectChain;
      try {
        ({ res, finalUrl: current, redirectChain } = await followRedirects({
          start: parsed,
          dispatcher,
          signal: bound.signal,
          onDispatcher: (next) => {
            const previous = dispatcher;
            dispatcher = next;
            previous?.close?.().catch(() => {});
          },
        }));
      } finally {
        timings.headers_ms = Math.round(performance.now() - hopStart);
      }

      const finalUrl = current;
      const chain = redirectChain.length ? { redirect_chain: redirectChain } : {};
      const contentType = res.headers.get('content-type') || '';
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, url: finalUrl, status: res.status, error: `HTTP ${res.status}`, ...chain };
      if (/image|video|audio|font|zip|octet-stream/.test(contentType)) {
        return { ok: false, url: finalUrl, status: res.status, error: `unsupported content-type: ${contentType}`, ...chain };
      }

      const bodyStart = performance.now();
      const { text: body, truncated } = await readLimited(res, config.fetcher.maxBytes, bound.signal);
      timings.body_ms = Math.round(performance.now() - bodyStart);
      const extractStart = performance.now();
      const isHtml = /html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
      const extracted = isHtml
        ? extractArticle(body, finalUrl)
        : {
            title: parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname,
            published_at: null,
            author: null,
            description: null,
            text: body.slice(0, maxChars),
            paragraphs: body.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40),
          };
      timings.extract_ms = Math.round(performance.now() - extractStart);

      return {
        ok: extracted.text.length > 0,
        url: finalUrl,
        final_url: finalUrl,
        ...chain,
        status: res.status,
        content_type: contentType,
        truncated,
        fetched_at: new Date().toISOString(),
        ...extracted,
        error: extracted.text.length ? null : 'no extractable text',
      };
    }).catch((err) => ({
      ok: false,
      url: parsed.toString(),
      status: null,
      // A cancelled fetch says nothing about the host. Recording it as a
      // failure would let a run that ended early trip the breaker for every
      // later run against that host.
      aborted: err?.name === 'AbortError' || err?.code === 'ABORT_ERR',
      error: err.code === 'circuit_open' ? `host temporarily skipped: ${err.message}` : err.message,
    })),
    recorder,
    // Cache successful reads only; a 503 or a timeout must not stick for hours.
    (value) => value.ok === true,
  );

  return { ...value, cached: wasCached, duration_ms: at(), timings };
  } finally {
    // Sockets are per-dispatcher, so one left open per fetch is a leak.
    dispatcher?.close?.().catch(() => {});
    bound.release();
  }
}

/** Bounded-concurrency fetch of several URLs. */
export async function fetchPages(urls, opts = {}) {
  const limit = opts.concurrency || config.fetcher.concurrency;
  const results = [];
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        results.push(await fetchPage(url, opts));
      } catch (err) {
        log.warn('fetch_failed', { url, err: err.message });
        results.push({ ok: false, url, error: err.message });
      }
    }
  });
  await Promise.all(workers);
  return results;
}
