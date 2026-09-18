# Citation provenance: the assignment's actual gate

> Not the benchmark. This scores answers from a saved run rather than
> driving the contract path, and it re-fetches today pages that were read
> weeks ago. It is an estimate of the gate, using the benchmark's own
> scoring functions rather than a second copy of them.

- run: `e2e0e4652a4283a5fcaef037a28f2e85d79335a3` (2026-09-17T14:25:29.887Z)
- checked: 2026-09-18T01:32:38.042Z
- gate: `min_citation_grounding` >= 0.95

## What the gate measures, and what it does not

For each distinct `[n]` in an answer: does it resolve to a source, and is
that source's snippet present as a contiguous 12-token window in the page
it names. That is provenance, not entailment. The internal groundedness
figures reported elsewhere in this directory ask a different question and
are not estimates of this one.

## Result

| citation grounding | **0.960** |
|---|---:|
| target | 0.95 |
| meets the target on this sample | |

## Every citation, by outcome

| outcome | citations | in the ratio |
|---|---:|---|
| provenance verified | 24 | numerator and denominator |
| snippet absent from the page | 0 | denominator only |
| page changed since the run | 1 | denominator only |
| **dangling citation** | 0 | denominator only, automatic fail |
| page fetch blocked | 0 | excluded from both |
| **total** | **25** | |

A blocked fetch is not unsupported content. A publisher that refuses this
checker makes a citation unverifiable, not false, and counting it against
the system would teach nobody anything.

`page changed` and `snippet absent` are told apart by the run's own saved
text: if the snippet is in what we extracted at the time but not in the page
today, the page moved. If it is in neither, the snippet never came from that
page, and that one is ours.

