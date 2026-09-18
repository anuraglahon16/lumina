import { config } from '../../shared/config.js';
import { complete, textOf } from './llm.js';
import { deadlineSignal } from './budget.js';

/**
 * Turn a follow-up back into a question that can be searched.
 *
 * "why?" retrieves nothing. Neither does "what about the second one". The
 * information needed to make them searchable is in the conversation rather than
 * in the request, which is why this is the one place in the fast path where a
 * model runs before retrieval — a rule cannot recover a subject that was never
 * written down.
 *
 * It is kept as small as the job: the smallest model, the last few turns, one
 * line out, and a short ceiling. If it fails or takes too long the original
 * question is used, which is what would have happened anyway.
 */

const CEILING_MS = 2500;

export async function rewriteFollowUp({ query, history, recorder, signal }) {
  if (!history?.length) return null;

  const bound = deadlineSignal(CEILING_MS, signal);
  try {
    const message = await complete({
      purpose: 'query_rewrite',
      recorder,
      signal: bound.signal,
      model: config.llm.queryRewriteModel,
      system:
        'Rewrite the user\'s latest message as a standalone search query, resolving every pronoun and reference from the conversation. ' +
        'Keep it under 20 words. Output the query alone: no quotes, no preamble, no explanation. ' +
        'If the message is already standalone, output it unchanged.',
      messages: [
        {
          role: 'user',
          content: [
            `<conversation>\n${history
              .slice(-4)
              .map((m) => `${m.role}: ${String(m.content).slice(0, 500)}`)
              .join('\n')}\n</conversation>`,
            `<latest_message>${query}</latest_message>`,
          ].join('\n\n'),
        },
      ],
      maxTokens: 80,
      effort: 'low',
    });

    const rewritten = textOf(message).trim().replace(/^["'`]|["'`]$/g, '').split('\n')[0].trim();

    // A rewrite that came back empty, enormous, or as commentary rather than a
    // query is not better than the question the user actually asked.
    if (!rewritten || rewritten.length > 300) return null;
    if (/^(?:sure|certainly|here(?:'s| is)|the standalone|rewritten)\b/i.test(rewritten)) return null;
    return rewritten;
  } catch {
    return null;
  } finally {
    bound.release();
  }
}
