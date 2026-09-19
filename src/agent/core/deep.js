import { config } from '../../shared/config.js';
import { Budget, ToolSlots, CAP_REASONS, deadlineSignal } from './budget.js';
import { validatePlan, fallbackPlan, repairInstruction, PLAN_ORIGIN } from './plan.js';
import { EvidenceLedger } from './evidence.js';
import { RunRecorder } from '../store/runLog.js';
import { runResearchLoop } from './researchLoop.js';
import { synthesizeAnswer } from './synthesize.js';
import { extractMemories } from './memoryExtractor.js';
import { summarizeRun } from './quick.js';
import { complete, textOf, parseJsonLoose } from './llm.js';
import { plannerSystem, branchSystem } from './prompts.js';
import { searchMemories } from '../services/memoryStore.js';
import { ensureThread, appendMessage, threadContext } from '../services/threads.js';
import { documentStats } from '../services/ragStore.js';
import { fetchPage } from '../services/fetcher.js';
import { resolveProviders } from '../services/search/index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('deep');

/**
 * Deep Search: plan → parallel branch research → cross-branch evidence sweep →
 * merged synthesis.
 *
 * Deliberately a separate code path from Quick mode. It has its own budgets,
 * its own prompts, and its own phases; Quick can never turn into it and it can
 * never silently degrade into Quick.
 */
export async function runDeepQuery({
  query,
  userId,
  threadId,
  requestId,
  emit,
  signal,
  // Where the answer should come from, and which Space if it is documents.
  // Quick has honoured these since the contract arrived; Deep accepted the
  // request and researched the open web regardless, so a Deep question asked
  // against an uploaded Space was answered from somewhere else entirely.
  retrievalMode = 'auto',
  spaceId = null,
  // Forwarded to the tool executor so a Deep test can drive the real
  // orchestration - real ledger writes, real deduplication - without touching
  // the network. Production passes neither.
  webSearch: webSearchFn = null,
  fetchPage: fetchPageFn = null,
  // Injected the way the research loop's are, and for the same reason: the
  // orchestration here — does it plan before retrieving, does every branch get
  // its own budget, is one branch's failure survivable — is the part that broke
  // in practice, and none of it is about what a model actually says. Without a
  // seam the only way to exercise this function is a live run, which is how a
  // `budget is not defined` reached a benchmark with the suite green.
  /**
   * Defaults to null, not to `complete`.
   *
   * It used to default to the imported non-streaming `complete`, which made
   * `completeFn ? { streamComplete: completeFn } : {}` always true: production
   * handed synthesis a function that cannot stream, so a Deep answer was
   * generated, stored and never sent to the reader. Quick, which overrides
   * nothing, streamed normally.
   */
  complete: completeFn = null,
  // Synthesis has its own seam. A test that wants deterministic streaming
  // supplies this; production supplies neither and gets the real one.
  streamComplete: streamFn = null,
  executor,
} = {}) {
  const completeImpl = completeFn ?? complete;
  const limits = config.budgets.deep;
  const deadline = Date.now() + limits.wallClockMs;
  const ledger = new EvidenceLedger();
  const recorder = new RunRecorder({ requestId, userId, threadId, mode: 'deep', query, model: config.llm.deepSynthesisModel });
  const thread = await ensureThread({ threadId, userId, title: query });

  emit('run_start', {
    run_id: recorder.id,
    thread_id: thread.id,
    mode: 'deep',
    query,
    model: config.llm.deepSynthesisModel,
    budget: { limits, deadline_in_ms: limits.wallClockMs },
    search_provider: resolveProviders()[0],
  });


  try {
    // ---- context ----------------------------------------------------------
    recorder.startPhase('context');
    // Three independent reads, so they go together. Sequentially they are three
    // round trips to a remote database in front of a phase the SLA gives four
    // seconds end to end, and none of them depends on another's result.
    const [memories, docs, history] = await Promise.all([
      searchMemories(query, { userId }).catch(() => []),
      documentStats(userId, { spaceId }),
      threadContext(thread.id),
    ]);

    // Recording the question is a write nothing downstream reads, so it is
    // started here and not waited for. It used to run before the context reads
    // purely so that `history` could drop its last entry, which made a
    // bookkeeping write a step on the path to the first thing the user sees.
    const questionRecorded = appendMessage(thread.id, {
      role: 'user',
      content: query,
      run_id: recorder.id,
      mode: 'deep',
    }).catch((err) => log.warn('append_user_message_failed', { run_id: recorder.id, err: err.message }));
    recorder.endPhase('context', { memories: memories.length, documents: docs.indexed });
    if (memories.length) emit('memory_used', { memories });

    // ---- plan -------------------------------------------------------------
    recorder.startPhase('plan');
    const plan = await buildPlan({ query, history, memories, recorder, deadline, signal, complete: completeImpl, emit });
    recorder.endPhase('plan', { sub_questions: plan.sub_questions.length, plan_origin: plan.origin });
    emit('plan', plan);

    // ---- parallel branch research ----------------------------------------
    recorder.startPhase('research');
    // One pool for the whole run. Per-branch budgets remain as a fairness bound
    // so one sub-question cannot spend everything, but this is the number that
    // is actually enforced and the one the grader counts.
    const poolSize = limits.maxToolCallsTotal ?? config.budgets.deep.maxToolCallsTotal;
    const slots = new ToolSlots(poolSize);
    // Decided before any branch runs, so the sweep's capacity is set aside
    // rather than being whatever the branches happen to leave.
    const allocation = allocateDeepBudget({
      total: poolSize,
      branches: plan.sub_questions.length,
      maxPerBranch: limits.maxToolCallsPerBranch,
    });
    // Held back until the sweep is known to be unnecessary, so a borrowing
    // branch cannot spend the capacity a later phase still needs.
    slots.setSweepReserve(allocation.reserve);
    /**
     * Every planned branch is registered before any of them runs.
     *
     * Registering at branch_start looked equivalent and was not:
     * `branchConcurrency` is 3, so a four-question plan leaves q4 unknown to
     * the pool while q1 to q3 are borrowing. Measured on a deployed probe, q4
     * then started with two of its five already lent away and was refused by
     * the pool - borrowing had starved the guarantee it exists to protect.
     */
    for (const sub of plan.sub_questions) slots.registerBranch(sub.id, allocation.perBranch);
    emit('budget_allocated', { total: poolSize, branches: plan.sub_questions.length, per_branch: allocation.perBranch, reserved: allocation.reserve });

    const branchResults = await runBranches({
      complete: completeImpl,
      executor,
      webSearch: webSearchFn,
      fetchPage: fetchPageFn,
      slots,
      allocation,
      retrievalMode,
      spaceId,
      plan,
      ledger,
      recorder,
      emit,
      userId,
      threadId: thread.id,
      runId: recorder.id,
      hasDocuments: docs.indexed > 0,
      limits,
      deadline,
      signal,
    });
    recorder.endPhase('research', {
      branches: branchResults.length,
      sources_after_branches: ledger.sources.length,
    });

    // ---- broader evidence sweep ------------------------------------------
    recorder.startPhase('sweep');
    const swept = await sweepUnreadCandidates({ ledger, recorder, emit, deadline, limits, fetchPage: fetchPageFn, slots, plan });
    recorder.endPhase('sweep', { fetched: swept.length });

    const cappedBranches = branchResults.filter((b) => b.capped);
    const timeExhausted = Date.now() >= deadline;
    const capped = timeExhausted || cappedBranches.length > 0;
    const capReason = timeExhausted
      ? CAP_REASONS.wall_clock_exceeded
      : cappedBranches.length
        ? `${cappedBranches.length} of ${branchResults.length} sub-questions hit ${CAP_REASONS[cappedBranches[0].budget.capped] || 'a branch limit'}`
        : null;

    if (capped) {
      emit('capped', {
        reason: timeExhausted ? 'wall_clock_exceeded' : 'branch_limits_reached',
        explanation: `Deep Search was constrained: ${capReason}. Coverage may be uneven across sub-questions.`,
        branches: branchResults.map((b) => ({ id: b.id, capped: b.capped, reason: b.budget.capped })),
      });
    }

    // ---- merged synthesis -------------------------------------------------
    const { answer, validation, truncated } = await synthesizeAnswer({
      query,
      ledger,
      mode: 'deep',
      capped,
      capReason,
      memories,
      threadContext: history,
      researchNotes: branchResults.map((b) => ({ id: b.id, note: b.summary })),
      plan,
      recorder,
      emit,
      // The one call in a deep run that earns the larger model: merging fifteen
      // sources into an answer that stays honest about what they disagree on.
      model: config.llm.deepSynthesisModel,
      maxTokens: limits.maxTokens,
      effort: limits.effort,
      ceilingMs: limits.synthesisCeilingMs,
      signal,
      // Only when injected. A test may drive synthesis with its own streaming
      // function, or reuse its model fake; production passes neither and keeps
      // the real `streamComplete`.
      ...(streamFn ?? completeFn ? { streamComplete: streamFn ?? completeFn } : {}),
    });

    // The question's write is joined here and nowhere earlier: the thread
    // must not show an answer arriving before the thing it answers.
    await questionRecorded;
    await appendMessage(thread.id, {
      role: 'assistant',
      content: answer,
      run_id: recorder.id,
      mode: 'deep',
      sources: ledger.publicSources(),
      citations: validation.cited,
      capped,
    });


    const stopReason = terminationFor({ truncated, refusedReason: slots.capReason, curtailed: capped });

    // Set before finish(): finish() is what persists the record.
    recorder.set({
      budget: {
        limits,
        branches: branchResults.map((b) => ({ id: b.id, question: b.question, ...b.budget })),
        /**
         * The pool, as it was actually spent.
         *
         * Enough to check the claims that matter without re-deriving them:
         * that nothing exceeded the ceiling, that every claim was settled,
         * that a refusal and a cap agree, and whether the sweep spent from
         * the pool or around it. The last one is the defect this exists to
         * make visible - the sweep used to call the fetcher directly, so runs
         * made 29 to 32 provider calls while the pool recorded 22.
         */
        pool: {
          total_limit: slots.limit,
          reserved: allocation.reserve,
          branch_allocations: Object.fromEntries(plan.sub_questions.map((q) => [q.id, allocation.perBranch])),
          attempted: slots.attempted,
          claimed: slots.claimed,
          settled: slots.settled,
          refused: slots.refused,
          branch_refused: slots.branchRefused,
          borrowed: slots.borrowed,
          branch_claimed: slots.byOwner.branch ?? 0,
          sweep_claimed: slots.byOwner.sweep ?? 0,
          stop_reason: stopReason,
        },
      },
    });
    const run = recorder.finish({
      status: 'ok',
      /**
       * Why the run stopped, which is a different question from whether
       * coverage was even. `capped` above still tells the reader a branch hit
       * its ceiling; this says whether the run was cut short.
       *
       * A per-branch ceiling is a designed fairness bound, not a refusal of the
       * run's work: the sub-question was still researched and synthesised. What
       * curtails a run is the wall clock, the token ceiling, the shared pool
       * refusing a call, or a sub-question that never got researched at all.
       */
      terminationReason: stopReason,
      answer,
      citations: {
        emitted: validation.cited.length + validation.invalid_citations.length,
        valid: validation.cited.length,
        invalid: validation.invalid_citations.length,
        groundedness: validation.groundedness,
      },
      sources: {
        discovered: ledger.sources.length + ledger.candidates.size,
        fetched: ledger.sources.filter((s) => s.type === 'web').length,
        cited: validation.cited.length,
      },
    });

    emit('done', summarizeRun(run, {
      capped,
      capReason,
      sub_questions: plan.sub_questions.length,
      branches: branchResults.map((b) => ({ id: b.id, question: b.question, sources: b.source_count, capped: b.capped })),
    }));

    // ---- long-term memory -------------------------------------------------
    // Extraction is a cheap model call *about the user*, not part of answering
    // them, so it runs after the answer is delivered rather than between the
    // last token and `done`. It used to be awaited here, which added its
    // latency to every single run for a call whose expected outcome is "no
    // memories". Its cost is still recorded, hence the re-persist.
    //
    // Serverless is the exception: the process is frozen the moment it
    // responds, so there the work has to finish before the response does or it
    // never happens at all.
    const extraction = (async () => {
      recorder.startPhase('memory_extraction');
      await extractMemories({ userId, threadId: thread.id, runId: recorder.id, query, answer, recorder, emit });
      recorder.endPhase('memory_extraction');
      recorder.persist();
    })().catch((err) => log.warn('memory_extraction_failed', { run_id: recorder.id, err: err.message }));
    if (config.runtime.serverless) await extraction;

    return { run, answer, sources: ledger.publicSources(), thread_id: thread.id, plan };
  } catch (err) {
    log.error('deep_run_failed', { run_id: recorder.id, err: err.message });
    recorder.recordError('deep_run', err);
    const run = recorder.finish({ status: 'error', terminationReason: 'error' });
    emit('error', { code: err.code || 'agent_error', message: err.message, run_id: run.id });
    emit('done', summarizeRun(run, { error: true }));
    throw err;
  }
}

/**
 * Produce a plan the run can act on: model, then one repair, then the harness.
 *
 * Planning is also the deep run's first paint — nothing is shown until it
 * lands — so it gets a deadline of its own rather than sharing the run's. A
 * planner that hangs past it is treated as a planner that failed, because a
 * deep search showing nothing for thirty seconds reads as broken however good
 * the eventual answer is.
 */
async function buildPlan({ query, history, memories, recorder, deadline, signal, complete: completeFn = complete, emit }) {
  const limits = config.budgets.deep;
  const min = limits.minSubQuestions;
  const max = limits.maxSubQuestions;
  const budgetMs = Math.max(1000, Math.min(limits.planCeilingMs, deadline - Date.now()));
  const bound = deadlineSignal(budgetMs, signal);

  const attempt = async (repair) => {
    const raw = await planCall({
      query,
      history,
      memories,
      recorder,
      signal: bound.signal,
      complete: completeFn,
      repair,
      maxSubQuestions: max,
    });
    return validatePlan(raw, { query, min, max });
  };

  try {
    let result;
    try {
      result = await attempt(null);
    } catch (err) {
      log.warn('plan_call_failed', { err: err.message });
      result = { ok: false, problems: [`the planner call failed: ${err.message}`] };
    }

    if (result.ok) return { ...result.plan, origin: PLAN_ORIGIN.MODEL, degraded: false };

    // One repair, with the problems named. Only worth attempting if there is
    // time left to attempt it in.
    log.warn('plan_invalid', { problems: result.problems.slice(0, 4) });
    // A repair needs time to land in. Starting one with a second left spends a
    // call to be cancelled, and delays the fallback the run will use anyway.
    const REPAIR_NEEDS_MS = 1200;
    if (!bound.signal.aborted && deadline - Date.now() > REPAIR_NEEDS_MS) {
      try {
        const repaired = await attempt(repairInstruction(result.problems, { min, max }));
        if (repaired.ok) {
          recorder.recordWarning('plan', 'plan_repaired', result.problems[0]);
          return { ...repaired.plan, origin: PLAN_ORIGIN.REPAIR, degraded: false };
        }
        result = repaired;
      } catch (err) {
        log.warn('plan_repair_failed', { err: err.message });
      }
    }

    // The harness decomposes it. A degraded run that answers beats a failed one.
    log.warn('plan_fallback', { query: query.slice(0, 120), problems: result.problems?.slice(0, 3) });
    recorder.recordWarning('plan', 'plan_fallback', result.problems?.[0] || 'planner produced no usable plan');
    return { ...fallbackPlan(query, { min, max }), origin: PLAN_ORIGIN.FALLBACK, degraded: true };
  } finally {
    bound.release();
  }
}

async function planCall({ query, history, memories, recorder, signal, complete: completeFn = complete, repair, maxSubQuestions }) {
  const message = await completeFn({
    purpose: repair ? 'plan_repair' : 'plan',
    recorder,
    signal,
    model: config.llm.plannerModel,
    system: plannerSystem({ maxSubQuestions, minSubQuestions: config.budgets.deep.minSubQuestions }),
    messages: [
      {
        role: 'user',
        content: [
          // Trimmed hard. Planning is the run's first paint and every token in
          // front of it is latency the reader waits through; a planner does not
          // need the whole conversation to split one question into parts.
          history.length
            ? `<recent_turns>\n${history.slice(-2).map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n')}\n</recent_turns>\n`
            : '',
          memories.length
            ? `<about_the_user>\n${memories.slice(0, 3).map((m) => `- ${String(m.content).slice(0, 160)}`).join('\n')}\n</about_the_user>\n`
            : '',
          `<question>${query}</question>`,
          repair ? `\n\n${repair}` : '',
        ].join(''),
      },
    ],
    maxTokens: 400,
    effort: 'low',
  });

  return parseJsonLoose(textOf(message));
}

async function runBranches({ plan, ledger, recorder, emit, userId, threadId, runId, hasDocuments, limits, deadline, signal, complete: completeFn, executor, webSearch: webSearchFn = null, fetchPage: fetchPageFn = null, slots = null, allocation = null, retrievalMode = 'auto', spaceId = null }) {
  const queue = [...plan.sub_questions];
  const results = [];

  const worker = async () => {
    while (queue.length) {
      if (Date.now() >= deadline) {
        // Out of time: record the untouched sub-questions instead of dropping them.
        while (queue.length) {
          const skipped = queue.shift();
          emit('branch_skipped', { id: skipped.id, question: skipped.question, reason: 'wall_clock_exceeded' });
          results.push({
            id: skipped.id,
            question: skipped.question,
            summary: 'Not researched: the Deep Search time limit was reached first.',
            capped: true,
            source_count: 0,
            budget: { capped: 'wall_clock_exceeded', used: {}, limits: {} },
          });
        }
        return;
      }
      const sub = queue.shift();
      // A branch is one sub-question, researched against the live web by a
      // model that can fail. Three of them run at once, so one failing is the
      // ordinary case rather than the exceptional one, and letting it reject
      // would throw away everything the other branches had already found and
      // paid for. The failure is recorded as this branch's result, the merged
      // answer is written from what survived, and the run says which part it
      // could not cover.
      try {
        results.push(await runBranch(sub));
      } catch (err) {
        log.warn('branch_failed', { run_id: runId, branch: sub.id, err: err.message });
        recorder.recordError(`branch:${sub.id}`, err);
            slots?.finishBranch(sub.id);
        emit('branch_done', { id: sub.id, question: sub.question, sources: 0, capped: true, termination_reason: 'error', summary: `Not researched: ${err.message}`, budget: null });
        results.push({
          id: sub.id,
          question: sub.question,
          summary: `Not researched: this sub-question failed (${err.message}).`,
          capped: true,
          source_count: 0,
          budget: { capped: 'error', used: {}, limits: {} },
        });
      }
    }
  };

  async function runBranch(sub) {
    const branchBudget = new Budget(
      {
        maxIterations: limits.maxIterationsPerBranch,
        // The allocated share, not the raw ceiling: four branches at the raw
        // ceiling spend the whole pool and leave the sweep nothing.
        maxToolCalls: allocation?.perBranch ?? limits.maxToolCallsPerBranch,
        maxFetches: Math.min(limits.maxFetchesPerBranch, allocation?.perBranch ?? limits.maxFetchesPerBranch),
        maxSearches: allocation?.perBranch ?? limits.maxToolCallsPerBranch,
        // A branch may never outlive the overall Deep Search deadline.
        wallClockMs: Math.max(1000, Math.min(limits.wallClockMs, deadline - Date.now())),
      },
      { label: `branch:${sub.id}` },
    );

    const sourcesBefore = ledger.sources.length;
    emit('branch_start', { id: sub.id, question: sub.question, why: sub.why, budget: branchBudget.snapshot() });

    const result = await runResearchLoop({
      ...(completeFn ? { complete: completeFn } : {}),
      ...(executor ? { executor } : {}),
      ...(webSearchFn ? { webSearch: webSearchFn } : {}),
      ...(fetchPageFn ? { fetchPage: fetchPageFn } : {}),
      slots,
      system: branchSystem({ subQuestion: sub.question, budget: limits, hasDocuments }),
      userMessage: [
        `<sub_question>${sub.question}</sub_question>`,
        sub.search_queries?.length ? `<suggested_queries>${sub.search_queries.join(' | ')}</suggested_queries>` : '',
        `<parent_question>${plan.interpretation}</parent_question>`,
      ]
        .filter(Boolean)
        .join('\n'),
      ledger,
      budget: branchBudget,
      recorder,
      emit,
      userId,
      threadId,
      runId,
      branch: sub.id,
      // Branches are parallel workers with narrow scope and their own budgets,
      // so they are the one place routing trades capability for cost.
      model: config.llm.branchModel,
      maxTokens: config.budgets.deep.researchMaxTokens,
      effort: config.budgets.deep.researchEffort,
      hasDocuments,
      retrievalMode,
      spaceId,
      signal,
    });

    const sourceCount = ledger.sources.length - sourcesBefore;
    const summary = result.notes.join('\n').slice(0, 1500) || 'No findings recorded.';
    // Whatever this branch did not spend is now lendable.
    slots?.finishBranch(sub.id);
    emit('branch_done', {
      id: sub.id,
      question: sub.question,
      sources: sourceCount,
      capped: result.capped,
      termination_reason: result.termination_reason,
      summary: summary.slice(0, 600),
      budget: result.budget,
    });

    return {
      id: sub.id,
      question: sub.question,
      summary,
      capped: result.capped,
      source_count: sourceCount,
      budget: result.budget,
    };
  }

  await Promise.all(Array.from({ length: Math.min(limits.branchConcurrency, queue.length) }, worker));
  // Keep plan order in the notes handed to synthesis.
  return plan.sub_questions.map((q) => results.find((r) => r.id === q.id)).filter(Boolean);
}

/**
 * Broader evidence pass: pages that several branches surfaced but none read are
 * usually the cross-cutting sources. Fetch the best few, so the merged answer
 * rests on more than the per-branch picks.
 */
async function sweepUnreadCandidates({ ledger, recorder, emit, deadline, limits, fetchPage: fetchPageFn = null, slots = null, plan = null }) {
  // Same narrow seam the branches use: the real fetcher unless a caller injects
  // one. Without this the sweep reached the network directly, which is why no
  // test could drive it and why its sources went unchecked.
  const fetch = fetchPageFn || fetchPage;
  const budgetMs = Math.min(30000, deadline - Date.now());
  if (budgetMs < 3000) return [];

  /**
   * Skip the sweep when the run already has what it needs.
   *
   * It existed as a phase that always ran, and a phase that always runs spends
   * calls to justify itself. Two citable sources per sub-question is enough for
   * a merged answer to rest on more than one publisher per part; below that the
   * sweep earns its capacity.
   */
  const planned = plan?.sub_questions?.length ?? 0;
  if (planned && ledger.citable.length >= planned * 2) {
    // Nothing further is coming, so the reserve is not reserved for anything.
    slots?.releaseSweepReserve();
    emit('sweep_skipped', { reason: 'sufficient_evidence', sources: ledger.citable.length, planned });
    return [];
  }

  const domainsRead = new Set(ledger.sources.map((s) => s.domain));
  const candidates = [...ledger.candidates.values()]
    .filter((c) => c.url && !domainsRead.has(c.domain))
    .slice(0, limits.maxSubQuestions + 2);
  if (!candidates.length) {
    slots?.releaseSweepReserve();
    return [];
  }

  emit('sweep_start', { considering: candidates.length });
  const fetched = [];
  const sweepDeadline = Date.now() + budgetMs;

  for (const candidate of candidates) {
    if (Date.now() >= sweepDeadline || fetched.length >= 3) break;
    // The sweep spends from the same pool as everything else. It used to call
    // the fetcher directly, so its pages were real provider calls that no
    // budget had counted - which is how runs reached 29 to 32 calls against a
    // ceiling of 24.
    const permit = slots ? slots.tryClaim('sweep') : null;
    if (slots && !permit) {
      emit('sweep_done', { fetched: fetched.length, stopped: slots.capReason });
      return fetched;
    }
    try {
      const page = await fetch(candidate.url, { recorder });
      if (!page.ok) continue;
      /**
       * Attributed to the sub-question that surfaced it, not to 'sweep'.
       *
       * The contract derives `subQuestion` by stripping non-digits, so 'sweep'
       * produced nothing and these sources reached the grader without an index
       * — 3 of 14 on the deployed preview. The page is genuinely cross-cutting,
       * but it entered this run through one branch's search, and first
       * discoverer is the rule the rest of the ledger already follows.
       */
      const source = ledger.addWebSource(page, { branch: candidate.discovered_by_branch || 'sweep', query: 'cross-branch sweep' });
      recorder.recordToolCall({
        name: 'fetch_page',
        input: { url: candidate.url },
        durationMs: page.duration_ms,
        ok: true,
        summary: `sweep: ${source.title}`,
        cached: page.cached,
        branch: 'sweep',
      });
      emit('source_added', { source: { n: source.n, title: source.title, url: source.url, domain: source.domain, type: 'web', snippet: source.snippet }, branch: 'sweep' });
      fetched.push(source);
    } catch {
      /* a sweep failure is not worth failing the run over */
    } finally {
      slots?.settle(permit);
    }
  }
  emit('sweep_done', { fetched: fetched.length });
  return fetched;
}

/**
 * Why a deep run stopped, in one place.
 *
 * The rule is about whether work was abandoned, not about how close a counter
 * came to its ceiling:
 *
 *   done — every planned sub-question was researched and synthesised, and
 *          nothing was refused. A run that used its last slot and needed no
 *          more finished; a full counter is a budget spent exactly, not a run
 *          cut short.
 *   cap  — a call the run still wanted was refused, by a branch's own gate or
 *          by the shared pool, or a deadline or token ceiling ended it early.
 *          `markCapped` fires only on an actual refusal, so `capped` already
 *          means "someone asked and was told no" rather than "a counter is
 *          full".
 *   error — kept for genuine provider or synthesis failures, and set by the
 *          catch, because a run that produced nothing has nothing to describe.
 *
 * This was `slots.exhausted ? slots.capReason : ...`, and the two are not the
 * same question. `exhausted` is "the pool is full"; `capReason` is "the pool
 * refused someone". A run that claimed its 24th slot and never asked for a
 * 25th had `exhausted` true and `capReason` null, so the whole expression
 * evaluated to null, `finish()` skipped the assignment, and the run persisted
 * with no termination reason at all — which the contract reads as `done`.
 *
 * Measured on the deployed benchmark: the three runs where all four branches
 * hit their ceiling recorded `null` and counted as finished, while three runs
 * where only some branches hit it recorded `capped`. The more constrained runs
 * were the ones reported as clean.
 */
export function terminationFor({ truncated, refusedReason, curtailed }) {
  if (truncated) return 'max_tokens';
  if (refusedReason) return refusedReason;
  if (curtailed) return 'capped';
  return 'completed';
}

/**
 * How the 24 calls are divided before any branch starts.
 *
 * The ceiling is fixed. What was wrong was the division: `maxToolCallsPerBranch`
 * 6 times four branches is exactly `maxToolCallsTotal` 24, so four branches
 * using their allowance consumed the entire pool and the cross-branch sweep had
 * nothing left. It took its pages anyway, outside the accounting — measured on
 * the deployed benchmark, runs recorded 29 to 32 provider calls against a pool
 * that only ever saw 22 claimed.
 *
 * So the reserve is subtracted first and the rest is shared. Fewer branches get
 * a larger allowance, because the capacity exists either way and leaving it
 * unspent helps nobody.
 *
 *   4 branches → 5 each, 4 reserved
 *   3 branches → 6 each, 6 reserved
 *
 * The reserve is a floor for later phases, not a quota to spend: a run with
 * enough evidence skips the sweep and simply does not use it.
 */
export function allocateDeepBudget({ total, branches, maxPerBranch, minReserve = 4 }) {
  const count = Math.max(1, branches);
  const reserve = Math.max(minReserve, total - count * maxPerBranch);
  const perBranch = Math.max(1, Math.min(maxPerBranch, Math.floor((total - reserve) / count)));
  return { perBranch, reserve: total - perBranch * count, total };
}
