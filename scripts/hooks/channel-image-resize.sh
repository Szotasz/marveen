#!/bin/bash
# PreToolUse hook: auto-resize channel-received large images before Read.
# Works for any channel provider (Telegram, Slack, etc.) whose plugin
# stores received images under ~/.claude/channels/<provider>/inbox/.
#
# Protection: a >500KB image base64-encoded into the context window would
# force a /compact. Instead this hook:
#   1. Copies the original to `inbox/original/<filename>` (if not there)
#   2. Resizes the inbox copy to max 1024x1024 (sips on macOS, ffmpeg elsewhere)
#   3. Reports the original path via additionalContext so the agent can
#      explicitly read full-res when needed (OCR, detail inspection).
#
# Trigger: PreToolUse hook on the Read tool. Only fires when:
#   - tool_name == "Read"
#   - file_path matches /channels/*/inbox/X.{jpg|jpeg|png|gif|webp}
#     (NOT /inbox/original/X -- originals are left alone)
#   - file_size > 500KB
#
# HOOKSTRIPFLEET924 -- two measured defects, both silent, fixed together:
#
#   1. The JSON was parsed with `jq`, which is NOT installed on this machine.
#      With `2>/dev/null` on the call, TOOL_NAME came back empty, the very next
#      line exited 0, and the hook did NOTHING -- no copy, no resize, no output,
#      no error. Measured 2026-09-24: the original was not written, which is
#      what src/__tests__/hookstripfleet-channel-hooks.test.ts:160 was red
#      about. The test was right; the behaviour was broken. python3 is a hard
#      dependency of this install and is used by the other hooks, so it parses.
#
#   2. `sips` is macOS-only. On Linux the resize never happened, yet the
#      additionalContext still told the agent the image "was auto-resized to
#      max 1024x1024" and printed identical before/after byte counts. A hook
#      that reports work it did not do is worse than one that does nothing.
#      ffmpeg (present here) is used when sips is absent, and when NEITHER is
#      available the message now says so instead of claiming a resize.
set -u

INPUT=$(cat)

# jq is not installed on every install; python3 is. Read both fields in ONE
# pass so a malformed payload cannot yield a half-parsed event.
FIELDS=$(printf '%s' "$INPUT" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
if not isinstance(d,dict): d={}
ti=d.get("tool_input") if isinstance(d.get("tool_input"),dict) else {}
def s(v): return v if isinstance(v,str) else ""
print(s(d.get("tool_name")))
print(s(ti.get("file_path")))
' 2>/dev/null) || exit 0
TOOL_NAME=$(printf '%s\n' "$FIELDS" | sed -n '1p')
FILE_PATH=$(printf '%s\n' "$FIELDS" | sed -n '2p')

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
# The copy is the context-protection contract: without it the full-res image is
# gone once the inbox copy is resized. If it did not land, resize NOTHING.
if [ ! -f "$ORIG_PATH" ]; then
  echo "[channel-image-resize] could not preserve original at $ORIG_PATH; leaving $FILE_PATH untouched" >&2
  exit 0
fi

# Resize max 1024x1024 (the longer side becomes 1024, aspect ratio kept).
# sips on macOS, ffmpeg everywhere else. RESIZED records what actually happened,
# so the message below can never claim work that did not occur.
RESIZED=0
if command -v sips >/dev/null 2>&1; then
  sips -Z 1024 "$FILE_PATH" >/dev/null 2>&1 && RESIZED=1
elif command -v ffmpeg >/dev/null 2>&1; then
  # The temp name MUST keep the original extension: ffmpeg picks its muxer
  # from it. Measured 2026-09-24 -- with "photo.jpg.resize.1234" it stops at
  # "Unable to choose an output format", writes nothing, and the resize
  # silently does not happen. Same class of defect as the sips one above.
  TMP_OUT="${FILE_PATH%.*}.resize.$$.${FILE_PATH##*.}"
  if ffmpeg -v error -i "$FILE_PATH" \
       -vf "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease" \
       -y "$TMP_OUT" >/dev/null 2>&1 && [ -s "$TMP_OUT" ]; then
    mv "$TMP_OUT" "$FILE_PATH" && RESIZED=1
  fi
  rm -f "$TMP_OUT" 2>/dev/null || true
fi

NEW_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null || echo 0)

if [ "$RESIZED" = "1" ]; then
  NOTE="Note: this channel-received image was auto-resized to max 1024x1024 to protect the context window (was ${SIZE}B, now ${NEW_SIZE}B). The full-resolution original is preserved at: $ORIG_PATH -- Read that path if you need detailed analysis (OCR, fine detail inspection, image editing pre-process)."
  echo "[channel-image-resize] $FILE_PATH: ${SIZE}B -> ${NEW_SIZE}B; original kept at $ORIG_PATH" >&2
else
  NOTE="Note: this channel-received image is ${SIZE}B and could NOT be resized (no sips or ffmpeg on this host), so reading it will cost the full image in context. A copy is preserved at: $ORIG_PATH."
  echo "[channel-image-resize] $FILE_PATH: ${SIZE}B, NOT resized (no sips/ffmpeg); original kept at $ORIG_PATH" >&2
fi

NOTE="$NOTE" python3 -c '
import json,os
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":os.environ["NOTE"]}}, ensure_ascii=False, indent=2))
'

exit 0
