/**
 * Tools whose failure yields no evidence at all, so charging them a full slot
 * spends the budget on nothing. A blocked aggregator (HTTP 403, robots.txt) is
 * the common case.
 */
const REFUNDABLE_TOOLS = new Set(['fetch_page', 'web_search']);

/**
 * A cancellation that fires when `remainingMs` elapses, composed with a
 * caller's own signal so whichever comes first wins.
 *
 * The timer is owned rather than borrowed from `AbortSignal.timeout`, whose
 * handle is unref'd: it does not hold the event loop open, so a process with
 * nothing else pending can settle before the deadline it is relying on.
 * `release()` clears it, so a call that returns normally leaves nothing behind.
 */
export function deadlineSignal(remainingMs, outer, onExpire) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    onExpire?.();
    controller.abort(new Error('wall_clock_exceeded'));
  }, Math.max(0, remainingMs));

  // The caller's signal is forwarded by hand rather than composed with
  // `AbortSignal.any`. The composite it returns keeps its link to the source
  // signals weakly, and a synthesis call was observed running for 864 seconds
  // under a 390-second ceiling that never fired: the deadline existed, held
  // nothing, and was collected. One owned controller cannot be collected out
  // from under the request it is bounding.
  const forward = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
}

/**
 * Hard execution limits. The model is told about these, but it is the harness
 * that enforces them: every counter is checked before a tool runs and the loop
 * exits with a named termination reason the user is shown.
 */
export class Budget {
  constructor(limits, { label = 'run' } = {}) {
    this.limits = limits;
    this.label = label;
    this.deadline = Date.now() + limits.wallClockMs;
    this.counts = { tool_calls: 0, searches: 0, fetches: 0, doc_searches: 0, iterations: 0 };
    this.capped = null;
    // Refunds are themselves capped, so a site that fails in a novel way each
    // time cannot buy unlimited retries.
    this.maxRefunds = limits.maxRefunds ?? 3;
    this.refunds = [];
  }

  get remainingMs() {
    return Math.max(0, this.deadline - Date.now());
  }

  /**
   * The run's wall clock, as a cancellation for one model call.
   *
   * The counters are checked between iterations, which bounds how many calls a
   * run makes but not how long one of them takes. That gap was not theoretical:
   * a single research call ran for 773 seconds inside a budget of 60, the loop
   * had no opportunity to notice, and the run reported `completed`. A limit the
   * harness only enforces between calls is not a limit on the run.
   */
  deadlineSignal(outer) {
    return deadlineSignal(this.remainingMs, outer, () => this.#cap('wall_clock_exceeded'));
  }

  /** Did this budget's own wall clock cause the abort, rather than the caller? */
  expired() {
    return this.remainingMs === 0;
  }

  /** Why the run must stop, or null if it may continue. */
  checkStop() {
    if (this.capped) return this.capped;
    if (Date.now() >= this.deadline) return this.#cap('wall_clock_exceeded');
    if (this.counts.iterations >= this.limits.maxIterations) return this.#cap('max_iterations_reached');
    if (this.counts.tool_calls >= this.limits.maxToolCalls) return this.#cap('max_tool_calls_reached');
    return null;
  }

  /** Whether one specific tool call is still affordable. */
  allows(toolName) {
    if (this.counts.tool_calls >= this.limits.maxToolCalls) return { ok: false, reason: 'max_tool_calls_reached' };
    if (Date.now() >= this.deadline) return { ok: false, reason: 'wall_clock_exceeded' };
    if (toolName === 'web_search' && this.limits.maxSearches !== undefined && this.counts.searches >= this.limits.maxSearches) {
      return { ok: false, reason: 'max_searches_reached' };
    }
    if (toolName === 'fetch_page' && this.counts.fetches >= this.limits.maxFetches) {
      return { ok: false, reason: 'max_fetches_reached' };
    }
    return { ok: true };
  }

  consume(toolName) {
    this.counts.tool_calls += 1;
    if (toolName === 'web_search') this.counts.searches += 1;
    if (toolName === 'fetch_page') this.counts.fetches += 1;
    if (toolName === 'search_documents') this.counts.doc_searches += 1;
  }

  /**
   * Give back the slot taken by a tool call that returned no evidence.
   *
   * A 403 and a page yielding eight citable passages cost the same slot under
   * plain counting, which lets two blocked aggregators truncate an otherwise
   * healthy run. Refunding keeps the cap meaningful, since it still bounds *useful*
   * work, while not charging the user for a door that was closed.
   *
   * Deliberately never refunded: the wall clock. A failed fetch really did
   * consume time, so the deadline is the floor that terminates the loop no
   * matter how many refunds are granted. Iterations are not refunded either,
   * for the same reason: the model still took a turn.
   *
   * @returns {boolean} whether a slot was actually returned.
   */
  refund(toolName, reason = null) {
    if (!REFUNDABLE_TOOLS.has(toolName)) return false;
    if (this.refunds.length >= this.maxRefunds) return false;
    if (this.counts.tool_calls <= 0) return false;

    this.counts.tool_calls -= 1;
    if (toolName === 'web_search') this.counts.searches = Math.max(0, this.counts.searches - 1);
    if (toolName === 'fetch_page') this.counts.fetches = Math.max(0, this.counts.fetches - 1);
    this.refunds.push({ tool: toolName, reason });
    return true;
  }

  nextIteration() {
    this.counts.iterations += 1;
  }

  #cap(reason) {
    this.capped = reason;
    return reason;
  }

  markCapped(reason) {
    return this.#cap(reason);
  }

  snapshot() {
    return {
      label: this.label,
      limits: this.limits,
      used: { ...this.counts },
      refunded: this.refunds.length,
      remaining: {
        tool_calls: Math.max(0, this.limits.maxToolCalls - this.counts.tool_calls),
        fetches: Math.max(0, this.limits.maxFetches - this.counts.fetches),
        searches: this.limits.maxSearches === undefined ? null : Math.max(0, this.limits.maxSearches - this.counts.searches),
        iterations: Math.max(0, this.limits.maxIterations - this.counts.iterations),
        wall_clock_ms: this.remainingMs,
      },
      capped: this.capped,
    };
  }
}

/** Human-readable cap explanation shown in the UI and written to the run log. */
export const CAP_REASONS = {
  max_tool_calls_reached: 'the tool-call limit',
  max_fetches_reached: 'the page-fetch limit',
  max_searches_reached: 'the search limit',
  max_iterations_reached: 'the reasoning-turn limit',
  wall_clock_exceeded: 'the time limit',
  max_tokens: 'the output token limit',
};
