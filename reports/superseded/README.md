# Superseded reports — not authoritative

These were produced by running the benchmark against `http://localhost:8787`
on 2026-09-18, on Node 21, before the deployed application had ever been
measured. They are kept because deleting a measurement to make a later one look
better is not something this project does, and because the difference between
them and the deployed run is itself a finding.

**They do not certify the deployed application, and two of their numbers are
known to be wrong about it:**

- **Document RAG scored 15/15 here and was completely broken deployed.** The
  Vercel function ran Node 24, where the pdf.js build vendored by `pdf-parse`
  throws `bad XRef entry` on every PDF. Nothing in a localhost run on Node 21
  could see that.
- **Embeddings ran locally here by configuration.** The deployed runtime
  resolved to Voyage, because `EMBEDDING_PROVIDER` was unset and
  `VOYAGE_API_KEY` was present.

The authoritative run is the one made against the deployed Preview URL and
recorded in `reports/phase7-deployed.md`. Read these only as history.

## bench-deployed-ec88475.json

The first deployed benchmark (commit `ec88475`, 2026-09-19T03:55Z). Superseded
rather than wrong: its citation grounding of 1.000 and recall@5 of 0.967 were
real. It is kept because the run that replaces it was taken after four fixes it
could not have measured — Deep answers that never streamed to the client, the
sweep spending outside the 24-call pool, branch allocations that stranded
capacity, and termination labels that inverted which runs were curtailed.

### What its recall@5 of 0.967 was actually measuring

Lexical retrieval. BM25 alone.

The run reported `vectorStore: atlas-vector-search`, which was read from
configuration and not from anything that ran. The dense half of retrieval did
not execute at all on the MongoDB path: `searchChunks` scored
`chunk.embedding`, and `allChunks` fetches the corpus with
`.project({ embedding: 0 })`, so every chunk failed the
`Array.isArray(chunk.embedding)` guard and the dense ranking came back empty.
`nearestChunks` — the function that issues `$vectorSearch` — had no callers in
the codebase, and neither did the `memories_vector` index.

Verified rather than reasoned about, on 2026-10-02 against a database holding
real chunks: a stored chunk carries 1024 floats under `embedding`; the same
chunk returned by `allChunks` has `embedding === undefined`.

So 0.967 is a real number and it is not a number about vector search. It is the
recall of BM25 over this corpus, and the `atlas-vector-search` label beside it
is the thing that was wrong. The contract asks `/health` to name the live
backend precisely because "a recall number is not comparable without it", and
that is the comparison the label prevented anyone from making.

Measured again on 2026-10-02 with `$vectorSearch` actually wired in — filters
inside the stage on the paths the index declares, `numCandidates` 150 over
`limit` 30, chunks dual-written with the camelCase keys `chunks_vector` filters
on — **recall@5 is 39/39 = 1.000, with a dense contribution on all 39 queries**.
That figure is retrieval measured at the `searchChunks` boundary rather than
end to end through an answer, so it is not interchangeable with the benchmark's
own recall@5; it is reported here because it is the before-and-after of the same
measurement taken the same way.

`bench-deployed-ec88475.json` is not edited. Read its recall figure as "BM25
over the gold corpus", and read its `vectorStore` field as a configuration
value that no query had earned.

## bench-fly-2026-10-02-credit-exhaustion.json / eval-fly-…json

The first full benchmark against the Fly deployment (2026-10-02 12:45–13:15Z).
74 runs completed cleanly, then the Anthropic credit balance ran out at 13:05:51
and every run after it failed — 12 of 12 on `"Your credit balance is too low to
access the Anthropic API"`, after which the circuit breaker opened and cascaded.
That is why `error rate` reads 0.1235, and why `deep/quick source ratio` reads
0× and `deepAttribution` 2/4: the two deep runs that errored recorded no sources.

Kept unedited. Its passing numbers are real — citation grounding 0.987 with **0
dangling citations**, recall@5 0.967, 202 accept p95 227ms, contract probes 4/4,
19 of 22 caps — and its failures are an exhausted balance, not the system under
test. `ttft p95` 3900ms against a 2500ms target is the one failure that is
genuinely the system's.
