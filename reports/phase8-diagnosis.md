# Phase 8 — diagnosis before repair

## Item 2: the two deployed benchmark errors

**Neither is attributable to a server fault, and neither reproduces.**

What the evidence shows, and what it cannot:

| | |
|---|---|
| request / run ID | **not recoverable.** The benchmark records no identifier for a failed ask, and the Vercel runtime logs for the window have aged out |
| path | web workload — `ask(client, threadId, { mode: 'web' })`, 40 queries at concurrency 4 |
| client deadline | 300000ms (`benchmark/lib.mjs`), against a 300s function `maxDuration` |
| exact exception | one `TimeoutError: The operation was aborted due to timeout` at fetch level (status 0, hence the "network" label); the second raised no note and was counted by `if (a.error) M.errors++`, i.e. an answer carrying a server-sent error frame |
| last successful phase | unknown for both — no run log ties to either |
| run log persisted | **no.** All 87 runs in the window are `status: ok`; none carries a non-empty `errors[]`; none terminated `error` or `client_disconnected` |
| client timed out while server continued | consistent with the record but unproven: 87 persisted runs against 81 benchmark attempts leaves runs with no matching client answer |
| root cause | **not confirmed** |

Two things rule out the obvious explanation. The slowest run in the entire
window is 56045ms against a 300000ms client deadline, so no run came close to
timing out. And the SSE path terminates correctly — `flushHeaders`, a heartbeat
interval, and a `close()` that calls `res.end()` when the response has not
already ended.

Reproduction, against the same deployment and commit:

```
20 asked · 0 failed        (unique queries, concurrency 4)
40 asked · 0 failed        (the benchmark's exact shape: 20 unique + 20 repeats)
```

60 matched requests, no failure. At 2 in 81 the observed rate is ~2.5%, so 60
clean requests do not disprove it — but nothing here identifies a cause.

**Therefore no production code is being changed for these two errors**, per the
instruction to fix only a confirmed cause. What is confirmed is an
observability gap: a failed ask leaves no correlatable identifier on either
side. That is worth closing before the next run so a recurrence is diagnosable
rather than archaeological.

## Item 3: the 202 accept latency (390ms against 300ms)

The accept path is already minimal. `onAccepted` fires immediately after
`createDocument`, **before** the job is enqueued and long before parsing,
chunking or embedding:

```js
const accepted = enqueueDocument({ ..., onAccepted: (doc) => res.status(202).json({ docId: doc.id, status: 'pending' }) });
```

So there is no indexing work to move out of it. Measured against the deployment:

| request | what it does | TTFB |
|---|---|---:|
| `POST /spaces/:id/documents` | validate + 2 Atlas round trips | 315–400 ms |
| `GET /spaces` | 1 Atlas read | 311–334 ms |
| `GET /evals/report.json` | reads a file, no Atlas | 305–324 ms |
| `GET /nope` | 404 from the router, no Atlas | 301–318 ms |
| `GET /` | **static asset, no function at all** | **280–285 ms** |

TCP connect is ~57ms throughout.

**A static file that never reaches our code costs 280ms from this client.** The
whole application layer — router, middleware, two Atlas round trips — accounts
for roughly 110ms of the upload's 390ms. The rest is the path from this machine
to the deployment's region.

That reframes the target. The 300ms p95 for `202 accept` is measured client-side,
and from this client's network position the floor before our handler runs is
already ~280ms. No amount of work removed from the accept path reaches 300ms
from here. The controllable part is the ~110ms our code adds, of which one Atlas
round trip (the space lookup) is the only obviously removable piece, worth
perhaps 40–50ms.

The same floor applies to TTFT, where it matters far less: ~280ms of a 4715ms
p95. A Quick run measured on the deployment spends 74ms in retrieval and 3172ms
in synthesis — 97% of the wall clock is the model writing the answer, which is
where TTFT work has to go, not into retrieval.

## What this means for the remaining items

- The error causes are understood as far as the evidence allows: client-side,
  no server fault, not reproducible. Not a reason to change latency code.
- The 202 target is dominated by measurement geography. Worth removing the
  space lookup round trip; not worth restructuring the accept path that is
  already correct.
- Cache-key diagnostics (item 4) are next and are genuinely measurable.

---

# Deployed Deep probes (commit 9f0a9bf, `lumina-jnf7s94r6`)

Three four-sub-question Deep runs against the deployed allocation fix. The
budget behaviour is fully verified; the evidence-bearing behaviour is not,
because the search provider ran out of quota mid-verification.

| probe | allocations | attempted | claimed | settled | refused | branch | sweep | traces | terminated | attribution |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| BM25 vs dense | q1–q4 = 5 each, 4 reserved | 20 | 20 | 20 | 0 | 20 | 0 | 20 | `completed` | 0 missing |
| SSE vs WebSockets | q1–q4 = 5 each, 4 reserved | 22 | 22 | 22 | 0 | 22 | 0 | 22 | `completed` | 0 missing |
| cost at 100k/month | q1–q4 = 5 each, 4 reserved | 20 | 20 | 20 | 0 | 20 | 0 | 20 | `completed` | 0 missing |

Every invariant holds on the deployed runtime:

- `claimed <= 24` — 20, 22, 20
- `settled == claimed` in all three
- `attempted == claimed + refused` in all three
- `branch_claimed + sweep_claimed == claimed` in all three
- **recorded provider calls == pool claims** — 20/20, 22/22, 20/20. This is the
  one that would have caught the original defect, where a run made 29–32 calls
  against 22 claimed.
- `refused == 0` and `terminated == done` agree
- traces stayed at or under 24 with no refusal

The same three questions were `cap` with `reason=null` before the fix. They are
now `completed`, and the run log says why rather than leaving it to be inferred.

## What these probes did not verify

`sources = 0` on all three, and every tool call failed with
`0 results (no provider)`. The cause is external and confirmed directly against
the provider:

```
tavily http=433
{"detail":{"error":"This request exceeds the pay-as-you-go limit."}}
```

The Tavily account reached its pay-as-you-go limit during this phase's work —
the benchmark, the 60-request error reproduction and these probes. So the runs
above researched nothing, answered from nothing, and completed honestly with no
evidence. That is correct behaviour for a provider outage, but it means these
probes say nothing about sources, citations, grounding or the sweep, and the
deliberately constrained cap probe is not worth running until search works: a
cap on a run with no evidence would prove nothing.

Blocked until the Tavily limit is raised:

- the constrained probe that must `cap`
- sweep capacity usage against real candidates
- the final deployed benchmark and quality run
