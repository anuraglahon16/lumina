# Retrieval outcomes, after review

> **Not the official benchmark.** One observational run, n=1 per question.
> Citation figures here are superseded by `rescored.md`: a sentence-splitter
> defect split claims from their citation markers. Outcomes derived from
> citation counts are provisional, and `agent_direct_ttft_ms` is not the gate
> metric. See `README.md` in this directory.

- commit: `e2e0e4652a4283a5fcaef037a28f2e85d79335a3`
- run: 2026-09-17T14:25:29.887Z
- reviewed: 2026-09-17T23:38:02.353Z
- questions: 20

## Three dimensions, measured separately

| dimension | value | what it does not tell you |
|---|---:|---|
| citation grounding (supported ÷ cited sentences) | 0.950 | whether the question was answered |
| mean run grounding | 0.906 | the same, weighted per run rather than per sentence |
| citation completeness (cited ÷ factual sentences) | 0.571 | whether the cited ones were right |

A system can score 1.00 on grounding by citing one safe sentence and
leaving the rest uncited, and can cite everything perfectly while answering
a different question from the one asked. Neither number sees the other, and
neither sees retrieval.

## Where retrieval ended up

| outcome | runs |
|---|---:|
| successful_retrieval | 13 |
| citation_failure | 3 |
| passage_miss | 2 |
| query_miss | 1 |
| synthesis_omission | 1 |
| **total** | **20** |

## Per question

| question | outcome | cited | supported | factual cited |
|---|---|---:|---:|---:|
| How does a bloom filter trade memory for false | successful_retrieval | 7 | 7 | 7/14 |
| What does the Linux OOM killer use to score wh | citation_failure | 3 | 2 | 3/7 |
| How does TCP slow start decide the initial con | successful_retrieval | 4 | 4 | 4/7 |
| What is the difference between a clustered and | successful_retrieval | 8 | 8 | 8/8 |
| How does the DNS resolver decide when a cached | successful_retrieval | 3 | 3 | 3/6 |
| What does a Merkle tree let a distributed syst | successful_retrieval | 6 | 6 | 6/8 |
| How does write amplification arise in solid st | query_miss | 0 | 0 | 0/3 |
| What problem does the two-phase commit protoco | successful_retrieval | 7 | 7 | 7/13 |
| How does HTTP content negotiation choose a res | successful_retrieval | 9 | 9 | 9/10 |
| What does the borrow checker in Rust prevent a | synthesis_omission | 1 | 1 | 1/5 |
| How does a JIT compiler decide that a method i | successful_retrieval | 8 | 8 | 4/9 |
| What is the purpose of a write-ahead log in da | successful_retrieval | 6 | 6 | 6/9 |
| How does consistent hashing limit the keys tha | citation_failure | 5 | 4 | 5/6 |
| What does TLS certificate pinning protect agai | passage_miss | 0 | 0 | 0/5 |
| How does a copy-on-write filesystem snapshot a | successful_retrieval | 7 | 7 | 7/10 |
| What causes head-of-line blocking in HTTP/2 bu | passage_miss | 1 | 0 | 1/3 |
| How does a vector clock differ from a Lamport  | citation_failure | 12 | 10 | 12/15 |
| What does the CAP theorem actually claim about | successful_retrieval | 4 | 4 | 4/8 |
| How do columnar storage formats achieve better | successful_retrieval | 3 | 3 | 0/7 |
| What is false sharing, and why does it slow do | successful_retrieval | 7 | 7 | 6/10 |
