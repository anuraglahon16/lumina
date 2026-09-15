import { streamComplete, textOf } from './llm.js';
import { normalizeAnswerStyle } from './style.js';
import { synthesisSystem, buildSynthesisUserMessage } from './prompts.js';

/**
 * Synthesis phase: sources first, then answer tokens.
 *
 * The `sources` event is emitted before the model call starts, so the client is
 * guaranteed to have the full source list before the first token, not as a
 * timing accident, but structurally.
 */
export async function synthesizeAnswer({
  query,
  ledger,
  mode,
  capped,
  capReason,
  memories,
  threadContext,
  researchNotes,
  plan,
  recorder,
  emit,
  model,
  maxTokens,
  effort,
  signal,
}) {
  const sources = ledger.publicSources();
  emit?.('sources', {
    sources,
    considered_not_read: ledger.publicCandidates(),
    count: sources.length,
  });

  recorder?.startPhase('synthesis');

  const system = synthesisSystem({
    mode,
    capped,
    capReason,
    memories,
    evidenceCount: sources.length,
  });

  const userMessage = buildSynthesisUserMessage({
    query,
    evidence: ledger.renderForPrompt(),
    threadContext,
    researchNotes,
    plan,
  });

  let streamed = '';
  const message = await streamComplete({
    purpose: 'synthesis',
    recorder,
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens,
    effort,
    signal,
    onText: (delta) => {
      if (!streamed) recorder?.markFirstToken();
      streamed += delta;
      emit?.('token', { text: delta });
    },
  });

  recorder?.endPhase('synthesis');

  const raw = textOf(message) || streamed;

  // Normalise punctuation before validating, so groundedness is scored on the
  // text the user will actually read rather than on a draft of it.
  const styled = normalizeAnswerStyle(raw);
  const validation = ledger.validate(styled.text);

  // If validation stripped anything, the client's streamed text is now stale,
  // send the authoritative answer so the UI can re-render it.
  emit?.('answer', {
    text: validation.answer,
    revised: validation.answer !== raw,
    restyled: styled.replaced,
    truncated: message.stop_reason === 'max_tokens',
  });

  emit?.('citations', {
    cited: validation.cited,
    uncited_sources: validation.uncited_sources,
    invalid_citations: validation.invalid_citations,
    groundedness: validation.groundedness,
    cited_sentences: validation.cited_sentences,
    supported_sentences: validation.supported_sentences,
    weak_citations: validation.weak_citations,
  });

  return {
    answer: validation.answer,
    validation,
    truncated: message.stop_reason === 'max_tokens',
  };
}
