#!/usr/bin/env bash
# STT wrapper for the fleet. Transcribes a Telegram voice message (Hungarian).
# Usage: stt.sh <file_id> [state_dir]
# state_dir defaults to the agent's own telegram channel dir (cwd-based) or global.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || echo "$HOME/.local/share/marveen-voice")"
# When installed to INSTALL_DIR, the parent is INSTALL_DIR itself.
# Detect: if _vtools.py is in the same dir as this script, use that dir.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/_vtools.py" ]]; then
  DEST="$SCRIPT_DIR"
fi
FID="${1:?usage: stt.sh <file_id> [state_dir]}"
STATE_DIR="${2:-$HOME/.claude/channels/telegram}"
exec "$DEST/venv/bin/python" "$DEST/_vtools.py" transcribe "$FID" "$STATE_DIR"
