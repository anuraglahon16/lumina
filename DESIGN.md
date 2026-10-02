# DESIGN.md — LUMINA

> Written against the deployed system, not an intended one. Where a number
> appears it was measured, and where a design was wrong it says what was wrong
> rather than describing the fix as if it were the plan. Dates are 2026.

## Components

**Three processes, two Fly apps, and the state they share.**

**Gateway** — `src/gateway`, Fly app `lumina-al-gateway`, the only process with a
public address. It serves the built React UI, validates every request against the
zod contract in `packages/contract`, mints or reuses the request id, holds the
shared-password gate, rate-limits per user, and pipes SSE straight through. It
holds **no provider keys**.

**Agent** — `src/agent`, Fly app `lumina-al-agent`, process group `agent`. It has
**no public IP and no Fly service**: it is reachable only over the private 6PN
network, and only with a matching `x-internal-token`. It runs the two answer
paths, search, fetching, RAG, memory and the run log. Every provider key lives
here and nowhere else.

**Worker** — the same image, process group `worker` in the agent app, with **no
HTTP listener at all**. It claims `index_document` jobs, parses, chunks, embeds
and indexes, and renews a lease while it works.

This is the part that was wrong when the system was first reviewed. The whole
application ran as one Vercel function (`api/index.js`): the gateway's middleware
in front of the agent's routers, in one process, with the provider keys on the
public edge and no worker — uploads were indexed inline because there was nothing
else to do it. The separation was documented and not deployed. That file is gone,
and the architecture above is what runs.

**MongoDB Atlas (`lumina_fly`)** holds `threads`, `messages`, `memories`,
`spaces`, `documents`, `chunks`, `jobs`, `searchCache`, `runs` and `requests`,
plus a GridFS bucket named `uploads` (`uploads.files` /
`uploads.chunks`) holding an upload's bytes while it is being indexed. **Two** Atlas Search indexes exist and are `READY`:
`chunks_vector` and `memories_vector`. `scripts/indexes.json` also declares
`chunks_text`, the Atlas index that would serve the lexical half — it has never
been built, and the free tier allows exactly three, so there is room for it. It is
not missed, because BM25 runs in this process over the corpus either way; the
consequence is that the lexical half reads the corpus rather than an index, which
is the latency cost named under Trade-offs. Verified by listing the indexes rather
than reading the declaration: the declaration says three.

**The job queue** is the `jobs` collection plus the worker. A claim is one
conditional write (`findOneAndUpdate` on status-and-lease), so two workers cannot
take the same job; it was read-then-patch, which is a race with a window.

**The search cache** has two tiers: an in-process LRU and the `searchCache`
collection with a TTL index. The key is a SHA-256 of the normalised query and the
provider. One tier was not enough — a cache that lives in a process is cold on
every deploy and is not shared with the worker.

**The evidence ledger** is not stored anywhere — it lives for one run — but it
decides what may be cited, so it belongs on this list.

## Responsibilities

The interesting lines are the exclusions.

**Only the agent may hold a provider key.** The gateway proxies; it never calls
Anthropic, Tavily or OpenAI. This is now a deployment property as well as a code
one: the keys are Fly secrets on one app, and the other app cannot read them.

**Only the gateway may be reached from outside.** The agent has no public address,
so the check on `x-internal-token` is a second lock rather than the only one.
Both apps hold the same `INTERNAL_TOKEN`; identical secret digests are how that is
verified without printing it.

**Only the worker may index.** `POST /spaces/:id/documents` writes the bytes to
GridFS, inserts a `queued` document and a job, and returns 202. Parsing,
chunking, embedding and indexing happen on the worker. A document becomes
`indexed` only after a **read-your-write probe** returns one of its own chunks
from the vector index — "upserted" is not "searchable", and an index still
building accepts a write and answers nothing.

**Only the evidence ledger may decide what is citable.** A search result is a
*candidate*; it becomes evidence when a page has been fetched and its text
extracted, and at no other moment. The synthesis prompt is never given a snippet
it did not read.

**Only the budget may decide a run is over its cap**, and only an actual refusal
counts. A full counter is a budget spent exactly, not a run cut short.

**Only an explicit `save_memory` writes long-term memory.** A post-run extractor
exists and is **off by default** (`MEMORY_EXTRACT_ENABLED=false`). It was on, and
it wrote memories the user never asked for — visible in `/memory`, so not hidden,
but not asked for either. The code stays because the extractor is useful; the
decision is a policy one and the policy is the spec's.

## Communication

**Browser → Gateway:** HTTP and SSE, one origin for the page, the API and the
stream, because the gateway serves `web/dist` (built in the image, Dockerfile
stage 1). The `sources` event is always emitted before the first token — not as a
timing accident, but because synthesis emits it before the model call starts.

**Gateway → Agent:** HTTP over the private network with `x-internal-token`, SSE
piped through. `X-Request-Id` is reused if the caller sent one and minted
otherwise, forwarded, and logged by both services, so one request is greppable
end to end. It is also on the SSE `error` frame, which is the one place a user
sees a failure.

**Agent → providers:** HTTP behind a per-host circuit breaker that distinguishes a
host fault from a caller cancellation — the fetch pool aborts its losers on every
healthy run, and counting those as failures would trip the breaker against the
hosts that answered fastest.

**Agent → Worker:** the `jobs` collection, and nothing else. They share no memory
and no socket. A worker killed mid-job stops renewing its lease; a sweeper returns
the row to `queued` and finished stages are not re-run.

**Retrieval, exactly as it works.** This is the part most worth stating precisely,
because the earlier version of this document described something the code did not
do.

- **Documents.** The dense half is a real `$vectorSearch` against
  `chunks_vector`, with the filter **inside** the stage on the paths the index
  declares (`userId`, and `spaceId` when the question is scoped to a Space).
  `docId` is not a declared filter field, so it is the one thing post-filtered,
  which is only sound because `numCandidates` (150) is far above `limit` (30).
  The lexical half is BM25 computed in this process over the corpus for that
  user or Space. The two rankings are fused by reciprocal rank fusion, because
  their scores are not on one scale.
- **Memory.** Recall is `$vectorSearch` against `memories_vector` filtered by
  `userId`, blended with term overlap. When the index answers "nothing", that
  answer is confirmed against the collection for memories written in the last
  five seconds — Atlas Search is eventually consistent, measured at roughly half
  a second on this cluster, and `save_memory` followed by a recall inside one run
  sits inside that window. The fallback is deliberately narrow: a full scan there
  would grow with how much a user remembers and would hide a broken index behind
  acceptable answers.
- **What this replaced.** `searchChunks` used to score `corpus` in JavaScript
  while `allChunks` fetched it with `.project({ embedding: 0 })`, so every chunk
  failed the `Array.isArray(chunk.embedding)` guard and the dense ranking was
  empty. Retrieval on Mongo was BM25 alone while reporting itself as
  `hybrid-bm25-cosine`; `nearestChunks` and `memories_vector` had no callers at
  all. Verified against a database holding real chunks: a stored chunk carries
  1024 floats, and the same chunk via `allChunks` has `embedding === undefined`.
  **The published recall@5 of 0.967 was lexical.** Measured again with
  `$vectorSearch` actually wired in, recall@5 is **39/39 = 1.000** with a dense
  contribution on all 39 queries. That is retrieval measured at the
  `searchChunks` boundary, not end to end through an answer, so it is not
  interchangeable with the benchmark's own figure.

**Quick and Deep retrieve differently.** Only Deep has a model-driven tool loop.
Quick is deterministic — one search, then a coverage-driven fetch pool — and
`plan_research` is not in its toolset, which is why it cannot escalate itself.

## State

**Authoritative:** `threads`, `messages`, `memories`, `spaces`, `documents`,
`chunks`, `jobs`. Losing any of these loses user data.

**Cache, deletable:** `searchCache`, the page cache, and every generated
`reports/*.json`. Deleting them costs latency and money, not information.

**Per-run and never stored:** the evidence ledger and the budget counters.

**A thread is a header; its messages are their own documents.** They were an array
on the thread, which made every append a read-modify-write: two appends landing
together both read the same array and the second overwrote the first, so a turn
could vanish — and appending cost grew with the conversation. An append is now one
insert plus one `$set`/`$inc`, neither of which reads the document it changes.

Ordering is by `seq`, taken from that `$inc`, **not by time**. Writing the test
found twenty appends landing in the same millisecond: the sort found them all
equal and the "last four turns" handed to the model were the first four,
backwards. A millisecond is not a position.

**Documents carry both snake_case and camelCase keys, and this is a deviation
worth naming.** Everything in `src/` reads `user_id`, `space_id`, `doc_id`,
`created_at`. The contract (`packages/contract/src/db.ts`) and the declared
indexes (`scripts/indexes.json`) are camelCase — and neither file is ours to
edit. A filter inside `$vectorSearch` on a path that does not exist matches
nothing, and the only symptom is poor recall, so the camelCase keys are not
optional. Both are written rather than renaming: a rename is a migration of every
reader at once, and the readers are the part that works. The cost is a wider
document and two names for one fact, which is a real cost and the reason this
paragraph exists.

**A document written but not yet searchable** is `queued`, then `indexed` only
after the read-your-write probe. There is no window in which it is
half-searchable, and `GET /spaces/:id/documents` reports the state honestly.

**Embedding namespaces.** Every vector is stored under `provider:model:dim:vN`
and vectors from different namespaces are never compared. On Atlas there is only
one namespace that can be in the index at all: `chunks_vector` declares 1536
dimensions, so `indexChunks` now *refuses* to index a document embedded at any
other width rather than storing chunks `$vectorSearch` cannot reach. The
deployment ran `EMBEDDING_PROVIDER=local` — a 512-dimension hashed bag-of-words —
against that index, and nothing on `/health` said so.

## Trade-offs

**The worker deletes the GridFS original once the chunks are searchable.** The
free Atlas tier caps total storage, and chunks plus their 1536-dimension
embeddings are what retrieval needs; the original bytes are dead weight against
that cap. The price is that **re-embedding is impossible without a re-upload** —
which is not hypothetical. When the embedding provider and vector width changed
this week, every indexed document had to be uploaded again, because the source
bytes were gone. Deliberate, with the cap as the reason and the re-upload as the
known cost. Verified on the deployed database: 31 documents, all `indexed`,
`uploads.files` empty.

**A deep run typically ends `terminated: "cap"`, and the label is honest.**
Measured across probes: the pool claimed 20 of 24 locally and 23 of 24 deployed,
with `refused: 0` and `branch_refused: 6`. At every refusal the free slots were
exactly accounted for by what other active branches were still owed plus the
sweep reserve, so `borrowable` was 0 — four branches at five calls each plus a
reserve of four is 24, the whole pool, committed by construction. The refusals
come from the model issuing several `tool_use` blocks in one turn when its branch
has one slot left. Every sub-question still got evidence (four sources each
locally, ten across four sub-questions deployed), so the run was complete and the
label records that something was asked for and denied. Making a typical run avoid
it means telling the branch how many calls remain so its parallelism matches its
budget — which changes no evidence and no label.

**Refusals are recorded but not counted as tool calls.** A deployed run logged
`tool_calls: 29` against a streamed trace of 23 and a pool that had claimed 23;
the extras were refusals, where nothing executed. Three records of one run
disagreeing is three numbers a reader has to choose between. They now live in
`run.refusals` with their reason. The trace could not include them regardless:
the grader counts trace events against a ceiling of 24, so tracing refusals would
fail a run precisely for enforcing its budget.

**A ceiling inside a run is measured against the run's deadline.** Both synthesis
calls passed the configured ceiling, which starts whenever research finishes —
and for Quick that ceiling is 90 seconds, exactly the whole Quick envelope. Sixty
seconds of research plus ninety of synthesis is a 150-second run against a
90-second budget; no phase overran a limit of its own. It is now
`min(ceiling, time left)`, with no floor, because inventing a minimum is how the
envelope gets exceeded.

**Upload acceptance is bounded by contention with the worker, and I misdiagnosed
it first.** The requirement is a 202 in under 300ms. Measured from the deployed
agent: a pooled round trip costs about 15ms, opening a *new* connection to this
cluster costs **104–376ms**, and server-side acceptance came back bimodal — 40–50ms
or 390–490ms with almost nothing between. I read that as "warm versus warm plus
one reconnect", cut the path from four sequential writes to three, set
`minPoolSize`, and added a keepalive ping because `maxIdleTimeMS: 0` only tells
the *driver* not to close a connection.

It barely moved: p95 over twenty uploads went from 623ms to 626ms. The actual
cause was the worker. Stopping it and repeating the same twenty uploads gives a
median of 173ms and **p95 245ms**, inside the budget, with the climb gone — so
what I had been attributing to cold connections was the worker's own writes
competing for a shared-tier cluster. Each document costs about a dozen writes
across two collections, and the per-batch progress writes scale with its size, so
those are now throttled to one a second and issued concurrently.

The honest limitation: acceptance meets its budget when little else is indexing,
and degrades under concurrent ingest in proportion to how much. The fix that
would remove it rather than reduce it is a dedicated Atlas tier in the Fly app's
region — a configuration change this project cannot make — and the pool work,
while it did not solve this, is kept because the 104–376ms cost of a cold
connection is real and will bite the next cold path.

**The lexical half of retrieval reads the corpus, not an index.** `chunks_text` is
declared and unbuilt, so BM25 is computed in this process over every chunk for the
user or Space. That is why `allChunks` exists at all, and it is the one part of
retrieval whose cost grows with corpus size — fine for a Space of a few documents,
wrong for a large one. Building `chunks_text` and fusing a `$search` ranking
instead is the obvious next step and was left undone deliberately: the dense half
was the half that was not working, and changing both at once would have made the
recall measurement unattributable.

**Lexical overlap as the grounding validator instead of an entailment model.**
Cheap, deterministic, no second model call. It also cannot tell a paraphrase from
a fabrication: adjudicating all 35 sentences it flagged as unsupported found that
**none** were — 26 were evidence-gap disclosures the prompt requires to be
uncited, and 9 were paraphrase the bar cannot see. It is a guard against a
citation pointing at the wrong source, which is what it was chosen for, and should
not be read as a measure of truthfulness.

**Haiku for Quick, Sonnet only for Deep synthesis.** Measured over the twelve
most recent deployed quick runs: median **$0.0036** an answer (range $0.0013 to
$0.0053) against a $0.05 cap. Deep, which uses Sonnet for the merge, is
**$0.094** against a $0.35 cap. Both gates have an order of magnitude of
headroom, and the cost of that headroom is instruction-following — a larger
model would probably follow the contract better. I chose the headroom.

**A per-source character cap in the synthesis prompt, and I got the cost wrong.**
Each source is capped so Quick's prompt stays small, since every character is
paid for before the first token. The pages this system reads run past ten
thousand characters, so more than half of a long source was never shown to the
model — and which half survived was decided by extraction order, which has nothing
to do with the question. Three questions in a twenty-question diagnostic were
answered "the evidence does not cover this" while the text that answered them sat
in the ledger past the cut. Passages are now ranked against the question before
the cap applies, which fixed two of the three.

**The thing I am least sure about:** TTFT. Measured across the twelve most recent
deployed quick runs the median is **2469ms** against a 2500ms target — which just
clears it, and should not be read as comfortable: three quick asks timed from a
laptop during the smoke test came back at 2649ms, 4615ms and 5047ms, and the
difference between those numbers and the server-side median is the part I cannot
tune. Quick
searches the web and reads pages before its first token, by construction, and no
tuning inside that shape reaches 2.5 seconds. Reaching it means streaming
something before the evidence exists — a plan, a restatement, an acknowledgement —
and every version of that is a progress indicator dressed as an answer. I chose an
honest four seconds over a fast two, and a reasonable engineer would tell me the
user does not care about my reasoning and wants the page to move.

**What I would do next, in order:** feed each branch its remaining call budget so
a typical deep run stops ending as `cap`; move the Atlas cluster to a dedicated
tier in the Fly app's region and delete the keepalive; and give the grounding
validator a semantic layer so the number means what a reader will assume it
means.
