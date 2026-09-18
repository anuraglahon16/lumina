# Retrieval probe, after the instrumentation fix

> Retrieval only: no synthesis, no model call. Three questions, one run each.
> It reaches the live web, so the pages are whatever is served today.

- commit: `0d2575f`
- ran: 2026-09-17T23:36:05.675Z

## Questions that could not be probed

| question | why |
|---|---|
| What is the purpose of a write-ahead log in  | the search returned no results |

These are not passes. Zero frozen events out of zero fetches demonstrates
nothing, so they are excluded from the counts below.

## Does every started fetch reach a terminal status?

| question | events | terminal | still attempted | cancelled |
|---|---:|---:|---:|---:|
| What causes head-of-line blocking in HTTP/2  | 3 | 3 | 0 | 2 |
| What does TLS certificate pinning protect ag | 3 | 3 | 0 | 2 |

No event remained at `attempted`. 4 were recorded as `cancelled`, a status the e2e0e46 run never produced.

## Where each one stopped

| question | stop reason | coverage met | statuses |
|---|---|---|---|
| What causes head-of-line blocking in HTT | coverage_sufficient | null | {"usable":1,"cancelled":2} |
| What does TLS certificate pinning protec | coverage_sufficient | null | {"cancelled":2,"usable":1} |

## Classified, after review

| question | outcome | why |
|---|---|---|
| What causes head-of-line blocking in HTT | coverage_miss | extraction was faithful and coverage cancelled 2 relevant page(s) still in flight |
| What does TLS certificate pinning protec | passage_miss | the page was read and the extracted passages did not carry the answer |
| What is the purpose of a write-ahead log | pending_review | no relevance review; which results were relevant cannot be derived from the run |

