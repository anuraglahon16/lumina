# LUMINA

A streaming, citation-grounded research agent. It searches the web, **reads the
pages it finds**, answers only from what it actually retrieved, remembers across
sessions, searches documents you upload, and runs a separate Deep Search mode
for questions that need decomposition.

Two Express services, as specified:

| Service | Port | Responsibility |
|---|---|---|
| **Gateway** | 8080 | CORS, request validation, user/request IDs, rate limiting, structured logging, SSE forwarding, UI |
| **Agent** | 8787 | Agent loop, LLM + tool calls, web search, page fetching, memory, RAG, Deep Search, background jobs, run logs |

The agent binds to loopback and, when `INTERNAL_TOKEN` is set, refuses any
request that did not come through the gateway.

---

## Run it

```bash
npm install
cp .env.example .env        # then add ANTHROPIC_API_KEY
npm run dev                 # both services, one terminal
open http://localhost:8080
```

Only `ANTHROPIC_API_KEY` is required. Everything else degrades honestly:

- **No search key** → a keyless DuckDuckGo HTML fallback. It works; quality is
  visibly lower, and `/health`, `/api/capabilities`, and the UI status line all
  say so rather than pretending otherwise.
- **No embedding key** → a deterministic local lexical embedder. Retrieval
  automatically shifts weight onto the BM25 half of the hybrid, because the
  local vectors are lexical and would otherwise double-count that signal.

```bash
npm test        # unit tests: grounding, budgets, chunking
npm run smoke   # end-to-end against a running stack (no model key needed)
npm run eval    # evaluation harness (needs a model key)
docker compose up --build
```

---

## The five things that make it work

### 1. Search finds leads; only a fetched page is evidence

A search snippet can never be cited. `EvidenceLedger` keeps search hits as
*candidates*; a source is created only when `fetch_page` succeeds and returns
extracted text. Uploaded-document chunks are citable on retrieval because the
text is already in hand. Nothing else can enter the ledger, so "cite only
retrieved evidence" is a property of the data structure rather than a request in
a prompt. The UI shows the candidates that were found but not read.

### 2. Sources arrive before answer tokens, structurally

Each run has two phases. The **research phase** uses tools, and nothing it
writes is shown as the answer. The **synthesis phase** emits the complete
`sources` event *before* the model call starts, then streams `token` events.
Ordering is not a timing accident, and the gateway logs
`sources_before_tokens` on every forwarded run so a regression is visible.

### 3. Citations are verified after generation, not trusted

`EvidenceLedger.validate()` strips any `[n]` outside the ledger, so a hallucinated
source number never reaches the user, and scores each cited sentence for
lexical support against the source it cites. That ratio is reported as
`groundedness` on the `citations` event, in the run log, and in the UI footer.
When validation changes the text, an authoritative `answer` event replaces what
was streamed.

### 4. Quick mode is capped, and says so

`Budget` enforces tool calls, searches, fetches, iterations, and wall clock. The
model is *told* the limits; the harness *enforces* them. A blocked tool returns
a result telling the model to wrap up, the run ends with a named
`termination_reason`, a `capped` event fires, and the synthesis prompt requires
the answer to open by stating that research was cut short. A truncated run that
sounds complete is the failure mode this design exists to prevent.

### 5. Quick and Deep are separate code paths

`core/quick.js` and `core/deep.js` share the research loop and the synthesis
step, and nothing else: separate budgets, prompts, phases, and rate-limit
buckets. Quick never escalates; Deep never silently degrades into Quick.

Deep Search: **plan** (decompose into sub-questions) → **branches** (each
sub-question researched in parallel under its own budget) → **sweep** (fetch
cross-branch sources that several branches surfaced but none read) →
**merge** (one global citation numbering, deduplicated by URL) → synthesis.

---

## Streaming protocol

`POST /api/query` returns `text/event-stream`.

| Event | Meaning |
|---|---|
| `run_start` | run id, thread id, mode, model, budget, search provider |
| `context` | prior turns, memories injected, documents available |
| `memory_used` | which long-term memories were retrieved |
| `plan` | Deep Search only: interpretation + sub-questions |
| `branch_start` / `branch_done` / `branch_skipped` | Deep Search branch lifecycle |
| `iteration` | a reasoning turn, with budget consumed so far |
| `tool_call` / `tool_result` / `tool_blocked` | the visible trace |
| `source_added` | a page became citable evidence |
| `capped` | an execution limit was reached, with an explanation |
| **`sources`** | **the complete citable set, always before the first token** |
| `token` | answer text delta |
| `answer` | authoritative text after citation validation |
| `citations` | cited sources, invalid markers dropped, groundedness |
| `memory_saved` | what was written to long-term memory |
| `done` | latency, TTFT, cost, tokens, tool calls, cache, termination reason |
| `error` | a structured failure |

Deep Search can also run detached (`"async": true`), returning a `stream_url`.
`GET /api/runs/stream/:id` replays the buffered events and then follows live, so
a closed tab does not lose a five-minute run.

---

## API

```
POST   /api/query                     { query, mode: quick|deep, thread_id?, async? }  → SSE
GET    /api/runs/stream/:streamId     replay + follow a detached run                   → SSE

GET    /api/threads                   list          POST /api/threads          create
GET    /api/threads/:id               full history  DELETE /api/threads/:id    delete

GET    /api/memories                  list (?q= semantic search)
POST   /api/memories                  add manually
DELETE /api/memories/:id              forget one
DELETE /api/memories                  forget everything

POST   /api/documents                 multipart upload → 202 + job id
GET    /api/documents                 list with indexing progress
GET    /api/documents/:id             status + job detail
DELETE /api/documents/:id             delete document and its chunks
GET    /api/documents/search/query    ?q= direct RAG probe

GET    /api/runs                      run log        GET /api/runs/:id      one run
GET    /api/runs/stats                p50/p95 latency, spend, cache hit rate
GET    /api/jobs  /api/jobs/:id       background job status
GET    /api/capabilities              active providers and budgets
GET    /health                        gateway + agent health
```

---

## Memory

**Thread memory** is the verbatim conversation, windowed into each run.

**Long-term memory** is user-scoped and survives threads. It is written two
ways: the model can call `remember` during a run, and a cheap post-run extractor
looks for durable facts about the *user*: stated preferences, role, projects,
constraints. The extraction prompt is written so that saving nothing is the
expected outcome; topic facts and anything from sources are explicitly excluded.
Retrieval is hybrid (embedding + term overlap) and near-duplicates are merged.

Every memory is listed in the UI with its kind, source, and age, and is
individually deletable. Nothing is remembered that the user cannot see and remove.

---

## Documents and RAG

Upload returns `202` immediately with a job id. A background worker parses →
chunks → embeds → indexes, reporting progress the UI polls.

Chunks **never span pages**, so a citation like `handbook.pdf, p. 7` is
literally true. PDFs get real page numbers from a per-page render hook; flat
text and HTML get ~3k-character sections with the same locator contract.

Retrieval is hybrid dense + BM25, with the blend weighted by which embedding
provider is actually active.

---

## What is measured

Every run writes a record to `data/runs.json` and appends it to
`data/runs.ndjson`:

latency and time-to-first-token · per-phase timings · cost in USD priced from
reported usage · input/output/cache-read/cache-write tokens · every tool call
with duration, success, and whether it was cached · cache hits, misses, and
writes per namespace · errors with their phase · sources discovered, fetched,
and cited · citation validity and groundedness · the termination reason.

`GET /api/runs/stats` aggregates p50/p95 latency, spend, and cache hit rate.

---

## Evaluation

```bash
node eval/run-eval.js --repeats 5
node eval/run-eval.js --case deep-multipart --judge
```

Each case runs N times, because one run of a stochastic agent over a changing
web tells you nearly nothing. Numeric metrics are reported as a mean with a 95%
t-interval; pass rates use a Wilson interval, which behaves correctly at 0/N and
N/N. Results are written to `eval/results-*.json` with every individual run kept.

Two kinds of measurement, deliberately separated:

- **Contracts**, which must hold on *every* run rather than on average: sources before
  tokens, no invalid citations, search-before-fetch, mode respected, honesty
  when capped, Deep Search actually planned. Any violation exits non-zero.
- **Quality and cost**: groundedness, citation coverage, key-term recall,
  latency, TTFT, spend. These are distributions, and reported as such.

`--judge` adds an LLM faithfulness grader over the answer and its evidence.

---

## Security

Secrets are read from `process.env` only. They are never written to disk, never sent to
the browser, and the logger redacts anything key-shaped before it reaches a log
line. `/api/capabilities` reports *which* providers are configured, never values.

The agent fetches URLs the model chose, so `fetchPage` is treated as an SSRF
surface: scheme allowlist, blocked hostnames, DNS resolution, and rejection of
private and link-local ranges before any request is made. Byte and character
ceilings bound memory, and `robots.txt` is respected by default.

Rate limiting is per-user token buckets with separate classes for quick, deep,
upload, and general traffic, since a Deep Search costs orders of magnitude more
than a thread listing.

---

## Layout

```
src/shared/          config, structured logging with redaction, SSE, errors, ids
src/gateway/
  middleware/        identity (request + user ids), token-bucket rate limiting
  routes/            validated API surface, JSON/SSE/upload forwarding
  public/            the UI (no build step)
src/agent/
  core/              agent loop, budgets, evidence ledger, prompts, tools,
                     synthesis, quick, deep, memory extraction
  services/          search providers, fetcher, cache, embeddings, chunker,
                     parsers, RAG store, memory store, threads, jobs, ingest
  store/             JSON persistence, run recorder and stats
  routes/            query/SSE, threads, memories, documents, observability
eval/                cases + harness
tests/               unit tests
```

Persistence is a small JSON document store with atomic writes, deliberately
dependency-free. Moving to Postgres means reimplementing `store/jsonStore.js`
and nothing else.

---

## Known limits

- The job queue and detached-run buffers are in-process. Two instances would
  need Redis; every handler is registered by name to make that swap mechanical.
- The keyless search fallback scrapes HTML and is rate-limited by the provider.
  Set a search key for anything beyond a demo.
- Groundedness is a lexical-support heuristic, not entailment. It catches
  citations pointing at the wrong source; it does not catch a fluent paraphrase
  of something the source never said. `--judge` in the eval harness is the
  stronger check.
