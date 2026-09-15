import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/**
 * Central configuration. Every secret is read from process.env and never
 * written to disk, never logged, and never sent to the browser.
 */
export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',

  gateway: {
    port: num(process.env.GATEWAY_PORT, 8080),
    agentUrl: process.env.AGENT_URL || 'http://127.0.0.1:8787',
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),
    // Per-user token buckets. Deep Search is far more expensive, so it gets its own.
    rateLimits: {
      global: { capacity: num(process.env.RL_GLOBAL_CAPACITY, 120), refillPerSec: num(process.env.RL_GLOBAL_REFILL, 2) },
      quick: { capacity: num(process.env.RL_QUICK_CAPACITY, 20), refillPerSec: num(process.env.RL_QUICK_REFILL, 0.2) },
      deep: { capacity: num(process.env.RL_DEEP_CAPACITY, 3), refillPerSec: num(process.env.RL_DEEP_REFILL, 0.01) },
      upload: { capacity: num(process.env.RL_UPLOAD_CAPACITY, 10), refillPerSec: num(process.env.RL_UPLOAD_REFILL, 0.05) },
      // Minting a new identity is what an attacker does to get a fresh bucket,
      // so issuance is itself limited, keyed by address rather than by user.
      // Tuned to roughly the quick refill rate: evading a per-user limit by
      // taking new identities then buys no more throughput than staying put.
      // Too tight would lock out legitimate users sharing an address behind NAT.
      identity: { capacity: num(process.env.RL_IDENTITY_CAPACITY, 15), refillPerSec: num(process.env.RL_IDENTITY_REFILL, 0.2) },
    },
    maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024),
    // Shared-password gate for demo deployments. Unset means no gate (local dev).
    demoPassword: process.env.DEMO_PASSWORD || undefined,
    // Signing secret for user-identity tokens. Unset means unsigned ids, which
    // are forgeable and therefore make per-user rate limits advisory.
    authSecret: process.env.AUTH_SECRET || undefined,
    authTtlSeconds: num(process.env.AUTH_TTL_SECONDS, 365 * 24 * 60 * 60),
    // Who may embed the UI in a frame. Denying everything is the right default
    // against clickjacking, but some hosts (Hugging Face Spaces) serve the app
    // inside their own page, where a blanket deny shows "refused to connect".
    frameAncestors: (process.env.FRAME_ANCESTORS || "'none'").trim(),
    // Allowing a host page to frame the app means its requests are cross-site,
    // and a SameSite=Lax cookie is not sent on those. Identity would then reset
    // on every request inside the frame, so the same intent has to relax the
    // cookie too. Kept as one derived flag so the two cannot disagree.
    get embedded() {
      return this.frameAncestors !== "'none'";
    },
  },

  /**
   * MongoDB, optional.
   *
   * Unset means the JSON store, which is correct for one container. Set it when
   * you need state shared between processes, or a vector index larger than
   * memory. `vectorBackend` exists because $vectorSearch is an Atlas feature: a
   * local mongod cannot do it, so development falls back to scanning and health
   * says which one is live rather than leaving it to be guessed.
   */
  mongo: {
    uri: process.env.MONGODB_URI || undefined,
    db: process.env.MONGODB_DB || 'lumina',
    vectorBackend: process.env.VECTOR_BACKEND || (process.env.MONGODB_URI?.includes('mongodb+srv') ? 'atlas-vector-search' : 'mongo-cosine-scan'),
    vectorIndex: process.env.VECTOR_INDEX || 'chunk_vector_index',
    vectorDim: num(process.env.VECTOR_DIM, 1024),
  },

  agent: {
    port: num(process.env.AGENT_PORT, 8787),
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    // How long to let in-flight work finish on SIGTERM. Keep below the
    // platform's own SIGKILL grace period or the drain is pointless.
    shutdownGraceMs: num(process.env.SHUTDOWN_GRACE_MS, 15000),
  },

  llm: {
    // A copied-but-unedited .env.example must not look like a configured key.
    apiKey: /^sk-ant-\.\.\.$|^$/.test(process.env.ANTHROPIC_API_KEY || '') ? undefined : process.env.ANTHROPIC_API_KEY,
    /**
     * Model routing, by what a mistake costs rather than by how hard the task
     * looks.
     *
     * `model` answers the user: the Quick research loop, the Deep Search plan,
     * and synthesis. Synthesis in particular is where citations and
     * groundedness are produced, so it never runs on the cheapest tier.
     *
     * `branchModel` runs Deep Search sub-questions. Those are parallel workers
     * with narrow scope and their own budgets, so they are the natural place to
     * trade capability for cost. It defaults to `model`, which keeps behaviour
     * unchanged until it is set deliberately.
     *
     * `fastModel` runs mechanical off-path work: memory extraction and the eval
     * judge. Note that Haiku rejects adaptive thinking and effort, which
     * core/llm.js shapes the request for.
     */
    model: process.env.LUMINA_MODEL || 'claude-sonnet-5',
    branchModel: process.env.LUMINA_BRANCH_MODEL || process.env.LUMINA_MODEL || 'claude-sonnet-5',
    fastModel: process.env.LUMINA_FAST_MODEL || 'claude-haiku-4-5',
    maxRetries: num(process.env.LLM_MAX_RETRIES, 2),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 120000),
    // Circuit breaker above the SDK's retries: consecutive provider faults
    // before calls fail fast, and how long to wait before probing once.
    breakerThreshold: num(process.env.LLM_BREAKER_THRESHOLD, 4),
    breakerCooldownMs: num(process.env.LLM_BREAKER_COOLDOWN_MS, 30000),
  },

  // Hard execution limits. Quick mode is deliberately small and must report
  // honestly when it hits a cap; Deep Search gets its own, larger envelope.
  budgets: {
    quick: {
      maxIterations: num(process.env.QUICK_MAX_ITERATIONS, 4),
      maxToolCalls: num(process.env.QUICK_MAX_TOOL_CALLS, 6),
      maxFetches: num(process.env.QUICK_MAX_FETCHES, 4),
      maxSearches: num(process.env.QUICK_MAX_SEARCHES, 3),
      wallClockMs: num(process.env.QUICK_WALL_CLOCK_MS, 60000),
      maxTokens: num(process.env.QUICK_MAX_TOKENS, 8000),
      maxRefunds: num(process.env.QUICK_MAX_REFUNDS, 3),
      effort: process.env.QUICK_EFFORT || 'medium',
    },
    deep: {
      maxSubQuestions: num(process.env.DEEP_MAX_SUBQUESTIONS, 5),
      maxIterationsPerBranch: num(process.env.DEEP_BRANCH_MAX_ITERATIONS, 4),
      maxToolCallsPerBranch: num(process.env.DEEP_BRANCH_MAX_TOOL_CALLS, 6),
      maxFetchesPerBranch: num(process.env.DEEP_BRANCH_MAX_FETCHES, 4),
      branchConcurrency: num(process.env.DEEP_BRANCH_CONCURRENCY, 3),
      wallClockMs: num(process.env.DEEP_WALL_CLOCK_MS, 420000),
      maxTokens: num(process.env.DEEP_MAX_TOKENS, 16000),
      maxRefunds: num(process.env.DEEP_BRANCH_MAX_REFUNDS, 3),
      effort: process.env.DEEP_EFFORT || 'high',
    },
  },

  search: {
    provider: process.env.SEARCH_PROVIDER || 'auto',
    braveKey: process.env.BRAVE_API_KEY,
    tavilyKey: process.env.TAVILY_API_KEY,
    serperKey: process.env.SERPER_API_KEY,
    searxngUrl: process.env.SEARXNG_URL,
    resultsPerQuery: num(process.env.SEARCH_RESULTS, 6),
    timeoutMs: num(process.env.SEARCH_TIMEOUT_MS, 12000),
  },

  fetcher: {
    timeoutMs: num(process.env.FETCH_TIMEOUT_MS, 15000),
    maxBytes: num(process.env.FETCH_MAX_BYTES, 3 * 1024 * 1024),
    maxChars: num(process.env.FETCH_MAX_CHARS, 24000),
    userAgent: process.env.FETCH_USER_AGENT || 'LuminaBot/1.0 (+research agent; respects robots)',
    respectRobots: bool(process.env.RESPECT_ROBOTS, true),
    concurrency: num(process.env.FETCH_CONCURRENCY, 4),
  },

  cache: {
    enabled: bool(process.env.CACHE_ENABLED, true),
    searchTtlMs: num(process.env.CACHE_SEARCH_TTL_MS, 30 * 60 * 1000),
    // A fetched page is the expensive half of a run, in latency and in budget,
    // and an article's text rarely changes within a day. Search results keep a
    // short TTL because freshness is the point of searching.
    fetchTtlMs: num(process.env.CACHE_FETCH_TTL_MS, 24 * 60 * 60 * 1000),
    embedTtlMs: num(process.env.CACHE_EMBED_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 2000),
  },

  embeddings: {
    provider: process.env.EMBEDDING_PROVIDER || 'auto',
    voyageKey: process.env.VOYAGE_API_KEY,
    voyageModel: process.env.VOYAGE_MODEL || 'voyage-3.5',
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    localDim: num(process.env.LOCAL_EMBEDDING_DIM, 512),
    batchSize: num(process.env.EMBEDDING_BATCH_SIZE, 64),
  },

  rag: {
    chunkChars: num(process.env.RAG_CHUNK_CHARS, 1200),
    chunkOverlap: num(process.env.RAG_CHUNK_OVERLAP, 180),
    topK: num(process.env.RAG_TOP_K, 6),
    // Hybrid retrieval: dense cosine blended with BM25 lexical score.
    denseWeight: num(process.env.RAG_DENSE_WEIGHT, 0.65),
  },

  memory: {
    maxLongTerm: num(process.env.MEMORY_MAX_LONG_TERM, 200),
    injectTopK: num(process.env.MEMORY_INJECT_TOP_K, 5),
    threadWindow: num(process.env.MEMORY_THREAD_WINDOW, 8),
    extractEnabled: bool(process.env.MEMORY_EXTRACT_ENABLED, true),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    runLogFile: process.env.RUN_LOG_FILE || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'runs.ndjson'),
  },
};

/** USD per 1M tokens. Used to price every run from reported usage. */
export const PRICING = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * An unknown model id falls back to the most expensive entry on purpose:
 * overstating spend is a visible annoyance, understating it hides real cost.
 */
export function priceFor(model) {
  if (PRICING[model]) return PRICING[model];
  return Object.values(PRICING).reduce((a, b) => (b.output > a.output ? b : a));
}

/** Report which capabilities are actually wired up, without leaking key values. */
export function capabilities() {
  return {
    llm: Boolean(config.llm.apiKey),
    search: {
      brave: Boolean(config.search.braveKey),
      tavily: Boolean(config.search.tavilyKey),
      serper: Boolean(config.search.serperKey),
      searxng: Boolean(config.search.searxngUrl),
      duckduckgo: true,
    },
    embeddings: {
      voyage: Boolean(config.embeddings.voyageKey),
      openai: Boolean(config.embeddings.openaiKey),
      local: true,
    },
  };
}
