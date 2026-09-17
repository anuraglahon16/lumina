# Grounding diagnostic

- commit: `b77f77187c009d20149e8e2a46066fb14b4aedd5`
- ran at: 2026-09-17T13:08:15.810Z
- node: v21.7.2
- answer model: claude-haiku-4-5
- search provider: tavily
- questions: 20 answered, 0 failed

Nothing was changed to produce this: no prompt, no threshold, no passage
selection, no model. It measures the state at the commit named above.

## Two different numbers, reported separately

| metric | value | gate |
|---|---:|---:|
| aggregate grounding (supported ÷ cited, pooled) | 0.962 | 0.95 |
| mean run grounding (mean of per-run ratios) | 0.870 | 0.95 |
| citation completeness (factual sentences cited ÷ factual) | 0.617 | — |

These are not interchangeable. Pooling weights a long answer more heavily
than a short one; the mean of ratios treats a run that cited one sentence
perfectly as equal to a run that cited twenty. Completeness is separate
again, and it is the one that catches a system scoring 1.00 grounding by
citing a single safe sentence and leaving everything else uncited.

## Why cited sentences failed

| category | count | what it would mean |
|---|---:|---|
| tokenization_false_negative | 8 | a faithful paraphrase sharing few exact words |
| missing_passage_or_unsupported | 4 | right page, wrong section selected — or nothing supports it |

The classification is a heuristic. Every sentence and the passage it was
scored against are in the JSON, so a reader can disagree with any row.

## Per run

| question | cited | supported | grounding | factual cited | weak |
|---|---:|---:|---:|---:|---:|
| How does a bloom filter trade memory for false posit | 2 | 2 | 1 | 1/4 | 0 |
| What does the Linux OOM killer use to score which pr | 1 | 1 | 1 | 7/7 | 0 |
| How does TCP slow start decide the initial congestio | 1 | 1 | 1 | 4/7 | 0 |
| What is the difference between a clustered and a non | 1 | 1 | 0.8 | 5/11 | 1 |
| How does the DNS resolver decide when a cached recor | 1 | 1 | 0.5 | 2/6 | 1 |
| What does a Merkle tree let a distributed system ver | 2 | 2 | 0.778 | 9/9 | 2 |
| How does write amplification arise in solid state dr | 2 | 2 | 1 | 9/10 | 0 |
| What problem does the two-phase commit protocol solv | 2 | 2 | 0.778 | 7/12 | 2 |
| How does HTTP content negotiation choose a response  | 1 | 1 | 1 | 1/4 | 0 |
| What does the borrow checker in Rust prevent at comp | 2 | 1 | 0.5 | 2/4 | 1 |
| How does a JIT compiler decide that a method is hot  | 0 | — | — | 0/4 | 0 |
| What is the purpose of a write-ahead log in database | 1 | 1 | 0.857 | 7/7 | 1 |
| How does consistent hashing limit the keys that move | 0 | — | — | 0/3 | 0 |
| What does TLS certificate pinning protect against, a | 1 | 1 | 1 | 8/11 | 0 |
| How does a copy-on-write filesystem snapshot avoid d | 1 | 1 | 1 | 7/11 | 0 |
| What causes head-of-line blocking in HTTP/2 but not  | 1 | 1 | 1 | 3/4 | 0 |
| How does a vector clock differ from a Lamport timest | 1 | 1 | 0.667 | 6/12 | 2 |
| What does the CAP theorem actually claim about parti | 2 | 2 | 1 | 3/7 | 0 |
| How do columnar storage formats achieve better compr | 2 | 2 | 1 | 2/5 | 0 |
| What is false sharing, and why does it slow down mul | 2 | 2 | 0.778 | 9/11 | 2 |

## Caveats

- One pass per question, one machine, one network. Not the official benchmark.
- The scorer is lexical overlap against the passages a source carried, not entailment.
- Questions were chosen to need a page read and are not drawn from the benchmark or the gold set.
