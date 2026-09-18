# The locator fix, measured before and after

The diagnosis run (`reports/grounding-failure-distribution.md`) classified every
citation in a 23-citation sample and found one cause behind every document
failure: `bench.mjs` keys its per-source haystack on
`docId:page:heading:line`, our document locator carried only a page, so two
chunks of one page produced one key, `Map.set` kept the last, and a citation to
the earlier chunk was scored against a different passage.

This is the same classifier, run again against the same corpus and the same
twelve gold questions, after the fix.

## Document citations

| | checked | verified | failed |
|---|---:|---:|---:|
| before | 12 | 8 | **4** |
| after | 13 | 13 | **0** |

All four "before" failures were `document locator mismatch`, every one of them
at document position 1 of 6 — inside the grader-visible first five, scored
against a ~400-character haystack that belonged to a sibling chunk, longest
contiguous match 2 tokens of the 12 required.

Thirteen rather than twelve because one answer cited two sources; the twelve
questions are the same twelve.

The locators the run now produces:

```
{"page": 1, "line": 15}   {"page": 2, "line": 1}    {"page": 2, "line": 15}
{"page": 2, "line": 26}   {"page": 3, "line": 1}    {"page": 3, "line": 14}
```

Six distinct keys for six sources, and every haystack is the citation's own
snippet rather than a sibling's.

### The lines are real

The point of a locator is that a reader can follow it. Every chunk of
`retrieval-basics.pdf` was re-parsed and its claimed line checked against the
page text it came from: **10 of 10 chunks start on the line they name**, none
wrong. The line is derived from `char_start`, at the first non-whitespace
character of the trimmed chunk — a chunk ordinal presented as a line would have
satisfied the grader's key and lied to the reader.

### The first attempt did not move the number

Worth recording, because the shape of the mistake is the same one the diagnosis
commit was written to avoid. The line was computed correctly in the chunker,
carried through the ledger and the contract mapper, and every unit test passed —
and the measured result was still 4 of 12 failed, with locators arriving as
`{ page }` exactly as before.

Three projections in between list their fields explicitly and `line` was in none
of them: the record written by `indexChunks`, the row `searchChunks` returns,
and the Mongo scan projection in `vectorStore`. `tests/docLocator.test.js` now
drives ingest and retrieval end to end rather than testing the chunker alone,
because a unit test on the chunker cannot see that failure.

## Web citations

| | checked | verified | failed |
|---|---:|---:|---:|
| before | 11 | 11 | 0 |
| after | 10 | 9 | 1 |

The change does not touch the web path, and the one failure is not a regression
from it: the GridFS question resolved to `oneuptime.com` in the diagnosis run
and to `geopits.com` in this one, and the `geopits.com` snippet is the page's
navigation chrome ("Meet Geopits at Gartner Data & Analytics Summit… Services
Talk to Us…"), 7 of 12 tokens matching contiguously. That is boilerplate
extraction on a marketing page, recorded here and not chased.

The web sample is drawn from live search and differs run to run, so these two
columns are not the same eleven pages. Neither number is evidence about web
provenance at large.

## What this does not claim

Overall grounding remains **unmeasured** since the fix. The benchmark's figure
of 0.784 covers 74 citations; this sample is 23 across both surfaces, contains
no Deep citations, and both arms are Quick. A full benchmark is the only thing
that can restate the overall number, and it has not been run.

## Noted in passing, not fixed here

The corpus `.md` files, which returned `415 Unsupported Media Type` during the
diagnosis run, upload successfully when the request carries an explicit
`text/markdown` content type. So the `415` is content-type detection on the
upload route rather than Markdown parsing. That remains a separate follow-up;
the document arm here ran against the same two PDFs as the diagnosis run, so the
two columns compare like with like.
