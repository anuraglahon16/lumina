FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY eval ./eval
COPY scripts ./scripts

# Both services run in one container by default; SERVICE=gateway|agent splits them.
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080 8787

RUN useradd -r -u 10001 lumina && mkdir -p /data && chown lumina /data
USER lumina

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/dev.js"]
