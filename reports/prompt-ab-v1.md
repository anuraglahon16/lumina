# Citation contract, A/B on fixed evidence

> Not a benchmark. Twenty questions, one answer per variant, on evidence
> replayed from the e2e0e46 run so retrieval cannot vary between them.

- evidence from: `e2e0e4652a4283a5fcaef037a28f2e85d79335a3` (2026-09-17T14:25:29.887Z)
- ran: 2026-09-17T23:32:45.835Z
- model: claude-haiku-4-5
- questions: 20, 3 sample(s) per variant each
- answers generated: 120

## The three dimensions

| measure | A: legacy prompt | B: granularity contract | change |
|---|---:|---:|---:|
| pooled citation grounding | 0.950 | 0.958 | +0.008 |
| mean run grounding | 0.948 | 0.956 | +0.009 |
| citation completeness | 0.625 | 0.787 | +0.162 |
| completeness, disclosures excluded | 0.638 | 0.800 | +0.162 |

## The guard rail

A prompt demanding a citation per sentence can satisfy completeness by
citing sentences the block does not support. If this row rises, the change
is not an improvement whatever else moved.

| | A | B | change |
|---|---:|---:|---:|
| unsupported cited sentences | 16 | 16 | +0 |
| orphan citations | 0 | 0 | +0 |
| uncited factual sentences a source supports | 144 | 51 | -93 |

## What it costs

| | A | B | change |
|---|---:|---:|---:|
| output tokens | 14837 | 13928 | -909 |
| cost (USD, synthesis only) | 0.1997 | 0.2039 | +0.0042 |
| words written | 10920 | 10284 | -636 |
| citation markers | 324 | 387 | +63 |
| markers per 100 words | 3.0 | 3.8 | — |
| mean synthesis latency (ms) | 3446 | 3243 | -203 |

Marker density is the readability cost. It is reported, not judged: whether
a citation on every factual sentence reads well is a call for a person.

## Each repeat on its own

A gap between the variants that is smaller than the gap between samples of
the same variant is not a result. One run of each could never show that.

| repeat | completeness A | completeness B | grounding A | grounding B | unsupported A | unsupported B |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 0.637 | 0.784 | 0.926 | 0.969 | 8 | 4 |
| 2 | 0.629 | 0.787 | 0.952 | 0.944 | 5 | 7 |
| 3 | 0.609 | 0.788 | 0.971 | 0.959 | 3 | 5 |

## Per question

First sample of each variant.

| question | grounding A→B | completeness A→B | unsupported A→B |
|---|---|---|---|
| How does a bloom filter trade memory for fal | 1.00 → 1.00 | 0.77 → 0.85 | 0 → 0 |
| What does the Linux OOM killer use to score  | 1.00 → 1.00 | 1.00 → 1.00 | 0 → 0 |
| How does TCP slow start decide the initial c | 1.00 → 1.00 | 0.33 → 0.50 | 0 → 0 |
| What is the difference between a clustered a | 1.00 → 1.00 | 0.91 → 1.00 | 0 → 0 |
| How does the DNS resolver decide when a cach | 1.00 → 1.00 | 0.80 → 0.67 | 0 → 0 |
| What does a Merkle tree let a distributed sy | 0.90 → 1.00 | 1.00 → 1.00 | 1 → 0 |
| How does write amplification arise in solid  | — → — | 0.00 → 0.00 | 0 → 0 |
| What problem does the two-phase commit proto | 0.89 → 1.00 | 0.90 → 0.83 | 1 → 0 |
| How does HTTP content negotiation choose a r | 1.00 → 1.00 | 0.56 → 0.89 | 0 → 0 |
| What does the borrow checker in Rust prevent | 1.00 → 1.00 | 0.75 → 0.75 | 0 → 0 |
| How does a JIT compiler decide that a method | 0.75 → 0.88 | 0.44 → 0.73 | 1 → 1 |
| What is the purpose of a write-ahead log in  | 1.00 → 0.91 | 0.86 → 1.00 | 0 → 1 |
| How does consistent hashing limit the keys t | 0.71 → 1.00 | 0.88 → 1.00 | 2 → 0 |
| What does TLS certificate pinning protect ag | — → — | 0.00 → 0.00 | 0 → 0 |
| How does a copy-on-write filesystem snapshot | 1.00 → 1.00 | 0.40 → 0.88 | 0 → 0 |
| What causes head-of-line blocking in HTTP/2  | 1.00 → 1.00 | 0.33 → 0.50 | 0 → 0 |
| How does a vector clock differ from a Lampor | 1.00 → 0.92 | 0.41 → 0.93 | 0 → 1 |
| What does the CAP theorem actually claim abo | 0.50 → 1.00 | 0.50 → 0.67 | 2 → 0 |
| How do columnar storage formats achieve bett | 1.00 → 1.00 | 0.38 → 0.50 | 0 → 0 |
| What is false sharing, and why does it slow  | 0.90 → 0.89 | 0.83 → 0.75 | 1 → 1 |
