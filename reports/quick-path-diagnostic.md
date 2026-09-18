# Quick path cold diagnostic

Twenty web questions, each asked once, none asked before in this session, so
every search and every fetch was a cache miss. Captured from the run log, one
row per query. This exists to locate the cost before anything is tuned.

- commit measured: `324ef3b`
- mode: quick, depth quick, no Space, fresh thread per query
- models: quick/planner/branch = claude-haiku-4-5, deep synthesis = claude-sonnet-5

## Totals

| metric | p50 | p95 | max | gate |
|---|---:|---:|---:|---:|
| TTFT | 3.64s | 7.24s | 7.24s | 2.5s |
| Answer | 6.06s | 10.50s | 10.50s | 12s |
| Cost | $0.0035 | $0.0069 | $0.0069 | $0.05 |

## Where the time goes

| phase | p50 | p95 | max |
|---|---:|---:|---:|
| context | 181 ms | 569 ms | 569 ms |
| rewrite | — | — | — |
| retrieval | 2676 ms | 6331 ms | 6331 ms |
| rescue | 2134 ms | 2255 ms | 2255 ms |
| synthesis | 1961 ms | 4615 ms | 4615 ms |

## Tool calls

- **web_search** — 25 calls, 25 succeeded, 0 failed. p50 1269 ms, p95 1843 ms, max 2306 ms
- **fetch_page** — 50 calls, 28 succeeded, 22 failed. p50 1013 ms, p95 2629 ms, max 5196 ms

## Outcomes

| termination | runs |
|---|---:|
| evidence_limited | 10 |
| sufficient_evidence | 10 |

- pages successfully read: median 2, zero in 2 of 20 runs
- sources cited: median 1, zero in 7 of 20 runs

## The finding

Retrieval dominates, and inside retrieval it is the page fetch rather than the
search. A representative row: search 1,135 ms, then two concurrent fetches both
taking 5,196 ms, one of which failed and the other returned 151 characters of
usable text. Synthesis after that was 1,128 ms.

So the ten `evidence_limited` runs are not a threshold set too strictly. They
are runs where the pages did not yield readable text in time. Tuning the
coverage thresholds would hide that by lowering the bar for what counts as
covered; the pages would still be unread.

Two consequences for what to do next:

- The largest single contributor to cold TTFT is `fetch_page` tail latency.
  Both fetches in a pair finish together at the slow one, because the pair is
  awaited as a unit — so the slowest page sets the cost of the fastest.
- A shared cache does not touch this. It removes repeat fetches, and every row
  here is a first fetch.

## Caveats

- One pass per query on one machine, one network. Not the official benchmark.
- n=20 makes p95 effectively the second-slowest observation.
- `coverage_ok` and `coverage_reasons` came back null in this capture: the
  phase metadata is recorded but was not read back correctly here, so the
  per-run coverage reasons are reconstructed from the `evidence_limited`
  warning rather than from the phase. Worth fixing before the next capture.
