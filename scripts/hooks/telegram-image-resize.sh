#!/bin/bash
# PreToolUse hook: auto-resize Telegram-fogadott nagy képeket a Read tool előtt
# Védelem: ha egy >500KB Telegram-fogadott kép kerülne a Marveen session-be, a
# base64-encoded representation megtelítheti a context window-t és /compact-ot
# kényszerítene. Helyette ez a hook:
#   1. Az eredetit átmenti `inbox/original/<filename>` alá (ha még nem ott van)
#   2. Az inbox-beli path-ra resize-ol max 1024x1024-re (sips macOS native)
#   3. additionalContext-en át értesíti az ágenst az eredeti pathról, hogy ha
#      részletes elemzés kell (OCR, részletek olvasása, edit-pre-process),
#      tudatosan tudjon az eredetihez nyúlni.
#
# Hatás: minden Marveen-szerű ágens automatikusan védve van az óriás-image-
# context-megtelítéstől, DE ha kell a full-res original, megtalálja az
# `inbox/original/`-ban.
#
# Trigger: PreToolUse hook a Read tool-ra. Csak akkor reagál ha:
#   - tool_name == "Read"
#   - file_path egy /channels/telegram/inbox/X.{jpg|jpeg|png|gif|webp} (de NEM
#     /inbox/original/X — ott az eredeti, hagyjuk békén)
#   - file_size > 500KB

set -u

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# Csak Read tool-ra reagáljunk
[ "$TOOL_NAME" = "Read" ] || exit 0

# Ha a path már a `original/` subfolder-be mutat, hagyjuk békén — az ágens
# explicit kért teljes felbontást.
case "$FILE_PATH" in
  */channels/telegram/inbox/original/*) exit 0 ;;
esac

# Csak Telegram inbox-ban lévő képekre (top-level)
case "$FILE_PATH" in
  */channels/telegram/inbox/*.jpg|*/channels/telegram/inbox/*.jpeg|\
  */channels/telegram/inbox/*.png|*/channels/telegram/inbox/*.gif|\
  */channels/telegram/inbox/*.webp) ;;
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

# Stderr log a Marveen-pane-be (debug)
echo "[telegram-image-resize] $FILE_PATH: ${SIZE}B → ${NEW_SIZE}B; original kept at $ORIG_PATH" >&2

# additionalContext: tájékoztatja a Claude-ot hogy van full-res original is
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Note: this Telegram-received image was auto-resized to max 1024x1024 to protect the context window (was ${SIZE}B, now ${NEW_SIZE}B). The full-resolution original is preserved at: $ORIG_PATH — Read that path if you need detailed analysis (OCR, fine detail inspection, image editing pre-process)."
  }
}
EOF

exit 0
