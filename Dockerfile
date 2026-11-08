# syntax=docker/dockerfile:1.7
#
# Marveen container image (HOSTINGERDOCKER1107). Based on the multi-stage build of #867 by vectorkovacspeter.
#
# Layout:
#   /opt/marveen-image  the code of this image (read-only for the app); never run from here.
#   /opt/marveen        the install dir, a VOLUME. docker/code-sync.sh copies the code from /opt/marveen-image into it
#                       when the image changes (atomic, verified against the build manifest), so every path is the same
#                       as on a normal install. The state (.env, store/, agents/, workspace/, ...) lives next to it.
#   /home/marveen       HOME, a VOLUME (~/.claude, ~/.claude.json, the channel plugin).
# The claude CLI and bun are installed npm-global into /usr/local, outside both volumes, so a new image really brings
# a new CLI; the in-container self-update is off (MARVEEN_DEPLOYMENT=docker, scripts/channels.sh).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# build: all deps (with the native toolchain for better-sqlite3), tsc -> dist/
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# DOCKERSEEDREFRESH1108: no gitignored file of the seed dirs ships (a skill's ignored secrets, e.g. fleet-helper's
# mail_rules.json / .dashboard-token, from a build context that holds them): first-boot copies those dirs whole and the
# seed refresh adds their files. HERE, in the build stage, right after the context is copied: the runtime stage copies
# only this stage's final /src, so a file removed here is in no shipped layer (a removal in a later runtime RUN would only
# hide it in an upper layer, its bytes still in the image). The ignore rules are git's own (every nested .gitignore),
# read through a throwaway GIT_DIR removed in the same step, so no .git reaches /src.
RUN cd /src && g="$(mktemp -d)" \
    && git --git-dir="$g" --work-tree=. init -q \
    && git --git-dir="$g" --work-tree=. ls-files -z --others --ignored --exclude-standard -- seed-skills skills seed-scheduled-tasks scheduled-tasks templates i18n > "$g.list" \
    && xargs -0 -r rm -f -- < "$g.list" \
    && rm -rf "$g" "$g.list"
ARG MARVEEN_COMMIT=""
RUN npm run build \
    && if printf '%s' "$MARVEEN_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then printf '%s\n' "$MARVEEN_COMMIT" > dist/.built-commit; fi \
    && npm prune --omit=dev

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false

# Runtime tools (see the installer inventory): tmux runs the agents, git/curl/lsof/python3 are called by the scripts and
# hooks, ffmpeg serves the voice features, sqlite3 the maintenance scripts; tini is PID 1, supervisor replaces the
# systemd user units of the Linux install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini supervisor tmux git curl lsof python3 ffmpeg sqlite3 ca-certificates procps tzdata \
    && rm -rf /var/lib/apt/lists/*

# Pinned agent runtime: the claude CLI (npm-global, /usr/local/bin/claude) and bun (the Telegram/Discord channel
# plugins run on it). A new version is a new image.
ARG CLAUDE_CODE_VERSION=2.1.311
ARG BUN_VERSION=1.4.4
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "bun@${BUN_VERSION}" \
    && claude --version && bun --version

# The managed policy the Linux installer writes with sudo (scripts/ensure-managed-channels-enabled.sh): without
# channelsEnabled, claude-code drops inbound channel messages on Team/Enterprise orgs.
RUN mkdir -p /etc/claude-code \
    && printf '%s\n' '{"channelsEnabled": true, "allowedChannelPlugins": [{"plugin": "telegram", "marketplace": "claude-plugins-official"}, {"plugin": "discord", "marketplace": "claude-plugins-official"}, {"plugin": "slack-channel", "marketplace": "marveen-marketplace"}]}' \
       > /etc/claude-code/managed-settings.json \
    && chmod 0644 /etc/claude-code/managed-settings.json

# The non-root user (claude refuses --dangerously-skip-permissions as root). The image's own `node` user (uid 1000) is
# renamed, so the uid stays 1000.
RUN usermod -l marveen -d /home/marveen -m node && groupmod -n marveen node \
    && mkdir -p /opt/marveen /home/marveen && chown marveen:marveen /opt/marveen /home/marveen && chmod 0700 /home/marveen

COPY --from=build --chown=root:root /src /opt/marveen-image
COPY --chown=root:root docker/ /opt/marveen-docker/
# The build manifest: every code file and its hash. code-sync.sh compares it before and verifies the copy after.
RUN cd /opt/marveen-image && find . -type f -o -type l | LC_ALL=C sort | while IFS= read -r f; do \
      if [ -L "$f" ]; then printf 'L %s %s\n' "$(readlink "$f")" "$f"; else printf 'F %s %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; fi; \
    done > /opt/marveen-docker/image.manifest \
    && sha256sum /opt/marveen-docker/image.manifest | cut -d' ' -f1 > /opt/marveen-docker/image.id \
    && chmod -R a+rX /opt/marveen-image /opt/marveen-docker && chmod 0755 /opt/marveen-docker/*.sh

USER marveen
ENV HOME=/home/marveen \
    MARVEEN_DEPLOYMENT=docker \
    PATH=/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    TERM=xterm-256color
WORKDIR /opt/marveen
VOLUME ["/opt/marveen", "/home/marveen"]
EXPOSE 3420

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${WEB_PORT:-3420}/" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/marveen-docker/entrypoint.sh"]
