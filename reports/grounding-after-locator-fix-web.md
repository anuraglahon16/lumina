# Every citation provenance failure, classified

> Scored with `benchmark/lib.mjs`'s own `snippetIsGrounded` and
> `citationNumbers`, against a haystack built the way `bench.mjs` builds it.
> Nothing is fixed here.

- ran: 2026-09-18T13:35:05.188Z
- citations checked: 10 (0 document, 10 web)
- verified: 9 · failed: 1

## By category

| category | citations |
|---|---:|
| fused or separated token boundary | 1 |
| **total failed** | **1** |

## Split by surface

| | checked | verified | failed |
|---|---:|---:|---:|
| doc | 0 | 0 | 0 |
| web | 10 | 9 | 1 |

## Web failures by domain

| domain | failed | categories |
|---|---:|---|
| geopits.com | 1 | fused or separated token boundary |

## Every failure

**[1] web** · fused or separated token boundary
- run: `web-probe` (quick)
- url: https://www.geopits.com/blog/mongodb-gridfs
- longest contiguous match: 7/12 · grader haystack 21253 chars
- snippet: NewMeet Geopits at Gartner Data & Analytics Summit 2026 | Sep 21–22 | MumbaiMeet Geopits at Gartner Data & Analytics Summit 2026 | Sep 21–22 | MumbaiRead More →Services Talk to UsS
- why: 7 of 12 tokens match contiguously, so the text is present and a boundary differs

