# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx tsc && (node scripts/write-built-commit.cjs || true)
RUN npm prune --omit=dev && rm -rf node_modules/@anthropic-ai/*-musl \
 # the SDK's bundled claude (~230MB) is replaced by a link to the global CLI
 && for b in node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude; do rm -f "$b" && ln -s /usr/local/bin/claude "$b"; done
# everything the runtime needs, in one tree
RUN mkdir /out && cp -a node_modules dist package.json web scripts templates plugins skills \
      seed-config seed-scheduled-tasks seed-skills config-examples mcp-catalog.json HEARTBEAT.md /out/

FROM oven/bun:1-slim AS bun

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git sqlite3 lsof curl ca-certificates procps python3 unzip zstd tini \
 && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=2.1.318
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN install -d -o node -g node /app/store /home/node/.claude && chown node:node /app
USER node
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1
EXPOSE 3420
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "dist/index.js"]
