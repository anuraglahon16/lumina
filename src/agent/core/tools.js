import { config } from '../../shared/config.js';
import { webSearch } from '../services/search/index.js';
import { fetchPage } from '../services/fetcher.js';
import { searchChunks } from '../services/ragStore.js';
import { saveMemory } from '../services/memoryStore.js';
import { z } from 'zod';

/**
 * Tool definitions handed to the model. Descriptions carry the operating rules
 * that matter at call time (search returns leads, not evidence; fetch is what
 * makes a page citable).
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'web_search',
    description:
      'Search the web for pages relevant to a query. Returns titles, URLs, and short snippets only. These are leads, not evidence, and must not be cited. Fetch the promising results with fetch_page before relying on them. Use focused queries; run separate searches for separate facets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Keywords beat full sentences.' },
        recency: {
          type: 'string',
          enum: ['any', 'recent'],
          description: 'Use "recent" when the answer depends on current information.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description:
      'Fetch a URL and extract its readable text. This is the only way a web page becomes citable evidence. Fetch a page when its snippet suggests it holds the specifics you need: numbers, dates, definitions, primary statements.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL, normally taken from web_search results.' },
        reason: { type: 'string', description: 'What you expect this page to establish (one short phrase).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_documents',
    description:
      "Semantic search over the user's uploaded documents. Returns passages with their page numbers; these are citable immediately. Use it whenever the question might concern the user's own material.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in the documents.' },
        doc_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict to specific document ids.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Store a durable fact about the user for future sessions: a stated preference, their role or project, a constraint they work under. Only for things the user said about themselves that will still matter next month. Never store topic facts, findings, or anything from sources.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'A third-person statement about the user.' },
        kind: { type: 'string', enum: ['preference', 'fact', 'project', 'constraint'] },
      },
      required: ['content'],
    },
  },
];

/**
 * Schemas for the arguments the *model* supplies.
 *
 * `input_schema` above tells the model what to send; nothing enforced that it
 * did. An absent `query` reached web_search as `undefined` and searched the
 * string "undefined"; a non-string `url` reached the fetcher. The harness rule
 * applies to tool arguments as much as to budgets: state the contract in the
 * description, enforce it at the boundary.
 *
 * A violation is returned to the model as a correctable tool result rather than
 * thrown, because the model can fix its own arguments if it is told what was
 * wrong. Since the call produced no evidence, the budget refund applies and it
 * gets a bounded number of attempts.
 */
const TOOL_INPUT_SCHEMAS = {
  web_search: z.object({
    query: z.string().trim().min(1, 'query must be a non-empty string').max(400),
    recency: z.enum(['any', 'recent']).optional(),
  }),
  fetch_page: z.object({
    url: z.string().trim().min(1).max(2048),
    reason: z.string().trim().max(300).optional(),
  }),
  search_documents: z.object({
    query: z.string().trim().min(1, 'query must be a non-empty string').max(400),
    doc_ids: z.array(z.string().min(1)).max(50).optional(),
  }),
  remember: z.object({
    content: z.string().trim().min(1, 'content must be a non-empty string').max(1000),
    kind: z.enum(['preference', 'fact', 'project', 'constraint']).optional(),
  }),
};

/** @returns {{ ok: true, value: object } | { ok: false, message: string }} */
export function validateToolInput(name, input) {
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (!schema) return { ok: false, message: `unknown tool "${name}"` };
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const message = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, message };
}

/**
 * Which tools this run may call.
 *
 * `retrievalMode` is the caller saying where the answer should come from. Asked
 * a question about an uploaded document, a model handed a web search will
 * often take it, answer from the web, and produce something plausible that
 * never touched the document — so "search the documents" is enforced by not
 * offering the web rather than by asking nicely in a prompt.
 */
export function toolDefinitionsFor({ hasDocuments, retrievalMode = 'auto' }) {
  const WEB = new Set(['web_search', 'fetch_page']);
  return TOOL_DEFINITIONS.filter((t) => {
    if (t.name === 'search_documents' && !hasDocuments) return false;
    if (retrievalMode === 'docs' && WEB.has(t.name)) return false;
    if (retrievalMode === 'web' && t.name === 'search_documents') return false;
    return true;
  });
}

/**
 * Build the executor that backs those definitions for one run (or one Deep
 * Search branch). It is responsible for budget accounting, ledger updates,
 * trace emission, and converting results into compact text for the model.
 */
export function createToolExecutor({
  ledger,
  budget,
  recorder,
  emit,
  userId,
  threadId,
  runId,
  branch = null,
  spaceId = null,
  // The Deep run's shared pool. Absent for Quick, which has its own budget and
  // one loop to spend it.
  slots = null,
  // Injected the same way `gatherFromWeb` injects them, and for the same
  // reason: what is worth testing here is attribution, budgets and ledger
  // bookkeeping, none of which is about the network. Without this a Deep test
  // must replace the whole executor, which then writes no sources and cannot
  // exercise deduplication - the exact shape of disconnection this codebase
  // has been bitten by before.
  webSearch: searchFn = webSearch,
  fetchPage: fetchFn = fetchPage,
}) {
  async function run(name, rawInput) {
    const checked = validateToolInput(name, rawInput);
    if (!checked.ok) {
      return {
        ok: false,
        summary: `invalid arguments: ${checked.message}`,
        detail: { tool: name, problem: checked.message },
        content: `Invalid arguments for ${name}: ${checked.message}. Check the tool's schema and call it again with corrected arguments.`,
      };
    }
    const input = checked.value;

    switch (name) {
      case 'web_search':
        return runWebSearch(input);
      case 'fetch_page':
        return runFetchPage(input);
      case 'search_documents':
        return runSearchDocuments(input);
      case 'remember':
        return runRemember(input);
      default:
        return { ok: false, summary: `unknown tool ${name}`, content: `Error: unknown tool "${name}".` };
    }
  }

  async function runWebSearch({ query, recency }) {
    const q = recency === 'recent' ? `${query} ${new Date().getFullYear()}` : query;
    const { results, provider, cached, degraded, provider_errors } = await searchFn(q, { recorder });
    ledger.noteCandidates(results, { branch });
    if (!results.length) {
      return {
        ok: false,
        cached,
        summary: `0 results (${provider || 'no provider'})`,
        detail: { query: q, provider, provider_errors },
        content: `No results for "${q}". ${provider_errors?.length ? `Provider errors: ${provider_errors.join('; ')}. ` : ''}Try different keywords.`,
      };
    }
    const content = [
      `${results.length} result(s) for "${q}"${degraded ? ' (keyless fallback provider, quality is lower)' : ''}:`,
      ...results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || '(no snippet)'}`),
      '',
      'These are leads only. Call fetch_page on the ones worth reading before citing anything.',
    ].join('\n');
    return {
      ok: true,
      cached,
      summary: `${results.length} results via ${provider}${cached ? ' (cached)' : ''}`,
      detail: { query: q, provider, degraded, results: results.map((r) => ({ title: r.title, url: r.url, domain: r.domain })) },
      content,
    };
  }

  async function runFetchPage({ url, reason }) {
    const page = await fetchFn(url, { recorder });
    if (!page.ok) {
      return {
        ok: false,
        cached: page.cached,
        summary: `failed: ${page.error}`,
        detail: { url, error: page.error, status: page.status },
        content: `Could not read ${url}: ${page.error}. Do not cite it; try another source.`,
      };
    }
    const source = ledger.addWebSource(page, { branch, query: reason });
    const body = source.passages.join('\n\n').slice(0, 6000);
    return {
      ok: true,
      cached: page.cached,
      summary: `read "${source.title}" (${source.passages.length} passages)${page.cached ? ' (cached)' : ''}`,
      detail: { url: source.url, title: source.title, source_n: source.n, chars: page.text?.length || 0 },
      source,
      content: `Fetched and indexed as evidence [${source.n}]: ${source.title}\nURL: ${source.url}${
        source.published_at ? `\nPublished: ${source.published_at}` : ''
      }\n\n${body}${page.truncated ? '\n\n[page truncated at the size limit]' : ''}`,
    };
  }

  async function runSearchDocuments({ query, doc_ids }) {
    const { results, corpus_size, embedding_provider } = await searchChunks(query, { userId, docIds: doc_ids, spaceId, recorder });
    if (!results.length) {
      return {
        ok: false,
        summary: `0 passages (corpus ${corpus_size} chunks)`,
        detail: { query, corpus_size },
        content: corpus_size
          ? `No passages in the uploaded documents matched "${query}".`
          : 'The user has no indexed documents yet.',
      };
    }
    const sources = results.map((r) => ledger.addDocumentSource(r, { branch, query }));
    const content = [
      `${results.length} passage(s) from uploaded documents, already citable:`,
      ...sources.map((s, i) => `[${s.n}] ${s.title}, ${s.locator} (score ${results[i].score})\n${results[i].text.slice(0, 1500)}`),
    ].join('\n\n');
    return {
      ok: true,
      summary: `${results.length} passages from ${new Set(results.map((r) => r.filename)).size} document(s)`,
      detail: { query, embedding_provider, hits: results.map((r) => ({ filename: r.filename, page: r.page, score: r.score })) },
      sources,
      content,
    };
  }

  async function runRemember({ content, kind }) {
    const saved = await saveMemory({
      userId,
      content,
      kind,
      source: 'agent_tool',
      threadId,
      runId,
      confidence: 0.9,
    });
    emit?.('memory_saved', { memory: saved ? { id: saved.id, content: saved.content, kind: saved.kind } : null, origin: 'tool' });
    return {
      ok: Boolean(saved),
      summary: saved ? `remembered: ${saved.content.slice(0, 60)}` : 'nothing saved',
      detail: { kind: saved?.kind },
      content: saved ? 'Saved to long-term memory.' : 'Nothing was saved.',
    };
  }

  /**
   * Execute one tool call end to end: budget gate, execution, trace events,
   * run-log entry. Returns the string the model sees as the tool result.
   */
  return async function execute(name, input) {
    const gate = budget.allows(name);
    if (!gate.ok) {
      budget.markCapped(gate.reason);
      slots?.noteBranchRefusal();
      emit?.('tool_blocked', { tool: name, reason: gate.reason, branch, budget: budget.snapshot() });
      recorder?.recordToolCall({ name, input, durationMs: 0, ok: false, summary: `blocked: ${gate.reason}`, error: gate.reason, branch });
      return {
        ok: false,
        blocked: true,
        reason: gate.reason,
        content: `Budget limit reached (${gate.reason}). No further ${name} calls are possible. Stop calling tools and finish with the evidence already gathered.`,
      };
    }

    // The shared claim, taken synchronously before any await. A branch that
    // passes its own budget check can still be refused here, because the pool
    // is what the grader counts and the other branches are spending from it.
    const permit = slots ? slots.tryClaim() : null;
    if (slots && !permit) {
      budget.markCapped(slots.capReason);
      emit?.('tool_blocked', { tool: name, reason: slots.capReason, branch, budget: budget.snapshot() });
      recorder?.recordToolCall({ name, input, durationMs: 0, ok: false, summary: `blocked: ${slots.capReason}`, error: slots.capReason, branch });
      return {
        ok: false,
        blocked: true,
        reason: slots.capReason,
        content: `The deep search tool budget is spent (${slots.capReason}). No further tool calls are possible in this run. Finish with the evidence already gathered.`,
      };
    }

    budget.consume(name);
    emit?.('tool_call', { tool: name, input, branch, budget: budget.snapshot() });
    const started = performance.now();
    try {
      const result = await run(name, input);
      const durationMs = Math.round(performance.now() - started);
      // A call that produced nothing citable bought no research, so return its
      // slot rather than letting a blocked site truncate the run. Budget.refund
      // caps how often this can happen and never refunds the wall clock.
      const refunded = result.ok ? false : budget.refund(name, result.summary);
      recorder?.recordToolCall({ name, input, durationMs, ok: result.ok, summary: result.summary, cached: result.cached, branch });
      emit?.('tool_result', {
        tool: name,
        ok: result.ok,
        cached: Boolean(result.cached),
        summary: result.summary,
        detail: result.detail,
        duration_ms: durationMs,
        refunded,
        budget: budget.snapshot(),
        branch,
      });
      if (result.source) emit?.('source_added', { source: publicSource(result.source), branch });
      if (result.sources) for (const s of result.sources) emit?.('source_added', { source: publicSource(s), branch });
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      recorder?.recordToolCall({ name, input, durationMs, ok: false, summary: 'error', error: err.message, branch });
      emit?.('tool_result', { tool: name, ok: false, summary: `error: ${err.message}`, duration_ms: durationMs, branch });
      return { ok: false, content: `Tool ${name} failed: ${err.message}. Continue with another approach.` };
    } finally {
      // The slot stays spent; settling only clears the in-flight count, so a
      // call that threw does not leave the pool believing it is still running.
      slots?.settle(permit);
    }
  };
}

function publicSource(s) {
  return {
    n: s.n,
    id: s.id,
    type: s.type,
    title: s.title,
    url: s.url,
    domain: s.domain,
    locator: s.locator,
    page: s.page ?? null,
    line: s.line ?? null,
    snippet: s.snippet,
    published_at: s.published_at ?? null,
    from_cache: Boolean(s.from_cache),
    // Same reason as publicSources: the contract reads `branch`, singular, and
    // the first discoverer is the stable owner.
    branch: s.branches?.[0] ?? null,
  };
}

