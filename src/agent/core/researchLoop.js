import { complete, textOf, toolUsesOf } from './llm.js';
import { createToolExecutor, toolDefinitionsFor } from './tools.js';
import { CAP_REASONS } from './budget.js';

/**
 * The tool-using research loop. Shared by Quick mode and by every Deep Search
 * branch: same enforcement, different budgets.
 *
 * Nothing the model writes here reaches the user as an answer. That separation
 * is what lets the caller emit the complete source list before the first answer
 * token, and it keeps the citation rules enforceable in one place.
 */
export async function runResearchLoop({
  system,
  userMessage,
  ledger,
  budget,
  recorder,
  emit,
  userId,
  threadId,
  runId,
  branch = null,
  model,
  maxTokens,
  effort,
  hasDocuments,
  signal,
  // Injected so the loop's control flow can be tested without a model or a
  // network: the behaviours worth pinning here are when it stops, why, and what
  // it refuses to accept, none of which are about the model's own output.
  complete: completeFn = complete,
  executor,
}) {
  const execute = executor || createToolExecutor({ ledger, budget, recorder, emit, userId, threadId, runId, branch });
  const tools = toolDefinitionsFor({ hasDocuments });
  const messages = [{ role: 'user', content: userMessage }];
  const notes = [];
  let terminationReason = null;
  // Bounded, so a model that insists it is finished is not argued with forever.
  const MAX_NUDGES = 2;
  let nudges = 0;

  while (true) {
    const stop = budget.checkStop();
    if (stop) {
      terminationReason = stop;
      break;
    }
    budget.nextIteration();
    emit?.('iteration', { n: budget.counts.iterations, branch, budget: budget.snapshot() });

    if (signal?.aborted) {
      terminationReason = 'client_disconnected';
      break;
    }

    const message = await completeFn({
      purpose: branch ? `research:${branch}` : 'research',
      recorder,
      model,
      system,
      messages,
      tools,
      maxTokens,
      effort,
    });

    const text = textOf(message).trim();
    if (text) {
      notes.push(text);
      emit?.('reasoning', { text: text.slice(0, 2000), branch });
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const toolUses = toolUsesOf(message);
    if (!toolUses.length) {
      // A search whose snippets happen to contain the answer will satisfy the
      // model, and it stops. The ledger then refuses to make those snippets
      // citable, so synthesis gets nothing and the run honestly reports having
      // no evidence, for a question that was in fact answerable.
      //
      // The rule is already stated in the prompt; stating it is not enough.
      // Ending the research phase with candidates found but nothing read is
      // treated as an unfinished run, and the loop says so and continues, while
      // the budget keeps it bounded.
      const nothingRead = ledger.citable.length === 0 && ledger.candidates.size > 0;
      if (nothingRead && nudges < MAX_NUDGES && budget.allows('fetch_page').ok) {
        nudges += 1;
        messages.push({ role: 'assistant', content: message.content });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'You have not read any page yet, so there is no evidence to answer from and nothing can be cited. ' +
                'Search snippets are leads, not evidence. Call fetch_page on the most promising results before finishing.',
            },
          ],
        });
        continue;
      }
      terminationReason = message.stop_reason === 'max_tokens' ? 'max_tokens' : 'completed';
      break;
    }

    messages.push({ role: 'assistant', content: message.content });

    // Parallel tool calls in one assistant turn must all come back in one user turn.
    const results = await Promise.all(
      toolUses.map(async (use) => ({ use, result: await execute(use.name, use.input) })),
    );
    messages.push({
      role: 'user',
      content: results.map(({ use, result }) => ({
        type: 'tool_result',
        tool_use_id: use.id,
        is_error: !result.ok,
        content: result.content,
      })),
    });

    // A blocked tool means the budget is spent. The tool result already told
    // the model to stop; there is nothing left to spend on another turn, so go
    // straight to synthesis with the evidence gathered so far.
    if (results.some((r) => r.result.blocked)) {
      const stopNow = budget.checkStop();
      if (stopNow) {
        terminationReason = stopNow;
        break;
      }
    }
  }

  const capped = Boolean(budget.capped) || ['max_tokens', 'client_disconnected'].includes(terminationReason);
  return {
    notes,
    termination_reason: terminationReason || budget.capped || 'completed',
    capped,
    cap_reason: capped ? CAP_REASONS[budget.capped || terminationReason] || terminationReason : null,
    budget: budget.snapshot(),
  };
}
