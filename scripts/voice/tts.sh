#!/usr/bin/env bash
# TTS wrapper for the fleet. Synthesizes Hungarian speech and sends it as a
# Telegram voice message via the agent's own bot token.
# Usage: tts.sh <voice> <chat_id> <text...>   (voice: imre|anna|<path-to-onnx>)
# Optional env: VOICE_STATE_DIR (defaults to global telegram channel dir).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/_vtools.py" ]]; then
  DEST="$SCRIPT_DIR"
else
  DEST="$HOME/.local/share/marveen-voice"
fi
VOICE_ARG="${1:?usage: tts.sh <voice> <chat_id> <text...>}"; shift
CHAT_ID="${1:?missing chat_id}"; shift
TEXT="$*"
STATE_DIR="${VOICE_STATE_DIR:-$HOME/.claude/channels/telegram}"
case "$VOICE_ARG" in
  imre)  ONNX="$DEST/voices/hu_HU-imre-medium.onnx" ;;
  anna)  ONNX="$DEST/voices/hu_HU-anna-medium.onnx" ;;
  /*)    ONNX="$VOICE_ARG" ;;
  *)     echo "Unknown voice alias: $VOICE_ARG (use: imre, anna, or absolute path)" >&2; exit 1 ;;
esac
exec "$DEST/venv/bin/python" "$DEST/_vtools.py" speak "$ONNX" "$STATE_DIR" "$CHAT_ID" "$TEXT"
