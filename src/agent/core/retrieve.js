import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { webSearch } from '../services/search/index.js';
import { fetchPages } from '../services/fetcher.js';
import { searchChunks } from '../services/ragStore.js';
import { assessCoverage } from './coverage.js';
import { deadlineSignal } from './budget.js';

const log = createLogger('retrieve');

/**
 * Retrieval the harness performs itself, before any model is asked anything.
 *
 * A question routed to the web needs a web search. That was never in doubt, and
 * discovering it cost a model turn, then discovering which pages to read cost
 * another, and concluding that enough had been read cost a third — three round
 * trips, all of them ahead of the first token the reader sees, none of them
 * deciding anything a rule could not.
 *
 * So the obvious retrieval happens here. The model still chooses everything
 * that genuinely needs judgement: whether this evidence answers the question,
 * what to say about it, and — when coverage comes back short — what else to
 * look for, through the ordinary research loop. What has been removed is only
 * the ceremony in front of the search.
 *
 * Nothing here relaxes the evidence rules. A page becomes citable by being
 * fetched and read, exactly as before; search results are still leads.
 */

/**
 * Record a retrieval step, to the stream and to the run log both.
 *
 * Retrieval performed by the harness is still retrieval: it has to appear in
 * the trace the reader sees and in the log the evaluation reads. Emitting only
 * to the stream left run records showing an answer with no tool calls at all,
 * which reads as a model answering from memory — the precise thing this system
 * exists to make impossible.
 */
function trace(emit, recorder, { tool, input, ok, ms, reason, error, cached = false }) {
  emit?.('tool_call', { tool, input });
  emit?.('tool_result', { tool, ok, duration_ms: ms, summary: reason, detail: error, cached });
  recorder?.recordToolCall({ name: tool, input, durationMs: ms, ok, summary: reason, error, cached });
}

/**
 * A search query from the user's own question.
 *
 * Deliberately close to what they typed. A model rewriting this is a round trip
 * spent to produce something a search engine would have handled anyway, and it
 * makes the cache key depend on the model's mood rather than on the question.
 */
export function searchQueryFor(query) {
  return String(query ?? '')
    .replace(/^\s*(?:can you|could you|please|i want to know|tell me|do you know)\b[,\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Pick the pages worth reading.
 *
 * One per publisher, because two pages from one site are one witness and the
 * fetch budget is small. Order is the search engine's — it is better at
 * relevance than any reordering available here without reading the pages first.
 */
export function choosePages(results, { limit = 2 } = {}) {
  const chosen = [];
  const seen = new Set();
  for (const r of results || []) {
    if (!r?.url) continue;
    let host;
    try {
      host = new URL(r.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const publisher = host.split('.').slice(-2).join('.');
    if (seen.has(publisher)) continue;
    seen.add(publisher);
    chosen.push(r);
    if (chosen.length === limit) break;
  }
  return chosen;
}

/**
 * Search once, read the best pages concurrently, and report what was gathered.
 *
 * Returns coverage rather than a verdict, so the caller decides whether to
 * synthesise or hand the question to the research loop with the evidence
 * already in hand — the loop continues from here rather than starting over.
 */
export async function gatherFromWeb({ query, ledger, budget, recorder, emit, signal, pages = 2 }) {
  const searchQuery = searchQueryFor(query);

  const allowed = budget.allows('web_search');
  if (!allowed.ok) return { searched: false, coverage: assessCoverage(query, ledger.citable), reason: allowed.reason };

  let results = [];
  const t0 = performance.now();
  try {
    budget.consume('web_search');
    const found = await webSearch(searchQuery, { recorder, signal });
    results = found.results || [];
    ledger.noteCandidates(results);
    trace(emit, recorder, {
      tool: 'web_search',
      input: { query: searchQuery },
      ok: true,
      ms: Math.round(performance.now() - t0),
      reason: `${results.length} results`,
    });
  } catch (err) {
    trace(emit, recorder, { tool: 'web_search', input: { query: searchQuery }, ok: false, ms: Math.round(performance.now() - t0), error: err.message });
    log.warn('deterministic_search_failed', { err: err.message });
    return { searched: true, coverage: assessCoverage(query, ledger.citable), reason: err.message };
  }

  const picks = choosePages(results, { limit: pages }).filter((r) => budget.allows('fetch_page').ok);
  if (!picks.length) return { searched: true, coverage: assessCoverage(query, ledger.citable), reason: 'nothing worth fetching' };

  // Concurrently: two pages read one after the other is two round trips for
  // evidence neither depends on.
  for (const _ of picks) budget.consume('fetch_page');
  const started = performance.now();
  const fetched = await fetchPages(picks.map((p) => p.url), { recorder, signal });

  // Matched by url, not by position: fetchPages resolves concurrently and
  // pushes in completion order, so index i is whichever page came back first.
  const byUrl = new Map(fetched.map((page) => [page?.url, page]));
  for (const pick of picks) {
    const page = byUrl.get(pick.url) ?? fetched.find((f) => f?.final_url === pick.url);
    const ms = Math.round(performance.now() - started);
    if (page?.ok && page.text) {
      ledger.addWebSource(page, { query: searchQuery });
      trace(emit, recorder, { tool: 'fetch_page', input: { url: pick.url }, ok: true, ms, reason: `read ${page.text.length} characters` });
    } else {
      // A fetch that yielded nothing bought no evidence, so it returns its slot.
      budget.refund?.('fetch_page', page?.error || 'no readable text');
      trace(emit, recorder, { tool: 'fetch_page', input: { url: pick.url }, ok: false, ms, error: page?.error || 'no readable text' });
    }
  }

  return { searched: true, coverage: assessCoverage(query, ledger.citable) };
}

/**
 * Search the Space's documents directly.
 *
 * A document question has exactly one sensible first move, and asking a model
 * to discover it costs a round trip in front of an answer that is already in
 * hand. If the first search comes back thin, one broader search follows before
 * the question goes to the loop.
 */
export async function gatherFromDocuments({ query, ledger, budget, recorder, emit, userId, spaceId, signal }) {
  const run = async (q, label) => {
    const allowed = budget.allows('search_documents');
    if (!allowed.ok) return [];
    budget.consume('search_documents');
    const t0 = performance.now();
    try {
      const { results } = await searchChunks(q, { userId, spaceId, recorder, signal });
      for (const chunk of results) ledger.addDocumentSource(chunk);
      trace(emit, recorder, {
        tool: 'search_documents',
        input: { query: q },
        ok: true,
        ms: Math.round(performance.now() - t0),
        reason: `${results.length} passages${label ? ` (${label})` : ''}`,
      });
      return results;
    } catch (err) {
      trace(emit, recorder, { tool: 'search_documents', input: { query: q }, ok: false, ms: Math.round(performance.now() - t0), error: err.message });
      return [];
    }
  };

  await run(query, null);
  let coverage = assessCoverage(query, ledger.citable, { minPublishers: 1 });

  if (!coverage.ok) {
    // One broader attempt: the question's content words alone, which reaches
    // passages phrased differently from the question.
    const broadened = searchQueryFor(query).replace(/[?!.]/g, '').split(/\s+/).slice(0, 12).join(' ');
    if (broadened && broadened !== query) {
      await run(broadened, 'broadened');
      coverage = assessCoverage(query, ledger.citable, { minPublishers: 1 });
    }
  }

  return { searched: true, coverage };
}

export const QUICK_PAGES = () => config.budgets.quick.deterministicPages ?? 2;

/**
 * One more attempt, when the first found nothing at all.
 *
 * Not a research loop and not a model call: a question that returned nothing
 * usually returned nothing because the phrasing was unlucky, so this searches
 * the question's content words instead of its sentence. It runs once, inside a
 * strict deadline, and whatever it finds is what the answer is written from.
 *
 * The distinction from "incomplete" matters. Incomplete evidence can still be
 * answered honestly. No evidence cannot be answered at all, which is the one
 * case worth spending another round trip on.
 */
export async function rescueRetrieval({ query, route, ledger, budget, recorder, emit, userId, spaceId, signal }) {
  const bound = deadlineSignal(config.budgets.quick.rescueCeilingMs, signal);
  const terms = searchQueryFor(query)
    .replace(/[?!.]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' ');

  try {
    if (route === 'documents') {
      return await gatherFromDocuments({ query: terms, ledger, budget, recorder, emit, userId, spaceId, signal: bound.signal });
    }
    return await gatherFromWeb({ query: terms, ledger, budget, recorder, emit, signal: bound.signal, pages: 2 });
  } catch (err) {
    log.warn('rescue_failed', { err: err.message });
    return { searched: true, coverage: assessCoverage(query, ledger.citable) };
  } finally {
    bound.release();
  }
}
