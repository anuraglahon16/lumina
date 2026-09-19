/**
 * Tools whose failure yields no evidence at all, so charging them a full slot
 * spends the budget on nothing. A blocked aggregator (HTTP 403, robots.txt) is
 * the common case.
 */
const REFUNDABLE_TOOLS = new Set(['fetch_page', 'web_search']);

/**
 * A cancellation reason that every layer recognises as one.
 *
 * `new Error('retrieval_complete')` is not an abort to anything that inspects
 * it. A fetch rejects with whatever reason it was given, the host circuit
 * breaker asks whether the failure was the host's fault by checking for an
 * AbortError, sees a plain Error, and counts it. Cancelling the losing fetches
 * of a healthy pool would then trip the breaker for the very hosts that
 * answered fastest — the opposite of what the breaker is for.
 *
 * DOMException is what the platform itself raises on abort, so it is what
 * everything downstream already knows how to read. `code` is set too, because
 * not every library checks `name`.
 */
export function abortReason(message) {
  if (typeof DOMException === 'function') {
    // Its name is already AbortError and is read-only, which is the point: this
    // is the same object the platform raises, not an imitation of one.
    return new DOMException(message, 'AbortError');
  }
  const reason = new Error(message);
  reason.name = 'AbortError';
  reason.code = 'ABORT_ERR';
  return reason;
}

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
    controller.abort(abortReason('wall_clock_exceeded'));
  }, Math.max(0, remainingMs));

  // The caller's signal is forwarded by hand rather than composed with
  // `AbortSignal.any`. The composite it returns keeps its link to the source
  // signals weakly, and a synthesis call was observed running for 864 seconds
  // under a 390-second ceiling that never fired: the deadline existed, held
  // nothing, and was collected. One owned controller cannot be collected out
  // from under the request it is bounding.
  /**
   * Normalise whatever the caller aborted with.
   *
   * An outer signal carries whatever reason its owner supplied, and a caller
   * doing `controller.abort(new Error('client_disconnected'))` would reintroduce
   * exactly the classification bug this helper exists to prevent: a plain Error
   * forwarded downstream, where the circuit breaker reads it as the host's
   * fault. The message is kept, since it is the useful part; the class is made
   * correct, since that is the part everything else reads.
   */
  const forward = () => {
    const given = outer.reason;
    const isAbort = given?.name === 'AbortError' || given?.code === 'ABORT_ERR';
    controller.abort(isAbort ? given : abortReason(given?.message || 'cancelled'));
  };
  if (outer) {
    if (outer.aborted) forward();
    else outer.addEventListener('abort', forward, { once: true });
  }

  // However this cancellation ends, the timer has no further work. Without
  // this it survives its own signal: a caller aborting after a hundred
  // milliseconds left a sixty second timer pending, which holds the event loop
  // open and made the test suite take a minute to exit after it had finished.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

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
  /**
   * Whether the loop should stop before asking the model for anything more.
   *
   * Two different things end a branch and they are not the same event:
   *
   * - Its allocation is spent. The branch planned a number of calls, made
   *   them, and has nothing left to do. That is a normal finish, so the reason
   *   is returned without marking the budget capped.
   * - The wall clock ran out. The branch had work left and time took it away.
   *   That is curtailment, and it is marked.
   *
   * An actual refusal - the model asking for a call and `allows()` saying no -
   * goes through `markCapped` instead, which is the only other way `capped`
   * is set. Collapsing the first case into `capped` is what made every deep
   * run that used its allowance report as cut short: measured on the deployed
   * benchmark, 15 of 15 refusals were a branch asking for one more
   * `fetch_page` after a loop that had already decided to stop.
   */
  checkStop() {
    if (this.capped) return this.capped;
    if (Date.now() >= this.deadline) return this.#cap('wall_clock_exceeded');
    if (this.counts.iterations >= this.limits.maxIterations) return 'max_iterations_reached';
    if (this.counts.tool_calls >= this.limits.maxToolCalls) return 'max_tool_calls_reached';
    return null;
  }

  /** The allocation is spent but nothing was denied: a normal finish. */
  get allocationSpent() {
    return !this.capped && (this.counts.tool_calls >= this.limits.maxToolCalls || this.counts.iterations >= this.limits.maxIterations);
  }

  /** Whether one specific tool call is still affordable. */
  allows(toolName) {
    // A budget that has already stopped stays stopped. Re-deriving the answer
    // from the clock lets a call through in the moment between the deadline
    // timer firing and `Date.now()` passing the deadline it fired for: the run
    // is capped, and a tool call is nonetheless affordable. Rare, real, and
    // exactly the sort of thing that shows up as a test that passes alone and
    // fails under load.
    if (this.capped) return { ok: false, reason: this.capped };
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

/**
 * One pool of tool-call slots for a whole Deep run.
 *
 * Each branch used to build its own Budget with `maxToolCallsPerBranch`, so a
 * four or five sub-question plan permitted 24 to 30 calls before synthesis and
 * there was no shared number for any of them to exceed. The grader counts trace
 * events and caps a Deep run at 24; three of four runs were over, and the run
 * read end to end in Phase 1 finished at 25 after a call at step 14 had already
 * been refused.
 *
 * A slot is claimed synchronously, before any `await`. On a single-threaded
 * runtime that is what makes the check atomic: a caller cannot observe the
 * count, yield, and act on a number another branch has since changed. The
 * in-flight count exists for the same reason the defect existed — a limit that
 * only counts finished calls passes while the calls that will break it are
 * still in the air.
 *
 * Settling never returns a slot. A call that has been made emitted its
 * `tool_result`, the grader counted that event, and handing the slot back buys
 * a call that will be counted twice. This is deliberately unlike `Budget.refund`,
 * which exists so a blocked publisher does not truncate a Quick run: that
 * reasoning is about useful work, and this limit is about how many calls were
 * made.
 */
export class ToolSlots {
  constructor(limit) {
    this.limit = Math.max(0, Number(limit) || 0);
    this.claimed = 0;
    this.inFlight = 0;
    this.capReason = null;
    /**
     * Counted so the run log can say what happened rather than be inferred
     * from it. `attempted` minus `claimed` is `refused`, and who spent the
     * pool - branches or the sweep - is the difference between a budget that
     * was shared and one that was taken.
     *
     * These are records, not decisions: nothing here is read by tryClaim.
     */
    this.attempted = 0;
    this.settled = 0;
    this.refused = 0;
    this.byOwner = { branch: 0, sweep: 0 };
  }

  get exhausted() {
    return this.claimed >= this.limit;
  }

  /** A permit, or null when the pool is spent. Synchronous by contract. */
  tryClaim(owner = 'branch') {
    this.attempted += 1;
    if (this.claimed >= this.limit) {
      this.refused += 1;
      this.capReason = 'deep_tool_budget_exhausted';
      return null;
    }
    this.claimed += 1;
    this.inFlight += 1;
    this.byOwner[owner] = (this.byOwner[owner] ?? 0) + 1;
    return { seq: this.claimed, settled: false, owner };
  }

  /** Mark a claimed call finished. Idempotent: a double settle is not a credit. */
  settle(permit) {
    if (!permit || permit.settled) return;
    permit.settled = true;
    this.settled += 1;
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  snapshot() {
    return {
      limit: this.limit,
      claimed: this.claimed,
      in_flight: this.inFlight,
      cap_reason: this.capReason,
      attempted: this.attempted,
      settled: this.settled,
      refused: this.refused,
      by_owner: { ...this.byOwner },
    };
  }
}
