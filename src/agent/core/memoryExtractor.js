import { config } from '../../shared/config.js';
import { complete, textOf, parseJsonLoose } from './llm.js';
import { memoryExtractionSystem } from './prompts.js';
import { saveMemory } from '../services/memoryStore.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('memory');

/**
 * After a run, look at the exchange for durable facts about the *user*.
 * Runs on the cheap model, off the critical path, and saves nothing by default.
 * the prompt is written so that "no memories" is the expected outcome.
 */
export async function extractMemories({ userId, threadId, runId, query, answer, recorder, emit }) {
  if (!config.memory.extractEnabled) return [];
  try {
    const message = await complete({
      purpose: 'memory_extraction',
      recorder,
      model: config.llm.memoryModel,
      system: memoryExtractionSystem(),
      messages: [
        {
          role: 'user',
          content: `<user_message>\n${query}\n</user_message>\n\n<assistant_answer>\n${(answer || '').slice(0, 2000)}\n</assistant_answer>`,
        },
      ],
      maxTokens: 1000,
      effort: 'low',
    });

    const parsed = parseJsonLoose(textOf(message));
    const candidates = Array.isArray(parsed?.memories) ? parsed.memories : [];
    const saved = [];
    for (const candidate of candidates.slice(0, 5)) {
      if (!candidate?.content || typeof candidate.content !== 'string') continue;
      if ((candidate.confidence ?? 1) < 0.5) continue;
      const record = await saveMemory({
        userId,
        content: candidate.content,
        kind: candidate.kind,
        source: 'auto_extraction',
        threadId,
        runId,
        confidence: candidate.confidence ?? 0.7,
      });
      if (record) saved.push({ id: record.id, content: record.content, kind: record.kind });
    }
    if (saved.length) emit?.('memory_saved', { memories: saved, origin: 'extraction' });
    return saved;
  } catch (err) {
    // Memory extraction must never fail a run that already produced an answer.
    log.warn('memory_extraction_failed', { err: err.message, run_id: runId });
    recorder?.recordError('memory_extraction', err);
    return [];
  }
}
