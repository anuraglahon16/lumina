# Rescored offline against the corrected citation validator

- run: `e2e0e4652a4283a5fcaef037a28f2e85d79335a3` at 2026-09-17T14:25:29.887Z
- rescored: 2026-09-17T23:37:49.550Z
- questions: 20 (20 rescored, 0 not rescorable, 0 errored)
- no network or model call: this reads the saved run and nothing else

## What the fix changed

| measure | as first reported | rescored |
|---|---:|---:|
| pooled citation grounding | 0.950 | **0.910** |
| mean run grounding | 0.906 | **0.861** |
| cited sentences | 101 | 100 |
| supported sentences | 96 | 91 |

Orphan citations, counted in neither direction: 0.
Cited sentences with nothing checkable in them, also counted in neither: 0.

## Citation completeness

- cited factual sentences: 99 of 163 = **0.607**
- excluding the disclosures the prompt requires to be uncited: 99 of 159 = **0.623**

Of the uncited factual sentences, measured rather than judged:

| | sentences |
|---|---:|
| statements a source in the same run supports (>= 0.5 overlap) | 42 |
| statements no source supports | 18 |
| disclosures about what the evidence lacks, required to be uncited | 4 |
| **total awaiting classification** | **64** |

The split above is the validator's own overlap measure applied to sentences
nobody cited. It separates an answer that had evidence and did not cite it
from one that asserted something nothing supports. It does not decide
whether a sentence asserts anything checkable — that judgement is left in
reports/uncited-audit.json for a person.

## Retrieval outcomes, recomputed

| outcome | runs |
|---|---:|
| successful_retrieval | 10 |
| citation_failure | 6 |
| passage_miss | 2 |
| query_miss | 1 |
| synthesis_omission | 1 |

## Per question

| question | cited → | supported → | grounding → | outcome |
|---|---|---|---|---|
| How does a bloom filter trade memory for fal | 7 → 7 | 7 → 7 | 1.000 → 1.000 | successful_retrieval |
| What does the Linux OOM killer use to score  | 3 → 3 | 2 → 2 | 0.667 → 0.667 | citation_failure |
| How does TCP slow start decide the initial c | 4 → 4 | 4 → 4 | 1.000 → 1.000 | successful_retrieval |
| What is the difference between a clustered a | 8 → 8 | 8 → 8 | 1.000 → 1.000 | successful_retrieval |
| How does the DNS resolver decide when a cach | 3 → 3 | 3 → 3 | 1.000 → 1.000 | successful_retrieval |
| What does a Merkle tree let a distributed sy | 6 → 6 | 6 → 6 | 1.000 → 1.000 | successful_retrieval |
| How does write amplification arise in solid  | 0 → 0 | 0 → 0 | — → — | query_miss |
| What problem does the two-phase commit proto | 7 → 7 | 7 → 7 | 1.000 → 1.000 | successful_retrieval |
| How does HTTP content negotiation choose a r | 9 → 9 | 9 → 9 | 1.000 → 1.000 | successful_retrieval |
| What does the borrow checker in Rust prevent | 1 → 1 | 1 → 1 | 1.000 → 1.000 | synthesis_omission |
| How does a JIT compiler decide that a method | 8 → 8 | 8 → 7 | 1.000 → 0.875 | citation_failure |
| What is the purpose of a write-ahead log in  | 6 → 6 | 6 → 6 | 1.000 → 1.000 | successful_retrieval |
| How does consistent hashing limit the keys t | 5 → 4 | 4 → 3 | 0.800 → 0.750 | citation_failure |
| What does TLS certificate pinning protect ag | 0 → 0 | 0 → 0 | — → — | passage_miss |
| How does a copy-on-write filesystem snapshot | 7 → 7 | 7 → 7 | 1.000 → 1.000 | successful_retrieval |
| What causes head-of-line blocking in HTTP/2  | 1 → 1 | 0 → 0 | 0.000 → 0.000 | passage_miss |
| How does a vector clock differ from a Lampor | 12 → 12 | 10 → 10 | 0.833 → 0.833 | citation_failure |
| What does the CAP theorem actually claim abo | 4 → 4 | 4 → 4 | 1.000 → 1.000 | successful_retrieval |
| How do columnar storage formats achieve bett | 3 → 3 | 3 → 2 | 1.000 → 0.667 | citation_failure |
| What is false sharing, and why does it slow  | 7 → 7 | 7 → 5 | 1.000 → 0.714 | citation_failure |
