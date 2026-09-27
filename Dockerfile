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
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so source edits do not reinstall them.
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace-root --include-workspace-root || npm ci --omit=dev

# The contract's compiled types ship with the repo; the React app is deployed
# separately to Vercel and is deliberately not in this image.
COPY packages/contract ./packages/contract
COPY src ./src
COPY api ./api
COPY eval ./eval
COPY benchmark ./benchmark
COPY quality ./quality
COPY tools ./tools
COPY reports ./reports

# Writable scratch for the local JSON store fallback and page cache. Neither is
# the deployed path - Mongo is - but a container that cannot write anywhere at
# all has a different failure mode than one that degrades.
RUN mkdir -p /data && chown -R node:node /data
ENV DATA_DIR=/data
USER node

# Overridden per process group in fly/agent.toml and fly/gateway.toml.
CMD ["node", "src/agent/server.js"]
