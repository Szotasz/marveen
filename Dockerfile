# syntax=docker/dockerfile:1.7
#
# Marveen — multistage container image.
# Base pinned to Node 22 (package.json engines: ">=20 <24"; .nvmrc: 22).
# Debian "bookworm-slim" (glibc) rather than Alpine (musl): the one native dep,
# better-sqlite3, and the runtime tools (ffmpeg, python venv) are happiest on glibc.

# ---------------------------------------------------------------------------
# base — shared, minimal Node layer
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — ALL deps (incl. dev) + native build toolchain for better-sqlite3.
# Cached on package*.json so a source-only change never re-runs npm ci.
# ---------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------------------
# build — compile TypeScript -> dist/
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# test — build stage (dev deps + src + tests) PLUS the runtime OS tools, so the
# vitest suite runs on the SUPPORTED platform (Linux, Node 22, tmux/git/python3
# present). Build + run:  docker build --target test -t marveen:test . &&
#                         docker run --rm marveen:test
# ---------------------------------------------------------------------------
FROM build AS test
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git tmux tar gawk python3 python3-venv sqlite3 ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Runtime assets the suite reads (scripts/*.sh, web/*, templates/*) — the build
# stage only has src/, so bring the rest in for a faithful in-container run.
COPY scripts    ./scripts
COPY web        ./web
COPY templates  ./templates
COPY seed-skills ./seed-skills
COPY seed-scheduled-tasks ./seed-scheduled-tasks
# Root installer/updater scripts some static tests assert against.
COPY install.sh install-linux.sh install-macos.sh install-lang.sh update.sh install-windows.ps1 ./
# `claude` on PATH so resolveFromPath('claude') (module-load in channel-monitor /
# onboarding) succeeds — same install as the runtime stage.
ENV PATH=/root/.local/bin:$PATH
RUN curl -fsSL https://claude.ai/install.sh | bash \
    || echo "WARN: claude CLI not installed in test image (offline?)."
# Several tests shell out to git inside PROJECT_ROOT; make /app a real repo with
# an identity so `git rev-parse`/branch lookups resolve instead of erroring.
RUN git config --global --add safe.directory /app \
    && git config --global user.email test@marveen.local \
    && git config --global user.name  marveen-test \
    && git init -q && git add -A && git commit -q -m "container test baseline" || true
CMD ["npx", "vitest", "run"]

# ---------------------------------------------------------------------------
# prod-deps — production-only node_modules (native module rebuilt for prod).
# Same base as runtime, so the compiled better-sqlite3 .node is ABI-compatible.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---------------------------------------------------------------------------
# runtime — slim image, runtime OS tools only, non-root, healthchecked.
# ---------------------------------------------------------------------------
FROM base AS runtime

# Tools the app shells out to at runtime (see docs/docker.md for the mapping):
#   tmux  - agents run as `claude` inside tmux sessions (agent-process.ts)
#   git   - update-checker, git-protect-guard hook, repo ops
#   tar   - backup/restore scripts
#   gawk  - install/status scripts
#   python3(+venv) - guard hooks (git-protect/secret-write/big-file) & tooling
#   sqlite3 - DB inspection/maintenance
#   ffmpeg  - voice/audio (libopus) features
#   curl, ca-certificates - HTTP, healthcheck, claude install
#   tini    - PID 1 that reaps the tmux/child process tree
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      tini git tmux tar gawk python3 python3-venv sqlite3 ffmpeg \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# App code + production dependencies, owned by the image's built-in non-root
# `node` user (uid/gid 1000). State dirs are created empty and later covered by
# volume mounts (store/ holds the SQLite DB and all runtime state).
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build     /app/dist         ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node web        ./web
COPY --chown=node:node templates  ./templates
COPY --chown=node:node scripts    ./scripts
COPY --chown=node:node seed-skills ./seed-skills
RUN mkdir -p store agents workspace reports .channels-config mcp-servers \
    && chown -R node:node /app

USER node
ENV PATH=/home/node/.local/bin:$PATH

# Claude Code CLI — the agent runtime the fleet drives in tmux. Best-effort:
# an offline build still produces a usable image; install/mount at runtime then.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    || echo "WARN: claude CLI not installed at build time (offline?) — install or mount at runtime."

ENV WEB_PORT=3420
EXPOSE 3420

# Root returns 200 (or a 302 to the setup wizard) once the dashboard is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 || exit 1

# tini reaps the tmux/claude child tree; the daemon is the main process.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
