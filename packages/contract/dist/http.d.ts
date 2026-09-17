import { z } from 'zod';
/**
 * Every route in PRD 7, as request and response schemas. The gateway validates inbound
 * bodies with these; the agent service validates what it sends back; the UI compiles
 * against the inferred types. One definition, three consumers, no drift.
 *
 * `X-User-Id` is required on every route except GET /health.
 */
export declare const USER_HEADER = "x-user-id";
export declare const REQUEST_HEADER = "x-request-id";
/** 400 · 401 · 404 · 413 · 429 · 501 · 502 all use this body. */
export declare const ErrorBody: z.ZodObject<{
    error: z.ZodString;
    status: z.ZodOptional<z.ZodNumber>;
    /** 429 from the image cap says when the cap resets. */
    resetsAt: z.ZodOptional<z.ZodString>;
    requestId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    error: string;
    status?: number | undefined;
    resetsAt?: string | undefined;
    requestId?: string | undefined;
}, {
    error: string;
    status?: number | undefined;
    resetsAt?: string | undefined;
    requestId?: string | undefined;
}>;
export type ErrorBody = z.infer<typeof ErrorBody>;
export declare const CreateThreadBody: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title?: string | undefined;
}, {
    title?: string | undefined;
}>;
export declare const CreateThreadResponse: z.ZodObject<{
    threadId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    threadId: string;
}, {
    threadId: string;
}>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponse>;
export declare const ThreadMessage: z.ZodObject<{
    role: z.ZodEnum<["user", "assistant"]>;
    content: z.ZodString;
    sources: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
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
    answerId: z.ZodOptional<z.ZodString>;
    done: z.ZodOptional<z.ZodObject<{
        answerId: z.ZodOptional<z.ZodString>;
        latencyMs: z.ZodOptional<z.ZodNumber>;
        ttftMs: z.ZodOptional<z.ZodNumber>;
        model: z.ZodOptional<z.ZodString>;
        tokens: z.ZodOptional<z.ZodObject<{
            in: z.ZodNumber;
            out: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            in: number;
            out: number;
        }, {
            in: number;
            out: number;
        }>>;
        costUsd: z.ZodOptional<z.ZodNumber>;
        searchCached: z.ZodOptional<z.ZodBoolean>;
        terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
        depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
        subQuestions: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        answerId?: string | undefined;
        subQuestions?: number | undefined;
        latencyMs?: number | undefined;
        ttftMs?: number | undefined;
        model?: string | undefined;
        tokens?: {
            in: number;
            out: number;
        } | undefined;
        costUsd?: number | undefined;
        searchCached?: boolean | undefined;
        terminated?: "error" | "done" | "cap" | undefined;
        depth?: "quick" | "deep" | undefined;
    }, {
        answerId?: string | undefined;
        subQuestions?: number | undefined;
        latencyMs?: number | undefined;
        ttftMs?: number | undefined;
        model?: string | undefined;
        tokens?: {
            in: number;
            out: number;
        } | undefined;
        costUsd?: number | undefined;
        searchCached?: boolean | undefined;
        terminated?: "error" | "done" | "cap" | undefined;
        depth?: "quick" | "deep" | undefined;
    }>>;
    createdAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "user" | "assistant";
    content: string;
    answerId?: string | undefined;
    done?: {
        answerId?: string | undefined;
        subQuestions?: number | undefined;
        latencyMs?: number | undefined;
        ttftMs?: number | undefined;
        model?: string | undefined;
        tokens?: {
            in: number;
            out: number;
        } | undefined;
        costUsd?: number | undefined;
        searchCached?: boolean | undefined;
        terminated?: "error" | "done" | "cap" | undefined;
        depth?: "quick" | "deep" | undefined;
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
    createdAt?: string | undefined;
}, {
    role: "user" | "assistant";
    content: string;
    answerId?: string | undefined;
    done?: {
        answerId?: string | undefined;
        subQuestions?: number | undefined;
        latencyMs?: number | undefined;
        ttftMs?: number | undefined;
        model?: string | undefined;
        tokens?: {
            in: number;
            out: number;
        } | undefined;
        costUsd?: number | undefined;
        searchCached?: boolean | undefined;
        terminated?: "error" | "done" | "cap" | undefined;
        depth?: "quick" | "deep" | undefined;
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
    createdAt?: string | undefined;
}>;
export type ThreadMessage = z.infer<typeof ThreadMessage>;
export declare const GetThreadResponse: z.ZodObject<{
    threadId: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<["user", "assistant"]>;
        content: z.ZodString;
        sources: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
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
        answerId: z.ZodOptional<z.ZodString>;
        done: z.ZodOptional<z.ZodObject<{
            answerId: z.ZodOptional<z.ZodString>;
            latencyMs: z.ZodOptional<z.ZodNumber>;
            ttftMs: z.ZodOptional<z.ZodNumber>;
            model: z.ZodOptional<z.ZodString>;
            tokens: z.ZodOptional<z.ZodObject<{
                in: z.ZodNumber;
                out: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                in: number;
                out: number;
            }, {
                in: number;
                out: number;
            }>>;
            costUsd: z.ZodOptional<z.ZodNumber>;
            searchCached: z.ZodOptional<z.ZodBoolean>;
            terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
            depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
            subQuestions: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        }, "strip", z.ZodTypeAny, {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
        }, {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
        }>>;
        createdAt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        role: "user" | "assistant";
        content: string;
        answerId?: string | undefined;
        done?: {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
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
        createdAt?: string | undefined;
    }, {
        role: "user" | "assistant";
        content: string;
        answerId?: string | undefined;
        done?: {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
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
        createdAt?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    messages: {
        role: "user" | "assistant";
        content: string;
        answerId?: string | undefined;
        done?: {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
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
        createdAt?: string | undefined;
    }[];
    threadId?: string | undefined;
    title?: string | undefined;
}, {
    messages: {
        role: "user" | "assistant";
        content: string;
        answerId?: string | undefined;
        done?: {
            answerId?: string | undefined;
            subQuestions?: number | undefined;
            latencyMs?: number | undefined;
            ttftMs?: number | undefined;
            model?: string | undefined;
            tokens?: {
                in: number;
                out: number;
            } | undefined;
            costUsd?: number | undefined;
            searchCached?: boolean | undefined;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
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
        createdAt?: string | undefined;
    }[];
    threadId?: string | undefined;
    title?: string | undefined;
}>;
export type GetThreadResponse = z.infer<typeof GetThreadResponse>;
export declare const ListThreadsResponse: z.ZodObject<{
    threads: z.ZodArray<z.ZodObject<{
        threadId: z.ZodString;
        title: z.ZodString;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        threadId: string;
        title: string;
        createdAt: string;
    }, {
        threadId: string;
        title: string;
        createdAt: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    threads: {
        threadId: string;
        title: string;
        createdAt: string;
    }[];
}, {
    threads: {
        threadId: string;
        title: string;
        createdAt: string;
    }[];
}>;
export type ListThreadsResponse = z.infer<typeof ListThreadsResponse>;
/** How the router picks retrieval: web, the Space's documents, or its own decision. */
export declare const AskMode: z.ZodEnum<["auto", "web", "docs"]>;
export type AskMode = z.infer<typeof AskMode>;
export declare const AskBody: z.ZodObject<{
    query: z.ZodString;
    /** Where to look. */
    mode: z.ZodDefault<z.ZodEnum<["auto", "web", "docs"]>>;
    /**
     * How hard to look. Defaults to quick on purpose: deep costs several times as much, so
     * it is something a user opts into, never somewhere the server drifts.
     */
    depth: z.ZodDefault<z.ZodEnum<["quick", "deep"]>>;
    spaceId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    depth: "quick" | "deep";
    query: string;
    mode: "web" | "auto" | "docs";
    spaceId?: string | undefined;
}, {
    query: string;
    spaceId?: string | undefined;
    depth?: "quick" | "deep" | undefined;
    mode?: "web" | "auto" | "docs" | undefined;
}>;
export type AskBody = z.input<typeof AskBody>;
export declare const Memory: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    sourceThread: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    text: string;
    createdAt: string;
    id: string;
    sourceThread?: string | undefined;
}, {
    text: string;
    createdAt: string;
    id: string;
    sourceThread?: string | undefined;
}>;
export type Memory = z.infer<typeof Memory>;
export declare const ListMemoryResponse: z.ZodObject<{
    memories: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        sourceThread: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        text: string;
        createdAt: string;
        id: string;
        sourceThread?: string | undefined;
    }, {
        text: string;
        createdAt: string;
        id: string;
        sourceThread?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    memories: {
        text: string;
        createdAt: string;
        id: string;
        sourceThread?: string | undefined;
    }[];
}, {
    memories: {
        text: string;
        createdAt: string;
        id: string;
        sourceThread?: string | undefined;
    }[];
}>;
export type ListMemoryResponse = z.infer<typeof ListMemoryResponse>;
export declare const CreateSpaceBody: z.ZodObject<{
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
}, {
    name: string;
}>;
export declare const CreateSpaceResponse: z.ZodObject<{
    spaceId: z.ZodString;
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    spaceId: string;
    name: string;
}, {
    spaceId: string;
    name: string;
}>;
export type CreateSpaceResponse = z.infer<typeof CreateSpaceResponse>;
export declare const ListSpacesResponse: z.ZodObject<{
    spaces: z.ZodArray<z.ZodObject<{
        spaceId: z.ZodString;
        name: z.ZodString;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        spaceId: string;
        createdAt: string;
        name: string;
    }, {
        spaceId: string;
        createdAt: string;
        name: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    spaces: {
        spaceId: string;
        createdAt: string;
        name: string;
    }[];
}, {
    spaces: {
        spaceId: string;
        createdAt: string;
        name: string;
    }[];
}>;
export type ListSpacesResponse = z.infer<typeof ListSpacesResponse>;
/** pending → parsing → embedding → indexed, or failed. `indexed` only after the probe. */
export declare const DocStatus: z.ZodEnum<["pending", "parsing", "embedding", "indexed", "failed"]>;
export type DocStatus = z.infer<typeof DocStatus>;
export declare const UploadDocumentResponse: z.ZodObject<{
    docId: z.ZodString;
    status: z.ZodLiteral<"pending">;
}, "strip", z.ZodTypeAny, {
    docId: string;
    status: "pending";
}, {
    docId: string;
    status: "pending";
}>;
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponse>;
export declare const DocumentRow: z.ZodObject<{
    docId: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<["pending", "parsing", "embedding", "indexed", "failed"]>;
    pct: z.ZodNumber;
    pages: z.ZodOptional<z.ZodNumber>;
    chunks: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    docId: string;
    status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
    title: string;
    pct: number;
    error?: string | undefined;
    pages?: number | undefined;
    chunks?: number | undefined;
}, {
    docId: string;
    status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
    title: string;
    pct: number;
    error?: string | undefined;
    pages?: number | undefined;
    chunks?: number | undefined;
}>;
export type DocumentRow = z.infer<typeof DocumentRow>;
export declare const ListDocumentsResponse: z.ZodObject<{
    documents: z.ZodArray<z.ZodObject<{
        docId: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<["pending", "parsing", "embedding", "indexed", "failed"]>;
        pct: z.ZodNumber;
        pages: z.ZodOptional<z.ZodNumber>;
        chunks: z.ZodOptional<z.ZodNumber>;
        error: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        docId: string;
        status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
        title: string;
        pct: number;
        error?: string | undefined;
        pages?: number | undefined;
        chunks?: number | undefined;
    }, {
        docId: string;
        status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
        title: string;
        pct: number;
        error?: string | undefined;
        pages?: number | undefined;
        chunks?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    documents: {
        docId: string;
        status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
        title: string;
        pct: number;
        error?: string | undefined;
        pages?: number | undefined;
        chunks?: number | undefined;
    }[];
}, {
    documents: {
        docId: string;
        status: "pending" | "parsing" | "embedding" | "indexed" | "failed";
        title: string;
        pct: number;
        error?: string | undefined;
        pages?: number | undefined;
        chunks?: number | undefined;
    }[];
}>;
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponse>;
export declare const MAX_UPLOAD_BYTES: number;
export declare const ACCEPTED_UPLOAD_TYPES: readonly ["application/pdf", "text/markdown", "text/plain"];
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
export declare const HealthResponse: z.ZodObject<{
    status: z.ZodEnum<["ok", "degraded"]>;
    /** The LLM actually serving answers, e.g. "claude-sonnet-5". Never a key. */
    model: z.ZodString;
    /** Conventionally "tavily" or "serpapi". Name whatever is live. */
    searchProvider: z.ZodString;
    /**
     * Conventionally "atlas-vector-search" or "mongo-cosine-scan" on the taught path.
     * Name whatever is live; a recall number is not comparable without it.
     */
    vectorStore: z.ZodString;
    db: z.ZodEnum<["ok", "down"]>;
    /** The gateway nests the agent service's own /health here. */
    ai: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<["ok", "down"]>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        status: z.ZodEnum<["ok", "down"]>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        status: z.ZodEnum<["ok", "down"]>;
    }, z.ZodTypeAny, "passthrough">>>;
    version: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "ok" | "degraded";
    model: string;
    searchProvider: string;
    vectorStore: string;
    db: "ok" | "down";
    ai?: z.objectOutputType<{
        status: z.ZodEnum<["ok", "down"]>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    version?: string | undefined;
}, {
    status: "ok" | "degraded";
    model: string;
    searchProvider: string;
    vectorStore: string;
    db: "ok" | "down";
    ai?: z.objectInputType<{
        status: z.ZodEnum<["ok", "down"]>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    version?: string | undefined;
}>;
/** The values the taught MERN path reports, for reference and for the local-dev fallback. */
export declare const VECTOR_BACKENDS: readonly ["atlas-vector-search", "mongo-cosine-scan"];
export declare const SEARCH_PROVIDERS: readonly ["tavily", "serpapi"];
export type HealthResponse = z.infer<typeof HealthResponse>;
export declare const StatsResponse: z.ZodObject<{
    requests: z.ZodNumber;
    answers: z.ZodNumber;
    searchCacheHitRatePct: z.ZodNumber;
    ttftP95Ms: z.ZodNumber;
    costUsdToday: z.ZodNumber;
    /** Deep searches this user has spent today, and the cap that stops them. */
    deepToday: z.ZodNumber;
    deepDailyCap: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    requests: number;
    answers: number;
    searchCacheHitRatePct: number;
    ttftP95Ms: number;
    costUsdToday: number;
    deepToday: number;
    deepDailyCap: number;
}, {
    requests: number;
    answers: number;
    searchCacheHitRatePct: number;
    ttftP95Ms: number;
    costUsdToday: number;
    deepToday: number;
    deepDailyCap: number;
}>;
export type StatsResponse = z.infer<typeof StatsResponse>;
/**
 * The routes the UI calls, in one place, so a skeleton can register all of them as 501
 * and the bench can walk them. `auth: false` means no X-User-Id required.
 */
export declare const ROUTES: readonly [{
    readonly method: "GET";
    readonly path: "/health";
    readonly auth: false;
}, {
    readonly method: "GET";
    readonly path: "/stats";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/evals/report.json";
    readonly auth: false;
}, {
    readonly method: "POST";
    readonly path: "/threads";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/threads";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/threads/:threadId";
    readonly auth: true;
}, {
    readonly method: "POST";
    readonly path: "/threads/:threadId/ask";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/memory";
    readonly auth: true;
}, {
    readonly method: "DELETE";
    readonly path: "/memory/:memoryId";
    readonly auth: true;
}, {
    readonly method: "POST";
    readonly path: "/spaces";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/spaces";
    readonly auth: true;
}, {
    readonly method: "POST";
    readonly path: "/spaces/:spaceId/documents";
    readonly auth: true;
}, {
    readonly method: "GET";
    readonly path: "/spaces/:spaceId/documents";
    readonly auth: true;
}];
export type Route = (typeof ROUTES)[number];
//# sourceMappingURL=http.d.ts.map