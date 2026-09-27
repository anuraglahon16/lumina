# Demo video script

About six minutes. Written to run against the **local Docker stack**, so it needs
no hosting account and cannot be broken by a suspended trial machine. Where the
Fly deployment is also live, the same beats work against
`https://lumina-al-gateway.fly.dev` — swap the base URL and say which you are
using.

Before recording:

```bash
docker compose up -d --build
curl -s localhost:8080/health          # expect status ok, db ok, ai ok
```

Keep two panes: a browser, and a terminal with `docker compose logs -f worker`.

---

## 1 · The architecture (45s)

Show `docker compose ps`. Point at the `PORTS` column.

> "Three services. The gateway is the only one with a published port. The agent
> and the worker have none — the agent is reachable only on the private network,
> and the worker has no HTTP listener at all. That's the correction: the
> separation used to exist in the code and not in the deployment."

Then, in one command:

```bash
for s in gateway agent worker; do printf '%s: ' $s; \
  docker compose exec -T $s sh -c 'env | grep -cE "^(ANTHROPIC_API_KEY|TAVILY_API_KEY)="'; done
```

> "Zero provider credentials on the public service. Two on each private one. A
> test walks the gateway's import graph and fails if it ever reaches a model
> client, so this can't quietly regress."

## 2 · A Quick answer, streaming with citations (60s)

Open `localhost:8080`, ask something current — *"Why do proxies buffer
Server-Sent Events?"*

> "Sources arrive before the first token, which is the ordering the contract
> requires: the citation chips exist before the text that refers to them. Every
> sentence that makes a claim carries a number, and the number resolves to a page
> we actually fetched."

Click a citation to show the source panel.

## 3 · A Deep answer (75s)

Ask *"What are the trade-offs between BM25 and dense vector retrieval for
technical documentation search?"* with Deep selected.

> "The plan comes first — four sub-questions, before any retrieval. Each trace
> step is tagged with the sub-question it belongs to, so you can see which part of
> the answer each source was gathered for. The whole run is capped at 24 provider
> calls, allocated before the branches start: five each with four reserved for the
> cross-branch sweep."

If it ends `cap`, say so plainly:

> "This one says capped, and that's honest — a branch asked for a call the budget
> couldn't fund. The run log records what was allocated, claimed, settled and
> refused, so 'capped' is a fact you can check rather than a label."

## 4 · Memory across threads (45s)

> "Remember that I'm writing a thesis on retrieval-augmented generation."

New thread, then: *"What am I writing about?"*

> "Saved in one thread, recalled in another, and scoped to this user — another
> user asking the same question gets nothing."

## 5 · Upload: 202 first, indexing after (75s)

This is the beat worth doing on the terminal so the timing is visible.

```bash
U=demo_$(date +%s)
SID=$(curl -s -X POST localhost:8080/spaces -H "x-user-id: $U" \
  -H 'content-type: application/json' -d '{"name":"demo"}' | jq -r .spaceId)
curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' -X POST \
  "localhost:8080/spaces/$SID/documents" -H "x-user-id: $U" \
  -F "file=@eval/gold/corpus/retrieval-basics.pdf;type=application/pdf"
curl -s "localhost:8080/spaces/$SID/documents" -H "x-user-id: $U"
```

> "202 in about fifty milliseconds, and the document is pending with zero chunks.
> The request stored the bytes in GridFS, created a durable job, and returned.
> Nothing was parsed."

Switch to the worker log pane.

> "The worker — a different process — claims the job, parses, chunks, embeds, and
> only then marks it indexed. And it doesn't say indexed until a read-after-write
> probe finds one of the chunks, because a document that claims to be searchable
> and isn't is worse than one that's still working."

Re-run the status command: `indexed`, 4 pages, 10 chunks.

## 6 · A document question with a page and line citation (45s)

Ask, scoped to that space: *"What chunk size and overlap does the course
recommend?"*

> "The citation is page and line, not just the filename. That mattered for
> correctness as well as for the reader: the benchmark keys each source by
> document, page, heading and line, and while the locator carried only a page, two
> chunks of one page collided — an honest citation scored against a different
> passage. Fixing it moved document grounding from 8 of 12 to 13 of 13."

## 7 · `/evals` (60s)

Open `localhost:8080/evals`.

> "Public, no password — a grader shouldn't need a credential to read the
> evaluation. Citation grounding 1.000 over a hundred verifiable citations, zero
> dangling. recall@5 0.967. Twelve of sixteen SLA gates."

Scroll to the trajectories.

> "One run that finished and one that didn't, both real, both from the measured
> population. The failing one is the run that exposed the budget defect — it
> recorded 31 provider calls against a ceiling of 24, because the sweep was
> spending outside the pool. It told the truth about being curtailed, which is
> what made the defect findable."

## 8 · Close (30s)

> "The gateway holds no provider keys. The agent and worker are private. The
> upload request stores and enqueues; the worker does the work. Completed runs and
> capped runs are kept apart without deleting either.
>
> What I'd flag honestly: the Fly deployment is on a free trial that stops
> machines after five minutes, so I haven't run the full benchmark there — the
> numbers would measure billing rather than the system. The last complete
> benchmark is the Vercel one, and one quality check still fails on its error
> rate, which the concurrency test suggests this architecture fixes but I haven't
> proven end to end."

---

## If recording against Fly instead

Wake the private machines first — a private-only app has no proxy route to
auto-start:

```bash
flyctl machine start --app lumina-al-agent
curl -s https://lumina-al-gateway.fly.dev/health
```

Then use that base URL throughout. Expect a five-minute window before the trial
stops them again, so record beats 2–7 in one take.
