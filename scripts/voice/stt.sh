#!/usr/bin/env bash
# STT wrapper for the fleet. Transcribes a Telegram voice message (Hungarian).
# Usage: stt.sh <file_id> [state_dir]
# state_dir defaults to the agent's own telegram channel dir (cwd-based) or global.
set -euo pipefail
# Resolve the toolkit dir (must contain BOTH _vtools.py AND a usable venv).
# The source tree (scripts/voice) has _vtools.py but NO venv -- the venv lives
# in the installed toolkit at ~/.local/share/marveen-voice. Prefer whichever dir
# has both, so the source-tree wrapper falls back to the installed venv.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${MARVEEN_VOICE_DIR:-$HOME/.local/share/marveen-voice}"
if [[ -f "$SCRIPT_DIR/_vtools.py" && -x "$SCRIPT_DIR/venv/bin/python" ]]; then
  DEST="$SCRIPT_DIR"
elif [[ -f "$INSTALL_DIR/_vtools.py" && -x "$INSTALL_DIR/venv/bin/python" ]]; then
  DEST="$INSTALL_DIR"
else
  DEST="$INSTALL_DIR"
fi
FID="${1:?usage: stt.sh <file_id> [state_dir]}"
# #915: arg, then env override, then install-scoped once migrated, then legacy.
STATE_DIR="${2:-${TELEGRAM_STATE_DIR:-}}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.claude/channels/telegram"
  [ -f "$STATE_DIR/.env" ] || STATE_DIR="$HOME/.claude/channels/telegram"
fi
exec "$DEST/venv/bin/python" "$DEST/_vtools.py" transcribe "$FID" "$STATE_DIR"
