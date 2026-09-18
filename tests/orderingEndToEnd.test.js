import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * The ordering fix, through the path a request actually takes.
 *
 * Unit tests pin that `renderForPrompt` ranks passages and that `quick.js`
 * passes the resolved question. Neither proves the two are connected: the
 * defect being fixed was itself a disconnection, where evidence the ledger held
 * never reached the prompt, and every component was behaving correctly.
 *
 * So this composes the real modules in the real order — `gatherFromWeb` with
 * the network stubbed, then `synthesizeAnswer` with the model stubbed — and
 * asserts on the prompt the model was actually handed.
 *
 * It stops short of `runQuickQuery`, which takes no injection points; adding
 * them to production code for a test's benefit is a worse trade than the small
 * gap it closes. What quick.js contributes — passing the resolved question
 * through as `retrievalQuery` — is pinned separately in passageOrder.test.js.
 *
 * No provider key is needed. What is under test is what we send, not what comes
 * back.
 */

dotenv.config();
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-e2e-order-'));
process.env.MONGODB_URI = '';
process.env.EMBEDDING_PROVIDER = 'local';
process.env.MEMORY_EXTRACT_ENABLED = 'false';

const { gatherFromWeb } = await import('../src/agent/core/retrieve.js');
const { synthesizeAnswer } = await import('../src/agent/core/synthesize.js');
const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
const { Budget } = await import('../src/agent/core/budget.js');

const QUESTION = 'What does TLS certificate pinning protect against?';
const ANSWER_LINE =
  'Certificate pinning effectively breaks this attack lifecycle because the application rejects any certificate that does not match the expected pin.';

/**
 * A page shaped like the ones that caused this: a navigation menu, a great deal
 * of unrelated prose, and the answer at the bottom, well past the cap.
 */
const PAGE_TEXT = [
  'Machine Identity Security: The Definitive Guide',
  'Four Pillars of Machine Identity Architecture',
  'What Is Cert-Manager? Kubernetes Certificate Management Explained',
  'This section covers unrelated background material about machine identity and adjacent operational topics in some depth. '.repeat(60),
  ANSWER_LINE,
].join('\n\n');

test('the answer past the cap reaches the prompt, through retrieval and synthesis', async () => {
  let userMessage = null;

  const ledger = new EvidenceLedger();
  await gatherFromWeb({
    query: QUESTION,
    ledger,
    budget: new Budget({ maxIterations: 4, maxToolCalls: 10, maxFetches: 4, maxSearches: 2, wallClockMs: 30_000 }),
    emit: () => {},
    pages: 1,
    webSearch: async () => ({
      results: [{ url: 'https://example.test/pinning', title: 'Certificate pinning', snippet: 'lead' }],
      provider: 'stub',
      cached: false,
    }),
    fetchPage: async (url) => ({
      ok: true,
      url,
      final_url: url,
      status: 200,
      title: 'Certificate pinning',
      text: PAGE_TEXT,
      fetched_at: new Date().toISOString(),
      duration_ms: 5,
      timings: {},
    }),
  });

  assert.equal(ledger.sources.length, 1, 'the page was read and admitted as evidence');
  assert.ok(ledger.sources[0].passages.join('\n').includes(ANSWER_LINE), 'and the ledger holds the answer');

  const result = await synthesizeAnswer({
    query: QUESTION,
    ledger,
    mode: 'quick',
    capped: false,
    capReason: null,
    memories: [],
    threadContext: null,
    researchNotes: null,
    plan: null,
    recorder: null,
    emit: () => {},
    model: 'stub-model',
    maxTokens: 400,
    streamComplete: async ({ messages, onText }) => {
      userMessage = messages.at(-1)?.content ?? '';
      const text = 'Pinning rejects certificates that do not match the expected pin [1].';
      onText?.(text);
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } };
    },
  });

  assert.ok(userMessage, 'synthesis was reached');
  assert.ok(
    userMessage.includes(ANSWER_LINE),
    'the passage answering the question is in the prompt, not merely in the ledger',
  );
  assert.ok(result.answer, 'and an answer came back');
});

test('without ordering the same page would have lost its answer', async () => {
  // The control, so the test above is known to be testing something. The same
  // evidence rendered without a question keeps whatever was extracted first.
  const { EvidenceLedger } = await import('../src/agent/core/evidence.js');
  const ledger = new EvidenceLedger();
  ledger.addWebSource({
    ok: true,
    url: 'https://example.test/pinning',
    title: 'Certificate pinning',
    text: PAGE_TEXT,
    fetched_at: new Date().toISOString(),
  });

  const unordered = ledger.renderForPrompt();
  const ordered = ledger.renderForPrompt({ query: QUESTION });

  assert.ok(!unordered.includes(ANSWER_LINE), 'extraction order buries the answer past the cap');
  assert.ok(ordered.includes(ANSWER_LINE), 'ranking by the question rescues it');
  assert.ok(unordered.dropped_sources.length > 0, 'and the loss was reported either way');
});
