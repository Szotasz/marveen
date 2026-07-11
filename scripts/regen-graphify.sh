#!/bin/bash
# regen-graphify.sh -- rebuild the Graphify knowledge-graph HTML for the dashboard.
#
# The dashboard "Graphify" panel serves web/icons/graphify-graph.html, which is
# gitignored (a ~2.5MB generated artifact, see .gitignore). After a fresh
# checkout/deploy that file is missing, so the iframe would 404. This script
# regenerates it from the current src/ using tree-sitter AST (zero API cost),
# plus local ollama community naming when available.
#
# Best-effort and idempotent: if graphify or its inputs are absent it exits 0
# without touching anything, so it NEVER breaks a deploy. Re-uses the graphify
# extract cache under store/ so repeat runs only re-parse changed files.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$PROJECT_ROOT/src"
DEST="$PROJECT_ROOT/web/icons/graphify-graph.html"
WORK="$PROJECT_ROOT/store/graphify-work"
OLLAMA_MODEL="qwen2.5-coder:7b"

# graphify installs as a uv tool under ~/.local/bin; make sure it is on PATH.
export PATH="$HOME/.local/bin:$PATH"
# Do not spam ~/.cache/graphify-queries.log during an unattended deploy run.
export GRAPHIFY_QUERY_LOG_DISABLE=1

# --- Graceful skips: never fail a deploy just because graphify is absent. -----
if ! command -v graphify >/dev/null 2>&1; then
  echo "regen-graphify: graphify not installed (uv tool install graphifyy) -- skipping."
  exit 0
fi
if [ ! -d "$SRC_DIR" ]; then
  echo "regen-graphify: $SRC_DIR missing -- skipping."
  exit 0
fi

mkdir -p "$WORK"

# --- 1. Index the codebase: local tree-sitter AST only, no API key, no cost. --
echo "regen-graphify: indexing $SRC_DIR (code-only, tree-sitter AST)..."
if ! graphify extract "$SRC_DIR" --code-only --out "$WORK" >/dev/null 2>&1; then
  echo "regen-graphify: extract failed -- keeping the existing graph."
  exit 1
fi

# --- 2. Build graph.html. Prefer local ollama naming (zero cost); fall back ---
#        to placeholder community names if ollama or the model is unavailable.
if curl -fsS -m 3 -o /dev/null http://localhost:11434/api/tags 2>/dev/null \
   && curl -fsS -m 3 http://localhost:11434/api/tags 2>/dev/null | grep -q "$OLLAMA_MODEL"; then
  echo "regen-graphify: naming communities via local ollama ($OLLAMA_MODEL)..."
  graphify label "$WORK" --backend=ollama --model="$OLLAMA_MODEL" >/dev/null 2>&1 \
    || graphify cluster-only "$WORK" --no-label >/dev/null 2>&1
else
  echo "regen-graphify: ollama/$OLLAMA_MODEL unavailable -- placeholder community names."
  graphify cluster-only "$WORK" --no-label >/dev/null 2>&1
fi

# --- 3. Publish the freshly built graph to the dashboard-served location. -----
GRAPH_HTML="$WORK/graphify-out/graph.html"
if [ ! -s "$GRAPH_HTML" ]; then
  echo "regen-graphify: graph.html not produced -- keeping the existing graph."
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
cp "$GRAPH_HTML" "$DEST"
echo "regen-graphify: updated $DEST ($(du -h "$DEST" | cut -f1))."
exit 0
