import { config } from '../../shared/config.js';

/**
 * What happened to every candidate, from the query to the citation.
 *
 * A run that answers badly can fail in seven different places: the query found
 * nothing relevant, something relevant ranked below what was tried, a good
 * candidate was never attempted, a good page would not load, the page loaded
 * but the needed passage was not in what was extracted, the evidence arrived
 * and the answer ignored it, or the answer used it and cited it wrongly. The
 * end state looks similar in most of those cases — a thin answer, or an honest
 * refusal — and the repairs are completely different.
 *
 * This records the path so the difference is visible. It is observation only:
 * off by default, no extra searches, no extra fetches, no model calls, nothing
 * requested that the run was not already requesting. With it off, a run is
 * exactly what it was before and carries nothing extra.
 *
 * What it cannot do is decide relevance. Whether a result was the one that
 * would have answered the question is a judgement, and the lexical score
 * available here is a weak proxy for it. Every relevance label is marked
 * provisional and every input to it is kept, so the rows that matter can be
 * read rather than trusted.
 */

export const RETRIEVAL_OUTCOME = {
  QUERY_MISS: 'query_miss',
  RANKING_MISS: 'ranking_miss',
  SELECTION_MISS: 'selection_miss',
  FETCH_FAILURE: 'fetch_failure',
  PASSAGE_MISS: 'passage_miss',
  SYNTHESIS_OMISSION: 'synthesis_omission',
  CITATION_FAILURE: 'citation_failure',
  SUCCESSFUL_RETRIEVAL: 'successful_retrieval',
};

/** In precedence order: the earliest thing that went wrong is the outcome. */
const PRECEDENCE = [
  RETRIEVAL_OUTCOME.QUERY_MISS,
  RETRIEVAL_OUTCOME.RANKING_MISS,
  RETRIEVAL_OUTCOME.SELECTION_MISS,
  RETRIEVAL_OUTCOME.FETCH_FAILURE,
  RETRIEVAL_OUTCOME.PASSAGE_MISS,
  RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION,
  RETRIEVAL_OUTCOME.CITATION_FAILURE,
  RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL,
];

export const tracingEnabled = () => config.diagnostics?.trace === true;

/** A funnel when tracing is on, and nothing at all when it is not. */
export function createFunnel({ question, enabled = tracingEnabled() } = {}) {
  if (!enabled) return null;
  return new Funnel(question);
}

class Funnel {
  constructor(question) {
    this.original_question = question ?? null;
    this.effective_question = null; // only set when a rewrite actually happened
    this.searches = [];
    this.coverage_events = [];
    this.stop_reason = null;
  }

  /** A rewrite, recorded only when it changed the question. */
  rewrote(effective) {
    if (effective && effective !== this.original_question) this.effective_question = effective;
  }

  search({ query, provider, cached, durationMs, results, error }) {
    const record = {
      query,
      provider: provider ?? null,
      attempt: this.searches.length + 1,
      cached: Boolean(cached),
      duration_ms: durationMs ?? null,
      ...(error ? { error } : {}),
      results: (results ?? []).map((r, i) => ({
        rank: i + 1,
        title: r.title ?? null,
        url: r.url ?? null,
        snippet: r.snippet ?? null,
        deduplicated: false,
        deduplication_reason: null,
        fetch_attempted: false,
        fetch_status: null,
        fetch_duration_ms: null,
        http_status: null,
        extracted_chars: null,
        selected_as_evidence: false,
        selection_reason: null,
      })),
    };
    this.searches.push(record);
    return record;
  }

  /** Every result, across every search, as one list to look things up in. */
  get candidates() {
    return this.searches.flatMap((s) => s.results);
  }

  find(url) {
    return this.candidates.find((r) => r.url === url) ?? null;
  }

  /** A candidate passed over before anything was attempted. */
  deduplicated(url, reason) {
    const row = this.find(url);
    if (row) {
      row.deduplicated = true;
      row.deduplication_reason = reason;
    }
  }

  attempted(url) {
    const row = this.find(url);
    if (row) row.fetch_attempted = true;
  }

  /**
   * How a fetch ended.
   *
   * A cancellation is kept apart from a failure. The pool aborts its losers on
   * every successful run, so counting those as failures would make a healthy
   * system look like one whose fetches mostly fail.
   */
  fetched(url, { status, httpStatus, durationMs, chars, selected, reason }) {
    const row = this.find(url);
    if (!row) return;
    row.fetch_attempted = true;
    row.fetch_status = status;
    row.http_status = httpStatus ?? null;
    row.fetch_duration_ms = durationMs ?? null;
    row.extracted_chars = chars ?? null;
    row.selected_as_evidence = Boolean(selected);
    row.selection_reason = reason ?? null;
  }

  coverage({ afterUrl, sufficient, reasons }) {
    this.coverage_events.push({ after_url: afterUrl ?? null, sufficient: Boolean(sufficient), reasons: reasons ?? [] });
  }

  stopped(reason) {
    this.stop_reason = reason;
  }

  toJSON() {
    return {
      original_question: this.original_question,
      ...(this.effective_question ? { effective_question: this.effective_question } : {}),
      searches: this.searches,
      coverage_events: this.coverage_events,
      stop_reason: this.stop_reason,
    };
  }
}

/**
 * The one thing that went wrong, or that nothing did.
 *
 * Precedence rather than a set of flags: a run whose search found nothing
 * relevant will also have no citations, and counting it in both places makes
 * twenty runs produce forty outcomes and no way to read them. Secondary
 * observations are kept alongside, so nothing is lost by choosing one.
 *
 * `relevantUrls` is the caller's judgement about which candidates could have
 * answered the question. Where it is absent the classification falls back to
 * what the run did, and says so.
 */
export function classifyRetrieval(funnel, { citedSentences = 0, supportedSentences = 0, evidenceCount = 0, relevantUrls = null } = {}) {
  const candidates = funnel?.candidates ?? [];
  const flags = [];

  if (!candidates.length) {
    return { primary: RETRIEVAL_OUTCOME.QUERY_MISS, flags: ['no results returned'], provisional: true };
  }

  // Relevance, when the caller has an opinion about it. Without one, every
  // candidate is treated as possibly relevant, which makes query_miss and
  // ranking_miss unavailable rather than guessed at.
  const known = Array.isArray(relevantUrls);
  const relevant = known ? candidates.filter((c) => relevantUrls.includes(c.url)) : null;

  if (known) {
    if (!relevant.length) return { primary: RETRIEVAL_OUTCOME.QUERY_MISS, flags: ['no relevant candidate in the results'], provisional: true };

    const attemptedAny = relevant.some((c) => c.fetch_attempted);
    if (!attemptedAny) {
      // Below what was tried, or inside the pool and passed over. The
      // difference is whether anything ranked lower was attempted.
      const deepestAttempt = Math.max(0, ...candidates.filter((c) => c.fetch_attempted).map((c) => c.rank));
      const bestRelevantRank = Math.min(...relevant.map((c) => c.rank));
      const primary = bestRelevantRank > deepestAttempt ? RETRIEVAL_OUTCOME.RANKING_MISS : RETRIEVAL_OUTCOME.SELECTION_MISS;
      return {
        primary,
        flags: [`best relevant candidate at rank ${bestRelevantRank}; deepest attempt rank ${deepestAttempt}`],
        provisional: true,
      };
    }

    const usable = relevant.filter((c) => c.fetch_status === 'usable');
    if (!usable.length) {
      const cancelled = relevant.some((c) => c.fetch_status === 'cancelled');
      return {
        primary: RETRIEVAL_OUTCOME.FETCH_FAILURE,
        flags: [cancelled ? 'the relevant page was cancelled rather than failing' : 'every relevant page that was attempted failed'],
        provisional: true,
      };
    }

    if (!usable.some((c) => c.selected_as_evidence)) {
      return { primary: RETRIEVAL_OUTCOME.PASSAGE_MISS, flags: ['the page was read but produced no usable passage'], provisional: true };
    }
  }

  // From here the question is what happened to evidence that did arrive.
  if (evidenceCount === 0) {
    const attempted = candidates.filter((c) => c.fetch_attempted);
    if (!attempted.length) return { primary: RETRIEVAL_OUTCOME.SELECTION_MISS, flags: ['results were returned and none were attempted'], provisional: true };
    const anyUsable = attempted.some((c) => c.fetch_status === 'usable');
    return {
      primary: anyUsable ? RETRIEVAL_OUTCOME.PASSAGE_MISS : RETRIEVAL_OUTCOME.FETCH_FAILURE,
      flags: [anyUsable ? 'pages were read but nothing became evidence' : 'no attempted page produced readable text'],
      provisional: true,
    };
  }

  if (citedSentences === 0) {
    return { primary: RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION, flags: [`${evidenceCount} source(s) available and nothing cited`], provisional: false };
  }

  if (supportedSentences < citedSentences) {
    flags.push(`${citedSentences - supportedSentences} of ${citedSentences} cited sentences unsupported`);
    return { primary: RETRIEVAL_OUTCOME.CITATION_FAILURE, flags, provisional: false };
  }

  return { primary: RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL, flags, provisional: false };
}

export { PRECEDENCE as RETRIEVAL_PRECEDENCE };
