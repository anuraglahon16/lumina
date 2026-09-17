# Diagnostic reports — what these are, and what they are not

**None of these is the official benchmark, and none of them should be presented
as one.** They come from one observational run of a twenty-question diagnostic
set, reviewed by hand afterwards. `n=1` per question: nothing here establishes
that a target passes or fails.

Everything in this directory describes commit `e2e0e46`, run 2026-09-17.

## The files

| file | what it holds |
|---|---|
| `grounding-diagnostic.json` / `.md` | the raw run: answers, sources, the funnel, per-sentence decisions |
| `retrieval-review.json` | the hand-written relevance review, one entry per question |
| `retrieval-outcomes.json` / `.md` | the run with the review applied — **citation figures superseded, see below** |
| `rescored.json` / `.md` | the same run re-scored offline against the corrected citation validator |
| `uncited-audit.json` | every uncited factual sentence, classified by hand |
| `prompt-ab.json` / `.md` | citation contract A/B, 120 answers on evidence replayed from this run |
| `retrieval-probe.json` / `.md` / `probe-review.json` | a live retrieval-only probe verifying the instrumentation fix |

## Limitations

**The citation figures in `retrieval-outcomes.md` are superseded.** That report
was produced with a validator defect in it. The sentence splitter broke
`"...rows do. [1]"` between a claim and its marker, which counted the claim as
uncited and the bare `"[1]"` as a cited sentence — and, having no words to
check, as a *supported* one, recorded nowhere. It moved grounding up and
completeness down at the same time.

`rescored.md` is the corrected reading of the same run. Use it for any citation
number. The originals are kept because they are what was published, and deleting
the record of a wrong measurement makes the correction unverifiable.

**The HTTP/2-versus-HTTP/3 question is filed as `passage_miss` and is not one.**
A page covering only HTTP/2 satisfied the coverage rule, which stopped the pool
and cancelled the two pages that compared HTTP/2 with HTTP/3 while they were
still in flight. Query-aware passage selection — the repair `passage_miss`
points at — would do nothing for it, because the text it would select from was
never read.

The `coverage_miss` category now exists for exactly this, but **it cannot be
applied to this run retroactively.** Deciding it requires knowing that a
relevant page was *cancelled*, and in this run no fetch event carries that
status: the thirty aborted losers are frozen at `attempted`, which is the
instrumentation gap described below. The category is reachable only in runs made
after fetch outcomes moved to the settlement path. Both files therefore still
say `passage_miss` for that question, and the classification is wrong in a way
the saved data cannot fix — it is recorded here instead.

`retrieval-probe.md` re-ran the same question live and it classified as
`coverage_miss`, so the category does work on a run that can reach it. That
probe also corrected the rule: the TLS run turned out to have two relevant pages
cancelled under a coverage stop as well, so cancellation cannot be what
separates the two cases. What separates them is whether extraction gave up what
the page it read actually contained, and the review now asks that — but only
where relevant pages were cancelled, so no existing review is invalidated by it.
The e2e0e46 outcome counts are unchanged.

**Retrieval outcomes that depend on citation counts are provisional.**
`citation_failure` is decided by cited and supported sentence totals, so every
run whose totals moved in the rescore may have moved category.

**The model attribution in `grounding-diagnostic.json` is wrong.** `health.model`
records `claude-sonnet-5`, read from the legacy `LUMINA_MODEL` variable. Quick
answers were written by Haiku. `/v1/health` now reports a `models` role map and
the diagnostic records `models.quick`; runs from before that carry the legacy
value.

**Thirty of sixty-eight fetch events in the raw run never reached a terminal
status.** They are aborted losers whose outcome was recorded by the result-
consumption loop, which never saw them. The fetch-success denominator in that
run is therefore ambiguous, and nothing in it is recorded as `cancelled`.
Retrieval now records outcomes at settlement, so later runs do not have this gap.

**`agent_direct_ttft_ms` is not the gate metric.** It is measured agent-direct,
bypassing the gateway, and is not comparable to the contract TTFT the benchmark
measures. It is in the file for diagnosis only.

## Reproducing

```sh
node tools/apply-review.js  --run reports/grounding-diagnostic.json --review reports/retrieval-review.json
node tools/rescore-run.js   --run reports/grounding-diagnostic.json --verify-offline
```

Both read files and write files. Neither opens a socket or calls a model, and
`--verify-offline` enforces that rather than asserting it.
