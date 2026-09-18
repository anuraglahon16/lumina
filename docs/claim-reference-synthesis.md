# Proposal: claim-plus-reference synthesis

**Status: proposed, not implemented.** It changes how tokens reach the reader,
so it needs a decision about streaming and TTFT before any code is written.

This exists because prompt tuning has stopped paying. Two iterations of the
citation contract were measured under evidence replay, and the second one moved
nothing outside sampling noise.

## What the two iterations actually bought

Both arms re-measured from scratch each time, three samples per question,
identical evidence.

| | legacy control | contract v1 | contract v2 |
|---|---:|---:|---:|
| citation completeness | 0.625 / 0.662 | **0.787** | **0.806** |
| pooled grounding | 0.950 / 0.931 | 0.958 | 0.958 |
| unsupported cited sentences | 16 / 22 | 16 | 16 |
| uncited sentences a source supports | 144 / 109 | 51 | 49 |

The first iteration is a result: +0.16 completeness against a per-repeat spread
of 0.004 to 0.028.

The second is not. Its +0.019 sits inside a B-arm per-repeat spread that widened
to 0.056, and the unchanged legacy control moved +0.037 between the two
experiments on its own. Both of those are larger than the gain.

What v2 did do is fix precisely the category it named. Uncited list items went
from 3 to 0. That category was 3 of 51.

## Why more prompt text will not work

Classifying every remaining miss by shape says where the gap is:

| shape | v1 | v2 |
|---|---:|---:|
| continuation prose | 37 | 39 |
| framing sentence | 4 | 2 |
| evidence-gap disclosure not detected as one | 3 | 4 |
| quotation fragment (splitter artifact) | 3 | 2 |
| list introduction | 1 | 2 |
| list item | 3 | **0** |

Three quarters of the residue is ordinary prose continuing a point whose opening
sentence carried the marker. The contract already forbids exactly that, in
plain words, with a worked example. Saying it a third time is not a plan.

The reason is structural rather than a matter of wording. The model writes prose
and attaches markers to it, so citation is a property of the text it is
producing rather than of the claims it is making. Under that arrangement a
citation is something it can forget, and across 60 answers it forgets roughly 40
times.

## The ceiling this measurement allows

Worth settling before proposing anything, because it bounds what any design can
achieve.

In the v2 B arm: 470 factual sentences, 379 cited, 91 uncited. Of those 91, 49
are supported by a source in the same run and 42 are not.

- Cite all 49 supported ones and completeness reaches **0.911**.
- The 42 remaining cannot be cited honestly. Citing them is the failure the
  guard rail exists to catch.

So **0.95 completeness is not reachable by citing better.** It needs the answer
to stop containing sentences the evidence does not support, which shrinks the
denominator: 428 supported factual sentences, all cited, is 1.00.

Those 42 are one of two things and the current measurement cannot tell which:
sentences that should not have been written, or paraphrase that the 0.5 lexical
overlap bar cannot recognise. Reading a sample of them by hand is the cheapest
way to find out, and it should happen before anyone builds for either case.

## The design

Synthesis stops emitting prose with markers in it and emits claims with
references attached.

```
{ "claims": [
    { "text": "A column holds values of one type that repeat or change gradually.",
      "refs": [1] },
    { "text": "That repetition is what compression exploits.",
      "refs": [1] },
    { "text": "The evidence does not say how the encoding is chosen.",
      "refs": [], "kind": "evidence_gap" }
] }
```

The answer is assembled from the claims. Three things follow from the shape
rather than from instruction:

- A claim with no `refs` and no `kind` cannot be emitted. The harness rejects it
  rather than asking the model not to produce it. Forgetting is not available.
- Every claim is validated against its own refs before assembly, so the guard
  rail runs per claim instead of per answer.
- `kind: "evidence_gap"` makes the uncited-by-design case explicit, which
  removes the 4 to 6 sentences per experiment that the absence patterns fail to
  detect and that currently count against completeness.

This is the harness principle the rest of the system already follows: a
constraint that matters is enforced structurally, never asked for in a prompt.
Citation granularity has now had two prompts and one worked example, which is a
fair trial of asking.

## What it costs, and why it is not built yet

**Streaming.** Sources already stream before answer tokens, and that ordering is
an architectural guarantee with tests behind it. Emitting JSON means either
parsing a partial structure as it arrives, or waiting for the object to close
before the first word reaches the reader. The second is simpler and would move
Quick TTFT from about 3s to roughly the full synthesis time, which is not
acceptable. The first is what would have to be built, and incremental parsing of
a partial JSON array is where this design earns its risk.

**Prose quality.** Claims assembled into paragraphs read differently from
paragraphs written as paragraphs. Connective sentences are what make an answer
read as an argument rather than a list of facts, and those are exactly the
sentences a claim-only structure has no slot for. The design needs a way to
carry them, probably as a claim kind that is not counted as factual, and that
slot is also an obvious hole through which uncited assertions could return.

**Output tokens.** JSON scaffolding costs tokens on every answer. The current
contract costs about $0.015 across 120 answers; this would cost more, on the
output side where it is more expensive.

**It does not fix the ceiling.** Structured claims would close most of the
0.806-to-0.911 gap. Reaching 0.95 still requires the answer to stop asserting
things the evidence does not support, which is a separate change, and it should
be understood before this one is built rather than after.

## What would have to be measured

Same harness, same replayed evidence, three samples: completeness, grounding,
unsupported cited sentences, and — new, because this design puts them at risk —
TTFT, time to full answer, output tokens, and a human read of whether the prose
still reads like prose.

## Recommendation

1. Read the 42 unsupported sentences by hand. They decide whether the target is
   a citation problem or a content problem, and that changes what to build.
2. Keep contract v2. It is not measurably better than v1, but it is not worse on
   any guard rail, it fixed list items outright, and its rules are correct.
3. Do not build this until the streaming question has an answer. An answer that
   is better cited and arrives in 12 seconds is worse than the one we have.
