#!/usr/bin/env bash
# TTS wrapper for the fleet. Synthesizes Hungarian speech and sends it as a
# Telegram voice message via the agent's own bot token.
# Usage: tts.sh <voice> <chat_id> <text...>   (voice: imre|anna|<path-to-onnx>)
# Optional env: VOICE_STATE_DIR (defaults to global telegram channel dir).
set -euo pipefail
# Prefer a toolkit dir that has BOTH _vtools.py AND a usable venv. The source
# tree (scripts/voice) has _vtools.py but no venv -> fall back to the installed
# toolkit at ~/.local/share/marveen-voice which carries the venv.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${MARVEEN_VOICE_DIR:-$HOME/.local/share/marveen-voice}"
if [[ -f "$SCRIPT_DIR/_vtools.py" && -x "$SCRIPT_DIR/venv/bin/python" ]]; then
  DEST="$SCRIPT_DIR"
else
  DEST="$INSTALL_DIR"
fi
VOICE_ARG="${1:?usage: tts.sh <voice> <chat_id> <text...>}"; shift
CHAT_ID="${1:?missing chat_id}"; shift
TEXT="$*"
# #915: env overrides, then install-scoped once migrated, then legacy shared.
STATE_DIR="${VOICE_STATE_DIR:-${TELEGRAM_STATE_DIR:-}}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.claude/channels/telegram"
  [ -f "$STATE_DIR/.env" ] || STATE_DIR="$HOME/.claude/channels/telegram"
fi
case "$VOICE_ARG" in
  imre)  ONNX="$DEST/voices/hu_HU-imre-medium.onnx" ;;
  anna)  ONNX="$DEST/voices/hu_HU-anna-medium.onnx" ;;
  /*)    ONNX="$VOICE_ARG" ;;
  *)     echo "Unknown voice alias: $VOICE_ARG (use: imre, anna, or absolute path)" >&2; exit 1 ;;
esac
exec "$DEST/venv/bin/python" "$DEST/_vtools.py" speak "$ONNX" "$STATE_DIR" "$CHAT_ID" "$TEXT"
