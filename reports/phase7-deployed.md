# Phase 7 — the full benchmark, against the deployed application

This is the authoritative run. Everything in `reports/superseded/` was measured
against `http://localhost:8787` and is kept only as history.

## What was measured, and where

| | |
|---|---|
| deployment | `https://lumina-kimit8sv0-anuraglahon16s-projects.vercel.app` |
| deployment id | `dpl_EihX2aBEPqDxC285JXTmq7ngq2od` (READY) |
| commit | `ec88475` on `rubric-conformance-final`, working tree clean |
| benchmark window | 2026-09-19T03:35:18Z → 03:55:26Z |
| Node | 22.23.2 — `engines.node: ">=20.19 <24"` overriding the project's `24.x` setting |
| model roles | quick/planner/branch/rewrite/memory `claude-haiku-4-5`, deep synthesis `claude-sonnet-5` |
| providers | Anthropic · Tavily (not degraded) · **local embeddings**, Voyage not called |
| database | MongoDB Atlas, database `lumina_preview`, `atlas-vector-search` |

No code or environment was changed during the run.

## Headline: citation grounding is 1.000

```
grounding: 75/75 verifiable citations · 0 unverifiable (fetch blocked) · 0 dangling
```

Against 0.784 on the localhost run. The target is 0.95.

## SLA

| metric | actual | target | |
|---|---:|---:|---|
| citation grounding | **1.000** | ≥ 0.95 | pass |
| recall@5 | **0.967** (29/30) | ≥ 0.7 | pass |
| citations with no matching source | 0 | 0 | pass |
| sources before the first token | 1 | ≥ 1 | pass |
| answer p95 | 9260 ms | ≤ 12000 | pass |
| search p95 during ingest / idle | 0.92× | ≤ 1.3× | pass |
| deep plan p95 | 3340 ms | ≤ 4000 | pass |
| deep answer p95 | 58.1 s | ≤ 90 s | pass |
| deep sub-questions (min) | 4 | ≥ 3 | pass |
| deep/quick source ratio (min) | 5.5× | ≥ 2× | pass |
| cost per deep answer | $0.1038 | ≤ $0.35 | pass |
| cost per quick answer | $0.0035 | ≤ $0.05 | pass |
| **ttft p95** | **4715 ms** | ≤ 2500 | **fail** |
| **202 accept p95** | **390 ms** | ≤ 300 | **fail** |
| **search cache hit rate** | **44.7%** | ≥ 50% | **fail** |
| **error rate** | **0.0247** | ≤ 0.01 | **fail** |

Contract probes, 4/4, including the one this phase's first commit was for:

```
✓ GET /memory without X-User-Id → 401
✓ GET /threads/thr_nope → 404
✓ POST /threads/thr_x/ask with an empty body → 400
✓ GET /evals/report.json without X-User-Id → 200 (must not be 401)
```

## Document RAG works deployed for the first time

All four corpus files indexed — `retrieval-basics.pdf` (4 pages),
`vector-search-on-mongodb.pdf` (3), and both Markdown files (3 each). Before the
Node pin, every PDF failed at 5% with `bad XRef entry` and document RAG measured
against the deployment would have scored zero while the localhost run reported
15/15.

## The two errors were client-side timeouts

77 answers, 2 errors in 81 attempts. The note the benchmark recorded is
`ask failed (network): The operation was aborted due to timeout` — the harness
aborting, not the server failing. The export confirms it: of the 87 run logs in
the window, **0 terminated in error**. This is the same root as the ttft miss:
deployed latency carries network and cold-start cost that localhost never had.

## Quality — 2 error-severity failures

`npm run quality` over the 87 exported runs of this window only:

| | | |
|---|---|---|
| C1 | pass | declared expectations coherent |
| A1 | pass | tool errors surface as errors |
| **A2** | **fail (error)** | 4 runs terminated `cap` |
| A3 | fail (warn) | consecutive `fetch_page` above 4 in 13 runs |
| E1 | pass | 39 gold items |
| **E2** | **fail (error)** | errorRate 0.0247 > 0.01 |
| B1 B2 B3 | pass | token, latency, cost budgets |
| E3 P1 | manual | judge severity; human trajectory read |
| P2 | fail (warn) | 10 rules lack a cited precedent |

### A2 is reporting a labelling bug, not a loop that fails to finish

Every deep run in the window, with what each branch actually did:

```
reason=null                     branches=[capped, capped, capped, capped]   → "done"
reason=null                     branches=[capped, capped, capped, capped]   → "done"
reason=null                     branches=[capped, capped, capped, capped]   → "done"
reason=deep_tool_budget_exhausted branches=[capped, capped, capped, POOL]   → "cap"
reason=completed                branches=[complete, complete, complete]     → "done"
reason=capped                   branches=[complete, capped, capped, complete] → "cap"
reason=capped                   branches=[complete, complete, capped, capped] → "cap"
reason=capped                   branches=[complete, complete, capped, complete] → "cap"
reason=completed                branches=[complete, complete, complete, complete] → "done"
```

The three runs where **all four** branches hit their per-branch ceiling report
`reason=null` and are counted as finished. Three runs where only **some**
branches hit it report `capped`. The more constrained runs are labelled done and
the less constrained ones are labelled cut short, which is backwards, and it
means A2's four failures do not identify the runs that were actually curtailed.

Applying the rule this project set — *was intended work abandoned?* — gives one
answer, not two:

- A **per-branch** ceiling is a designed fairness bound. Every sub-question was
  still researched and the answer synthesised (2641–3791 characters, with
  sources). Nothing was abandoned. That is `done`.
- The **shared pool** running out stopped a branch that still had budget of its
  own: `req_mu7upct3qus33l`, where q4 had 1 tool call left and the global pool
  was spent. That is `cap`, honestly.

Under that rule exactly one run in 87 is `cap`, and **A2 still fails** — which is
the correct outcome, because that run really was curtailed. It is not fixed by
relabelling and this report does not relabel it.

There is a design reason it happened: `maxToolCallsPerBranch` is 6 and
`maxSubQuestions` is 4, so four full branches sum to exactly
`maxToolCallsTotal: 24`. The pool is guaranteed to be exhausted by branches
alone, leaving nothing for the cross-branch sweep. The budget collides with
itself by construction.

### A3, the same shape as before

`fetch_page` called 5–12 times consecutively against a cap of 4. These are the
coverage-driven fetch pools running concurrently: the pool issues fetches
together, so the recorder sees a run of them with nothing interleaved. It is a
warning, not an error, and it is documented rather than disguised.

### Tool-call accounting is worth a look

The contract's trace frames stay inside 24 (the Phase 6 smoke measured 23 and
24), but the run log for `req_mu7upct3qus33l` records **31 tool calls** against
`maxToolCallsTotal: 24`. The difference is the per-branch budget refunds
(`refunded: 1` on each branch) and sweep fetches, which are recorded but not
emitted as contract traces. The grader-visible number is inside the cap; the
recorded number is not. That gap should be explained or closed before anyone
relies on either figure.

## Provenance of the numbers

- `reports/bench.json`, `reports/eval.json` — this run
- `reports/quality.json` — quality over this run's 87 exported logs
- `runs/` — 87 logs, benchmark user, this window only, re-exported with
  `--scope benchmark` after the run
- `reports/superseded/` — the localhost run, labelled non-authoritative
