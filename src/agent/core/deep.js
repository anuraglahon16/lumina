import { config } from '../../shared/config.js';
import { Budget, CAP_REASONS, deadlineSignal } from './budget.js';
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
export async function runDeepQuery({ query, userId, threadId, requestId, emit, signal }) {
  const limits = config.budgets.deep;
  const deadline = Date.now() + limits.wallClockMs;
  const ledger = new EvidenceLedger();
  const recorder = new RunRecorder({ requestId, userId, threadId, mode: 'deep', query, model: config.llm.model });
  const thread = await ensureThread({ threadId, userId, title: query });

  emit('run_start', {
    run_id: recorder.id,
    thread_id: thread.id,
    mode: 'deep',
    query,
    model: config.llm.model,
    budget: { limits, deadline_in_ms: limits.wallClockMs },
    search_provider: resolveProviders()[0],
  });

  await appendMessage(thread.id, { role: 'user', content: query, run_id: recorder.id, mode: 'deep' });

  try {
    // ---- context ----------------------------------------------------------
    recorder.startPhase('context');
    const memories = await searchMemories(query, { userId }).catch(() => []);
    const docs = await documentStats(userId);
    const history = (await threadContext(thread.id)).slice(0, -1);
    recorder.endPhase('context', { memories: memories.length, documents: docs.indexed });
    if (memories.length) emit('memory_used', { memories });

    // ---- plan -------------------------------------------------------------
    recorder.startPhase('plan');
    const plan = await buildPlan({ query, history, memories, recorder, deadline, signal });
    recorder.endPhase('plan', { sub_questions: plan.sub_questions.length });
    emit('plan', plan);

    // ---- parallel branch research ----------------------------------------
    recorder.startPhase('research');
    const branchResults = await runBranches({
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
    const swept = await sweepUnreadCandidates({ ledger, recorder, emit, deadline, limits });
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
      model: config.llm.model,
      maxTokens: limits.maxTokens,
      effort: limits.effort,
      signal,
    });

    await appendMessage(thread.id, {
      role: 'assistant',
      content: answer,
      run_id: recorder.id,
      mode: 'deep',
      sources: ledger.publicSources(),
      citations: validation.cited,
      capped,
    });


    // Set before finish(): finish() is what persists the record.
    recorder.set({
      budget: {
        limits,
        branches: branchResults.map((b) => ({ id: b.id, question: b.question, ...b.budget })),
      },
    });
    const run = recorder.finish({
      status: 'ok',
      terminationReason: truncated ? 'max_tokens' : capped ? 'capped' : 'completed',
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

async function buildPlan({ query, history, memories, recorder, deadline, signal }) {
  // Planning is inside the run's wall clock like everything else. Deep mode
  // tracks that clock as an absolute deadline rather than a Budget, because its
  // limits are per branch; the bound is the same one either way.
  const bound = deadlineSignal(deadline - Date.now(), signal);
  try {
    return await planCall({ query, history, memories, recorder, signal: bound.signal });
  } finally {
    bound.release();
  }
}

async function planCall({ query, history, memories, recorder, signal }) {
  const message = await complete({
    purpose: 'plan',
    recorder,
    signal,
    model: config.llm.model,
    system: plannerSystem({ maxSubQuestions: config.budgets.deep.maxSubQuestions }),
    messages: [
      {
        role: 'user',
        content: [
          history.length ? `<conversation_so_far>\n${history.map((m) => `${m.role}: ${m.content}`).join('\n')}\n</conversation_so_far>\n` : '',
          memories.length ? `<about_the_user>\n${memories.map((m) => `- ${m.content}`).join('\n')}\n</about_the_user>\n` : '',
          `<question>${query}</question>`,
        ].join(''),
      },
    ],
    maxTokens: 2000,
    effort: 'medium',
  });

  const parsed = parseJsonLoose(textOf(message));
  const subQuestions = Array.isArray(parsed?.sub_questions) ? parsed.sub_questions : [];

  if (!subQuestions.length) {
    // Planning failed to produce usable JSON: fall back to researching the
    // question itself rather than failing the run.
    return {
      interpretation: query,
      answer_shape: 'Direct answer with supporting evidence.',
      sub_questions: [{ id: 'q1', question: query, why: 'fallback: planner returned no usable plan', search_queries: [query] }],
      degraded: true,
    };
  }

  return {
    interpretation: parsed.interpretation || query,
    answer_shape: parsed.answer_shape || null,
    degraded: false,
    sub_questions: subQuestions.slice(0, config.budgets.deep.maxSubQuestions).map((q, i) => ({
      id: q.id || `q${i + 1}`,
      question: String(q.question || '').slice(0, 400),
      why: q.why || null,
      search_queries: Array.isArray(q.search_queries) ? q.search_queries.slice(0, 4) : [],
    })),
  };
}

/** Research every sub-question, at most `branchConcurrency` at a time. */
async function runBranches({ plan, ledger, recorder, emit, userId, threadId, runId, hasDocuments, limits, deadline, signal }) {
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
      results.push(await runBranch(sub));
    }
  };

  async function runBranch(sub) {
    const branchBudget = new Budget(
      {
        maxIterations: limits.maxIterationsPerBranch,
        maxToolCalls: limits.maxToolCallsPerBranch,
        maxFetches: limits.maxFetchesPerBranch,
        maxSearches: limits.maxToolCallsPerBranch,
        // A branch may never outlive the overall Deep Search deadline.
        wallClockMs: Math.max(1000, Math.min(limits.wallClockMs, deadline - Date.now())),
      },
      { label: `branch:${sub.id}` },
    );

    const sourcesBefore = ledger.sources.length;
    emit('branch_start', { id: sub.id, question: sub.question, why: sub.why, budget: branchBudget.snapshot() });

    const result = await runResearchLoop({
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
      signal,
    });

    const sourceCount = ledger.sources.length - sourcesBefore;
    const summary = result.notes.join('\n').slice(0, 1500) || 'No findings recorded.';
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
async function sweepUnreadCandidates({ ledger, recorder, emit, deadline, limits }) {
  const budgetMs = Math.min(30000, deadline - Date.now());
  if (budgetMs < 3000) return [];

  const domainsRead = new Set(ledger.sources.map((s) => s.domain));
  const candidates = [...ledger.candidates.values()]
    .filter((c) => c.url && !domainsRead.has(c.domain))
    .slice(0, limits.maxSubQuestions + 2);
  if (!candidates.length) return [];

  emit('sweep_start', { considering: candidates.length });
  const fetched = [];
  const sweepDeadline = Date.now() + budgetMs;

  for (const candidate of candidates) {
    if (Date.now() >= sweepDeadline || fetched.length >= 3) break;
    try {
      const page = await fetchPage(candidate.url, { recorder });
      if (!page.ok) continue;
      const source = ledger.addWebSource(page, { branch: 'sweep', query: 'cross-branch sweep' });
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
    }
  }
  emit('sweep_done', { fetched: fetched.length });
  return fetched;
}
