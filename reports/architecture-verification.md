# Architecture verification

The deployment criticism was that the physical deployment did not match the
documented architecture: one public serverless function held the Gateway, the
Agent and the provider credentials, and indexing ran inside the upload request.
Both are now corrected. This records what was changed, what was measured, and
what is still open.

## What the deployment now is

```
  Browser ─▶ Gateway (public)          no provider credentials
                │
                ▼  private network only
             Agent (private)           Anthropic, Tavily, Mongo, orchestration
                │
             Worker (private)          no HTTP listener; claims durable jobs
```

| | Fly | Local Docker |
|---|---|---|
| Gateway | `https://lumina-al-gateway.fly.dev` | `localhost:8080` |
| Agent | `lumina-al-agent.internal:8787`, **no public IP** | no published port |
| Worker | process group in the Agent app | no published port |
| Database | Atlas, `lumina_fly` | local `mongo:7`, `lumina_local` |

Both are the same image and the same entry points. `docker-compose.yml` is the
free, reproducible form; `docs/verify-architecture.md` is the five-minute check.

## Measured, not asserted

**The boundary.** `flyctl ips list --app lumina-al-agent` returns nothing — the
Agent app has no public address of any kind, and direct requests to
`lumina-al-agent.fly.dev` return `000`. Locally, `docker compose ps` shows one
published port in the whole stack.

**Credentials by service.** Counted inside the running processes:

| service | `ANTHROPIC_API_KEY` / `TAVILY_API_KEY` |
|---|---|
| gateway | **0** |
| agent | 2 |
| worker | 2 |

Fly secret placement matches: the Gateway holds `INTERNAL_TOKEN`, `AUTH_SECRET`
and `DEMO_PASSWORD`; the Agent adds `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`,
`MONGODB_URI` and `MONGODB_DB`. `tests/serviceBoundary.test.js` walks the
Gateway's real import graph and fails if it ever reaches a provider client, a
parser or the orchestration.

**Upload returns before indexing.**

```
{"docId":"doc_muj07lt1fvlcv3","status":"pending"}
HTTP 202 in 0.053031s
immediately after:  status pending,  0 chunks
fifteen seconds on: status indexed, 10 chunks, 4 pages
gateway log lines mentioning parse/chunk/embed: 0
worker  log lines mentioning them:              non-zero
```

On Fly the same sequence measured `202` in **420ms**, with the Worker completing
four seconds later.

**The queue is durable and single-owner.** Eight simultaneous claims produce
exactly one winner; a lapsed lease returns the job and a renewed one is not
stealable; retries are bounded and end in a visible `failed` with the reason
kept; a document reaches `indexed` only after a read-after-write probe finds one
of its chunks. 31 tests across four files, each written before its change and
failing first.

**Run populations are separated without losing evidence.** `runs/` holds runs
that finished, `runs/failing/` holds capped and error runs with their exact
reasons intact, `reports/run-population.json` records what each means, and the 50
provider errors from an earlier benchmark are preserved in
`runs/archive-localhost/`. Over the corrected population A2 passes, taking
quality from two error-severity failures to one.

**Reliability under the benchmark's own shape.** 40 Quick requests at
concurrency 4 against the Fly Gateway: **1 failure, 2.50%**, p50 3171ms, p95
6469ms, and **no platform execution timeout** — against 9.88% and eight
300-second function kills on the single-function deployment. The one failure was
the Fly trial stopping a machine mid-stream, not the architecture.

## Two defects this work found

Both were invisible until the services were actually separated.

**Public `/health` never authenticated to the Agent.** It was the only upstream
call in the Gateway that omitted `x-internal-token`. Harmless while no token
existed; the moment one was configured the Agent refused with 403, the catch
swallowed it, and public health reported `degraded` with `db: down` and
`ai: down` on a stack where nothing was wrong. Observed live on Fly within the
hour. A test now sweeps every `fetch(AGENT(...))` in the file.

**The Agent logged its configured port, not its bound one.** With `AGENT_PORT=0`
it announced `"port":0`, which tells a reader — or a test waiting to connect —
nothing about where the service is.

## Open, and honest about it

- **The Fly deployment is on a trial.** Machines stop after five minutes:
  *"Trial machine stopping. To run for longer than 5m0s, add a credit card."*
  They can be woken with `flyctl machine start`, but a private-only app has no
  proxy route to auto-wake, so the Gateway simply times out until they are
  started. No payment method has been added.
- **The full benchmark has not been run against Fly.** On a trial account the
  numbers would measure billing rather than the system, so it is deliberately
  not run. The last complete benchmark is the Vercel one: grounding **1.000**
  (100/100 verifiable), recall@5 **0.967**, 12 of 16 SLA gates.
- **Quality has one error-severity failure left**, E2, the 9.88% error rate from
  that Vercel run. The concurrency measurement above suggests the three-service
  deployment removes its cause, but that is an expectation until a full
  benchmark is run somewhere it can finish.
- **`main` is untouched.** Production still serves the graded commit `a9cadef`.
  All of this is on `fly-architecture`.
