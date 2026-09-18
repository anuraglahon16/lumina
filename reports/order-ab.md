# Does evidence order decide whether the answer uses it?

> Not a benchmark. Three orderings of identical evidence, replayed from the
> e2e0e46 run. Nothing is added or removed; only the order changes.

- ran: 2026-09-18T00:54:26.323Z
- model: claude-haiku-4-5
- questions: 20, 3 samples per arm each
- answers generated: 180

## The primary metric

A false refusal is an answer that declines to answer while the evidence it
was given holds what was asked. Which questions those are was declared
before the run, from adjudication and from the baseline.

| | A original | B relevance | C content first |
|---|---:|---:|---:|
| **false refusals** | 5 | 1 | 2 |
| false refusal rate | 0.083 | 0.017 | 0.033 |
| correct refusals (evidence really absent) | 3 | 3 | 3 |

Correct refusals must not fall. An ordering that answers the SSD question
has not improved anything; it has started answering from nothing.

## What the answers did

| | A | B | C |
|---|---:|---:|---:|
| answered outright | 44 | 53 | 53 |
| answered with a disclosure | 8 | 3 | 2 |
| refused entirely | 8 | 4 | 5 |

## Regressions to watch

| | A | B | C |
|---|---:|---:|---:|
| pooled grounding | 0.931 | 0.944 | 0.967 |
| citation completeness | 0.809 | 0.843 | 0.819 |
| unsupported cited sentences | 27 | 22 | 13 |
| output tokens | 13871 | 13825 | 13865 |
| cost (USD) | 0.2101 | 0.2090 | 0.2093 |
| mean synthesis latency (ms) | 3042 | 2970 | 2955 |

Reordering costs no model call and no embedding call, so any latency
difference here is the provider, not the ranker.

## Each repeat on its own

| repeat | false refusals A | B | C |
|---|---:|---:|---:|
| 1 | 2 | 1 | 1 |
| 2 | 1 | 0 | 0 |
| 3 | 2 | 0 | 1 |

## The four questions the hypothesis is about

| question | evidence holds the answer | A | B | C |
|---|---|---|---|---|
| How does write amplification arise in so | no | refused, refused, refused | refused, refused, refused | refused, refused, refused |
| What does the borrow checker in Rust pre | yes | partial, partial, partial | answered, answered, answered | answered, answered, answered |
| What does TLS certificate pinning protec | yes | refused, refused, refused | answered, answered, answered | answered, answered, answered |
| What causes head-of-line blocking in HTT | yes | refused, partial, refused | refused, partial, partial | refused, partial, refused |

