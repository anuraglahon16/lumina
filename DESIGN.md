# DESIGN.md — LUMINA

## Components

Two Express services and five pieces of state that are not services.

**Gateway** (`src/gateway`) is the only process the browser reaches. It serves the
React UI, validates every request against the zod contract, mints request and user
ids, rate-limits, forwards SSE, and holds the shared-password gate. It has no
provider keys at all.

**Agent** (`src/agent`) binds to loopback and, when `INTERNAL_TOKEN` is set,
refuses anything that did not come through the gateway. It runs the two answer
paths (Quick and Deep), web search, page fetching, RAG, memory, and the job
worker. Every provider key lives here.

**MongoDB Atlas** holds `chunks` (document text plus its embedding, searched by
`$vectorSearch`), `runs`, `threads`, `memories`, `spaces`, `documents` and `jobs`.

**The job queue** is the `jobs` collection plus an in-process worker. Ingestion is
accepted with a 202 and finished in the background, which is why a 60-page PDF
does not block a search.

**The search cache** keys on a normalised query rather than the raw string,
because the model rephrases the same intent three ways and each rephrasing was a
paid API call.

**The evidence ledger** is not stored anywhere — it lives for one run — but it
makes decisions, so it belongs on this list. It is the only thing that can say a
source is citable.

**The funnel** is a diagnostic trace, off by default, that records what happened
to every candidate from the query to the citation.

## Responsibilities

The interesting lines are the exclusions.

**Only the agent may hold a provider key.** The gateway proxies; it never calls
Anthropic, Tavily or Voyage. A key that reaches the browser is a key that has
leaked, so the gateway is not given one to leak.

**Only the gateway may talk to the browser.** The agent binds to 127.0.0.1 and
checks `x-internal-token`. A request that reaches the agent without having passed
the gateway's validation is refused rather than repaired.

**Only the evidence ledger may decide what is citable.** A search result is a
*candidate*. It becomes evidence when a page has been fetched and its text
extracted, and at no other moment. The synthesis prompt is never given a snippet
it did not read, so an answer cannot cite one — this is enforced by what is in
the prompt, not by asking the model nicely.

**Only the budget may decide a run is over its cap.** It counts tool calls,
searches, fetches, turns and wall clock, and every stop carries a named reason
that reaches the run log and the user. Tools do not decide to stop; the harness
stops them.

**Only the validator may report groundedness**, and it runs after the answer is
written, against the same passages the model saw.

## Communication

**Browser to gateway:** HTTP and SSE. The `sources` event is emitted before the
first answer token, always — not as a timing accident but because synthesis emits
it before the model call starts. A reader never sees a claim before the list it
was drawn from.

**Gateway to agent:** HTTP, with the SSE stream piped straight through. If the
agent is down the gateway answers `ai: { status: 'down' }` on `/health` and the
ask fails with a contract error rather than a hung stream.

**Agent to providers:** HTTP behind a per-host circuit breaker. The breaker
distinguishes a host fault from a caller cancellation — the fetch pool aborts its
losers on every healthy run, and counting those as failures would trip the
breaker against the hosts that answered fastest.

**Agent to the worker:** the `jobs` collection. Ingestion returns 202 immediately;
the worker embeds and indexes. If the worker dies mid-job the document stays
`processing` and is visible as such, rather than silently appearing complete.

**In-flight requests when something is down:** an abort is a real
`DOMException('…', 'AbortError')` propagated through an owned `AbortController`.
A cancelled synthesis that has already streamed text keeps the text, because the
reader watched those words appear and replacing them with an error is the worse
outcome.

## State

**Authoritative:** `chunks` (the only copy of an uploaded document's text),
`threads`, `memories`, `spaces`, `documents`, `jobs`. Losing any of these loses
user data.

**Cache, deletable:** the search cache, the page cache, and every `reports/*.json`.
Deleting them costs latency and money, not information.

**Per-run and never stored:** the evidence ledger and the budget counters.

**Consistency for a document written but not yet searchable:** the upload returns
202 with the document in `processing`. It is not in `chunks`, so it cannot be
retrieved and cannot be cited. `GET /spaces/:id/documents` reports the state
honestly, and the UI shows it. There is no window in which a document is
half-searchable: a chunk exists with its embedding or it does not exist.

**Embedding namespaces** are part of the state story. Every vector is stored under
`provider:model:dim:vN`, and vectors from different namespaces are never compared.
When Voyage is unavailable the local lexical embedder serves under its own
namespace, so a corpus half-indexed by each does not silently produce nonsense
similarities — it produces two searchable namespaces.

## Trade-offs

**A per-source character cap in the synthesis prompt, and I got the cost wrong.**
Each source is capped at 4500 characters so Quick's prompt stays small, since
every character is paid for before the first token. The pages this system reads
run past ten thousand characters, so more than half of a long source was never
shown to the model — and which half survived was decided by extraction order,
which has nothing to do with the question. Three questions in a twenty-question
diagnostic were answered "the evidence does not cover this" while the text that
answered them sat in the ledger past the cut. Passages are now ranked by the
question before the cap applies, which fixed two of the three. I am still unsure
the cap is in the right place at all; raising it trades directly against TTFT,
which is the gate with the least headroom.

**Lexical overlap as the grounding validator instead of an entailment model.**
It is cheap, deterministic, and runs on every answer without a second model call.
It also cannot tell a paraphrase from a fabrication. Adjudicating all 35 sentences
it flagged as unsupported found that **none** of them were: 26 were evidence-gap
disclosures the prompt requires to be uncited, and 9 were paraphrase the bar
cannot see. The measure is useful as a guard against a citation pointing at the
wrong source, which is what it was chosen for, and it should not be read as a
measure of truthfulness. A reasonable engineer would have added a semantic layer;
I did not, because changing the ruler while trying to improve the product makes
both unmeasurable.

**Haiku for Quick, Sonnet only for Deep synthesis.** Quick costs $0.0036 an answer
against a $0.05 cap, which is most of the reason the cost gates are not close.
The cost is instruction-following: the citation-granularity work moved
completeness from 0.625 to 0.806 and then stalled, and a larger model would
probably follow the contract better. I chose the cost headroom.

**One search, then a coverage-driven fetch pool, rather than an agentic loop for
Quick.** The pool reads pages until the evidence covers the question and then
stops, cancelling the rest. It is fast and bounded. It also stopped too early on a
question with two halves, satisfying coverage from a page that answered one of
them. I added a `coverage_miss` retrieval category for exactly that shape and then
could not confirm a single real instance of it, which is a fair warning that I
built the category before I understood the failure.

**The thing I am least sure about:** TTFT is 4029ms against a 2500ms target and I
have accepted it as a design limitation rather than a miss. Quick searches the web
and reads pages before its first token, by construction, and no amount of tuning
inside that shape reaches 2.5 seconds. Reaching it means streaming something
before the evidence exists — a plan, a restatement, an acknowledgement — and every
version of that I considered is a progress indicator dressed as an answer. I chose
an honest four seconds over a fast two, and a reasonable engineer would tell me
the user does not care about my reasoning and wants the page to move.
