# Velvarr container: multi-stage, reproducible, secrets only at runtime.
# Build needs no VELVARR_* secrets; .dockerignore keeps .env* out of the context entirely.

# Install stage: Bun 1.3.14 with the frozen lockfile produces node_modules for the Node build.
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build stage: Next standalone output compiled by Node 24.21.0. No env secrets required.
FROM node:24.21.0-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ./node_modules/.bin/next build

# Runtime stage: non-root, writable /data only, loopback-published port via compose.
FROM node:24.21.0-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=5577 \
    VELVARR_DATA_DIR=/data
# The image-owned /data gives a first-use named volume velvarr ownership in compose.
RUN groupadd --system --gid 10001 velvarr \
 && useradd --system --uid 10001 --gid velvarr --home-dir /app --shell /usr/sbin/nologin velvarr \
 && mkdir -p /data \
 && chown velvarr:velvarr /data
COPY --from=build --chown=velvarr:velvarr /app/.next/standalone ./
COPY --from=build --chown=velvarr:velvarr /app/.next/static ./.next/static
# ponytail: no COPY public — M1 ships no public/ assets; add one line here if that changes.
USER velvarr
EXPOSE 5577
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5577/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
