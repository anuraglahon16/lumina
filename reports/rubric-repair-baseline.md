# Rubric repair — baseline before any change

Recorded before touching production code, so every later claim has something to
be measured against.

## Where we are

| | |
|---|---|
| branch | `rubric-conformance-final`, cut from `main` |
| commit | `295bc4c` |
| deployment | https://lumina-wheat-ten-92.vercel.app |
| tests | 427 passing, 0 failing |
| automated rubric | **54 / 85** |
| manual rubric | 15 points, ungraded |
| quality | 2 errors, 3 warnings over 400 run logs, exit 2 |

**Commit discrepancy, stated up front.** The instruction names `f102fbb` as the
deployed `main`. `main` is at `295bc4c`, one commit ahead: "Let the React app own
/evals", pushed after that instruction was written. It removed a server route
that shadowed the React evals page, so `/evals` rendered a legacy page telling a
reader to run a harness that had moved. The branch is cut from `295bc4c` because
reverting it would put the wrong page back in front of a grader.

## The scores, and what is failing

| area | score | what the grader says |
|---|---:|---|
| UI lights up & contract | 10/10 | — |
| Search & cited answers | 13/20 | citation grounding 0.784 over 74 verifiable citations, 0 dangling |
| Memory (thread + long-term) | **0/10** | no new row in `GET /memory` after asking it to remember; recall and delete untestable because nothing saved |
| RAG over documents | 15/15 | — |
| Deep search | 8/15 | 4/4 runs left `subQuestion` off a step or source; 3 runs over 24 tool calls; 27 deep searches all accepted, no daily cap |
| Performance & SLA | 3/10 | 2 SLA targets missed; quality has error-severity failures |
| Logging, tracing & stats | 5/5 | — |

## Benchmark metrics this baseline refers to

Run recorded at `reports/eval.json` `ranAt` **2026-09-18T03:09:22Z**, against
`http://localhost:8787`, on a stack reporting `claude-haiku-4-5 · tavily ·
atlas-vector-search · db ok`.

```
ttft p50 1628ms · ttft p95 4029ms   (target 2500)
answer p50 3477ms · answer p95 8460ms (target 12000)
202 accept p95 288ms
grounding 58/76 checked · 2 unverifiable · 0 dangling → 0.784
```

The report's `deployedAt` is 2026-09-18T03:28:11Z, which is when
`eval/build-report.mjs` last ran, not when the benchmark ran. Those are 19
minutes apart and the report does not currently distinguish them.

## Quality failures

```
A2 ✗  The loop terminates because it finished     (error)
A3 ✗  No tool thrash                              (error)
E2 ✗  Declared eval thresholds are met
B2 ✗  Latency budget respected
P2 ✗  Every rule cites a real precedent
```

A2 and A3 read all 400 exported run logs, which currently mix development runs,
provider-outage failures and benchmark runs from several days. Phase 4 addresses
the population, not the records.

## Where each failing behaviour lives

| concern | files |
|---|---|
| `/evals/report.json` | `eval/build-report.mjs` writes `reports/report.json`; `src/agent/routes/contract.js:334` serves it |
| submission metadata | `eval/build-report.mjs` — `--student`, `--successful`, `--failing` flags, currently unpassed |
| memory behaviour | `src/agent/services/memoryStore.js`, `src/agent/routes/memories.js`, `src/agent/core/memoryExtractor.js`, tool wiring in `src/agent/core/tools.js` |
| deep trace/source fields | `src/agent/core/deep.js`; the contract mapping already reads `subQuestion` at `src/gateway/contract/events.js:64` |
| deep tool budget | `src/shared/config.js:256` `maxToolCallsPerBranch: 6`, per branch rather than shared |
| daily deep quota | **does not exist** — no `quota`, `dailyCap` or `resetsAt` anywhere in `src/` |
| run exports | `scripts/export-runs.mjs` (provided), `tools/export-runlogs.mjs` (ours, contract shape) |
| citation snippets | `src/agent/core/evidence.js:275` web, `:359` document, `:436` public serialisation |

## Two observations that bear on later phases

**The deep budget is per branch, not shared.** `maxToolCallsPerBranch: 6` with a
four or five sub-question plan permits 24 to 30 calls before synthesis. That is
consistent with "3 runs over 24 tool calls" and means Phase 3B is a real
architectural change, not a limit adjustment.

**The document snippet is cut with a plain `slice`.** Line 359 uses
`chunk.text.slice(0, 400)` where the web path now uses `safeSlice`. The lone
surrogate defect fixed earlier for web sources is still present for document
sources. Noted here rather than fixed, because Phase 5 forbids changing citation
text before the failure distribution is known.

## What this phase did not do

No production code was changed. No record was edited. No run log was deleted.
