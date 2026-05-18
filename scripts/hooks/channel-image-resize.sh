#!/bin/bash
# PreToolUse hook: auto-resize channel-received large images before Read.
# Works for any channel provider (Telegram, Slack, etc.) whose plugin
# stores received images under ~/.claude/channels/<provider>/inbox/.
#
# Protection: a >500KB image base64-encoded into the context window would
# force a /compact. Instead this hook:
#   1. Copies the original to `inbox/original/<filename>` (if not there)
#   2. Resizes the inbox copy to max 1024x1024 (sips on macOS)
#   3. Reports the original path via additionalContext so the agent can
#      explicitly read full-res when needed (OCR, detail inspection).
#
# Trigger: PreToolUse hook on the Read tool. Only fires when:
#   - tool_name == "Read"
#   - file_path matches /channels/*/inbox/X.{jpg|jpeg|png|gif|webp}
#     (NOT /inbox/original/X -- originals are left alone)
#   - file_size > 500KB

set -u

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# Csak Read tool-ra reagáljunk
[ "$TOOL_NAME" = "Read" ] || exit 0

# Skip if path is already in the `original/` subfolder
case "$FILE_PATH" in
  */channels/*/inbox/original/*) exit 0 ;;
esac

# Match any channel provider inbox image (top-level only)
case "$FILE_PATH" in
  */channels/*/inbox/*.jpg|*/channels/*/inbox/*.jpeg|\
  */channels/*/inbox/*.png|*/channels/*/inbox/*.gif|\
  */channels/*/inbox/*.webp) ;;
  *) exit 0 ;;
esac

# File léteznie kell
[ -f "$FILE_PATH" ] || exit 0

# Méret-check: csak ha >500KB
SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)
if [ "$SIZE" -le 524288 ]; then
  exit 0
fi

# Original mentés a /original/ subfolder-be (ha még nincs ott)
INBOX_DIR=$(dirname "$FILE_PATH")
ORIG_DIR="$INBOX_DIR/original"
mkdir -p "$ORIG_DIR" 2>/dev/null
ORIG_PATH="$ORIG_DIR/$(basename "$FILE_PATH")"
if [ ! -f "$ORIG_PATH" ]; then
  cp "$FILE_PATH" "$ORIG_PATH" 2>/dev/null || true
fi

# Resize sips-pal max 1024x1024 (a nagyobb oldal lesz 1024, arány marad)
sips -Z 1024 "$FILE_PATH" >/dev/null 2>&1 || true

NEW_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)

# Debug log
echo "[channel-image-resize] $FILE_PATH: ${SIZE}B -> ${NEW_SIZE}B; original kept at $ORIG_PATH" >&2

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Note: this channel-received image was auto-resized to max 1024x1024 to protect the context window (was ${SIZE}B, now ${NEW_SIZE}B). The full-resolution original is preserved at: $ORIG_PATH -- Read that path if you need detailed analysis (OCR, fine detail inspection, image editing pre-process)."
  }
}
EOF

exit 0
