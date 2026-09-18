# Benchmark run, 2026-09-18 — conditions and what they cost

The first end-to-end run of `npm run bench` against the contract path. It
completed and wrote `bench.json` and `eval.json`, and **six of sixteen gates were
missed**. Read the numbers with the conditions below, not without them.

## Execution conditions

| setting | this run |
|---|---|
| starting commit | `348aa50`, clean tree at process load |
| gateway | port `8787` (matches `sla.json`) |
| agent | port `8788` |
| `DEMO_PASSWORD` | empty — the provided benchmark sends only `x-user-id` and the password gate would 401 every request |
| search provider | tavily, healthy, first attempt, no fallback |
| Quick model | `claude-haiku-4-5` |
| actual vector backend | `atlas-vector-search` |
| **printed** vector backend | `mongo-cosine-scan` — wrong, see below |
| embedding provider configured | voyage |
| embedding provider **used** | local — voyage returned 429 throughout |
| Anthropic balance | **exhausted 51 seconds before the run finished** |

## Three things that make this run less than a clean measurement

**The header names the wrong vector backend.** `/contract/health` read
`config.vector?.backend`, a path that does not exist, and fell through to a
hardcoded default. The run used `atlas-vector-search`. Fixed after this process
had loaded, so the generated report still says `mongo-cosine-scan`; the
generated file is left as written rather than edited by hand.

**Embeddings ran on the local fallback.** Voyage returned
`429: "You have not yet added your payment method"` throughout, and the system
fell back to local embeddings. `recall@5` of 0.967 was therefore achieved
*without* the configured embedding model — a better result than expected, and
not a measurement of the intended stack. `/v1/health` still reports
`embedding_provider: voyage`, because it reports what is configured rather than
what served.

**The Anthropic balance ran out during the final phase.** The first
`credit balance is too low` error is timestamped 02:26:44; the benchmark
finished at 02:27:35. In those 51 seconds 156 model calls failed. Only one HTTP
request in that window returned non-200, so most of those were off-path calls
(memory extraction, run summarisation) that are caught and do not fail a
request — but the tail of this run cannot be certified unaffected, and one
document never finished embedding inside the 240s budget.

## The gates

| gate | result | target | |
|---|---:|---:|---|
| ttft p95 | 11725ms | 2500ms | ✗ |
| answer p95 | 12770ms | 12000ms | ✗ |
| 202 accept p95 | 300ms | 300ms | ✓ |
| search p95 during ingest / idle | 1.43× | 1.3× | ✗ |
| recall@5 | 0.967 | 0.70 | ✓ |
| search cache hit rate | 52.6% | 50% | ✓ |
| deep plan p95 | 4102ms | 4000ms | ✗ |
| deep answer p95 | 69.3s | 90s | ✓ |
| deep sub-questions (min) | 3 | 3 | ✓ |
| deep/quick source ratio | 3.5× | 2× | ✓ |
| cost per deep answer | $0.0964 | $0.35 | ✓ |
| **citation grounding** | **0.80** | **0.95** | **✗** |
| error rate | 0.0375 | 0.01 | ✗ |
| cost per quick answer | $0.0036 | $0.05 | ✓ |
| sources before first token | 1 | ≥1 | ✓ |
| citations with no matching source | 0 | 0 | ✓ |

Grounding detail: 64 of 80 verifiable citations, 1 unverifiable (fetch blocked),
**0 dangling**. The automatic-fail case is clean; the failures are all snippets
not found in the page they name.

## Why citation grounding failed, diagnosed

Not a measurement artifact. The extractor fuses words across element
boundaries, and the grader cannot match text that we never wrote.

`bench.mjs` strips tags by replacing every `<[^>]+>` with a space, so its text
always has whitespace where markup was. Our extraction sometimes has none.
Fetching `https://www.geopits.com/blog/mongodb-gridfs` through our own fetcher
produces:

```
NewMeet Geopits at Gartner Data & Analytics Summit 2026 | Sep 21–22 |
MumbaiMeet Geopits ... MumbaiRead More →Services

Talk to UsServicesTechnologyPartnersProductsAboutResourcesContact Us
```

and further down, `onSeptember`, `uploadDate`, `pdfThis`, `bucketName`,
`flexibilityHigh`, `understandStreamlined`. The grader sees `New Meet Geopits`,
we publish `NewMeet Geopits`, and a contiguous twelve-token window can never
match across the join. On that page the longest matching window was 7 tokens of
the 12 required.

Reproduced on a 17-URL sample drawn from the benchmark's own web queries: 16
grounded, 1 failed, and the failure was this. Five control pages (Wikipedia,
MDN) all matched 12/12, which is why the defect shows on some pages and not
others — it needs markup that puts inline elements against each other without
whitespace.

Two consequences beyond the gate. The fused tokens reach the embedding model and
the citation validator as single unknown words, so they degrade retrieval and
grounding scoring as well. And the snippet shown to a reader is the first 400
characters of extracted text, which on pages like this is the cookie banner and
the navigation menu rather than the content.

## What this run does not establish

It is one run. `main` is untouched. The result should be re-measured on a funded
Anthropic account and with voyage available before it is treated as this
system's performance, because two of the three conditions above were not true of
the system as designed.
