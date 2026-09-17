# Quick path: cold and warm, after coverage-driven fetching

- commit: `b6e5382` (measured before this commit)
- 20 unique questions asked cold, then the same 20 repeated warm
- quick model claude-haiku-4-5; one machine, one network; not the official benchmark

| metric | cold p50 | cold p95 | warm p50 | warm p95 | gate |
|---|---:|---:|---:|---:|---:|
| TTFT | 3.33s | 7.34s | 0.99s | 3.04s | 2.5s |
| Answer | 6.35s | 8.37s | 3.87s | 5.59s | 12s |
| Cost | $0.0039 | $0.0049 | $0.0038 | $0.0051 | $0.05 |

## Retrieval quality

| measure | before | cold | warm |
|---|---:|---:|---:|
| evidence-limited | 10/20 | 1/20 | 1/20 |
| zero citations | 7/20 | 1/20 | 2/20 |
| zero sources | 2/20 | 0/20 | 0/20 |
| fetch success | 28/50 | 36/43 | 36/38 |
| groundedness (mean) | — | 0.860 | 0.862 |

## Component latency, measured per call

| component | cold p95 | warm p95 |
|---|---:|---:|
| web_search | 5229 ms | 1 ms |
| fetch_page (per page) | 1541 ms | 138 ms |

## What this says

The fetch pool did what it was for. Page fetching succeeds 84% of the time
against 56%, evidence-limited runs fell from half to one in twenty, and runs
citing nothing fell from seven in twenty to one.

The bottleneck moved rather than disappeared. Cold `web_search` p95 is now
5.2 seconds, which is larger than everything else in the request combined and
is the search provider rather than this system. No amount of fetch scheduling
reaches below it, so cold TTFT cannot approach 2.5s until that is addressed:
a faster provider, a second provider raced against the first, or accepting
that the cold gate is unreachable through this dependency.

Warm TTFT p50 is 0.99s and p95 3.04s, which shows the rest of the pipeline is
already fast enough. That is a warm number and is not the gate.

## Open

- Groundedness 0.86 against a 0.95 gate.
- One in twenty answers still cites nothing despite having sources; it is now
  detected and recorded as `uncited_answer` rather than passing silently.
- n=20 makes p95 the second-slowest observation.
