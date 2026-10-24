#!/bin/bash
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"
SESSION="${MAIN_AGENT_ID:-marveen}-channels"
export MARVEEN_CODEX_TELEGRAM_PLUGIN="${MARVEEN_CODEX_TELEGRAM_PLUGIN:-$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts}"
# Pane mode is shared by cold start and dashboard recovery. It deliberately
# owns no tmux lifecycle, so pane recovery replaces only this channel process.
if [ "${1:-}" = "--pane" ]; then
  exec node scripts/codex-channels.mjs
fi
# Validate login before taking over the old tmux session.
node scripts/codex-channels.mjs --preflight
tmux kill-session -t "=$SESSION:" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "env MARVEEN_CODEX_TELEGRAM_PLUGIN='$MARVEEN_CODEX_TELEGRAM_PLUGIN' /bin/bash '$INSTALL_DIR/scripts/codex-channels.sh' --pane"
trap 'tmux kill-session -t "=$SESSION:" 2>/dev/null || true; exit 0' TERM INT
while tmux has-session -t "=$SESSION:" 2>/dev/null; do sleep 5; done
exit 1
