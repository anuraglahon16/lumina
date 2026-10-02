# One image, three entry points.
#
# The Gateway, the Agent and the Worker are the same code deployed three ways —
# two Fly apps, and a process group inside the Agent app for the Worker. Building
# one image keeps them from drifting: a change to the contract cannot land on the
# Gateway and miss the Agent.
#
# Node 22 on purpose. `engines` pins ">=20.19 <24" because the pdf.js build
# vendored by pdf-parse throws `bad XRef entry` on Node 24, which is how every
# PDF upload failed on a deployment whose platform default had moved on.
# ---- stage 1: build the provided React app -----------------------------------
#
# The UI used to be deployed separately to Vercel while the API ran here, so the
# page and the API it talked to came from two different origins and two different
# commits. The Gateway serves `web/dist` now, which means the image has to contain
# it, which means building it - with dev dependencies, which the runtime stage
# does not have and should not.
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY web/package.json web/
RUN npm ci
COPY packages/contract ./packages/contract
COPY web ./web
# `npm run build` in web/ typechecks first, so a UI that does not compile fails
# the image build instead of being quietly left out of it.
RUN npm run build -w @lumina/web

# ---- stage 2: the runtime image ----------------------------------------------
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so source edits do not reinstall them.
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace-root --include-workspace-root || npm ci --omit=dev

# The contract's compiled types ship with the repo.
COPY packages/contract ./packages/contract
COPY src ./src
COPY eval ./eval
COPY benchmark ./benchmark
COPY quality ./quality
COPY tools ./tools
COPY reports ./reports

# The built UI, from stage 1. Only the output: no sources, no dev dependencies.
COPY --from=web /app/web/dist ./web/dist

# Writable scratch for the local JSON store fallback and page cache. Neither is
# the deployed path - Mongo is - but a container that cannot write anywhere at
# all has a different failure mode than one that degrades.
RUN mkdir -p /data && chown -R node:node /data
ENV DATA_DIR=/data
USER node

# Overridden per process group in fly/agent.toml and fly/gateway.toml.
CMD ["node", "src/agent/server.js"]
