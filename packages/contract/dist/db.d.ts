import { z } from 'zod';
export declare const ThreadDoc: z.ZodObject<{
    _id: z.ZodString;
    userId: z.ZodString;
    title: z.ZodString;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    title: string;
    createdAt: string | Date;
    _id: string;
    userId: string;
}, {
    title: string;
    createdAt: string | Date;
    _id: string;
    userId: string;
}>;
export type ThreadDoc = z.infer<typeof ThreadDoc>;
export declare const MessageDoc: z.ZodObject<{
    _id: z.ZodString;
    threadId: z.ZodString;
    userId: z.ZodString;
    role: z.ZodEnum<["user", "assistant"]>;
    content: z.ZodString;
    answerId: z.ZodOptional<z.ZodString>;
    sources: z.ZodDefault<z.ZodArray<z.ZodEffects<z.ZodObject<{
        n: z.ZodNumber;
        kind: z.ZodEnum<["web", "doc"]>;
        title: z.ZodString;
        snippet: z.ZodString;
        url: z.ZodOptional<z.ZodString>;
        docId: z.ZodOptional<z.ZodString>;
        locator: z.ZodOptional<z.ZodEffects<z.ZodObject<{
            page: z.ZodOptional<z.ZodNumber>;
            heading: z.ZodOptional<z.ZodString>;
            line: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        }, {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        }>, {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        }, {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        }>>;
        subQuestion: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }, {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }>, {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }, {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }>, "many">>;
    done: z.ZodOptional<z.ZodObject<{
        answerId: z.ZodString;
        latencyMs: z.ZodNumber;
        ttftMs: z.ZodNumber;
        model: z.ZodString;
        tokens: z.ZodObject<{
            in: z.ZodNumber;
            out: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            in: number;
            out: number;
        }, {
            in: number;
            out: number;
        }>;
        costUsd: z.ZodNumber;
        searchCached: z.ZodBoolean;
        terminated: z.ZodEnum<["done", "cap", "error"]>;
        depth: z.ZodEnum<["quick", "deep"]>;
        subQuestions: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        answerId: string;
        latencyMs: number;
        ttftMs: number;
        model: string;
        tokens: {
            in: number;
            out: number;
        };
        costUsd: number;
        searchCached: boolean;
        terminated: "error" | "done" | "cap";
        depth: "quick" | "deep";
        subQuestions?: number | undefined;
    }, {
        answerId: string;
        latencyMs: number;
        ttftMs: number;
        model: string;
        tokens: {
            in: number;
            out: number;
        };
        costUsd: number;
        searchCached: boolean;
        terminated: "error" | "done" | "cap";
        depth: "quick" | "deep";
        subQuestions?: number | undefined;
    }>>;
    /** The plan a deep search ran, stored so the answer stays explainable after the stream. */
    subQuestions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        i: z.ZodNumber;
        question: z.ZodString;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        i: number;
        question: string;
        reason?: string | undefined;
    }, {
        i: number;
        question: string;
        reason?: string | undefined;
    }>, "many">>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    threadId: string;
    sources: {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }[];
    role: "user" | "assistant";
    content: string;
    createdAt: string | Date;
    _id: string;
    userId: string;
    answerId?: string | undefined;
    subQuestions?: {
        i: number;
        question: string;
        reason?: string | undefined;
    }[] | undefined;
    done?: {
        answerId: string;
        latencyMs: number;
        ttftMs: number;
        model: string;
        tokens: {
            in: number;
            out: number;
        };
        costUsd: number;
        searchCached: boolean;
        terminated: "error" | "done" | "cap";
        depth: "quick" | "deep";
        subQuestions?: number | undefined;
    } | undefined;
}, {
    threadId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string | Date;
    _id: string;
    userId: string;
    answerId?: string | undefined;
    subQuestions?: {
        i: number;
        question: string;
        reason?: string | undefined;
    }[] | undefined;
    done?: {
        answerId: string;
        latencyMs: number;
        ttftMs: number;
        model: string;
        tokens: {
            in: number;
            out: number;
        };
        costUsd: number;
        searchCached: boolean;
        terminated: "error" | "done" | "cap";
        depth: "quick" | "deep";
        subQuestions?: number | undefined;
    } | undefined;
    sources?: {
        n: number;
        kind: "doc" | "web";
        title: string;
        snippet: string;
        docId?: string | undefined;
        subQuestion?: number | undefined;
        url?: string | undefined;
        locator?: {
            page?: number | undefined;
            heading?: string | undefined;
            line?: number | undefined;
        } | undefined;
    }[] | undefined;
}>;
export type MessageDoc = z.infer<typeof MessageDoc>;
export declare const EMBEDDING_DIMS = 1536;
export declare const MemoryDoc: z.ZodObject<{
    _id: z.ZodString;
    userId: z.ZodString;
    text: z.ZodString;
    embedding: z.ZodArray<z.ZodNumber, "many">;
    sourceThread: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    text: string;
    createdAt: string | Date;
    embedding: number[];
    _id: string;
    userId: string;
    sourceThread?: string | undefined;
}, {
    text: string;
    createdAt: string | Date;
    embedding: number[];
    _id: string;
    userId: string;
    sourceThread?: string | undefined;
}>;
export type MemoryDoc = z.infer<typeof MemoryDoc>;
export declare const SpaceDoc: z.ZodObject<{
    _id: z.ZodString;
    userId: z.ZodString;
    name: z.ZodString;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    createdAt: string | Date;
    name: string;
    _id: string;
    userId: string;
}, {
    createdAt: string | Date;
    name: string;
    _id: string;
    userId: string;
}>;
export type SpaceDoc = z.infer<typeof SpaceDoc>;
export declare const DocumentDoc: z.ZodObject<{
    _id: z.ZodString;
    spaceId: z.ZodString;
    userId: z.ZodString;
    title: z.ZodString;
    mimeType: z.ZodString;
    bytes: z.ZodNumber;
    status: z.ZodEnum<["pending", "parsing", "embedding", "indexed", "failed"]>;
    pct: z.ZodNumber;
    pages: z.ZodOptional<z.ZodNumber>;
    chunks: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
    /** GridFS id of the raw upload. */
    fileId: z.ZodString;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    spaceId: string;
    status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
    title: string;
    createdAt: string | Date;
    pct: number;
    _id: string;
    userId: string;
    mimeType: string;
    bytes: number;
    fileId: string;
    error?: string | undefined;
    pages?: number | undefined;
    chunks?: number | undefined;
}, {
    spaceId: string;
    status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
    title: string;
    createdAt: string | Date;
    pct: number;
    _id: string;
    userId: string;
    mimeType: string;
    bytes: number;
    fileId: string;
    error?: string | undefined;
    pages?: number | undefined;
    chunks?: number | undefined;
}>;
export type DocumentDoc = z.infer<typeof DocumentDoc>;
export declare const ChunkDoc: z.ZodObject<{
    _id: z.ZodString;
    docId: z.ZodString;
    spaceId: z.ZodString;
    userId: z.ZodString;
    /** The chunk's own text. This is what a citation's snippet must be found in. */
    text: z.ZodString;
    locator: z.ZodEffects<z.ZodObject<{
        page: z.ZodOptional<z.ZodNumber>;
        heading: z.ZodOptional<z.ZodString>;
        line: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    }, {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    }>, {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    }, {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    }>;
    ord: z.ZodNumber;
    embedding: z.ZodArray<z.ZodNumber, "many">;
    createdAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
}, "strip", z.ZodTypeAny, {
    spaceId: string;
    docId: string;
    locator: {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    };
    text: string;
    embedding: number[];
    _id: string;
    userId: string;
    ord: number;
    createdAt?: string | Date | undefined;
}, {
    spaceId: string;
    docId: string;
    locator: {
        page?: number | undefined;
        heading?: string | undefined;
        line?: number | undefined;
    };
    text: string;
    embedding: number[];
    _id: string;
    userId: string;
    ord: number;
    createdAt?: string | Date | undefined;
}>;
export type ChunkDoc = z.infer<typeof ChunkDoc>;
export declare const SearchCacheDoc: z.ZodObject<{
    /** sha256 of (normalized query + provider). */
    _id: z.ZodString;
    provider: z.ZodEnum<["tavily", "serpapi"]>;
    query: z.ZodString;
    results: z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">;
    /** The TTL index on this field is what expires the row; do not delete rows by hand. */
    expiresAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    createdAt: string | Date;
    query: string;
    _id: string;
    provider: "tavily" | "serpapi";
    results: Record<string, unknown>[];
    expiresAt: string | Date;
}, {
    createdAt: string | Date;
    query: string;
    _id: string;
    provider: "tavily" | "serpapi";
    results: Record<string, unknown>[];
    expiresAt: string | Date;
}>;
export type SearchCacheDoc = z.infer<typeof SearchCacheDoc>;
export declare const JobKind: z.ZodEnum<["index_document"]>;
export type JobKind = z.infer<typeof JobKind>;
export declare const JobStatus: z.ZodEnum<["pending", "running", "done", "failed"]>;
export type JobStatus = z.infer<typeof JobStatus>;
export declare const JobDoc: z.ZodObject<{
    _id: z.ZodString;
    kind: z.ZodEnum<["index_document"]>;
    status: z.ZodEnum<["pending", "running", "done", "failed"]>;
    payload: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    userId: z.ZodString;
    /** Stale `claimedAt` on a `running` row is how the sweeper finds a crashed job. */
    claimedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodDate]>>;
    workerId: z.ZodOptional<z.ZodString>;
    attempts: z.ZodDefault<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    status: "done" | "pending" | "failed" | "running";
    kind: "index_document";
    createdAt: string | Date;
    _id: string;
    userId: string;
    payload: Record<string, unknown>;
    attempts: number;
    error?: string | undefined;
    claimedAt?: string | Date | undefined;
    workerId?: string | undefined;
}, {
    status: "done" | "pending" | "failed" | "running";
    kind: "index_document";
    createdAt: string | Date;
    _id: string;
    userId: string;
    payload: Record<string, unknown>;
    error?: string | undefined;
    claimedAt?: string | Date | undefined;
    workerId?: string | undefined;
    attempts?: number | undefined;
}>;
export type JobDoc = z.infer<typeof JobDoc>;
export declare const RequestDoc: z.ZodObject<{
    requestId: z.ZodString;
    userId: z.ZodString;
    route: z.ZodString;
    status: z.ZodNumber;
    ms: z.ZodNumber;
    tokensIn: z.ZodOptional<z.ZodNumber>;
    tokensOut: z.ZodOptional<z.ZodNumber>;
    costUsd: z.ZodOptional<z.ZodNumber>;
    toolCalls: z.ZodOptional<z.ZodNumber>;
    terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
    depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    status: number;
    ms: number;
    requestId: string;
    createdAt: string | Date;
    userId: string;
    route: string;
    costUsd?: number | undefined;
    terminated?: "error" | "done" | "cap" | undefined;
    depth?: "quick" | "deep" | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    toolCalls?: number | undefined;
}, {
    status: number;
    ms: number;
    requestId: string;
    createdAt: string | Date;
    userId: string;
    route: string;
    costUsd?: number | undefined;
    terminated?: "error" | "done" | "cap" | undefined;
    depth?: "quick" | "deep" | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    toolCalls?: number | undefined;
}>;
export type RequestDoc = z.infer<typeof RequestDoc>;
/**
 * The run log. Exactly the shape `quality/check.mjs` reads out of `runs/<requestId>.json`
 * (PRD 13) — `tokens` is a single total, not the `{in,out}` split the done event carries.
 * Written once per answer. Ten lines of adapter; it is what the gates read.
 */
export declare const RunLog: z.ZodObject<{
    tokens: z.ZodNumber;
    wallClockSec: z.ZodNumber;
    costUsd: z.ZodNumber;
    terminated: z.ZodEnum<["done", "cap", "error"]>;
    /**
     * Which gear ran. The gates read one global budget out of expectations.json, so this is
     * how a reader (and the bench) tells a legitimately expensive deep run apart from a
     * quick run that has quietly run away with the budget.
     */
    depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
    toolCalls: z.ZodArray<z.ZodEffects<z.ZodObject<{
        name: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
        ok: z.ZodBoolean;
        error: z.ZodOptional<z.ZodString>;
        ms: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }>, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    tokens: number;
    costUsd: number;
    terminated: "error" | "done" | "cap";
    toolCalls: {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }[];
    wallClockSec: number;
    depth?: "quick" | "deep" | undefined;
}, {
    tokens: number;
    costUsd: number;
    terminated: "error" | "done" | "cap";
    toolCalls: {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }[];
    wallClockSec: number;
    depth?: "quick" | "deep" | undefined;
}>;
export type RunLog = z.infer<typeof RunLog>;
/** Same shape as the file, plus what makes it queryable when it lives in Mongo. */
export declare const RunDoc: z.ZodObject<{
    tokens: z.ZodNumber;
    wallClockSec: z.ZodNumber;
    costUsd: z.ZodNumber;
    terminated: z.ZodEnum<["done", "cap", "error"]>;
    /**
     * Which gear ran. The gates read one global budget out of expectations.json, so this is
     * how a reader (and the bench) tells a legitimately expensive deep run apart from a
     * quick run that has quietly run away with the budget.
     */
    depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
    toolCalls: z.ZodArray<z.ZodEffects<z.ZodObject<{
        name: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
        ok: z.ZodBoolean;
        error: z.ZodOptional<z.ZodString>;
        ms: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }>, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }, {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }>, "many">;
} & {
    requestId: z.ZodString;
    userId: z.ZodOptional<z.ZodString>;
    threadId: z.ZodOptional<z.ZodString>;
    answerId: z.ZodOptional<z.ZodString>;
    query: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodUnion<[z.ZodString, z.ZodDate]>;
}, "strip", z.ZodTypeAny, {
    tokens: number;
    costUsd: number;
    terminated: "error" | "done" | "cap";
    requestId: string;
    createdAt: string | Date;
    toolCalls: {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }[];
    wallClockSec: number;
    threadId?: string | undefined;
    answerId?: string | undefined;
    depth?: "quick" | "deep" | undefined;
    query?: string | undefined;
    userId?: string | undefined;
}, {
    tokens: number;
    costUsd: number;
    terminated: "error" | "done" | "cap";
    requestId: string;
    createdAt: string | Date;
    toolCalls: {
        ok: boolean;
        name: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ms?: number | undefined;
        error?: string | undefined;
    }[];
    wallClockSec: number;
    threadId?: string | undefined;
    answerId?: string | undefined;
    depth?: "quick" | "deep" | undefined;
    query?: string | undefined;
    userId?: string | undefined;
}>;
export type RunDoc = z.infer<typeof RunDoc>;
export declare const COLLECTIONS: {
    readonly threads: "threads";
    readonly messages: "messages";
    readonly memories: "memories";
    readonly spaces: "spaces";
    readonly documents: "documents";
    readonly chunks: "chunks";
    readonly searchCache: "searchCache";
    readonly jobs: "jobs";
    readonly requests: "requests";
    readonly runs: "runs";
};
export declare const GRIDFS_BUCKETS: {
    readonly uploads: "uploads";
};
/** Index names `scripts/create-indexes.mjs` creates. `/health` reports which backend is live. */
export declare const SEARCH_INDEXES: {
    readonly memoriesVector: "memories_vector";
    readonly chunksVector: "chunks_vector";
    readonly chunksText: "chunks_text";
};
//# sourceMappingURL=db.d.ts.map