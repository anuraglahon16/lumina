import { z } from 'zod';
import { AnswerId, DocId, MemoryId, SpaceId, ThreadId } from './ids.js';
import { Depth, DoneEvent, Source } from './sse.js';
/**
 * Every route in PRD 7, as request and response schemas. The gateway validates inbound
 * bodies with these; the agent service validates what it sends back; the UI compiles
 * against the inferred types. One definition, three consumers, no drift.
 *
 * `X-User-Id` is required on every route except GET /health.
 */
export const USER_HEADER = 'x-user-id';
export const REQUEST_HEADER = 'x-request-id';
/** 400 · 401 · 404 · 413 · 429 · 501 · 502 all use this body. */
export const ErrorBody = z.object({
    error: z.string().min(1),
    status: z.number().int().optional(),
    /** 429 from the image cap says when the cap resets. */
    resetsAt: z.string().datetime().optional(),
    requestId: z.string().optional()
});
// ---------------------------------------------------------------- threads
export const CreateThreadBody = z.object({ title: z.string().min(1).max(200).optional() });
export const CreateThreadResponse = z.object({ threadId: ThreadId });
export const ThreadMessage = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    sources: z.array(Source).optional(),
    answerId: AnswerId.optional(),
    done: DoneEvent.partial().optional(),
    createdAt: z.string().datetime().optional()
});
export const GetThreadResponse = z.object({
    threadId: ThreadId.optional(),
    title: z.string().optional(),
    messages: z.array(ThreadMessage)
});
export const ListThreadsResponse = z.object({
    threads: z.array(z.object({ threadId: ThreadId, title: z.string(), createdAt: z.string().datetime() }))
});
/** How the router picks retrieval: web, the Space's documents, or its own decision. */
export const AskMode = z.enum(['auto', 'web', 'docs']);
export const AskBody = z.object({
    query: z.string().min(1, 'query is required').max(2000),
    /** Where to look. */
    mode: AskMode.default('auto'),
    /**
     * How hard to look. Defaults to quick on purpose: deep costs several times as much, so
     * it is something a user opts into, never somewhere the server drifts.
     */
    depth: Depth.default('quick'),
    spaceId: SpaceId.optional()
});
// ---------------------------------------------------------------- memory
export const Memory = z.object({
    id: MemoryId,
    text: z.string().min(1),
    sourceThread: ThreadId.optional(),
    createdAt: z.string().datetime()
});
export const ListMemoryResponse = z.object({ memories: z.array(Memory) });
// ---------------------------------------------------------------- spaces & documents
export const CreateSpaceBody = z.object({ name: z.string().min(1).max(120) });
export const CreateSpaceResponse = z.object({ spaceId: SpaceId, name: z.string() });
export const ListSpacesResponse = z.object({
    spaces: z.array(z.object({ spaceId: SpaceId, name: z.string(), createdAt: z.string().datetime() }))
});
/** pending → parsing → embedding → indexed, or failed. `indexed` only after the probe. */
export const DocStatus = z.enum(['pending', 'parsing', 'embedding', 'indexed', 'failed']);
export const UploadDocumentResponse = z.object({
    docId: DocId,
    status: z.literal('pending')
});
export const DocumentRow = z.object({
    docId: DocId,
    title: z.string(),
    status: DocStatus,
    pct: z.number().min(0).max(100),
    pages: z.number().int().positive().optional(),
    chunks: z.number().int().nonnegative().optional(),
    error: z.string().optional()
});
export const ListDocumentsResponse = z.object({ documents: z.array(DocumentRow) });
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_UPLOAD_TYPES = [
    'application/pdf',
    'text/markdown',
    'text/plain'
];
// ---------------------------------------------------------------- health & stats
/**
 * `/health` must NAME what is live, not be restricted to one stack. A grader reading a
 * recall number has to know whether it came from an approximate vector index or an exact
 * scan, and whether search came from Tavily or SerpApi — so these are free strings with
 * documented conventional values rather than closed enums.
 *
 * MERN is the taught path (`atlas-vector-search`, or `mongo-cosine-scan` for the local-dev
 * fallback). If you build on something else, say so here: `qdrant`, `pgvector`,
 * `pinecone`. What is graded is the contract and the gates, and both speak HTTP.
 */
export const HealthResponse = z.object({
    status: z.enum(['ok', 'degraded']),
    /** The LLM actually serving answers, e.g. "claude-sonnet-5". Never a key. */
    model: z.string().min(1),
    /** Conventionally "tavily" or "serpapi". Name whatever is live. */
    searchProvider: z.string().min(1),
    /**
     * Conventionally "atlas-vector-search" or "mongo-cosine-scan" on the taught path.
     * Name whatever is live; a recall number is not comparable without it.
     */
    vectorStore: z.string().min(1),
    db: z.enum(['ok', 'down']),
    /** The gateway nests the agent service's own /health here. */
    ai: z.object({ status: z.enum(['ok', 'down']) }).passthrough().optional(),
    version: z.string().optional()
});
/** The values the taught MERN path reports, for reference and for the local-dev fallback. */
export const VECTOR_BACKENDS = ['atlas-vector-search', 'mongo-cosine-scan'];
export const SEARCH_PROVIDERS = ['tavily', 'serpapi'];
export const StatsResponse = z.object({
    requests: z.number().int().nonnegative(),
    answers: z.number().int().nonnegative(),
    searchCacheHitRatePct: z.number().min(0).max(100),
    ttftP95Ms: z.number().nonnegative(),
    costUsdToday: z.number().nonnegative(),
    /** Deep searches this user has spent today, and the cap that stops them. */
    deepToday: z.number().int().nonnegative(),
    deepDailyCap: z.number().int().nonnegative()
});
// ---------------------------------------------------------------- route table
/**
 * The routes the UI calls, in one place, so a skeleton can register all of them as 501
 * and the bench can walk them. `auth: false` means no X-User-Id required.
 */
export const ROUTES = [
    { method: 'GET', path: '/health', auth: false },
    { method: 'GET', path: '/stats', auth: true },
    { method: 'GET', path: '/evals/report.json', auth: false },
    { method: 'POST', path: '/threads', auth: true },
    { method: 'GET', path: '/threads', auth: true },
    { method: 'GET', path: '/threads/:threadId', auth: true },
    { method: 'POST', path: '/threads/:threadId/ask', auth: true },
    { method: 'GET', path: '/memory', auth: true },
    { method: 'DELETE', path: '/memory/:memoryId', auth: true },
    { method: 'POST', path: '/spaces', auth: true },
    { method: 'GET', path: '/spaces', auth: true },
    { method: 'POST', path: '/spaces/:spaceId/documents', auth: true },
    { method: 'GET', path: '/spaces/:spaceId/documents', auth: true }
];
//# sourceMappingURL=http.js.map