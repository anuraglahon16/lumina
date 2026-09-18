import { z } from 'zod';
/**
 * The events of a streamed answer, in the order the UI expects them:
 *
 *   quick:  trace* → sources → token* → done
 *   deep:   plan → trace* → sources → token* → done
 *
 * `sources` MUST arrive before the first `token` so the UI can render citation chips
 * while the text is still arriving (PRD 7). On a deep search `plan` comes first, so the
 * reader can see what the system decided to go and find out.
 *
 * `error` ends the stream at any point.
 */
/** Every tool the loop may call. */
export declare const AskTool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
export type AskTool = z.infer<typeof AskTool>;
/** Tools a quick search may never call, whatever the model decides it wants. */
export declare const DEEP_ONLY_TOOLS: readonly ["plan_research"];
export declare const ToolName: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
export type ToolName = z.infer<typeof ToolName>;
/**
 * How hard to look. Perplexity's two gears, and the whole point of having both is that
 * the cheap one is the default: most questions do not need six sub-questions and twelve
 * pages, and answering them as if they did is how a product becomes uneconomic.
 */
export declare const Depth: z.ZodEnum<["quick", "deep"]>;
export type Depth = z.infer<typeof Depth>;
/**
 * One step of the loop, emitted before the answer streams. `reason` is what makes the
 * trace a debugging surface rather than a progress bar: it is why this step happened.
 */
export declare const TraceEvent: z.ZodEffects<z.ZodObject<{
    step: z.ZodNumber;
    tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    ok: z.ZodBoolean;
    ms: z.ZodNumber;
    reason: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    /** On a deep search, which sub-question this step was serving. Absent on a quick one. */
    subQuestion: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    input: Record<string, unknown>;
    ok: boolean;
    ms: number;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    input: Record<string, unknown>;
    ok: boolean;
    ms: number;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}>, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    input: Record<string, unknown>;
    ok: boolean;
    ms: number;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    input: Record<string, unknown>;
    ok: boolean;
    ms: number;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}>;
export type TraceEvent = z.infer<typeof TraceEvent>;
/** One thing the planner decided to go and find out. */
export declare const SubQuestion: z.ZodObject<{
    i: z.ZodNumber;
    question: z.ZodString;
    /** Why this sub-question, in the planner's words. This is what makes the plan readable. */
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    i: number;
    question: string;
    reason?: string | undefined;
}, {
    i: number;
    question: string;
    reason?: string | undefined;
}>;
export type SubQuestion = z.infer<typeof SubQuestion>;
/**
 * Emitted once, at the start of a deep search, before any retrieval. A deep search that
 * streams no plan is a slow quick search: the decomposition IS the feature, and it has to
 * be visible or nobody can tell whether it was any good.
 */
export declare const PlanEvent: z.ZodObject<{
    subQuestions: z.ZodArray<z.ZodObject<{
        i: z.ZodNumber;
        question: z.ZodString;
        /** Why this sub-question, in the planner's words. This is what makes the plan readable. */
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        i: number;
        question: string;
        reason?: string | undefined;
    }, {
        i: number;
        question: string;
        reason?: string | undefined;
    }>, "many">;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    subQuestions: {
        i: number;
        question: string;
        reason?: string | undefined;
    }[];
    reason?: string | undefined;
}, {
    subQuestions: {
        i: number;
        question: string;
        reason?: string | undefined;
    }[];
    reason?: string | undefined;
}>;
export type PlanEvent = z.infer<typeof PlanEvent>;
export declare const Locator: z.ZodEffects<z.ZodObject<{
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
export type Locator = z.infer<typeof Locator>;
/** One citable thing that was actually retrieved in this request. `n` is the `[n]` in the text. */
export declare const Source: z.ZodEffects<z.ZodObject<{
    n: z.ZodNumber;
    kind: z.ZodEnum<["web", "doc"]>;
    title: z.ZodString;
    /** The passage the claim rests on. The grounding check looks for this in the fetched text. */
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
    /**
     * Which sub-question turned this up. Deep search merges several result sets into one
     * numbering, and without this a reader cannot tell why a source is in the list.
     */
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
}>;
export type Source = z.infer<typeof Source>;
export declare const SourcesEvent: z.ZodArray<z.ZodEffects<z.ZodObject<{
    n: z.ZodNumber;
    kind: z.ZodEnum<["web", "doc"]>;
    title: z.ZodString;
    /** The passage the claim rests on. The grounding check looks for this in the fetched text. */
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
    /**
     * Which sub-question turned this up. Deep search merges several result sets into one
     * numbering, and without this a reader cannot tell why a source is in the list.
     */
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
}>, "many">;
export type SourcesEvent = z.infer<typeof SourcesEvent>;
export declare const TokenEvent: z.ZodObject<{
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    text: string;
}, {
    text: string;
}>;
export type TokenEvent = z.infer<typeof TokenEvent>;
/**
 * Why the loop stopped, set explicitly at the call site. No SDK gives you this:
 *   done  finished on its own
 *   cap   hit the tool-call or wall-clock cap; the answer is an honest partial
 *   error a provider threw; the request is also a 502
 */
export declare const Terminated: z.ZodEnum<["done", "cap", "error"]>;
export type Terminated = z.infer<typeof Terminated>;
export declare const DoneEvent: z.ZodObject<{
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
    /** true only when EVERY search in the request was a cache hit. */
    searchCached: z.ZodBoolean;
    terminated: z.ZodEnum<["done", "cap", "error"]>;
    /** Which gear actually ran. The client asked; the server reports what it did. */
    depth: z.ZodEnum<["quick", "deep"]>;
    /** How many sub-questions the plan held. Absent or 0 on a quick search. */
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
}>;
export type DoneEvent = z.infer<typeof DoneEvent>;
export declare const StreamErrorEvent: z.ZodObject<{
    status: z.ZodNumber;
    error: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: number;
    error: string;
}, {
    status: number;
    error: string;
}>;
export type StreamErrorEvent = z.infer<typeof StreamErrorEvent>;
export declare const SSE_EVENTS: readonly ["plan", "trace", "sources", "token", "done", "error"];
export type SseEventName = (typeof SSE_EVENTS)[number];
/** Discriminated union of a parsed SSE frame, for the UI's reducer. */
export declare const AskStreamEvent: z.ZodUnion<[z.ZodObject<{
    event: z.ZodLiteral<"plan">;
    data: z.ZodObject<{
        subQuestions: z.ZodArray<z.ZodObject<{
            i: z.ZodNumber;
            question: z.ZodString;
            /** Why this sub-question, in the planner's words. This is what makes the plan readable. */
            reason: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            i: number;
            question: string;
            reason?: string | undefined;
        }, {
            i: number;
            question: string;
            reason?: string | undefined;
        }>, "many">;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        subQuestions: {
            i: number;
            question: string;
            reason?: string | undefined;
        }[];
        reason?: string | undefined;
    }, {
        subQuestions: {
            i: number;
            question: string;
            reason?: string | undefined;
        }[];
        reason?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    event: "plan";
    data: {
        subQuestions: {
            i: number;
            question: string;
            reason?: string | undefined;
        }[];
        reason?: string | undefined;
    };
}, {
    event: "plan";
    data: {
        subQuestions: {
            i: number;
            question: string;
            reason?: string | undefined;
        }[];
        reason?: string | undefined;
    };
}>, z.ZodObject<{
    event: z.ZodLiteral<"trace">;
    data: z.ZodEffects<z.ZodObject<{
        step: z.ZodNumber;
        tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        ok: z.ZodBoolean;
        ms: z.ZodNumber;
        reason: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        /** On a deep search, which sub-question this step was serving. Absent on a quick one. */
        subQuestion: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }>, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    event: "trace";
    data: {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    };
}, {
    event: "trace";
    data: {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        input: Record<string, unknown>;
        ok: boolean;
        ms: number;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    };
}>, z.ZodObject<{
    event: z.ZodLiteral<"sources">;
    data: z.ZodArray<z.ZodEffects<z.ZodObject<{
        n: z.ZodNumber;
        kind: z.ZodEnum<["web", "doc"]>;
        title: z.ZodString;
        /** The passage the claim rests on. The grounding check looks for this in the fetched text. */
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
        /**
         * Which sub-question turned this up. Deep search merges several result sets into one
         * numbering, and without this a reader cannot tell why a source is in the list.
         */
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
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    event: "sources";
    data: {
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
}, {
    event: "sources";
    data: {
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
}>, z.ZodObject<{
    event: z.ZodLiteral<"token">;
    data: z.ZodObject<{
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        text: string;
    }, {
        text: string;
    }>;
}, "strip", z.ZodTypeAny, {
    event: "token";
    data: {
        text: string;
    };
}, {
    event: "token";
    data: {
        text: string;
    };
}>, z.ZodObject<{
    event: z.ZodLiteral<"done">;
    data: z.ZodObject<{
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
        /** true only when EVERY search in the request was a cache hit. */
        searchCached: z.ZodBoolean;
        terminated: z.ZodEnum<["done", "cap", "error"]>;
        /** Which gear actually ran. The client asked; the server reports what it did. */
        depth: z.ZodEnum<["quick", "deep"]>;
        /** How many sub-questions the plan held. Absent or 0 on a quick search. */
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
    }>;
}, "strip", z.ZodTypeAny, {
    event: "done";
    data: {
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
    };
}, {
    event: "done";
    data: {
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
    };
}>, z.ZodObject<{
    event: z.ZodLiteral<"error">;
    data: z.ZodObject<{
        status: z.ZodNumber;
        error: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        status: number;
        error: string;
    }, {
        status: number;
        error: string;
    }>;
}, "strip", z.ZodTypeAny, {
    event: "error";
    data: {
        status: number;
        error: string;
    };
}, {
    event: "error";
    data: {
        status: number;
        error: string;
    };
}>]>;
export type AskStreamEvent = z.infer<typeof AskStreamEvent>;
/**
 * Every `[n]` in an answer must have exactly one matching source. Extra or missing is a
 * grounding failure (PRD 7). Both the agent service and the bench use this.
 */
export declare function citationNumbers(text: string): number[];
export declare function unresolvedCitations(text: string, sources: readonly Source[]): number[];
//# sourceMappingURL=sse.d.ts.map