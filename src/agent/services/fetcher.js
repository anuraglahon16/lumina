import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { config } from '../../shared/config.js';
import { deadlineSignal } from '../core/budget.js';
import { cached } from './cache.js';
import { createLogger } from '../../shared/logger.js';
import { breaker } from '../../shared/circuitBreaker.js';

const log = createLogger('fetcher');

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower === '::';
}

/**
 * The agent fetches URLs the model chose, so every fetch is an SSRF risk.
 * Scheme allowlist + DNS resolution + private-range rejection before any request.
 */
async function assertFetchable(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`blocked scheme: ${parsed.protocol}`);
  if (BLOCKED_HOST.test(parsed.hostname)) throw new Error(`blocked host: ${parsed.hostname}`);
  if (net.isIP(parsed.hostname) && isPrivateAddress(parsed.hostname)) throw new Error('blocked private address');
  const addrs = await dns.lookup(parsed.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`dns failure for ${parsed.hostname}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('host resolves to a private address');
  return parsed;
}

const robotsCache = new Map();

async function robotsAllows(parsed) {
  if (!config.fetcher.respectRobots) return true;
  const origin = parsed.origin;
  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      (async () => {
        try {
          const res = await fetch(`${origin}/robots.txt`, {
            headers: { 'user-agent': config.fetcher.userAgent },
            signal: AbortSignal.timeout(5000),
          });
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
  const rules = await robotsCache.get(origin);
  const path = parsed.pathname + parsed.search;
  // Longest-match wins, as per the robots.txt convention.
  let best = null;
  for (const rule of rules) {
    if (path.startsWith(rule.path) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  return !best || best.type === 'allow';
}

/** Strip chrome and pull the main readable text out of an HTML document. */
function extractArticle(html, url) {
  const $ = cheerio.load(html);
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
    title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
    published_at: published,
    author,
    description,
    text: paragraphs.join('\n\n').slice(0, config.fetcher.maxChars),
    paragraphs,
  };
}

/** Read the body with a hard byte ceiling so one huge page can't exhaust memory. */
async function readLimited(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
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
 * Fetch one URL and return cleaned, citable evidence.
 * Cached by URL, so repeated runs over the same source cost nothing.
 */
export async function fetchPage(url, { recorder, maxChars = config.fetcher.maxChars, signal } = {}) {
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);
  // Where the time inside one fetch actually goes. Without this, a slow page is
  // just slow; with it, a slow resolver and a slow server and a heavy document
  // are three different problems with three different answers.
  const timings = { resolve_ms: null, robots_ms: null, headers_ms: null, body_ms: null, extract_ms: null };

  const resolveStart = performance.now();
  const parsed = await assertFetchable(url);
  timings.resolve_ms = Math.round(performance.now() - resolveStart);

  const robotsStart = performance.now();
  const allowed = await robotsAllows(parsed);
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
    // A cancellation is this system changing its mind, not the host failing.
    // Counting it would let a run that found its evidence early trip the
    // breaker for every later run against that host.
    countsAsFailure: (err) => !(err?.name === 'AbortError' || err?.code === 'ABORT_ERR'),
  });

  const { value, cached: wasCached } = await cached(
    'fetch',
    { url: parsed.toString(), maxChars },
    config.cache.fetchTtlMs,
    async () => hostBreaker.run(async () => {
      // The caller's cancellation and this fetch's own timeout, composed. Without
      // the caller's, a page kept being read after the answer it was for had
      // already been given up on — and on a coverage-driven pool that is most
      // of the requests in flight.
      const bound = deadlineSignal(config.fetcher.timeoutMs, signal);
      let res;
      const headersStart = performance.now();
      try {
        res = await fetch(parsed, {
          headers: {
            'user-agent': config.fetcher.userAgent,
            accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5',
            'accept-language': 'en',
          },
          redirect: 'follow',
          signal: bound.signal,
        });
      } finally {
        timings.headers_ms = Math.round(performance.now() - headersStart);
        bound.release();
      }

      const contentType = res.headers.get('content-type') || '';
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, url: res.url || parsed.toString(), status: res.status, error: `HTTP ${res.status}` };
      if (/image|video|audio|font|zip|octet-stream/.test(contentType)) {
        return { ok: false, url: res.url, status: res.status, error: `unsupported content-type: ${contentType}` };
      }

      const bodyStart = performance.now();
      const { text: body, truncated } = await readLimited(res, config.fetcher.maxBytes);
      timings.body_ms = Math.round(performance.now() - bodyStart);
      const extractStart = performance.now();
      const isHtml = /html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
      const extracted = isHtml
        ? extractArticle(body, res.url || parsed.toString())
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
        url: res.url || parsed.toString(),
        final_url: res.url,
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
