# Every citation provenance failure, classified

Scored with `benchmark/lib.mjs`'s own `snippetIsGrounded` and `citationNumbers`,
against a haystack built the way `bench.mjs` builds it. **Nothing is fixed
here.**

Two earlier attempts at this number were generalised from too little evidence: a
snippet-splitter defect that was real and not dominant, and a word-fusion defect
that was real, fixed, and moved the metric by nothing. Both times the mistake was
the same shape — read a handful of failures, form a theory, ship it. So this
classifies every failure in the sample and implements none of them.

```
23 citations checked   ·   19 verified   ·   4 failed
```

| category | citations |
|---|---:|
| document locator mismatch | 4 |
| **total failed** | **4** |

| surface | checked | verified | failed |
|---|---:|---:|---:|
| document | 12 | 8 | 4 |
| web | 11 | 11 | 0 |

## The document failures: two chunks of a page are one key

All four failures are the same defect, and it is arithmetic rather than
interpretation.

`bench.mjs` scores a document citation against a per-source haystack:

```js
for (const s of top5) docText.set(locatorKey(s), s.snippet);
const locatorKey = (s) => `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`;
```

Its own comment says why: *"Full locator identity: two chunks of one document
must not share a key."*

Ours share one. A document source carries `{ page }` and nothing else —
`toLocator` produces a `page` **or** a `heading`, never both, and never a line —
so every chunk from the same page of the same document collides. `Map.set` keeps
the last. A citation to the earlier chunk is then scored against a **different
passage**, and fails.

Measured on a real docs run:

```
6 doc sources returned, 5 distinct locator keys
  doc_mu6kwshke10qel:1::   <- sources [1, 5]      <-- collision
  doc_mu6kwshke10qel:2::   <- sources [2]
  doc_mu6l13vbmjx6it:1::   <- sources [3]
  doc_mu6l13vbmjx6it:2::   <- sources [4]
  doc_mu6kwshke10qel:4::   <- sources [6]
```

Every failed row shows the signature: the haystack is ~400 characters — the size
of *a* snippet, not the five-way `'*'` fallback — and the longest contiguous
match is 2 tokens of the 12 required. The citation found a keyed entry; it just
belonged to a different chunk.

An honest citation, a correct page, a real snippet, scored against the wrong
passage.

## What did not cause them

**Not "beyond the first five".** That theory is structurally real — `RAG_TOP_K`
is 6 and the grader keys only five, so a citation to the sixth is invisible — and
it fired **zero times** in this sample. Every failure sat at position 1 of 6. It
is pinned in `tests/docLocator.test.js` because it remains a live hazard, but it
is not the current cause.

**Not the web path.** 11 of 11 web citations verified, across 12 questions and
domains including Cloudflare community, MDN, MongoDB and vendor docs. That is a
small sample and is not evidence that web provenance is solved — but it does say
the dominant remaining cause is not there.

Worth noting for interpretation: the word-fusion fix (`spaceElementBoundaries`)
landed *after* the benchmark run that produced 0.784. Some web failures counted
there may already be gone. That is a hypothesis this sample is too small to
settle, not a claim.

## Sample limits, stated plainly

- 23 citations, against the benchmark's 74. Small.
- The document arm ran against 2 of 4 corpus files: the `.md` uploads returned
  `415 Unsupported Media Type` on the contract route, while the benchmark's own
  ingestion handles all four. That is a separate finding and is recorded here
  rather than chased.
- One web question timed out at 240s and produced no answer to classify. Recorded
  in `reports/grounding-timeouts.json`.
- Deep runs are not represented. Every row is Quick.

## What the fix would have to satisfy

Stated as a property rather than an implementation, because the implementation is
Phase 5's second half and not this commit:

> Two distinct chunks of one document must produce two distinct
> `docId:page:heading:line` keys.

The grader reads `page`, `heading` **and** `line`. A chunk ordinal carried as
`line`, or the section heading it came from, would separate them. What must not
happen is inventing a locator a reader cannot follow back to the document: the
point of a locator is that a person can check the citation, and a synthetic key
that satisfies the grader while pointing nowhere is the failure this metric
exists to catch.

`tests/docLocator.test.js` pins the mechanism, the eviction, the failure, and
what a unique locator would restore.
