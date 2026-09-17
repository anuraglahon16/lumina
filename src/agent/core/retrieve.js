import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { webSearch } from '../services/search/index.js';
import { fetchPage } from '../services/fetcher.js';
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
function trace(emit, recorder, { tool, input, ok, ms, reason, error, cached = false, meta }) {
  emit?.('tool_call', { tool, input });
  emit?.('tool_result', { tool, ok, duration_ms: ms, summary: reason, detail: error, cached });
  recorder?.recordToolCall({ name: tool, input, durationMs: ms, ok, summary: reason, error, cached, meta });
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
export async function gatherFromWeb({ query, ledger, budget, recorder, emit, signal, pages = 2, deadlineMs }) {
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
      cached: Boolean(found.cached),
    });
  } catch (err) {
    trace(emit, recorder, { tool: 'web_search', input: { query: searchQuery }, ok: false, ms: Math.round(performance.now() - t0), error: err.message });
    log.warn('deterministic_search_failed', { err: err.message });
    return { searched: true, coverage: assessCoverage(query, ledger.citable), reason: err.message };
  }

  const coverage = await fetchUntilCovered({
    query,
    searchQuery,
    candidates: choosePages(results, { limit: 8 }),
    ledger,
    budget,
    recorder,
    emit,
    signal,
    target: pages,
    deadlineMs: deadlineMs ?? config.budgets.quick.retrievalCeilingMs,
  });

  return { searched: true, coverage, candidates: results };
}

/**
 * Read pages until the evidence covers the question, then stop.
 *
 * Not "first page that returns something": a fetch can succeed and yield a
 * hundred and fifty characters of navigation furniture, and accepting that as
 * the answer's evidence is how a run ends up with sources it cannot cite. The
 * condition is coverage, reassessed after each page that actually arrives.
 *
 * Several fetches are in flight at once and each is handled as it lands, so a
 * slow page delays only itself. When one fails or comes back thin, the next
 * unused candidate is started — the first search already produced six or more
 * leads, and searching again for the same thing would return the same list.
 *
 * It remains one search and one retrieval phase. Nothing here consults a model.
 */
async function fetchUntilCovered({ query, searchQuery, candidates, ledger, budget, recorder, emit, signal, target, deadlineMs }) {
  const bound = deadlineSignal(deadlineMs, signal);
  const queue = [...candidates];
  const inFlight = new Map();
  const attempted = new Set();
  let usable = 0;
  let coverage = assessCoverage(query, ledger.citable);

  const start = (candidate, rank) => {
    if (!candidate || attempted.has(candidate.url)) return;
    if (!budget.allows('fetch_page').ok) return;
    attempted.add(candidate.url);
    ledger.attempted?.add(candidate.url);
    budget.consume('fetch_page');
    const began = performance.now();
    const promise = fetchPage(candidate.url, { recorder, signal: bound.signal })
      .catch((err) => ({ ok: false, url: candidate.url, error: err.message, aborted: err?.name === 'AbortError' }))
      .then((page) => ({ page, candidate, rank, waited: Math.round(performance.now() - began) }));
    inFlight.set(candidate.url, promise);
  };

  // Open the pool. More at once than the answer needs, because roughly half of
  // all fetches return nothing usable and waiting to discover that serially is
  // what made the tail long.
  const poolSize = Math.min(config.budgets.quick.fetchConcurrency, queue.length);
  for (let i = 0; i < poolSize; i += 1) start(queue.shift(), i + 1);

  try {
    while (inFlight.size) {
      const { page, candidate, rank, waited } = await Promise.race(inFlight.values());
      inFlight.delete(candidate.url);

      const readable = page?.ok && (page.text?.length ?? 0) >= config.budgets.quick.minPageChars;
      if (readable) {
        ledger.addWebSource(page, { query: searchQuery });
        usable += 1;
      } else if (!page?.aborted) {
        // Nothing citable came of it, so it returns the slot it took.
        budget.refund?.('fetch_page', page?.error || 'too little readable text');
      }

      trace(emit, recorder, {
        tool: 'fetch_page',
        input: { url: candidate.url },
        ok: Boolean(readable),
        // The page's own time, not the batch's. Copying a batch elapsed time
        // onto every member proves only that the batch waited for its slowest.
        ms: page?.duration_ms ?? waited,
        reason: readable ? `read ${page.text.length} characters` : undefined,
        error: readable ? undefined : page?.error || `only ${page?.text?.length ?? 0} characters extracted`,
        cached: Boolean(page?.cached),
        meta: { candidate_rank: rank, attempt: attempted.size, timings: page?.timings ?? null, aborted: Boolean(page?.aborted) },
      });

      if (readable) {
        coverage = assessCoverage(query, ledger.citable);
        if (coverage.ok && usable >= Math.min(target, 1)) break;
      }

      if (bound.signal.aborted) break;
      // Replace what did not work with a lead not yet tried.
      if (inFlight.size + usable < target + 1) start(queue.shift(), attempted.size + 1);
    }
  } finally {
    // Whatever is still running is no longer wanted; aborting stops the work
    // rather than merely ignoring it, and the ledger cannot be mutated after
    // the answer has moved on.
    bound.release();
    for (const promise of inFlight.values()) promise.catch(() => {});
  }

  return assessCoverage(query, ledger.citable);
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
 * One more attempt, when the first pass found nothing citable.
 *
 * The first search already returned six or more leads and only some were tried,
 * so this reaches for the ones that were not. Repeating the same normalised
 * search would return the same list, and re-fetching the same URLs would fail
 * the same way — a round trip spent to reproduce a result already in hand.
 *
 * A fresh search happens only when there is genuinely nothing left: the first
 * search returned nothing, or every candidate it produced has been tried.
 *
 * It is one more bounded attempt, not a loop, and no model is consulted.
 */
export async function rescueRetrieval({ query, route, ledger, budget, recorder, emit, userId, spaceId, signal, candidates = [] }) {
  const bound = deadlineSignal(config.budgets.quick.rescueCeilingMs, signal);
  try {
    if (route === 'documents') {
      const terms = contentTerms(query);
      return await gatherFromDocuments({ query: terms, ledger, budget, recorder, emit, userId, spaceId, signal: bound.signal });
    }

    const untried = choosePages(candidates, { limit: 8 }).filter((c) => !ledger.byUrl?.has(c.url) && !triedUrls(ledger).has(c.url));
    if (untried.length) {
      const coverage = await fetchUntilCovered({
        query,
        searchQuery: searchQueryFor(query),
        candidates: untried,
        ledger,
        budget,
        recorder,
        emit,
        signal: bound.signal,
        target: 2,
        deadlineMs: config.budgets.quick.rescueCeilingMs,
      });
      return { searched: false, coverage, reused_candidates: untried.length };
    }

    // Nothing left to try, so a different search is the only move available.
    return await gatherFromWeb({
      query: contentTerms(query),
      ledger,
      budget,
      recorder,
      emit,
      signal: bound.signal,
      pages: 2,
      deadlineMs: config.budgets.quick.rescueCeilingMs,
    });
  } catch (err) {
    log.warn('rescue_failed', { err: err.message });
    return { searched: true, coverage: assessCoverage(query, ledger.citable) };
  } finally {
    bound.release();
  }
}

/** The question's content words, for when its phrasing was the problem. */
function contentTerms(query) {
  return searchQueryFor(query)
    .replace(/[?!.]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8)
    .join(' ');
}

/** Every URL this run has already attempted, successfully or not. */
function triedUrls(ledger) {
  const tried = new Set();
  for (const s of ledger.sources || []) if (s.url) tried.add(s.url);
  for (const url of ledger.attempted || []) tried.add(url);
  return tried;
}
