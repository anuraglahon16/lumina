import { config } from '../../shared/config.js';
import { Budget, CAP_REASONS } from './budget.js';
import { EvidenceLedger } from './evidence.js';
import { RunRecorder } from '../store/runLog.js';
import { runResearchLoop } from './researchLoop.js';
import { synthesizeAnswer } from './synthesize.js';
import { extractMemories } from './memoryExtractor.js';
import { researchSystem, buildResearchUserMessage } from './prompts.js';
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
export async function runQuickQuery({ query, userId, threadId, requestId, emit, signal }) {
  const budget = new Budget(config.budgets.quick, { label: 'quick' });
  const ledger = new EvidenceLedger();
  const recorder = new RunRecorder({ requestId, userId, threadId, mode: 'quick', query, model: config.llm.model });
  const thread = ensureThread({ threadId, userId, title: query });

  emit('run_start', {
    run_id: recorder.id,
    thread_id: thread.id,
    mode: 'quick',
    query,
    model: config.llm.model,
    budget: budget.snapshot(),
    search_provider: resolveProviders()[0],
  });

  appendMessage(thread.id, { role: 'user', content: query, run_id: recorder.id });

  try {
    // ---- context assembly -------------------------------------------------
    recorder.startPhase('context');
    const [memories, docs] = await Promise.all([
      searchMemories(query, { userId }).catch(() => []),
      Promise.resolve(documentStats(userId)),
    ]);
    const history = threadContext(thread.id).slice(0, -1);
    recorder.endPhase('context', { memories: memories.length, thread_turns: history.length, documents: docs.indexed });

    if (memories.length) emit('memory_used', { memories });
    emit('context', {
      thread_turns: history.length,
      memories_injected: memories.length,
      documents_indexed: docs.indexed,
      document_chunks: docs.chunks,
    });

    // ---- research ---------------------------------------------------------
    recorder.startPhase('research');
    const research = await runResearchLoop({
      system: researchSystem({
        mode: 'quick',
        budget: config.budgets.quick,
        memories,
        hasDocuments: docs.indexed > 0,
        searchDegraded: resolveProviders()[0] === 'duckduckgo',
      }),
      userMessage: buildResearchUserMessage({ query, threadContext: history, documentCount: docs.indexed }),
      ledger,
      budget,
      recorder,
      emit,
      userId,
      threadId: thread.id,
      runId: recorder.id,
      model: config.llm.model,
      maxTokens: config.budgets.quick.maxTokens,
      effort: config.budgets.quick.effort,
      hasDocuments: docs.indexed > 0,
      signal,
    });
    recorder.endPhase('research', {
      tool_calls: budget.counts.tool_calls,
      sources_fetched: ledger.sources.length,
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
      memories,
      threadContext: history,
      researchNotes: null,
      recorder,
      emit,
      model: config.llm.model,
      maxTokens: config.budgets.quick.maxTokens,
      effort: config.budgets.quick.effort,
      signal,
    });

    appendMessage(thread.id, {
      role: 'assistant',
      content: answer,
      run_id: recorder.id,
      mode: 'quick',
      sources: ledger.publicSources(),
      citations: validation.cited,
      capped: research.capped,
    });

    // ---- long-term memory -------------------------------------------------
    recorder.startPhase('memory_extraction');
    await extractMemories({ userId, threadId: thread.id, runId: recorder.id, query, answer, recorder, emit });
    recorder.endPhase('memory_extraction');

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
      },
      sources: {
        discovered: ledger.sources.length + ledger.candidates.size,
        fetched: ledger.sources.filter((s) => s.type === 'web').length,
        cited: validation.cited.length,
      },
    });

    emit('done', summarizeRun(run, { capped: research.capped, capReason: research.cap_reason, budget: budget.snapshot() }));
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

/** The metrics block the UI shows in the run footer. */
export function summarizeRun(run, extra = {}) {
  return {
    run_id: run.id,
    mode: run.mode,
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
