# Deploying LUMINA to Hugging Face Spaces

Spaces has a **Docker SDK**, so LUMINA runs as it is. There is no Streamlit
rewrite: Streamlit is a Python framework and this is a Node service, and its
rerun-per-interaction model works against the SSE streaming that the whole
design depends on.

One container runs both services. The agent stays on loopback and only the
gateway is exposed, which is the same shape as `docker-compose.yml`.

---

## 1. Create the Space

New Space at <https://huggingface.co/new-space>, SDK **Docker**, template
**Blank**.

## 2. Push the code

The Space is a git repo. From a clone of it:

```bash
cp -r /path/to/lumina/{src,scripts,eval,package.json,package-lock.json} .
cp /path/to/lumina/Dockerfile.hf ./Dockerfile     # Spaces build the root Dockerfile
```

## 3. README front matter

Spaces read configuration from YAML at the top of `README.md`. `app_port` must
match the port the gateway listens on.

```yaml
---
title: LUMINA
emoji: 🔎
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---
```

Anything below the front matter is the Space description.

## 4. Secrets

Settings → **Variables and secrets**. Add as **secrets**, never as variables:

| Secret | Required | Why |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | nothing answers without it |
| `DEMO_PASSWORD` | yes, if the Space is public | see below |
| `TAVILY_API_KEY` | recommended | without it search falls back to a keyless scrape |
| `VOYAGE_API_KEY` | recommended | without it retrieval uses the local lexical embedder |
| `AUTH_SECRET` | recommended | makes per-user rate limits real rather than advisory |

They arrive as environment variables at runtime, which is what `config.js`
reads. Nothing needs to change in the code.

## 5. Protect it before making it public

**A public Space with your key on it is a stranger's free access to your model
credits.** Either keep the Space private, or set `DEMO_PASSWORD`, which puts
the gateway behind HTTP Basic and gives everything except `/health` a 401
without it. `/health` stays open so the platform's probe still works.

`AUTH_SECRET` is the second half: without it a caller picks their own user id,
so per-user rate limits reset on a header change.

---

## What you give up on the free tier

**Disk is wiped on restart.** Threads, long-term memories, uploaded documents,
the run log and the search cache all live on disk, so a restart or rebuild
loses them. The app works; it just forgets.

To keep data, attach a [Storage Bucket](https://huggingface.co/docs/hub/storage-buckets)
mounted at `/data` (which `DATA_DIR` already points at). Note that `/data` is a
runtime mount, so it cannot be used during the build.

**Spaces sleep when idle**, and the first request after a sleep pays a cold
start. A Deep Search can run for minutes; start one and leave the tab open
rather than reloading.

**Single instance.** The job queue, rate-limit buckets and circuit breakers are
in-process, which suits one container and is all a Space gives you. Do not plan
on replicas without moving that state to Redis.

---

## Verify after deploy

```bash
curl -u x:$DEMO_PASSWORD https://<user>-<space>.hf.space/health
```

Look for `"status": "ok"` and no `search_degraded` or `embedding_provider:
local`. The evaluation report is at `/evals`, and `/api/limits` shows what the
rate limiter has been doing.
