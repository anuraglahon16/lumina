# Grounding diagnostic

- commit: `a02283232533fa2a8ed3dd87df822330322a5002`
- ran at: 2026-09-17T12:43:18.306Z
- node: v21.7.2
- answer model: claude-haiku-4-5
- search provider: tavily
- questions: 6 answered, 14 failed

Nothing was changed to produce this: no prompt, no threshold, no passage
selection, no model. It measures the state at the commit named above.

## Two different numbers, reported separately

| metric | value | gate |
|---|---:|---:|
| aggregate grounding (supported ÷ cited, pooled) | 1.000 | 0.95 |
| mean run grounding (mean of per-run ratios) | 1.000 | 0.95 |
| citation completeness (factual sentences cited ÷ factual) | 0.071 | — |

These are not interchangeable. Pooling weights a long answer more heavily
than a short one; the mean of ratios treats a run that cited one sentence
perfectly as equal to a run that cited twenty. Completeness is separate
again, and it is the one that catches a system scoring 1.00 grounding by
citing a single safe sentence and leaving everything else uncited.

## Why cited sentences failed

No weak citations in this run.

## Per run

| question | cited | supported | grounding | factual cited | weak |
|---|---:|---:|---:|---:|---:|
| How does a bloom filter trade memory for false posit | 3 | 3 | 1 | 1/4 | 0 |
| How does TCP slow start decide the initial congestio | 0 | — | — | 0/0 | 0 |
| What is the difference between a clustered and a non | 0 | — | — | 0/3 | 0 |
| How does a JIT compiler decide that a method is hot  | 0 | — | — | 0/3 | 0 |
| What is the purpose of a write-ahead log in database | 0 | — | — | 0/2 | 0 |
| What does the CAP theorem actually claim about parti | 0 | — | — | 0/2 | 0 |

## Caveats

- One pass per question, one machine, one network. Not the official benchmark.
- The scorer is lexical overlap against the passages a source carried, not entailment.
- Questions were chosen to need a page read and are not drawn from the benchmark or the gold set.
