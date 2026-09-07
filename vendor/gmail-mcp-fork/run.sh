#!/usr/bin/env bash
# Launcher for the vendored Gmail MCP fork (see VENDOR.md).
# Self-healing: prod deps installed on first run; config dir defaults to the
# v2 path so the parallel-run phase NEVER touches the live ~/.gmail-mcp of
# the current MCP (Marveen's condition, 2026-09-07: separate dir even for
# the same account, so rollback stays one step and token files cannot
# cross-write).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
if [ ! -d node_modules ]; then
  npm ci --omit=dev --silent
fi
export GMAIL_OAUTH_PATH="${GMAIL_OAUTH_PATH:-$HOME/.gmail-mcp-v2/gcp-oauth.keys.json}"
export GMAIL_CREDENTIALS_PATH="${GMAIL_CREDENTIALS_PATH:-$HOME/.gmail-mcp-v2/credentials.json}"
exec node dist/index.js "$@"
