import { config } from '../../shared/config.js';

/**
 * What happened to every candidate, from the query to the citation.
 *
 * A run that answers badly can fail in seven different places: the query found
 * nothing relevant, something relevant ranked below what was tried, a good
 * candidate was never attempted, a good page would not load, the page loaded
 * but what was extracted did not carry the answer, the evidence arrived and the
 * answer ignored it, or the answer used it and cited it wrongly. The end state
 * looks alike in most of those — a thin answer, or an honest refusal — and the
 * repairs are completely different.
 *
 * This records the path. It is observation only: off by default, and with it on
 * nothing is searched, fetched or asked of a model that the run was not already
 * doing.
 *
 * Two things it deliberately does not do.
 *
 * It does not decide relevance. Whether a result was the one that would have
 * answered the question is a judgement, and the lexical score here is a weak
 * proxy. Classification without a relevance annotation returns `pending_review`
 * rather than a plausible guess — a guess would have filed an honest refusal to
 * use irrelevant pages as a synthesis failure, and sent work at synthesis when
 * the search was at fault.
 *
 * And search results are never modified after they are recorded. The same URL
 * can come back from two searches at two ranks; writing a fetch outcome onto
 * "the first row with this URL" loses which query produced the attempt. Fetches
 * are their own events, naming the search and rank they came from.
 */

export const RETRIEVAL_OUTCOME = {
  PENDING_REVIEW: 'pending_review',
  QUERY_MISS: 'query_miss',
  RANKING_MISS: 'ranking_miss',
  SELECTION_MISS: 'selection_miss',
  FETCH_FAILURE: 'fetch_failure',
  PASSAGE_MISS: 'passage_miss',
  SYNTHESIS_OMISSION: 'synthesis_omission',
  CITATION_FAILURE: 'citation_failure',
  SUCCESSFUL_RETRIEVAL: 'successful_retrieval',
};

export const tracingEnabled = () => config.diagnostics?.trace === true;

/** A funnel when tracing is on, and nothing at all when it is not. */
export function createFunnel({ question, enabled = tracingEnabled() } = {}) {
  if (!enabled) return null;
  return new Funnel(question);
}

class Funnel {
  constructor(question) {
    this.original_question = question ?? null;
    this.effective_question = null; // set only when a rewrite changed it
    /** Immutable once recorded. */
    this.searches = [];
    /** Every attempt, naming where it came from. */
    this.fetch_events = [];
    /** Every candidate passed over, and why. */
    this.deduplications = [];
    this.coverage_events = [];
    this.stop_reason = null;
  }

  rewrote(effective) {
    if (effective && effective !== this.original_question) this.effective_question = effective;
  }

  search({ query, provider, cached, durationMs, results, error }) {
    this.searches.push({
      attempt: this.searches.length + 1,
      query,
      provider: provider ?? null,
      cached: Boolean(cached),
      duration_ms: durationMs ?? null,
      ...(error ? { error } : {}),
      results: (results ?? []).map((r, i) => ({
        rank: i + 1,
        title: r.title ?? null,
        url: r.url ?? null,
        snippet: r.snippet ?? null,
      })),
    });
    return this.searches.at(-1);
  }

  /** Where a url sits: which search returned it, and at what rank. */
  locate(url) {
    for (const s of this.searches) {
      const hit = s.results.find((r) => r.url === url);
      if (hit) return { search_attempt: s.attempt, rank: hit.rank };
    }
    return { search_attempt: null, rank: null };
  }

  /** Every result across every search, flattened, for counting. */
  get candidates() {
    return this.searches.flatMap((s) => s.results.map((r) => ({ ...r, search_attempt: s.attempt })));
  }

  /**
   * A candidate passed over before it was ever tried.
   *
   * Recorded where it happens rather than inferred later: "not attempted" and
   * "attempted and failed" are different questions with different answers, and
   * so are "skipped because a sibling page shares its publisher" and "never
   * reached because the budget ran out".
   */
  deduplicated({ url, reason, keptUrl = null }) {
    const where = this.locate(url);
    this.deduplications.push({ ...where, url, reason, kept_url: keptUrl });
  }

  attempted({ url }) {
    const where = this.locate(url);
    this.fetch_events.push({ ...where, url, status: 'attempted', at: this.fetch_events.length + 1 });
    return this.fetch_events.at(-1);
  }

  /**
   * How an attempt ended.
   *
   * A cancellation is kept apart from a failure. The pool aborts its losers on
   * every successful run, so counting those as failures would make a healthy
   * system look like one whose fetches mostly fail.
   *
   * `passages` is the text that was actually extracted, kept for every usable
   * page including ones nothing ended up citing — that is precisely the set a
   * reviewer needs to tell an irrelevant page from a relevant page whose
   * extraction missed the answer.
   */
  fetched(url, { status, httpStatus, durationMs, chars, admitted, reason, passages }) {
    const event = [...this.fetch_events].reverse().find((e) => e.url === url && e.status === 'attempted');
    const target = event ?? this.attempted({ url });
    target.status = status;
    target.http_status = httpStatus ?? null;
    target.duration_ms = durationMs ?? null;
    target.extracted_chars = chars ?? null;
    target.admitted_as_evidence = Boolean(admitted);
    target.reason = reason ?? null;
    if (passages?.length) target.extracted_passages = passages;
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
      fetch_events: this.fetch_events,
      deduplications: this.deduplications,
      coverage_events: this.coverage_events,
      stop_reason: this.stop_reason,
    };
  }
}

/**
 * The one thing that went wrong, or that nothing did.
 *
 * Requires a review: which results were relevant, and whether the answer
 * actually addressed the question. Neither is derivable from what the run
 * recorded. Without them this returns `pending_review`, because the plausible
 * guesses available here are wrong in a specific and expensive direction — a
 * search returning pages about something else, followed by an answer that
 * honestly declines to use them, looks exactly like the answer ignoring good
 * evidence, and would send work at synthesis when the fault was the query.
 *
 * Precedence, not flags: a run whose search found nothing relevant also cites
 * nothing, and counting it in both places makes twenty runs produce forty
 * outcomes and no way to read them.
 */
export function classifyRetrieval(funnel, { citedSentences = 0, supportedSentences = 0, review = null } = {}) {
  if (!funnel) return { primary: RETRIEVAL_OUTCOME.PENDING_REVIEW, flags: ['no funnel was recorded'], reviewed: false };
  if (!review || !Array.isArray(review.relevant_urls)) {
    return {
      primary: RETRIEVAL_OUTCOME.PENDING_REVIEW,
      flags: ['no relevance review; which results were relevant cannot be derived from the run'],
      reviewed: false,
    };
  }

  const candidates = funnel.candidates ?? [];
  const events = funnel.fetch_events ?? [];
  const relevant = candidates.filter((c) => review.relevant_urls.includes(c.url));
  const done = (primary, note) => ({ primary, flags: note ? [note] : [], reviewed: true });

  if (!relevant.length) {
    return done(RETRIEVAL_OUTCOME.QUERY_MISS, candidates.length ? 'no relevant url among the results' : 'the search returned nothing');
  }

  const attemptsFor = (url) => events.filter((e) => e.url === url);
  const attemptedRelevant = relevant.filter((c) => attemptsFor(c.url).length > 0);

  if (!attemptedRelevant.length) {
    const deepest = Math.max(0, ...events.map((e) => e.rank ?? 0));
    const best = Math.min(...relevant.map((c) => c.rank));
    return best > deepest
      ? done(RETRIEVAL_OUTCOME.RANKING_MISS, `the best relevant result is rank ${best}; nothing past rank ${deepest} was tried`)
      : done(RETRIEVAL_OUTCOME.SELECTION_MISS, `a relevant result at rank ${best} was inside the tried range and passed over`);
  }

  const usableRelevant = attemptedRelevant.filter((c) => attemptsFor(c.url).some((e) => e.status === 'usable'));
  if (!usableRelevant.length) {
    // A cancelled loser is not a failure — unless it was the only relevant page
    // and nothing else supplied the evidence.
    const onlyCancelled = attemptedRelevant.every((c) => attemptsFor(c.url).every((e) => e.status === 'cancelled'));
    return done(
      RETRIEVAL_OUTCOME.FETCH_FAILURE,
      onlyCancelled ? 'the only relevant page was cancelled before any other supplied evidence' : 'every relevant page attempted failed or read too thin',
    );
  }

  // The page read in full. Did what was extracted carry the answer? Only a
  // reviewer can say, having read the passages the record keeps.
  if (review.relevant_evidence_reached_ledger === false) {
    return done(RETRIEVAL_OUTCOME.PASSAGE_MISS, 'the page was read and the extracted passages did not carry the answer');
  }

  if (review.answer_addressed_question === false) {
    return done(RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION, 'relevant evidence reached the ledger and the answer did not address the question');
  }

  if (citedSentences === 0) {
    return done(RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION, 'evidence was available and nothing was cited');
  }

  if (supportedSentences < citedSentences) {
    return done(RETRIEVAL_OUTCOME.CITATION_FAILURE, `${citedSentences - supportedSentences} of ${citedSentences} cited sentences unsupported`);
  }

  return done(RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL, null);
}
