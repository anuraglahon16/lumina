# Grounding diagnostic

> **Not the official benchmark.** One observational run, n=1 per question.
> Citation figures here are superseded by `reports/rescored.md`: a sentence-splitter
> defect split claims from their citation markers. Outcomes derived from citation
> counts are provisional. `agent_direct_ttft_ms` is not the gate metric. See
> `reports/README.md`.


- commit: `e2e0e4652a4283a5fcaef037a28f2e85d79335a3`
- ran at: 2026-09-17T14:25:29.887Z
- node: v21.7.2
- answer model: claude-sonnet-5
- store: mongodb · vectors: atlas-vector-search · embeddings: voyage
- search provider: tavily
- questions: 20 answered, 0 failed

Nothing was changed to produce this: no prompt, no threshold, no passage
selection, no model. It measures the state at the commit named above.

## Two different numbers, reported separately

| metric | value | gate |
|---|---:|---:|
| aggregate grounding (supported ÷ cited sentences, pooled) | 0.950 | 0.95 |
| mean run grounding (mean of per-run ratios) | 0.906 | 0.95 |
| citation completeness (factual sentences cited ÷ factual) | 0.571 | — |

These are not interchangeable. Pooling weights a long answer more heavily
than a short one; the mean of ratios treats a run that cited one sentence
perfectly as equal to a run that cited twenty. Completeness is separate
again, and it is the one that catches a system scoring 1.00 grounding by
citing a single safe sentence and leaving everything else uncited.

## Where retrieval ended up

Not yet classified. Which results were relevant, and whether each answer
addressed the question, are judgements this run cannot make; guessing them
would file an honest refusal to use irrelevant pages as a synthesis
failure, and send work at the part that behaved correctly.

The funnel for every question is in the JSON. Run:

    node tools/apply-review.js --run reports/grounding-diagnostic.json

to produce a blank review, fill it in, and run it again for the outcomes.

## Why cited sentences failed

| category | count | what it would mean |
|---|---:|---|
| missing_passage_or_unsupported | 3 | right page, wrong section selected — or nothing supports it |
| tokenization_false_negative | 2 | a faithful paraphrase sharing few exact words |

The classification is a heuristic. Every sentence and the passage it was
scored against are in the JSON, so a reader can disagree with any row.

## Per run

| question | cited | supported | grounding | factual cited | weak |
|---|---:|---:|---:|---:|---:|
| How does a bloom filter trade memory for false posit | 7 | 7 | 1 | 7/14 | 0 |
| What does the Linux OOM killer use to score which pr | 3 | 2 | 0.667 | 3/7 | 1 |
| How does TCP slow start decide the initial congestio | 4 | 4 | 1 | 4/7 | 0 |
| What is the difference between a clustered and a non | 8 | 8 | 1 | 8/8 | 0 |
| How does the DNS resolver decide when a cached recor | 3 | 3 | 1 | 3/6 | 0 |
| What does a Merkle tree let a distributed system ver | 6 | 6 | 1 | 6/8 | 0 |
| How does write amplification arise in solid state dr | 0 | 0 | — | 0/3 | 0 |
| What problem does the two-phase commit protocol solv | 7 | 7 | 1 | 7/13 | 0 |
| How does HTTP content negotiation choose a response  | 9 | 9 | 1 | 9/10 | 0 |
| What does the borrow checker in Rust prevent at comp | 1 | 1 | 1 | 1/5 | 0 |
| How does a JIT compiler decide that a method is hot  | 8 | 8 | 1 | 4/9 | 0 |
| What is the purpose of a write-ahead log in database | 6 | 6 | 1 | 6/9 | 0 |
| How does consistent hashing limit the keys that move | 5 | 4 | 0.8 | 5/6 | 1 |
| What does TLS certificate pinning protect against, a | 0 | 0 | — | 0/5 | 0 |
| How does a copy-on-write filesystem snapshot avoid d | 7 | 7 | 1 | 7/10 | 0 |
| What causes head-of-line blocking in HTTP/2 but not  | 1 | 0 | 0 | 1/3 | 1 |
| How does a vector clock differ from a Lamport timest | 12 | 10 | 0.833 | 12/15 | 2 |
| What does the CAP theorem actually claim about parti | 4 | 4 | 1 | 4/8 | 0 |
| How do columnar storage formats achieve better compr | 3 | 3 | 1 | 0/7 | 0 |
| What is false sharing, and why does it slow down mul | 7 | 7 | 1 | 6/10 | 0 |

## Caveats

- One pass per question, one machine, one network. Not the official benchmark.
- Questions go straight to the agent, so `agent_direct_ttft_ms` excludes the
  gateway and the contract translation. It is not the gated TTFT and must not
  be compared with the 2.5 second target.
- The scorer is lexical overlap against the passages a source carried, not entailment.
- Questions were chosen to need a page read and are not drawn from the benchmark or the gold set.
