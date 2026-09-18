import { z } from 'zod';
/**
 * `GET /evals/report.json` — the Product Evaluation, written by `/fde-lumina-eval` and
 * rendered by the provided UI at `/evals`. This page IS the submission (SUBMISSION.md).
 *
 * Never hand-edit a report, and never write a number into one that a run did not produce.
 */
/** The five system-design questions, answered before the build. Graded as the design section. */
export declare const DesignAnswers: z.ZodObject<{
    components: z.ZodString;
    responsibilities: z.ZodString;
    communication: z.ZodString;
    state: z.ZodString;
    tradeoffs: z.ZodString;
}, "strip", z.ZodTypeAny, {
    components: string;
    responsibilities: string;
    communication: string;
    state: string;
    tradeoffs: string;
}, {
    components: string;
    responsibilities: string;
    communication: string;
    state: string;
    tradeoffs: string;
}>;
export type DesignAnswers = z.infer<typeof DesignAnswers>;
export declare const RubricRow: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    points: z.ZodNumber;
    awarded: z.ZodNumber;
    status: z.ZodEnum<["pass", "partial", "fail", "manual"]>;
    evidence: z.ZodString;
    rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    status: "pass" | "partial" | "fail" | "manual";
    id: string;
    label: string;
    points: number;
    awarded: number;
    evidence: string;
    rules: string[];
}, {
    status: "pass" | "partial" | "fail" | "manual";
    id: string;
    label: string;
    points: number;
    awarded: number;
    evidence: string;
    rules?: string[] | undefined;
}>;
export type RubricRow = z.infer<typeof RubricRow>;
export declare const RubricReport: z.ZodObject<{
    total: z.ZodNumber;
    awarded: z.ZodNumber;
    automated: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        points: z.ZodNumber;
        awarded: z.ZodNumber;
        status: z.ZodEnum<["pass", "partial", "fail", "manual"]>;
        evidence: z.ZodString;
        rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules: string[];
    }, {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules?: string[] | undefined;
    }>, "many">;
    manual: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        points: z.ZodNumber;
        awarded: z.ZodNumber;
        status: z.ZodEnum<["pass", "partial", "fail", "manual"]>;
        evidence: z.ZodString;
        rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules: string[];
    }, {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules?: string[] | undefined;
    }>, "many">;
    redLines: z.ZodDefault<z.ZodArray<z.ZodObject<{
        check: z.ZodString;
        ok: z.ZodBoolean;
        detail: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        ok: boolean;
        check: string;
        detail?: string | undefined;
    }, {
        ok: boolean;
        check: string;
        detail?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    awarded: number;
    manual: {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules: string[];
    }[];
    total: number;
    automated: {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules: string[];
    }[];
    redLines: {
        ok: boolean;
        check: string;
        detail?: string | undefined;
    }[];
}, {
    awarded: number;
    manual: {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules?: string[] | undefined;
    }[];
    total: number;
    automated: {
        status: "pass" | "partial" | "fail" | "manual";
        id: string;
        label: string;
        points: number;
        awarded: number;
        evidence: string;
        rules?: string[] | undefined;
    }[];
    redLines?: {
        ok: boolean;
        check: string;
        detail?: string | undefined;
    }[] | undefined;
}>;
export type RubricReport = z.infer<typeof RubricReport>;
/** One SLA line: what was declared, what the run produced, and whether it held. */
export declare const SlaRow: z.ZodObject<{
    metric: z.ZodString;
    target: z.ZodNumber;
    actual: z.ZodNullable<z.ZodNumber>;
    unit: z.ZodString;
    comparator: z.ZodEnum<["<=", ">="]>;
    pass: z.ZodBoolean;
    note: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    pass: boolean;
    metric: string;
    target: number;
    actual: number | null;
    unit: string;
    comparator: "<=" | ">=";
    note?: string | undefined;
}, {
    pass: boolean;
    metric: string;
    target: number;
    actual: number | null;
    unit: string;
    comparator: "<=" | ">=";
    note?: string | undefined;
}>;
export type SlaRow = z.infer<typeof SlaRow>;
export declare const BenchReport: z.ZodObject<{
    ranAt: z.ZodString;
    target: z.ZodString;
    pass: z.ZodBoolean;
    sla: z.ZodArray<z.ZodObject<{
        metric: z.ZodString;
        target: z.ZodNumber;
        actual: z.ZodNullable<z.ZodNumber>;
        unit: z.ZodString;
        comparator: z.ZodEnum<["<=", ">="]>;
        pass: z.ZodBoolean;
        note: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        pass: boolean;
        metric: string;
        target: number;
        actual: number | null;
        unit: string;
        comparator: "<=" | ">=";
        note?: string | undefined;
    }, {
        pass: boolean;
        metric: string;
        target: number;
        actual: number | null;
        unit: string;
        comparator: "<=" | ">=";
        note?: string | undefined;
    }>, "many">;
    /** The four metric names quality/check.mjs looks for, also written to reports/eval.json. */
    citationGrounding: z.ZodNullable<z.ZodNumber>;
    recallAt5: z.ZodNullable<z.ZodNumber>;
    retrievalRate: z.ZodNullable<z.ZodNumber>;
    errorRate: z.ZodNullable<z.ZodNumber>;
    latency: z.ZodObject<{
        ttftP50Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        ttftP95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        answerP50Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        answerP95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        accept202P95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        ttftP95Ms?: number | null | undefined;
        ttftP50Ms?: number | null | undefined;
        answerP50Ms?: number | null | undefined;
        answerP95Ms?: number | null | undefined;
        accept202P95Ms?: number | null | undefined;
    }, {
        ttftP95Ms?: number | null | undefined;
        ttftP50Ms?: number | null | undefined;
        answerP50Ms?: number | null | undefined;
        answerP95Ms?: number | null | undefined;
        accept202P95Ms?: number | null | undefined;
    }>;
    cost: z.ZodObject<{
        meanCostPerAnswerUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        projectedMonthlyUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        projectedMonthlyNoCacheUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        meanCostPerAnswerUsd?: number | null | undefined;
        projectedMonthlyUsd?: number | null | undefined;
        projectedMonthlyNoCacheUsd?: number | null | undefined;
    }, {
        meanCostPerAnswerUsd?: number | null | undefined;
        projectedMonthlyUsd?: number | null | undefined;
        projectedMonthlyNoCacheUsd?: number | null | undefined;
    }>;
    searchCacheHitRatePct: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    answers: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    pass: boolean;
    target: string;
    ranAt: string;
    sla: {
        pass: boolean;
        metric: string;
        target: number;
        actual: number | null;
        unit: string;
        comparator: "<=" | ">=";
        note?: string | undefined;
    }[];
    citationGrounding: number | null;
    recallAt5: number | null;
    retrievalRate: number | null;
    errorRate: number | null;
    latency: {
        ttftP95Ms?: number | null | undefined;
        ttftP50Ms?: number | null | undefined;
        answerP50Ms?: number | null | undefined;
        answerP95Ms?: number | null | undefined;
        accept202P95Ms?: number | null | undefined;
    };
    cost: {
        meanCostPerAnswerUsd?: number | null | undefined;
        projectedMonthlyUsd?: number | null | undefined;
        projectedMonthlyNoCacheUsd?: number | null | undefined;
    };
    answers?: number | undefined;
    searchCacheHitRatePct?: number | null | undefined;
}, {
    pass: boolean;
    target: string;
    ranAt: string;
    sla: {
        pass: boolean;
        metric: string;
        target: number;
        actual: number | null;
        unit: string;
        comparator: "<=" | ">=";
        note?: string | undefined;
    }[];
    citationGrounding: number | null;
    recallAt5: number | null;
    retrievalRate: number | null;
    errorRate: number | null;
    latency: {
        ttftP95Ms?: number | null | undefined;
        ttftP50Ms?: number | null | undefined;
        answerP50Ms?: number | null | undefined;
        answerP95Ms?: number | null | undefined;
        accept202P95Ms?: number | null | undefined;
    };
    cost: {
        meanCostPerAnswerUsd?: number | null | undefined;
        projectedMonthlyUsd?: number | null | undefined;
        projectedMonthlyNoCacheUsd?: number | null | undefined;
    };
    answers?: number | undefined;
    searchCacheHitRatePct?: number | null | undefined;
}>;
export type BenchReport = z.infer<typeof BenchReport>;
export declare const QualityRuleResult: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    severity: z.ZodString;
    status: z.ZodEnum<["pass", "fail", "skip", "manual", "unimplemented"]>;
    detail: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
    title: string;
    id: string;
    severity: string;
    detail?: string | undefined;
}, {
    status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
    title: string;
    id: string;
    severity: string;
    detail?: string | undefined;
}>;
export type QualityRuleResult = z.infer<typeof QualityRuleResult>;
export declare const QualityReport: z.ZodObject<{
    project: z.ZodString;
    checkedAt: z.ZodString;
    runs: z.ZodNumber;
    errors: z.ZodNumber;
    warnings: z.ZodNumber;
    results: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        severity: z.ZodString;
        status: z.ZodEnum<["pass", "fail", "skip", "manual", "unimplemented"]>;
        detail: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
        title: string;
        id: string;
        severity: string;
        detail?: string | undefined;
    }, {
        status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
        title: string;
        id: string;
        severity: string;
        detail?: string | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    results: {
        status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
        title: string;
        id: string;
        severity: string;
        detail?: string | undefined;
    }[];
    runs: number;
    project: string;
    checkedAt: string;
    errors: number;
    warnings: number;
}, {
    results: {
        status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
        title: string;
        id: string;
        severity: string;
        detail?: string | undefined;
    }[];
    runs: number;
    project: string;
    checkedAt: string;
    errors: number;
    warnings: number;
}>;
export type QualityReport = z.infer<typeof QualityReport>;
/** One step of a trajectory a human actually read, end to end. */
export declare const TrajectoryStep: z.ZodObject<{
    step: z.ZodNumber;
    tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
    ok: z.ZodBoolean;
    ms: z.ZodOptional<z.ZodNumber>;
    input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    reason: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    subQuestion: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    ok: boolean;
    input?: Record<string, unknown> | undefined;
    ms?: number | undefined;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}, {
    step: number;
    tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
    ok: boolean;
    input?: Record<string, unknown> | undefined;
    ms?: number | undefined;
    reason?: string | undefined;
    error?: string | undefined;
    subQuestion?: number | undefined;
}>;
export type TrajectoryStep = z.infer<typeof TrajectoryStep>;
export declare const Trajectory: z.ZodObject<{
    requestId: z.ZodString;
    query: z.ZodOptional<z.ZodString>;
    terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
    depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
    steps: z.ZodArray<z.ZodObject<{
        step: z.ZodNumber;
        tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
        ok: z.ZodBoolean;
        ms: z.ZodOptional<z.ZodNumber>;
        input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        reason: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        subQuestion: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ok: boolean;
        input?: Record<string, unknown> | undefined;
        ms?: number | undefined;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }, {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ok: boolean;
        input?: Record<string, unknown> | undefined;
        ms?: number | undefined;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }>, "many">;
    /** What reading it taught you. P1 is not satisfied by pasting a log. */
    notes: z.ZodString;
}, "strip", z.ZodTypeAny, {
    requestId: string;
    steps: {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ok: boolean;
        input?: Record<string, unknown> | undefined;
        ms?: number | undefined;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }[];
    notes: string;
    terminated?: "error" | "done" | "cap" | undefined;
    depth?: "quick" | "deep" | undefined;
    query?: string | undefined;
}, {
    requestId: string;
    steps: {
        step: number;
        tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
        ok: boolean;
        input?: Record<string, unknown> | undefined;
        ms?: number | undefined;
        reason?: string | undefined;
        error?: string | undefined;
        subQuestion?: number | undefined;
    }[];
    notes: string;
    terminated?: "error" | "done" | "cap" | undefined;
    depth?: "quick" | "deep" | undefined;
    query?: string | undefined;
}>;
export type Trajectory = z.infer<typeof Trajectory>;
export declare const GateResult: z.ZodObject<{
    gate: z.ZodNumber;
    name: z.ZodEnum<["STATIC", "CONTRACT", "RUN", "TRAJECTORY", "EVAL", "HUMAN"]>;
    status: z.ZodEnum<["pass", "fail", "skip", "manual"]>;
    detail: z.ZodOptional<z.ZodString>;
    exitCode: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status: "pass" | "fail" | "manual" | "skip";
    name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
    gate: number;
    detail?: string | undefined;
    exitCode?: number | undefined;
}, {
    status: "pass" | "fail" | "manual" | "skip";
    name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
    gate: number;
    detail?: string | undefined;
    exitCode?: number | undefined;
}>;
export type GateResult = z.infer<typeof GateResult>;
export declare const EvalsReport: z.ZodObject<{
    assignment: z.ZodString;
    student: z.ZodString;
    repo: z.ZodOptional<z.ZodString>;
    video: z.ZodOptional<z.ZodString>;
    deployedAt: z.ZodString;
    /** LLM, search provider, Atlas tier: how this run was actually configured. */
    runNotes: z.ZodOptional<z.ZodString>;
    design: z.ZodObject<{
        components: z.ZodString;
        responsibilities: z.ZodString;
        communication: z.ZodString;
        state: z.ZodString;
        tradeoffs: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        components: string;
        responsibilities: string;
        communication: string;
        state: string;
        tradeoffs: string;
    }, {
        components: string;
        responsibilities: string;
        communication: string;
        state: string;
        tradeoffs: string;
    }>;
    gates: z.ZodDefault<z.ZodArray<z.ZodObject<{
        gate: z.ZodNumber;
        name: z.ZodEnum<["STATIC", "CONTRACT", "RUN", "TRAJECTORY", "EVAL", "HUMAN"]>;
        status: z.ZodEnum<["pass", "fail", "skip", "manual"]>;
        detail: z.ZodOptional<z.ZodString>;
        exitCode: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "fail" | "manual" | "skip";
        name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
        gate: number;
        detail?: string | undefined;
        exitCode?: number | undefined;
    }, {
        status: "pass" | "fail" | "manual" | "skip";
        name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
        gate: number;
        detail?: string | undefined;
        exitCode?: number | undefined;
    }>, "many">>;
    rubric: z.ZodObject<{
        total: z.ZodNumber;
        awarded: z.ZodNumber;
        automated: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            points: z.ZodNumber;
            awarded: z.ZodNumber;
            status: z.ZodEnum<["pass", "partial", "fail", "manual"]>;
            evidence: z.ZodString;
            rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }, {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }>, "many">;
        manual: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            label: z.ZodString;
            points: z.ZodNumber;
            awarded: z.ZodNumber;
            status: z.ZodEnum<["pass", "partial", "fail", "manual"]>;
            evidence: z.ZodString;
            rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }, {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }>, "many">;
        redLines: z.ZodDefault<z.ZodArray<z.ZodObject<{
            check: z.ZodString;
            ok: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }, {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        awarded: number;
        manual: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }[];
        total: number;
        automated: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }[];
        redLines: {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }[];
    }, {
        awarded: number;
        manual: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }[];
        total: number;
        automated: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }[];
        redLines?: {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }[] | undefined;
    }>;
    bench: z.ZodObject<{
        ranAt: z.ZodString;
        target: z.ZodString;
        pass: z.ZodBoolean;
        sla: z.ZodArray<z.ZodObject<{
            metric: z.ZodString;
            target: z.ZodNumber;
            actual: z.ZodNullable<z.ZodNumber>;
            unit: z.ZodString;
            comparator: z.ZodEnum<["<=", ">="]>;
            pass: z.ZodBoolean;
            note: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }, {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }>, "many">;
        /** The four metric names quality/check.mjs looks for, also written to reports/eval.json. */
        citationGrounding: z.ZodNullable<z.ZodNumber>;
        recallAt5: z.ZodNullable<z.ZodNumber>;
        retrievalRate: z.ZodNullable<z.ZodNumber>;
        errorRate: z.ZodNullable<z.ZodNumber>;
        latency: z.ZodObject<{
            ttftP50Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            ttftP95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            answerP50Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            answerP95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            accept202P95Ms: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, "strip", z.ZodTypeAny, {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        }, {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        }>;
        cost: z.ZodObject<{
            meanCostPerAnswerUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            projectedMonthlyUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            projectedMonthlyNoCacheUsd: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, "strip", z.ZodTypeAny, {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        }, {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        }>;
        searchCacheHitRatePct: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        answers: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        pass: boolean;
        target: string;
        ranAt: string;
        sla: {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }[];
        citationGrounding: number | null;
        recallAt5: number | null;
        retrievalRate: number | null;
        errorRate: number | null;
        latency: {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        };
        cost: {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        };
        answers?: number | undefined;
        searchCacheHitRatePct?: number | null | undefined;
    }, {
        pass: boolean;
        target: string;
        ranAt: string;
        sla: {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }[];
        citationGrounding: number | null;
        recallAt5: number | null;
        retrievalRate: number | null;
        errorRate: number | null;
        latency: {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        };
        cost: {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        };
        answers?: number | undefined;
        searchCacheHitRatePct?: number | null | undefined;
    }>;
    quality: z.ZodObject<{
        project: z.ZodString;
        checkedAt: z.ZodString;
        runs: z.ZodNumber;
        errors: z.ZodNumber;
        warnings: z.ZodNumber;
        results: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            title: z.ZodString;
            severity: z.ZodString;
            status: z.ZodEnum<["pass", "fail", "skip", "manual", "unimplemented"]>;
            detail: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }, {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        results: {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }[];
        runs: number;
        project: string;
        checkedAt: string;
        errors: number;
        warnings: number;
    }, {
        results: {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }[];
        runs: number;
        project: string;
        checkedAt: string;
        errors: number;
        warnings: number;
    }>;
    trajectories: z.ZodObject<{
        successful: z.ZodObject<{
            requestId: z.ZodString;
            query: z.ZodOptional<z.ZodString>;
            terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
            depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
            steps: z.ZodArray<z.ZodObject<{
                step: z.ZodNumber;
                tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
                ok: z.ZodBoolean;
                ms: z.ZodOptional<z.ZodNumber>;
                input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                reason: z.ZodOptional<z.ZodString>;
                error: z.ZodOptional<z.ZodString>;
                subQuestion: z.ZodOptional<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }, {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }>, "many">;
            /** What reading it taught you. P1 is not satisfied by pasting a log. */
            notes: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        }, {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        }>;
        failing: z.ZodObject<{
            requestId: z.ZodString;
            query: z.ZodOptional<z.ZodString>;
            terminated: z.ZodOptional<z.ZodEnum<["done", "cap", "error"]>>;
            depth: z.ZodOptional<z.ZodEnum<["quick", "deep"]>>;
            steps: z.ZodArray<z.ZodObject<{
                step: z.ZodNumber;
                tool: z.ZodEnum<["web_search", "fetch_page", "search_documents", "recall_memory", "save_memory", "plan_research"]>;
                ok: z.ZodBoolean;
                ms: z.ZodOptional<z.ZodNumber>;
                input: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                reason: z.ZodOptional<z.ZodString>;
                error: z.ZodOptional<z.ZodString>;
                subQuestion: z.ZodOptional<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }, {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }>, "many">;
            /** What reading it taught you. P1 is not satisfied by pasting a log. */
            notes: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        }, {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        successful: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
        failing: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
    }, {
        successful: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
        failing: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
    }>;
}, "strip", z.ZodTypeAny, {
    assignment: string;
    student: string;
    deployedAt: string;
    design: {
        components: string;
        responsibilities: string;
        communication: string;
        state: string;
        tradeoffs: string;
    };
    gates: {
        status: "pass" | "fail" | "manual" | "skip";
        name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
        gate: number;
        detail?: string | undefined;
        exitCode?: number | undefined;
    }[];
    rubric: {
        awarded: number;
        manual: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }[];
        total: number;
        automated: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules: string[];
        }[];
        redLines: {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }[];
    };
    bench: {
        pass: boolean;
        target: string;
        ranAt: string;
        sla: {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }[];
        citationGrounding: number | null;
        recallAt5: number | null;
        retrievalRate: number | null;
        errorRate: number | null;
        latency: {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        };
        cost: {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        };
        answers?: number | undefined;
        searchCacheHitRatePct?: number | null | undefined;
    };
    quality: {
        results: {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }[];
        runs: number;
        project: string;
        checkedAt: string;
        errors: number;
        warnings: number;
    };
    trajectories: {
        successful: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
        failing: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
    };
    repo?: string | undefined;
    video?: string | undefined;
    runNotes?: string | undefined;
}, {
    assignment: string;
    student: string;
    deployedAt: string;
    design: {
        components: string;
        responsibilities: string;
        communication: string;
        state: string;
        tradeoffs: string;
    };
    rubric: {
        awarded: number;
        manual: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }[];
        total: number;
        automated: {
            status: "pass" | "partial" | "fail" | "manual";
            id: string;
            label: string;
            points: number;
            awarded: number;
            evidence: string;
            rules?: string[] | undefined;
        }[];
        redLines?: {
            ok: boolean;
            check: string;
            detail?: string | undefined;
        }[] | undefined;
    };
    bench: {
        pass: boolean;
        target: string;
        ranAt: string;
        sla: {
            pass: boolean;
            metric: string;
            target: number;
            actual: number | null;
            unit: string;
            comparator: "<=" | ">=";
            note?: string | undefined;
        }[];
        citationGrounding: number | null;
        recallAt5: number | null;
        retrievalRate: number | null;
        errorRate: number | null;
        latency: {
            ttftP95Ms?: number | null | undefined;
            ttftP50Ms?: number | null | undefined;
            answerP50Ms?: number | null | undefined;
            answerP95Ms?: number | null | undefined;
            accept202P95Ms?: number | null | undefined;
        };
        cost: {
            meanCostPerAnswerUsd?: number | null | undefined;
            projectedMonthlyUsd?: number | null | undefined;
            projectedMonthlyNoCacheUsd?: number | null | undefined;
        };
        answers?: number | undefined;
        searchCacheHitRatePct?: number | null | undefined;
    };
    quality: {
        results: {
            status: "pass" | "fail" | "manual" | "skip" | "unimplemented";
            title: string;
            id: string;
            severity: string;
            detail?: string | undefined;
        }[];
        runs: number;
        project: string;
        checkedAt: string;
        errors: number;
        warnings: number;
    };
    trajectories: {
        successful: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
        failing: {
            requestId: string;
            steps: {
                step: number;
                tool: "web_search" | "fetch_page" | "search_documents" | "recall_memory" | "save_memory" | "plan_research";
                ok: boolean;
                input?: Record<string, unknown> | undefined;
                ms?: number | undefined;
                reason?: string | undefined;
                error?: string | undefined;
                subQuestion?: number | undefined;
            }[];
            notes: string;
            terminated?: "error" | "done" | "cap" | undefined;
            depth?: "quick" | "deep" | undefined;
            query?: string | undefined;
        };
    };
    repo?: string | undefined;
    video?: string | undefined;
    runNotes?: string | undefined;
    gates?: {
        status: "pass" | "fail" | "manual" | "skip";
        name: "STATIC" | "CONTRACT" | "RUN" | "TRAJECTORY" | "EVAL" | "HUMAN";
        gate: number;
        detail?: string | undefined;
        exitCode?: number | undefined;
    }[] | undefined;
}>;
export type EvalsReport = z.infer<typeof EvalsReport>;
//# sourceMappingURL=report.d.ts.map