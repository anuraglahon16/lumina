# Verifying the architecture in five minutes, at no cost

Everything below runs locally with Docker. No hosting account, no credentials
beyond an Anthropic and a Tavily key if you want to ask questions — the
structural checks work without them.

```bash
git clone https://github.com/anuraglahon16/lumina && cd lumina
git checkout fly-architecture
docker compose up -d --build        # gateway, agent, worker, mongo
```

## 1. Only the Gateway is reachable

```bash
docker compose ps
```

The `PORTS` column is the whole claim:

```
gateway   0.0.0.0:8080->8080/tcp     <- the only published port
agent                                <- none
worker                               <- none
mongo     27017/tcp                  <- in-network only, not published
```

```bash
curl -s localhost:8080/health          # answers, via the private agent
curl -s -m 5 localhost:8787/v1/health  # nothing: the agent has no published port
```

## 2. The Gateway holds no provider credentials

```bash
for s in gateway agent worker; do
  printf '%s: ' "$s"
  docker compose exec -T $s sh -c 'env | grep -cE "^(ANTHROPIC_API_KEY|TAVILY_API_KEY)="'
done
```

```
gateway: 0
agent:   2
worker:  2
```

The same property is asserted in the test suite, from the Gateway's real import
graph rather than from its environment:

```bash
npm test -- tests/serviceBoundary.test.js
```

`tests/serviceBoundary.test.js` walks every module reachable from
`src/gateway/server.js` and fails if it ever reaches the model client, the search
client, the embedder, a parser, or the orchestration — and asserts the Agent and
Worker *do* reach them, so the boundary means the work moved rather than vanished.

## 3. Upload returns before any indexing happens

```bash
U=demo_$(date +%s)
SID=$(curl -s -X POST localhost:8080/spaces -H "x-user-id: $U" \
  -H 'content-type: application/json' -d '{"name":"demo"}' | jq -r .spaceId)

curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -X POST "localhost:8080/spaces/$SID/documents" -H "x-user-id: $U" \
  -F "file=@eval/gold/corpus/retrieval-basics.pdf;type=application/pdf"

curl -s "localhost:8080/spaces/$SID/documents" -H "x-user-id: $U"   # pending, 0 chunks
sleep 15
curl -s "localhost:8080/spaces/$SID/documents" -H "x-user-id: $U"   # indexed, 10 chunks
```

Measured on this stack:

```
{"docId":"doc_muj07lt1fvlcv3","status":"pending"}
HTTP 202 in 0.053031s

immediately after:  {"status":"pending","pct":0,"chunks":0}
fifteen seconds on: {"status":"indexed","pct":100,"pages":4,"chunks":10}
```

And the work happened in the other container:

```bash
docker compose logs gateway | grep -ciE 'pars|chunk|embed'   # 0
docker compose logs worker  | grep -ciE 'pars|chunk|embed'   # non-zero
```

## 4. The Worker has no HTTP listener

```bash
for s in gateway agent worker; do printf '%s: ' $s
  docker compose exec -T $s sh -c 'awk "NR>1 && \$4==\"0A\" {print \$2}" /proc/net/tcp /proc/net/tcp6' | tr '\n' ' '; echo
done
```

Decoded, the only socket the worker listens on is `127.0.0.11:<ephemeral>` —
Docker's embedded DNS resolver, which every container on a user-defined network
has. It has no application listener; the gateway shows `8080` and the agent
`8787` beside the same DNS socket. The count is not zero, and claiming zero
would be wrong.

It claims jobs from the database and writes results back; nothing can address it.
`tests/serviceBoundary.test.js` also asserts `src/agent/worker.js` contains no
`express`, no `createServer` and no `.listen(`.

## 5. The durable queue, without a happy path

```bash
npm test -- tests/jobClaim.test.js tests/asyncUpload.test.js tests/workerLoop.test.js
```

Eight concurrent claims yield exactly one winner; a lease that lapses returns the
job; a renewed lease is not stealable; retries are bounded and end in a visible
`failed`; a document cannot reach `indexed` before a read-after-write probe finds
one of its chunks.

## Tearing down

```bash
docker compose down -v
```
