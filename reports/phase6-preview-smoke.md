# Phase 6 — the deployed preview, checked

## What was checked, and where

| | |
|---|---|
| deployment | `https://lumina-1q8mjcpg9-anuraglahon16s-projects.vercel.app` |
| deployment id | `dpl_28co5Y1yK6wDU6cXahuiQNSHKAQA` (state READY) |
| commit | `593ff5e` on `rubric-conformance-final` |
| ran | 2026-09-19T01:46:03Z |
| harness | `tools/preview-smoke.mjs`, raw result in `reports/preview-smoke.json` |
| runtime | Node 22.23.2, x64 · MongoDB Atlas (`lumina_preview`) · Tavily · local embeddings |
| identities | `smoke_mu7pyp0sruiu` and three siblings for memory, quota and documents; Space `spc_…` created per run |

Every SSE frame and HTTP body is validated against the contract package's own
zod schemas (`AskStreamEvent`, `CreateThreadResponse`, `ListMemoryResponse` …)
rather than a second description of them, so "conforms" means the same thing
here as it does to the grader.

**`main` is untouched.** The branch was pushed, which creates a preview; nothing
was promoted to production.

## Environment conditions

The Preview environment had **no variables at all** — all 14 were scoped
`production` — so every preview deployment on this project had been failing at
import with `ENOENT: mkdir '/var/task/data'` and answering
`FUNCTION_INVOCATION_FAILED` on every route while reporting READY. Preview now
carries the same 14 plus `EMBEDDING_PROVIDER=local`, with `MONGODB_DB` pointed
at a separate `lumina_preview` database so nothing here touches production data.

Two values were copied wrong on the first attempt and corrected: `.env` stores
the Tavily and Voyage keys with an explanatory comment *inside* the quotes, and
dotenv strips it where a naive parser does not. The deployment spent one run
sending a 99-character "key" and getting `tavily 401` back on every search.

## Results — 25 of 26 passed, and the one failure was the harness

| # | check | result |
|---|---|---|
| 1 | fresh Vercel build completes | pass — READY, built from `593ff5e` |
| 2 | `web/dist` is the deployed output | pass — root serves the built SPA (`/assets/index-*.js`) |
| 3 | health reflects current code | pass — `db=ok`, `atlas-vector-search`, quick `claude-haiku-4-5`, deepSynthesis `claude-sonnet-5` |
| 4 | Anthropic real request succeeds | pass — 136 output tokens, $0.002539 |
| 5 | Tavily live, no fallback | pass — verified separately: `searchCached=false`, 6 results, 2 pages read |
| 6 | Voyage not called | pass — `embedding_provider=local` |
| 7 | local embeddings intentional, not degraded | pass — `status=ok`, `search_degraded=false` |
| 8 | four contract probes | pass — POST /threads (201), GET /threads, GET /memory, 401 without `X-User-Id` |
| 9 | Quick: sources before tokens | pass — sources at frame 3, first token at 4, 0 invalid frames, ttft 547 ms |
| 10a | Deep plans before retrieving | pass — plan at frame 0 (4 sub-questions), first trace at 1 |
| 10b | integer `subQuestion` on every retrieval trace | pass — 23/23 |
| 10c | integer `subQuestion` on every source | pass — 9/9 |
| 10d | Deep inside 24 calls | pass — 23 calls |
| 11 | memory save → row → recall → delete → gone | pass — all four steps; see the note below |
| 12 | daily Deep quota | pass — 5 accepted, cap+1 → JSON 429 with `resetsAt` 2026-09-20T00:00:00Z, and no run recorded for the refusal |
| 13 | upload and query a document | pass — indexed, 6 sources, 563-character answer |
| 14 | same-page sources carry distinct real lines | pass — 6 sources, 6 distinct keys, one page carrying several |
| 15 | `/evals` renders | pass — React app, names Anurag Lahon, both trajectories present |
| 16 | no secret browser-accessible | pass — 5 routes and the JS bundle scanned for connection strings and key prefixes |
| 17 | deployment recorded | this document |

Check 5 was the failing row in the recorded run, and the fault was the check's:
it asserted the search was live while asking a question a previous run had
already cached, so `searchCached` was correctly `true`. Re-asked with a unique
query against the same deployment it returns `searchCached=false`, 6 Tavily
results and two fetched pages. The harness now varies the query per run, and no
longer requires `search_last` to be populated — that diagnostic is per-instance
memory, and a different lambda answers `/api/health`.

## Three defects found here, each fixed on its own commit

**`51de6f4` — the JSON store took the whole function down.** `runLog.js` builds
its collection at module scope and the constructor mkdirs eagerly, so on a
read-only serverless bundle the import threw before any route ran. The file's
own comment already said a refusing filesystem should "cost the convenience, not
the run"; now it does.

**`a281ab0` — 3 of 14 Deep sources reached the grader without a `subQuestion`.**
The cross-branch sweep tagged its sources `branch: 'sweep'`, and the contract
derives the index by stripping non-digits. They are now attributed to the branch
whose search first surfaced the candidate — first discoverer, the rule the rest
of the ledger follows. The existing attribution tests could not have caught it:
their stub search returns one result per query so the sweep never had anything
to do, and the sweep called the module-level fetcher rather than the injected
one, so it could not be driven from a test at all.

**`593ff5e` — every PDF upload failed on the deployment.** `bad XRef entry`,
status `failed` at 5%. Document RAG was entirely broken on the deployed app
while scoring 15/15 locally. The upload was innocent: a diagnostic against the
live function showed the bytes arriving byte-perfect — same sha256, 13051 bytes,
correct header and trailer, zero replacement characters — and parsing that same
buffer in-process reproduced the failure on **Node v24.20.0**, inside the pdf.js
build from 2018 that `pdf-parse` vendors. `engines.node` said `>=20.19`, so the
platform took its newest. Bounded to `<24` the function runs on Node 22.23.2 and
the same request returns 4 pages.

That last one had never been visible because the benchmark that scored Document
RAG 15/15 ran against `http://localhost:8787`. The deployed document path had
not been exercised once.

## Carried forward, not fixed here

- **Production still has both deployed defects.** `main` runs the same
  `engines.node: ">=20.19"`, so its PDF ingest fails the same way, and its
  `EMBEDDING_PROVIDER` is unset with `VOYAGE_API_KEY` present, so it resolves to
  Voyage. Both are fixed on this branch; production only picks them up on merge
  and redeploy, and `EMBEDDING_PROVIDER=local` is currently Preview-only by
  choice.
- **`/evals` is behind the demo password.** Unauthenticated it returns 401. A
  grader opening the link needs the password; that is a deliberate gate, but it
  is a gate on the page the rubric asks a human to read.
- **Memory recall answers poorly, though it recalls.** `recall_memory` returns
  the memory on every attempt and the answer does use it, but the model also
  runs a web search for "what am I writing about", finds an article about
  fiction-writing prompts, and opens with "The evidence doesn't tell me what
  you're writing about" before getting to the fact. The lifecycle is correct;
  the answer reads badly. Left alone because changing it is prompt design, not
  rubric conformance.
- **Markdown uploads are fine with an explicit content type.** The `415` seen
  earlier is content-type detection on the upload route, not Markdown parsing.
  Still a separate follow-up.
- **Quick's tool envelope is 10 where the grader checks 8** — unchanged from the
  Phase 3B note.
