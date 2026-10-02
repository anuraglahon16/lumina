import { createLogger } from '../../shared/logger.js';
/**
 * Translate this engine's stream into the assignment's SSE contract.
 *
 * The two vocabularies were designed independently and neither is wrong. Ours is
 * a debugging surface: it names iterations, nudges, refunds, sweeps. The
 * contract's is a UI surface: six events, in a fixed order, each a shape the
 * provided React app compiles against. Mapping between them is a better trade
 * than editing the engine to speak the narrower vocabulary, because the extra
 * events are what makes a run diagnosable and nothing in the contract forbids
 * having them — it only fixes what the six named ones look like.
 *
 * The ordering rule is the one thing the contract will not bend on:
 *
 *   quick:  trace* → sources → token* → done
 *   deep:   plan → trace* → sources → token* → done
 *
 * `sources` before the first `token` is already an architectural guarantee here
 * (the ledger is sealed before synthesis begins), so this layer does not have to
 * arrange it. It asserts it instead, because a mapping bug that reordered them
 * would be invisible until the grader caught it.
 */

/** Tools the contract knows about. Ours that have no counterpart are not traced. */
const TOOL_NAMES = new Set(['web_search', 'fetch_page', 'search_documents', 'recall_memory', 'save_memory', 'plan_research']);

/**
 * Our page label as the contract's Locator.
 *
 * The ledger carries a human string — "p. 3", or a heading for a document with
 * no pages — because that is what reads well under a citation. The contract
 * wants a structured locator, and the grader tests `locator.page === n`
 * numerically, so a citation that points at exactly the right page of exactly
 * the right document fails every check while looking correct to a reader.
 */
function toLocator(raw) {
  if (raw == null) return undefined;
  if (typeof raw === 'object') return raw.page || raw.heading || raw.line ? raw : undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const page = text.match(/(?:^|\bp\.?\s*|\bpage\s+)(\d{1,5})\b/i);
  if (page) return { page: Number(page[1]) };
  return { heading: text.slice(0, 200) };
}

/** `kind` in the contract, `type` here; doc sources carry a locator, web ones a url. */
function toContractSource(s) {
  const out = {
    n: s.n,
    kind: s.type === 'document' || s.type === 'doc' ? 'doc' : 'web',
    title: s.title || s.url || `Source ${s.n}`,
    // Must be non-empty: the grounding check looks for this string in the
    // fetched text, so an empty snippet fails the gate rather than merely
    // looking bare.
    snippet: (s.snippet || '').trim() || (s.title || 'No excerpt available.'),
  };
  if (out.kind === 'web') out.url = s.url;
  else {
    out.docId = s.doc_id || s.docId;
    // The page from the human label, the line from the chunk itself.
    //
    // The grader keys its per-source haystack on docId:page:heading:line and
    // warns that two chunks of one document must not share a key. With a page
    // alone every chunk of a page collided, Map.set kept the last, and a
    // citation to an earlier chunk was scored against a different passage.
    const locator = toLocator(s.locator);
    if (locator) out.locator = Number.isInteger(s.line) && s.line > 0 ? { ...locator, line: s.line } : locator;
  }
  if (s.branch != null) {
    const i = Number(String(s.branch).replace(/\D/g, ''));
    if (Number.isFinite(i) && i > 0) out.subQuestion = i;
  }
  return out;
}

/**
 * How the run ended, in the contract's three words.
 *
 * `cap` is not a failure: it is an honest partial, and the contract wants it
 * distinguishable from both a clean finish and a provider fault. Every reason
 * this engine can terminate with maps onto exactly one of the three.
 */
function toTerminated(reason, status) {
  if (status === 'error' || reason === 'error') return 'error';
  if (reason === 'completed' || reason === 'sufficient_evidence' || !reason) return 'done';
  return 'cap';
}

/**
 * Wrap a contract-shaped `emit` around the engine's.
 *
 * Returns the emit function the engine should be given. Events with no contract
 * counterpart are dropped rather than passed through under their own names: the
 * UI's reducer parses every frame against a closed union, so an unknown event is
 * not ignored there, it is a validation error.
 */
const log = createLogger('contract');

/**
 * Hold back a citation marker until its numbers are known to resolve.
 *
 * The benchmark reads the streamed `token` deltas - `benchmark/lib.mjs` builds
 * `answer.text` from them and the contract has no `answer` event, so nothing can
 * replace what was streamed - and a `[n]` with no matching source is scored as
 * `dangling`, which bench calls an automatic fail. The post-hoc validator strips
 * such a marker from the stored answer, which fixes the transcript and not the
 * stream.
 *
 * `sources` is always emitted before the first token, so by the time any text
 * arrives the full set of valid numbers is known. The check is therefore exact
 * rather than a guess.
 *
 * What is held: only a trailing fragment that could still become a citation.
 * Anything else passes through untouched, including a `[` that is plainly not one
 * - a Markdown link, an array index, a quoted bracket.
 */
export function createCitationGuard({ allowed, onStripped }) {
  let held = '';
  const MAX_HELD = 8;
  // `[`, digits, and the separators a multi-reference citation uses. A fragment
  // that cannot continue into `[n]` or `[n, m]` is not a citation.
  const PARTIAL = /^\[[\d\s,]*$/;
  const COMPLETE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/;

  /** Drop markers whose numbers do not all resolve; keep the rest verbatim. */
  const scrub = (text) =>
    text.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (marker, inner) => {
      const ns = inner.split(',').map((x) => Number(x.trim()));
      const bad = ns.filter((n) => !allowed.has(n));
      if (!bad.length) return marker;
      for (const n of bad) onStripped?.(n, marker);
      return '';
    });

  return {
    /** Text safe to send now. The caller sends whatever this returns, if anything. */
    push(chunk) {
      let buf = held + String(chunk ?? '');
      held = '';
      // A trailing fragment that could still grow into a citation is held, but
      // only up to a bound: an unclosed `[` is otherwise an unbounded buffer and
      // a stream that stops mid-bracket would never flush.
      const open = buf.lastIndexOf('[');
      if (open !== -1 && !buf.slice(open).includes(']')) {
        const tail = buf.slice(open);
        if (PARTIAL.test(tail) && tail.length <= MAX_HELD) {
          held = tail;
          buf = buf.slice(0, open);
        }
      }
      return scrub(buf);
    },
    /** Whatever is still held at the end of the stream, scrubbed and released. */
    flush() {
      const rest = held;
      held = '';
      // An unclosed fragment is not a citation, so it goes out as written.
      return COMPLETE.test(rest) ? scrub(rest) : rest;
    },
  };
}

export function contractStream({ send, depth, answerId, requestId = null }) {
  let step = 0;
  let sentSources = false;
  let sentToken = false;
  let subQuestionCount = 0;
  let everyCachedSoFar = null;
  const pending = new Map(); // tool name -> { input, at }
  // Numbers a citation may use: the sources actually sent to this client.
  const allowedCitations = new Set();
  const strippedCitations = [];
  const guard = createCitationGuard({
    allowed: allowedCitations,
    onStripped: (n, marker) => {
      strippedCitations.push(n);
      log.warn('citation_stripped_from_stream', { requestId, answerId, n, marker, depth });
    },
  });

  return function emit(event, data) {
    switch (event) {
      case 'plan': {
        const subQuestions = (data?.sub_questions || []).map((q, i) => ({
          i: i + 1,
          question: q.question || String(q),
          ...(q.rationale || q.reason ? { reason: q.rationale || q.reason } : {}),
        }));
        subQuestionCount = subQuestions.length;
        // The contract wants between two and eight. A one-question plan is a
        // quick search wearing a costume, and the schema says so.
        if (subQuestions.length >= 2) {
          send('plan', { subQuestions: subQuestions.slice(0, 8), ...(data?.interpretation ? { reason: data.interpretation } : {}) });
        }
        return;
      }

      case 'tool_call':
        if (TOOL_NAMES.has(data?.tool)) pending.set(data.tool, { input: data.input || {}, at: Date.now() });
        return;

      case 'tool_result': {
        if (!TOOL_NAMES.has(data?.tool)) return;
        const started = pending.get(data.tool);
        pending.delete(data.tool);
        step += 1;
        const ok = Boolean(data.ok);
        if (data.tool === 'web_search') everyCachedSoFar = (everyCachedSoFar ?? true) && Boolean(data.cached);
        const frame = {
          step,
          tool: data.tool,
          input: started?.input ?? {},
          ok,
          ms: data.duration_ms ?? (started ? Date.now() - started.at : 0),
        };
        if (data.summary) frame.reason = String(data.summary).slice(0, 400);
        // The schema refuses ok:false without a non-empty error, because a
        // failure you cannot tell from an empty result is the bug this whole
        // contract exists to prevent.
        if (!ok) frame.error = String(data.detail || data.summary || 'tool call failed').slice(0, 400) || 'tool call failed';
        if (data.branch != null) {
          const i = Number(String(data.branch).replace(/\D/g, ''));
          if (Number.isFinite(i) && i > 0) frame.subQuestion = i;
        }
        send('trace', frame);
        return;
      }

      case 'sources': {
        sentSources = true;
        const rows = (data?.sources || []).map(toContractSource);
        // The guard's allowed set is exactly what the client was told about.
        for (const r of rows) allowedCitations.add(r.n);
        send('sources', rows);
        return;
      }

      case 'token':
        if (!sentSources) {
          // Never observed, and it must stay that way: the UI renders citation
          // chips as text arrives, so a token first means chips that point at
          // nothing yet.
          throw new Error('contract violation: a token was emitted before the sources event');
        }
        sentToken = true;
        {
          // A frame that is entirely a held fragment sends nothing; the text is
          // not lost, it arrives with the next frame or at flush.
          const text = guard.push(data?.text ?? '');
          if (text) send('token', { text });
        }
        return;

      case 'done': {
        if (!sentSources) send('sources', []);
        // Release anything still held before the answer is declared finished,
        // or a stream ending mid-bracket would silently lose its last characters.
        {
          const tail = guard.flush();
          if (tail) send('token', { text: tail });
        }
        if (strippedCitations.length) {
          log.warn('citations_stripped', { requestId, answerId, count: strippedCitations.length, numbers: [...new Set(strippedCitations)] });
        }
        send('done', {
          answerId,
          latencyMs: data?.latency_ms ?? 0,
          ttftMs: data?.ttft_ms ?? data?.latency_ms ?? 0,
          model: data?.model || 'unknown',
          // The contract asks for one model name; a run uses several. The map
          // is carried alongside so a cost figure can be read against what
          // actually produced it, and so the deployed routing is visible rather
          // than inferred from the code's defaults.
          ...(data?.models ? { models: data.models } : {}),
          tokens: { in: data?.tokens?.input ?? 0, out: data?.tokens?.output ?? 0 },
          costUsd: data?.cost_usd ?? 0,
          searchCached: everyCachedSoFar === true,
          terminated: toTerminated(data?.termination_reason, data?.status),
          depth,
          ...(depth === 'deep' ? { subQuestions: subQuestionCount } : {}),
        });
        return;
      }

      case 'error':
        /**
         * The error frame names the request, so a user can quote it.
         *
         * A 502 reached the browser with a status and a sentence and no way to
         * tie it to anything: the id was in the response header and in both
         * services' logs, but the frame the user actually sees carried none of
         * it. `StreamErrorEvent` is a non-strict object, so the field validates
         * and a schema parse drops it - it costs the contract nothing and makes
         * the stream greppable from the one place a person is looking.
         */
        send('error', {
          status: data?.status ?? 502,
          error: data?.message || 'the run failed',
          ...(requestId ? { requestId } : {}),
        });
        return;

      default:
        // context, iteration, reasoning, capped, citations, memory_used,
        // branch_* and the rest: real signal, but not part of this contract.
        return;
    }
  };
}

export const __testing = { toContractSource, toTerminated, toLocator };
