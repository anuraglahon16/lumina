# Which runs the quality gates read, and why those

`quality/check.mjs` reads `runs/*.json`. This says how that directory is filled,
because a gate is only as meaningful as the population it is asked about.

Regenerate with:

```sh
node tools/export-runlogs.mjs --scope benchmark
```

## The rule

A run is in the evaluated population when **both** hold:

1. its `user_id` is the benchmark user declared in `benchmark/sla.json`
   (`bench`) or one of the `bench-*` sub-users the harness derives from it —
   `bench-mem-*`, `bench-deep-*`, `bench-deepcap-*`;
2. it was created inside the window ending at `reports/bench.json`'s own
   `ranAt`, whose start is found by walking back while the gap between
   consecutive runs stays under fifteen minutes.

Both identifiers come from the benchmark rather than from a date chosen after
seeing the results. The fifteen-minute gap is what separates one invocation of
the harness from the one before it; a benchmark run takes about twenty minutes
and its internal pauses are seconds.

## This population

```
window   bench*   2026-09-18T02:47:51.595Z .. 2026-09-18T03:09:22.903Z
in scope 111 runs
excluded 934 runs
```

| terminated | runs |
|---|---:|
| done | 83 |
| cap | 18 |
| error | 10 |

The 10 errors are in `runs/failing/`, not deleted. `eval/build-report.mjs` reads
both directories, so the P1 failing trajectory is still rendered from there.

## What the 934 excluded runs are

Not failures being hidden. They are traffic that was never part of this
evaluation:

- `groundcheck` (50) and `doccheck` (8) — diagnostic scripts run by hand while
  investigating citation provenance;
- `recall15939` (42) and other development users;
- earlier benchmark invocations from 2026-09-17, a separate evaluation of an
  earlier build;
- runs from the window when the Anthropic account was out of credit, whose
  failures are the account's rather than the code's.

Every one of them is still in the store. Nothing was deleted to make a gate
pass, and the count is stated here so the exclusion is visible rather than
implied.

## The part that was not a scoping problem

Scoping alone would have produced a *dishonest* pass, and finding that mattered
more than the scoping.

`terminatedOf` mapped our internal reasons onto the contract's
`done | cap | error`, and its cap list was missing `capped` — which is what
`deep.js` writes when a branch hits its limit, 59 runs in the store — and
`max_tokens`. Both fell through to `done`. Runs that visibly stopped because
they ran out were being written to disk as runs that finished, **in the file A2
reads to find runs that stopped because they ran out**.

That is not a population question. A mapper that hides a rule's subject from the
rule defeats it while appearing to satisfy it. Fixed, and pinned by
`tests/runPopulation.test.js`.

`evidence_limited` is deliberately still `done`: a run that searched, found
little, and said so in its answer finished its work. Calling that a cap would
report honest reporting as failure.

## What this population does not do

It does not make A2 pass. 18 runs in the window terminated `cap` and 10
`error`, and A2 asks for every run to be `done`. Those are real: the caps are
Deep branches exhausting `maxToolCallsPerBranch`, and the errors are largely the
`bench-deepcap-*` probe, which the benchmark drives deliberately past the daily
limit.

Both should change on the next benchmark for reasons that are behavioural rather
than editorial. The daily quota added in Phase 3C refuses the cap probe with a
429 **before a run is created**, so those runs will not exist to fail. The shared
tool budget in Phase 3B changes when and why a Deep run stops. Whether that is
enough for A2 is a question for the next full evaluation, not something to
arrange here.
