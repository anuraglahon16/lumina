import { config } from '../../shared/config.js';

/**
 * What happened to every candidate, from the query to the citation.
 *
 * A run that answers badly can fail in eight different places: the query found
 * nothing relevant, something relevant ranked below what was tried, a good
 * candidate was never attempted, a good page would not load, coverage declared
 * itself satisfied and cancelled the pages carrying the rest of the answer, the
 * page loaded but what was extracted did not carry the answer, the evidence
 * arrived and the answer ignored it, or the answer used it and cited it
 * wrongly. The end state looks alike in most of those — a thin answer, or an
 * honest refusal — and the repairs are completely different.
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
  COVERAGE_MISS: 'coverage_miss',
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
        // Identity belongs to the occurrence, not to the url. The same page
        // comes back from two searches at two ranks, and a fetch that
        // rediscovers "which row has this url" can only ever find the first
        // one — which silently attributes every rescue fetch to the original
        // search and makes any claim about ranking meaningless.
        candidate_id: `search_${this.searches.length + 1}_rank_${i + 1}`,
        search_attempt: this.searches.length + 1,
        rank: i + 1,
        title: r.title ?? null,
        url: r.url ?? null,
        snippet: r.snippet ?? null,
      })),
    });
    return this.searches.at(-1);
  }

  /** Every result occurrence, across every search. */
  get candidates() {
    return this.searches.flatMap((s) => s.results);
  }

  /** The occurrence with this id, if it is one this funnel recorded. */
  candidate(candidateId) {
    return this.candidates.find((c) => c.candidate_id === candidateId) ?? null;
  }

  /**
   * A candidate passed over before it was ever tried.
   *
   * Recorded where it happens rather than inferred later: "not attempted" and
   * "attempted and failed" are different questions with different answers, and
   * so are "skipped because a sibling page shares its publisher" and "never
   * reached because the budget ran out".
   */
  deduplicated({ candidateId = null, url, reason, keptUrl = null }) {
    const c = candidateId ? this.candidate(candidateId) : null;
    this.deduplications.push({
      candidate_id: candidateId,
      search_attempt: c?.search_attempt ?? null,
      rank: c?.rank ?? null,
      url,
      reason,
      kept_url: keptUrl,
    });
  }

  attempted({ candidateId = null, url }) {
    const c = candidateId ? this.candidate(candidateId) : null;
    const event = {
      event_id: `fetch_${this.fetch_events.length + 1}`,
      candidate_id: candidateId,
      search_attempt: c?.search_attempt ?? null,
      rank: c?.rank ?? null,
      url: url ?? c?.url ?? null,
      status: 'attempted',
    };
    this.fetch_events.push(event);
    return event;
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
  fetched({ eventId = null, candidateId = null, url }, { status, httpStatus, durationMs, chars, admitted, reason, passages, excerpt }) {
    // Found by the event it belongs to, never by scanning for a matching url.
    const target =
      (eventId && this.fetch_events.find((e) => e.event_id === eventId)) ||
      (candidateId && [...this.fetch_events].reverse().find((e) => e.candidate_id === candidateId && e.status === 'attempted')) ||
      this.attempted({ candidateId, url });
    target.status = status;
    target.http_status = httpStatus ?? null;
    target.duration_ms = durationMs ?? null;
    target.extracted_chars = chars ?? null;
    target.admitted_as_evidence = Boolean(admitted);
    target.reason = reason ?? null;
    if (passages?.length) target.extracted_passages = passages;
    // Kept for a page that read but gave too little: ninety characters of
    // navigation furniture, a paywall notice and a partially useful extraction
    // all look identical as a number, and want different answers.
    if (excerpt) target.extracted_excerpt = excerpt;
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
 * Each stage asks for exactly the judgement it needs, and asks only once the
 * run has actually reached it. A question whose search returned nothing
 * relevant needs no opinion about its answer, and demanding one would leave
 * every such row unreviewable.
 *
 * A required judgement left null returns `pending_review`. That matters more
 * than it looks: "I have not decided" and "no" are different, and letting the
 * missing one fall through to a category manufactures a confident label out of
 * a reviewer's silence. The earlier version required only `relevant_urls` and
 * would happily reach `successful_retrieval` with every other field unfilled.
 *
 * Precedence, not flags: a run whose search found nothing relevant also cites
 * nothing, and counting it twice makes twenty runs produce forty outcomes.
 */
export function classifyRetrieval(funnel, { citedSentences = 0, supportedSentences = 0, review = null } = {}) {
  const pending = (why) => ({ primary: RETRIEVAL_OUTCOME.PENDING_REVIEW, flags: [why], reviewed: false });
  const done = (primary, note) => ({ primary, flags: note ? [note] : [], reviewed: true });
  const decided = (v) => typeof v === 'boolean';

  if (!funnel) return pending('no funnel was recorded');
  if (!review || !Array.isArray(review.relevant_urls)) {
    return pending('no relevance review; which results were relevant cannot be derived from the run');
  }

  const candidates = funnel.candidates ?? [];
  const events = funnel.fetch_events ?? [];

  // A url in the review that is not in the results is not evidence that the
  // search failed; it is evidence that the review is wrong about this run. A
  // mistyped or carried-over url would otherwise match nothing and be reported
  // as a query miss, manufacturing a search failure out of a typo.
  const known = new Set(candidates.map((c) => c.url));
  const unknown = review.relevant_urls.filter((u) => !known.has(u));
  if (unknown.length) {
    throw new Error(
      `the review names ${unknown.length} url(s) that this run never returned: ${unknown.slice(0, 3).join(', ')}. ` +
        'A url absent from the results cannot be judged relevant to them.',
    );
  }

  const relevant = candidates.filter((c) => review.relevant_urls.includes(c.url));

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

  // A relevant page read in full. Whether what was extracted carried the answer
  // is a question only someone who read the passages can settle.
  if (!decided(review.extracted_passages_contain_answer)) {
    return pending('a relevant page was read; whether its extracted passages carry the answer has not been decided');
  }
  if (review.extracted_passages_contain_answer === false) {
    // Two very different failures reach this point, and the repairs share
    // nothing.
    //
    // One is extraction: the right page was read in full and what came out of
    // it was a table of contents. Query-aware passage selection fixes that.
    //
    // The other is the coverage rule stopping too early. A page answering half
    // the question satisfied it, and the pool aborted the pages carrying the
    // other half while they were still in flight. Passage selection cannot fix
    // that, because the text it would select from was never read — the
    // component at fault is the one that declared the evidence sufficient.
    //
    // They are told apart by what happened to the *other* relevant candidates:
    // relevant pages cancelled under a coverage stop mean the run had the
    // evidence in its hands and let go of it.
    const cancelledRelevant = relevant.filter((c) => attemptsFor(c.url).some((e) => e.status === 'cancelled'));
    const stoppedOnCoverage = funnel.stop_reason === 'coverage_sufficient';

    // Both conditions hold more often than they look like they would, and a
    // live probe caught this: the TLS run reproduced with two relevant pages
    // cancelled under a coverage stop *and* an extraction that returned a
    // navigation menu from a nineteen-thousand-character page. Coverage
    // cancelling losers is what the pool does on every healthy run, so its
    // presence is not evidence of anything on its own.
    //
    // What separates them is whether the page that was read gave up what it
    // contained. If extraction returned the page's actual content and the
    // content was only half the answer, the run stopped too early. If
    // extraction returned headings from a page with the answer in it, the
    // gathering was fine and the reading was not.
    //
    // A reviewer can see that by comparing the extracted passages against the
    // page, and nothing in the funnel can. So it is asked for, and only here —
    // where the ambiguity is real. Where no relevant page was cancelled there
    // is nothing to confuse, and the question is not asked.
    if (cancelledRelevant.length && stoppedOnCoverage) {
      if (!decided(review.extraction_faithful)) {
        return pending(
          'a relevant page was read and relevant pages were cancelled by a coverage stop; ' +
            'whether extraction represented the page it read has not been decided, and that is what separates a coverage miss from a passage miss',
        );
      }
      if (review.extraction_faithful) {
        return done(
          RETRIEVAL_OUTCOME.COVERAGE_MISS,
          `extraction was faithful and coverage cancelled ${cancelledRelevant.length} relevant page(s) still in flight`,
        );
      }
    }
    return done(RETRIEVAL_OUTCOME.PASSAGE_MISS, 'the page was read and the extracted passages did not carry the answer');
  }

  if (!decided(review.answer_addressed_question) || !decided(review.answer_complete)) {
    return pending('evidence reached the answer; whether it addressed the question, and fully, has not been decided');
  }

  if (review.answer_addressed_question === false) {
    return done(RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION, 'relevant evidence reached the ledger and the answer did not address the question');
  }

  if (review.answer_complete === false) {
    // Addressed but partial. Not a success: the evidence was there and part of
    // the question went unanswered, which is the same failure as ignoring it,
    // in a smaller quantity.
    return done(RETRIEVAL_OUTCOME.SYNTHESIS_OMISSION, 'the answer addressed the question but omitted a required part');
  }

  if (citedSentences === 0) {
    // The answer was written, addressed the question and covered it. What is
    // missing is the citing, and calling that a synthesis failure would send
    // work at the part that did its job.
    return done(RETRIEVAL_OUTCOME.CITATION_FAILURE, 'the complete answer contains no cited sentences');
  }

  if (supportedSentences < citedSentences) {
    return done(RETRIEVAL_OUTCOME.CITATION_FAILURE, `${citedSentences - supportedSentences} of ${citedSentences} cited sentences unsupported`);
  }

  return done(RETRIEVAL_OUTCOME.SUCCESSFUL_RETRIEVAL, null);
}
