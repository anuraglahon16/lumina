import * as cheerio from 'cheerio';
import { config } from '../../../shared/config.js';
import { cached } from '../cache.js';
import { createLogger } from '../../../shared/logger.js';
import { breaker } from '../../../shared/circuitBreaker.js';

const log = createLogger('search');

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

function normalize(results, provider) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r?.url) continue;
    let url;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    // Strip tracking params so the same page caches as the same key.
    for (const p of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_?src)/i.test(p)) url.searchParams.delete(p);
    }
    url.hash = '';
    const clean = url.toString();
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      title: (r.title || url.hostname).trim().slice(0, 300),
      url: clean,
      domain: url.hostname.replace(/^www\./, ''),
      snippet: (r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      published_at: r.published_at || null,
      provider,
    });
  }
  return out;
}

const providers = {
  async tavily(query, limit) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.search.tavilyKey}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false }),
      signal: timeoutSignal(config.search.timeoutMs),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return normalize(
      (json.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, published_at: r.published_date })),
      'tavily',
    );
  },

  async brave(query, limit) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': config.search.braveKey },
      signal: timeoutSignal(config.search.timeoutMs),
    });
    if (!res.ok) throw new Error(`brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return normalize(
      (json.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description, published_at: r.age })),
      'brave',
    );
  },

  async serper(query, limit) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': config.search.serperKey },
      body: JSON.stringify({ q: query, num: limit }),
      signal: timeoutSignal(config.search.timeoutMs),
    });
    if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return normalize(
      (json.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, published_at: r.date })),
      'serper',
    );
  },

  async searxng(query, limit) {
    const url = new URL('/search', config.search.searxngUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const res = await fetch(url, { signal: timeoutSignal(config.search.timeoutMs) });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const json = await res.json();
    return normalize(
      (json.results || []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content, published_at: r.publishedDate })),
      'searxng',
    );
  },

  /**
   * Keyless fallback so the agent still works with no search key configured.
   * Best-effort HTML scrape: rate-limited and lower quality. The run log marks
   * results with this provider so evaluation can account for it.
   */
  async duckduckgo(query, limit) {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // The HTML endpoint serves an empty results page to obvious bot
        // user-agents. This is the keyless fallback path only; every keyed
        // provider identifies itself honestly via its API key.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
      signal: timeoutSignal(config.search.timeoutMs),
    });
    if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
    const html = await res.text();
    if (/anomaly|unusual traffic|captcha/i.test(html.slice(0, 4000))) throw new Error('duckduckgo rate limited this client');

    const $ = cheerio.load(html);
    const results = [];
    $('.result, .web-result').each((_, el) => {
      if (results.length >= limit) return;
      const a = $(el).find('a.result__a').first();
      let href = a.attr('href');
      if (!href) return;
      if (href.startsWith('//')) href = `https:${href}`;
      try {
        // Older responses wrap outbound links as /l/?uddg=<encoded>; newer ones
        // link directly. Handle both.
        const parsed = new URL(href, 'https://duckduckgo.com');
        href = parsed.searchParams.get('uddg') || parsed.toString();
      } catch {
        return;
      }
      results.push({ title: a.text(), url: href, snippet: $(el).find('.result__snippet').text() });
    });
    return normalize(results, 'duckduckgo');
  },
};

/**
 * What each provider last actually did.
 *
 * Health could only say which provider was *configured*, which is a claim about
 * an environment variable, not about search working. A key that is present but
 * rejected looks identical to a key that works, right up until every answer
 * comes back with no sources. This records the outcome so the difference is
 * visible before a user has to notice it.
 */
const providerHealth = new Map();

function noteProvider(name, outcome) {
  providerHealth.set(name, { ...outcome, at: new Date().toISOString() });
}

export function searchHealth() {
  return Object.fromEntries(providerHealth);
}

/** Provider order: explicit choice, else best available key, else keyless. */
export function resolveProviders() {
  if (config.search.provider !== 'auto') return [config.search.provider];
  const order = [];
  if (config.search.tavilyKey) order.push('tavily');
  if (config.search.braveKey) order.push('brave');
  if (config.search.serperKey) order.push('serper');
  if (config.search.searxngUrl) order.push('searxng');
  order.push('duckduckgo');
  return order;
}

/**
 * Run a web search with caching and provider failover.
 * Returns { results, provider, cached, degraded }.
 */
export async function webSearch(query, { limit = config.search.resultsPerQuery, recorder } = {}) {
  const trimmed = query.trim().slice(0, 400);
  if (!trimmed) return { results: [], provider: null, cached: false, degraded: false };

  const order = resolveProviders();
  const { value, cached: wasCached } = await cached(
    'search',
    { q: trimmed.toLowerCase(), limit, order: order[0] },
    config.cache.searchTtlMs,
    async () => {
      const errors = [];
      for (const name of order) {
        const provider = providers[name];
        if (!provider) {
          errors.push(`${name}: unknown provider`);
          continue;
        }
        try {
          // One breaker per provider. The fallback chain already tries the next
          // provider on failure, but without this it retries the dead one first
          // every single time, paying its timeout on every search.
          const results = await breaker(`search:${name}`, {
            failureThreshold: 3,
            cooldownMs: 60000,
          }).run(() => provider(trimmed, limit));
          if (results.length) {
            noteProvider(name, { ok: true, results: results.length });
            return { results, provider: name, errors };
          }
          noteProvider(name, { ok: true, results: 0 });
          errors.push(`${name}: 0 results`);
        } catch (err) {
          log.warn('search_provider_failed', { provider: name, err: err.message });
          noteProvider(name, { ok: false, error: String(err.message).slice(0, 160) });
          errors.push(`${name}: ${err.message}`);
        }
      }
      return { results: [], provider: null, errors };
    },
    recorder,
    // Never memoize a search that found nothing. The next attempt deserves a
    // real try rather than a cached failure.
    (value) => value.results.length > 0,
  );

  return {
    results: value.results,
    provider: value.provider,
    cached: wasCached,
    degraded: value.provider === 'duckduckgo',
    provider_errors: value.errors || [],
  };
}
