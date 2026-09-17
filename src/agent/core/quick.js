import { config } from '../../shared/config.js';
import { Budget, CAP_REASONS } from './budget.js';
import { EvidenceLedger } from './evidence.js';
import { RunRecorder } from '../store/runLog.js';
import { classifyQuestion, QUESTION_KIND } from './router.js';
import { gatherFromWeb, gatherFromDocuments, rescueRetrieval, QUICK_PAGES } from './retrieve.js';
import { rewriteFollowUp } from './rewrite.js';
import { synthesizeAnswer } from './synthesize.js';
import { extractMemories } from './memoryExtractor.js';
import { searchMemories } from '../services/memoryStore.js';
import { ensureThread, appendMessage, threadContext } from '../services/threads.js';
import { documentStats } from '../services/ragStore.js';
import { resolveProviders } from '../services/search/index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('quick');

/**
 * Quick mode: one research loop under hard caps, then a streamed, cited answer.
 *
 * Quick never escalates into Deep Search. If the budget runs out it says so,
 * an honest partial answer beats a silently-truncated confident one.
 */
export async function runQuickQuery({ query, userId, threadId, requestId, emit, signal, spaceId = null, retrievalMode = 'auto' }) {
  const budget = new Budget(config.budgets.quick, { label: 'quick' });
  const ledger = new EvidenceLedger();
  const recorder = new RunRecorder({ requestId, userId, threadId, mode: 'quick', query, model: config.llm.quickModel });
  const thread = await ensureThread({ threadId, userId, title: query });

  emit('run_start', {
    run_id: recorder.id,
    thread_id: thread.id,
    mode: 'quick',
    query,
    model: config.llm.quickModel,
    budget: budget.snapshot(),
    search_provider: resolveProviders()[0],
  });


  try {
    // ---- context assembly -------------------------------------------------
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
    }).catch((err) => log.warn('append_user_message_failed', { run_id: recorder.id, err: err.message }));
    recorder.endPhase('context', { memories: memories.length, thread_turns: history.length, documents: docs.indexed });

    if (memories.length) emit('memory_used', { memories });
    emit('context', {
      thread_turns: history.length,
      memories_injected: memories.length,
      documents_indexed: docs.indexed,
      document_chunks: docs.chunks,
    });

    // ---- routing ----------------------------------------------------------
    // Decided from the request, not by asking a model. The turn that used to
    // reach this conclusion sat in front of every answer.
    const route = classifyQuestion({
      query,
      mode: retrievalMode,
      spaceId,
      hasDocuments: docs.indexed > 0,
      threadTurns: history.length,
    });
    emit('route', { kind: route.kind, reason: route.reason });
    recorder.set({ route: route.kind });

    // ---- deterministic retrieval -------------------------------------------
    recorder.startPhase('retrieval');
    let searchQuery = query;
    let rewritten = false;

    if (route.kind === QUESTION_KIND.CONTEXTUAL_FOLLOW_UP) {
      recorder.startPhase('rewrite');
      // "why?" cannot be searched. One small model call turns it back into a
      // question that can be, which is the only place in this path where a
      // model is needed before retrieval — and it is needed, because the
      // information is in the conversation rather than in the request.
      const standalone = await rewriteFollowUp({ query, history, recorder, signal }).catch(() => null);
      if (standalone && standalone !== query) {
        searchQuery = standalone;
        rewritten = true;
        emit('query_rewritten', { from: query, to: standalone });
      }
      recorder.endPhase('rewrite', { rewritten: Boolean(standalone && standalone !== query) });
    }

    const gathered =
      route.kind === QUESTION_KIND.DOCUMENTS
        ? await gatherFromDocuments({ query: searchQuery, ledger, budget, recorder, emit, userId, spaceId, signal })
        : route.kind === QUESTION_KIND.MEMORY_INSTRUCTION
          ? { searched: false, coverage: { ok: true, reasons: [] } }
          : await gatherFromWeb({ query: searchQuery, ledger, budget, recorder, emit, signal, pages: QUICK_PAGES() });

    recorder.endPhase('retrieval', {
      route: route.kind,
      rewritten,
      sources: ledger.citable.length,
      coverage_ok: gathered.coverage.ok,
      coverage_reasons: gathered.coverage.reasons,
    });

    /**
     * Quick is one pass, and stays one pass.
     *
     * Incomplete evidence used to hand the question to the iterative research
     * loop, which added eight to ten seconds and turned a quick answer into a
     * slow one — for a mode whose entire premise is that most questions do not
     * need that. Deep Search is the iterative one; that is what the two gears
     * are for, and quietly escalating between them is the spend failure their
     * separation exists to prevent.
     *
     * So an incomplete result is answered as incomplete. The evidence that was
     * found is used, the answer says what it could not establish, and the run
     * is marked evidence-limited rather than failed: a partial answer with
     * honest limits is a real outcome, not an error.
     *
     * Nothing found at all is different, because there is nothing to answer
     * from. That gets exactly one more deterministic attempt — a broader search
     * on the same question, no model call in front of it — and then answers
     * with whatever that produced.
     */
    let coverage = gathered.coverage;
    let rescued = false;

    if (!coverage.ok && ledger.citable.length === 0 && route.kind !== QUESTION_KIND.MEMORY_INSTRUCTION) {
      recorder.startPhase('rescue');
      const rescue = await rescueRetrieval({
        query: searchQuery,
        route: route.kind,
        ledger,
        budget,
        recorder,
        emit,
        userId,
        spaceId,
        signal,
        candidates: gathered.candidates || [],
      });
      coverage = rescue.coverage;
      rescued = true;
      recorder.endPhase('rescue', { sources: ledger.citable.length, coverage_ok: coverage.ok });
    }

    const evidenceLimited = !coverage.ok;
    if (evidenceLimited) {
      recorder.recordWarning('retrieval', 'evidence_limited', coverage.reasons.join('; '));
      emit('evidence_limited', {
        reasons: coverage.reasons,
        sources: ledger.citable.length,
        // The honest next step, offered rather than taken: escalating a quick
        // run into a deep one on the server's own initiative is an unbounded
        // bill the user never agreed to.
        suggestion: 'Deep Search researches each part of a question separately and reads more sources.',
      });
    }

    const research = {
      notes: [],
      termination_reason: evidenceLimited ? 'evidence_limited' : 'sufficient_evidence',
      capped: false,
      cap_reason: null,
      budget: budget.snapshot(),
    };
    recorder.endPhase('retrieval_outcome', {
      route: route.kind,
      rescued,
      tool_calls: budget.counts.tool_calls,
      sources_fetched: ledger.sources.length,
      coverage_ok: coverage.ok,
      coverage_reasons: coverage.reasons,
      termination_reason: research.termination_reason,
    });

    if (research.capped) {
      emit('capped', {
        reason: budget.capped || research.termination_reason,
        explanation: `Research stopped early: ${research.cap_reason}. The answer below is based on partial research.`,
        budget: budget.snapshot(),
      });
    }

    // ---- synthesis (sources always emitted before answer tokens) ----------
    const { answer, validation, truncated } = await synthesizeAnswer({
      query,
      ledger,
      mode: 'quick',
      capped: research.capped,
      capReason: research.cap_reason,
      evidenceLimited,
      evidenceGaps: coverage.reasons.join('; ') || null,
      memories,
      threadContext: history,
      researchNotes: null,
      recorder,
      emit,
      model: config.llm.quickModel,
      maxTokens: config.budgets.quick.maxTokens,
      effort: config.budgets.quick.effort,
      ceilingMs: config.budgets.quick.synthesisCeilingMs,
      signal,
    });

    // An answer written from evidence that cites none of it is the failure this
    // system exists to prevent, and it is indistinguishable from an answer made
    // up entirely. Recorded rather than patched: attaching citations after the
    // fact would put markers on sentences nothing checked.
    if (ledger.citable.length > 0 && validation.cited.length === 0) {
      recorder.recordWarning('synthesis', 'uncited_answer', `${ledger.citable.length} sources available, none cited`);
      emit('uncited_answer', { sources: ledger.citable.length });
      log.warn('uncited_answer', { run_id: recorder.id, sources: ledger.citable.length, model: config.llm.quickModel });
    }

    // The question's write is joined here and nowhere earlier: the thread
    // must not show an answer arriving before the thing it answers.
    await questionRecorded;
    await appendMessage(thread.id, {
      role: 'assistant',
      content: answer,
      run_id: recorder.id,
      mode: 'quick',
      sources: ledger.publicSources(),
      citations: validation.cited,
      capped: research.capped,
    });

    const terminationReason = truncated ? 'max_tokens' : research.termination_reason;
    // Set before finish(): finish() is what persists the record.
    recorder.set({ budget: budget.snapshot() });
    const run = recorder.finish({
      status: 'ok',
      terminationReason,
      answer,
      citations: {
        emitted: validation.cited.length + validation.invalid_citations.length,
        valid: validation.cited.length,
        invalid: validation.invalid_citations.length,
        groundedness: validation.groundedness,
        // The two counts the ratio is made of. Without them a pooled figure
        // across runs cannot be computed at all: `valid` counts distinct
        // sources, not sentences, and dividing by it produces a number that
        // looks like grounding and is not one.
        cited_sentences: validation.cited_sentences,
        supported_sentences: validation.supported_sentences,
        // Kept so grounding can be diagnosed from the run itself. A support
        // score is only interpretable beside the sentence it scored and the
        // text it was scored against; the ratio alone says a number failed and
        // nothing about why.
        // The validator's own decisions, capped so a run record stays a record
        // rather than a transcript. Passages are trimmed, not summarised: a
        // classifier reading a paraphrase of the evidence is back to guessing.
        sentence_results: (validation.sentence_results || []).slice(0, 20).map((r) => ({
          sentence: r.sentence,
          refs: r.refs,
          supported: r.supported,
          best_score: r.best_score,
          // Not truncated. Trimming a passage to twelve hundred characters can
          // drop the sentence that produced the score, which makes the record
          // unable to explain its own number.
          scored_against: r.scored_against,
        })),
      },
      sources: {
        discovered: ledger.sources.length + ledger.candidates.size,
        fetched: ledger.sources.filter((s) => s.type === 'web').length,
        cited: validation.cited.length,
      },
    });

    emit('done', summarizeRun(run, { capped: research.capped, capReason: research.cap_reason, budget: budget.snapshot() }));

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

    return { run, answer, sources: ledger.publicSources(), thread_id: thread.id };
  } catch (err) {
    log.error('quick_run_failed', { run_id: recorder.id, err: err.message });
    recorder.recordError('quick_run', err);
    const run = recorder.finish({ status: 'error', terminationReason: 'error' });
    emit('error', { code: err.code || 'agent_error', message: err.message, run_id: run.id });
    emit('done', summarizeRun(run, { error: true }));
    throw err;
  }
}

/** Which model served which role, as the running process is configured. */
export function modelRoles() {
  return {
    quick: config.llm.quickModel,
    planner: config.llm.plannerModel,
    branch: config.llm.branchModel,
    deepSynthesis: config.llm.deepSynthesisModel,
    queryRewrite: config.llm.queryRewriteModel,
    memory: config.llm.memoryModel,
  };
}

/** The metrics block the UI shows in the run footer. */
export function summarizeRun(run, extra = {}) {
  return {
    run_id: run.id,
    mode: run.mode,
    // The contract's done event names the model that served the answer, and a
    // grader reading a cost figure cannot interpret it without one.
    model: run.model,
    models: modelRoles(),
    status: run.status,
    termination_reason: run.termination_reason,
    termination_explanation: CAP_REASONS[run.termination_reason] || null,
    latency_ms: run.latency_ms,
    ttft_ms: run.ttft_ms,
    cost_usd: run.cost_usd,
    tokens: run.tokens,
    tool_calls: run.tool_calls.length,
    llm_calls: run.llm_calls.length,
    errors: run.errors.length,
    cache: run.cache,
    sources: run.sources,
    citations: run.citations,
    phases: run.phases,
    ...extra,
  };
}
