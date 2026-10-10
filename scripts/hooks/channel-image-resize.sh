#!/bin/bash
# PreToolUse hook: auto-resize channel-received large images before Read.
# Works for any channel provider (Telegram, Slack, etc.) whose plugin
# stores received images under ~/.claude/channels/<provider>/inbox/.
#
# Protection: a >500KB image base64-encoded into the context window would
# force a /compact. Instead this hook:
#   1. Copies the original to `inbox/original/<filename>` (if not there)
#   2. Resizes the inbox copy to max 1024x1024
#   3. Reports the original path via additionalContext so the agent can
#      explicitly read full-res when needed (OCR, detail inspection).
#
# Trigger: PreToolUse hook on the Read tool. Only fires when:
#   - tool_name == "Read"
#   - file_path matches /channels/*/inbox/X.{jpg|jpeg|png|gif|webp}
#     (NOT /inbox/original/X -- originals are left alone)
#   - file_size > 500KB
#
# ---------------------------------------------------------------------------
# WHY THIS WAS REWRITTEN (2026-09-21, #1565 item 4)
#
# The old version parsed its input with `jq ... 2>/dev/null`. jq is not
# installed on this machine and is not an installer dependency, so every
# invocation produced an EMPTY tool_name, fell through `[ "$TOOL_NAME" = "Read" ]
# || exit 0`, and exited 0 with no output. Measured live: a real Read payload in,
# exit 0, nothing out. Registered, running, and doing nothing -- for weeks.
#
# The bug was not jq. The bug was `2>/dev/null`: it turned `command not found`
# into silence, and the next line turned silence into "nothing to do". The hook
# did not fail, it AGREED that it had no work. Same family as `curl` returning 0
# on a 401 and a pipeline reporting the exit code of `head`: THE COMMAND
# SUCCEEDED, THE WORK DID NOT.
#
# The second one, hidden behind the first: `sips -Z 1024 ... || true`. sips is
# macOS-only and absent here, so even with a working parser the resize was a
# no-op -- and the hook then told the agent "was ${SIZE}B, now ${NEW_SIZE}B",
# with the two numbers equal. A false claim, injected into the context the hook
# exists to protect. Three `|| true` / `2>/dev/null` swallows, three lies.
#
# So: parsing is python3 (an installer dependency, always present); every step
# that CANNOT be done is loud on stderr and exits non-zero; and nothing is
# claimed that was not measured on the file afterwards.
#
# Exit 1, not 2, on failure: for PreToolUse a 2 BLOCKS the tool call, and a
# broken resizer must never stop a Read. (Exit-code meaning per the documented
# Claude Code hook contract; not measured here.) The in-house precedent for a
# missing interpreter is the egress-gate registration in .claude/settings.json,
# which says so out loud and exits 2 -- correct there, because that one is a
# protective gate and silence would be worse than blocking. This one is not.
# ---------------------------------------------------------------------------

set -u

HOOK="channel-image-resize"
LOG_FILE="${HOME}/.claude/logs/${HOOK}.log"

# Redundant evidence, NOT the mechanism. The mechanism is stderr + a non-zero
# exit; this only survives if stderr is swallowed somewhere upstream. Its own
# failure is ignored on purpose, and this is the ONLY swallow left in the file.
log_line() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  printf '%s [%s] %s\n' "$(date -Is 2>/dev/null)" "$HOOK" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# A hook that cannot do its job must SAY SO. This is the whole point of the
# rewrite: never again exit 0 in a state that is indistinguishable from "no work".
die_loud() {
  echo "[$HOOK] HIBA: $*" >&2
  echo "[$HOOK] Ez NEM 'nincs dolgom': a hook nem tudta elvegezni a munkat," >&2
  echo "[$HOOK] es a kep VALTOZATLANUL megy be a kontextusba." >&2
  log_line "HIBA: $*"
  exit 1
}

INPUT=$(cat)

# Two lines out: tool_name, then file_path. A newline inside either value cannot
# travel this way, so the parser REFUSES it rather than silently mis-splitting.
PARSED=$(printf '%s' "$INPUT" | python3 -c '
import json, sys

try:
    doc = json.load(sys.stdin)
except Exception as exc:
    sys.stderr.write("nem ervenyes JSON: %s" % exc)
    sys.exit(3)
if not isinstance(doc, dict):
    sys.stderr.write("a legfelso szint %s, nem objektum" % type(doc).__name__)
    sys.exit(3)
tool_input = doc.get("tool_input")
if not isinstance(tool_input, dict):
    tool_input = {}
name = doc.get("tool_name") or ""
path = tool_input.get("file_path") or ""
if not isinstance(name, str) or not isinstance(path, str):
    sys.stderr.write("tool_name vagy file_path nem string")
    sys.exit(3)
if "\n" in name or "\n" in path:
    sys.stderr.write("ujsor van a tool_name/file_path erteken belul")
    sys.exit(3)
sys.stdout.write(name + "\n" + path + "\n")
' 2>&1)
PARSE_RC=$?

# python3 missing -> 127; bad JSON -> 3; anything else is still not "no work".
if [ "$PARSE_RC" -ne 0 ]; then
  die_loud "a bemenet feldolgozasa megbukott (rc=$PARSE_RC): ${PARSED:-nincs kimenet}"
fi

TOOL_NAME=$(printf '%s\n' "$PARSED" | sed -n '1p')
FILE_PATH=$(printf '%s\n' "$PARSED" | sed -n '2p')

# From here on, every `exit 0` means: the input was UNDERSTOOD and there is
# genuinely nothing to do. That is a different state from the one above.

# Csak Read tool-ra reagaljunk
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

# File leteznie kell
[ -f "$FILE_PATH" ] || exit 0

# Meret-check: csak ha >500KB
SIZE=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH" 2>/dev/null || echo 0)
if [ "$SIZE" -le 524288 ]; then
  exit 0
fi

# --- past this line there IS work, so every failure below is loud ------------

# Pick a resizer. sips is macOS, magick/convert is ImageMagick, ffmpeg is the
# installer dependency that is actually present on a Linux box (measured
# 2026-09-21: ffmpeg is the ONLY one of the four on this machine).
RESIZER=""
for cand in sips magick convert ffmpeg; do
  if command -v "$cand" >/dev/null 2>&1; then
    RESIZER="$cand"
    break
  fi
done
if [ -z "$RESIZER" ]; then
  die_loud "nincs atmeretezo eszkoz (sips, magick, convert, ffmpeg -- egyik sem). A ${SIZE}B-os kep: $FILE_PATH"
fi

INBOX_DIR=$(dirname "$FILE_PATH")
ORIG_DIR="$INBOX_DIR/original"
ORIG_PATH="$ORIG_DIR/$(basename "$FILE_PATH")"

# CONCURRENCY. Measured live 2026-09-21, and only visible once the hook stopped
# being a no-op: this script is registered TWICE -- in the project
# .claude/settings.json AND in the global ~/.claude/settings.json -- and the
# runtime fires both for the same Read, in parallel. One Read produced two
# identical additionalContext notes and two ffmpeg runs on the same file. The
# results agreed this time only because ffmpeg is deterministic; the real shape
# is a race, where one instance replaces the file while the other is still
# reading it and then writes its own result over the winner's.
# Removing the duplicate REGISTRATION is a settings decision and not mine to
# take. Making the hook survive it is.
# THE LOCK IS AN O_EXCL FILE, NOT A `mkdir` DIRECTORY, and that is a measured
# choice. The first version used the usual `mkdir` lock and STILL let two of
# three instances through, about one run in five. Measured 2026-09-21 with 30
# racers behind one fifo gate, same filesystem, same rounds, one variable moved:
#     coreutils /bin/mkdir      1-3 winners (2 of 6 rounds had more than one)
#     bash `set -C; : > file`   1 winner, 6/6
#     python os.mkdir(2)        1 winner, 6/6  (and 8/8 on tmpfs and on ext4)
# So mkdir(2) itself is atomic and the coreutils binary is not a dependable
# mutex here; the cause of that is NOT established, only the behaviour. Anything
# in the fleet that guards shared state with a `mkdir` lock is standing on the
# same measurement.
LOCK="$INBOX_DIR/.${HOOK}.lock-$(basename "$FILE_PATH")"
LOCK_TRIES=40          # x 0.2s = 8s, inside the 15s hook timeout
acquire_lock() {
  local i=0 now age
  while [ "$i" -lt "$LOCK_TRIES" ]; do
    if ( set -C; : > "$LOCK" ) 2>/dev/null; then return 0; fi
    # A lock left by a killed instance must not disable the hook forever: that
    # would be the silent no-op again, arrived at from a different direction.
    now=$(date +%s 2>/dev/null || echo 0)
    age=$(( now - $(stat -c%Y "$LOCK" 2>/dev/null || stat -f%m "$LOCK" 2>/dev/null || echo "$now") ))
    i=$((i+1))
    if [ "$age" -gt 60 ]; then
      # `continue` without the increment above would spin forever if the stale
      # lock cannot be removed (permissions, read-only dir) -- a hang inside a
      # hook, which the runtime would eventually kill with no explanation.
      rm -f "$LOCK" 2>/dev/null
      continue
    fi
    sleep 0.2
  done
  return 1
}
if ! acquire_lock; then
  die_loud "nem sikerult megszerezni a zarat (masik peldany dolgozik rajta?): $LOCK"
fi
trap 'rm -f "$LOCK" 2>/dev/null' EXIT

# Re-measure UNDER the lock. If the other instance already did the work, there is
# now genuinely nothing to do -- and that is an understood silence, not the bug.
SIZE=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH" 2>/dev/null || echo 0)
if [ "$SIZE" -le 524288 ]; then
  exit 0
fi

# Original mentes a /original/ subfolder-be (ha meg nincs ott). If this fails we
# must NOT resize: the inbox copy would become the only copy, and the note below
# would promise a full-resolution original that does not exist.
if [ ! -f "$ORIG_PATH" ]; then
  if ! mkdir -p "$ORIG_DIR" 2>/dev/null; then
    die_loud "nem sikerult letrehozni az eredeti-mappat: $ORIG_DIR"
  fi
  if ! cp "$FILE_PATH" "$ORIG_PATH" 2>/dev/null; then
    die_loud "nem sikerult felmenteni az eredetit ide: $ORIG_PATH -- NEM meretezek at"
  fi
fi

# Resize into a sibling temp file, never in place: ffmpeg cannot read and write
# the same file, and an in-place failure would destroy the inbox copy. The temp
# name KEEPS THE EXTENSION, because magick and ffmpeg infer the format from it.
TMP_OUT="$INBOX_DIR/.${HOOK}-$$-$(basename "$FILE_PATH")"
case "$RESIZER" in
  sips)
    cp "$FILE_PATH" "$TMP_OUT" 2>/dev/null && sips -Z 1024 "$TMP_OUT" >/dev/null 2>&1
    ;;
  magick)
    magick "$FILE_PATH" -resize '1024x1024>' "$TMP_OUT" >/dev/null 2>&1
    ;;
  convert)
    convert "$FILE_PATH" -resize '1024x1024>' "$TMP_OUT" >/dev/null 2>&1
    ;;
  ffmpeg)
    ffmpeg -y -loglevel error -i "$FILE_PATH" \
      -vf "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease" \
      "$TMP_OUT" >/dev/null 2>&1
    ;;
esac
RESIZE_RC=$?

if [ "$RESIZE_RC" -ne 0 ] || [ ! -s "$TMP_OUT" ]; then
  rm -f "$TMP_OUT" 2>/dev/null
  die_loud "$RESIZER nem tudta atmeretezni (rc=$RESIZE_RC): $FILE_PATH"
fi

NEW_SIZE=$(stat -c%s "$TMP_OUT" 2>/dev/null || stat -f%z "$TMP_OUT" 2>/dev/null || echo 0)

# Not shrinking is not a malfunction -- a small-dimensioned but heavy image is a
# real thing. It is only a lie if we then claim we shrank it. Keep the original
# bytes, say what actually happened, and let the agent decide.
if [ "$NEW_SIZE" -ge "$SIZE" ]; then
  rm -f "$TMP_OUT" 2>/dev/null
  echo "[$HOOK] $FILE_PATH: az atmeretezes NEM csokkentette a meretet (${SIZE}B -> ${NEW_SIZE}B), az eredeti maradt" >&2
  log_line "nincs nyereseg: $FILE_PATH ${SIZE}B -> ${NEW_SIZE}B, eredeti megtartva"
  NEW_SIZE="$SIZE"
  RESIZED="no"
else
  if ! mv -f "$TMP_OUT" "$FILE_PATH" 2>/dev/null; then
    rm -f "$TMP_OUT" 2>/dev/null
    die_loud "az atmeretezett fajl nem irhato vissza ide: $FILE_PATH"
  fi
  RESIZED="yes"
fi

echo "[$HOOK] $FILE_PATH: ${SIZE}B -> ${NEW_SIZE}B ($RESIZER, resized=$RESIZED); original kept at $ORIG_PATH" >&2
log_line "ok: $FILE_PATH ${SIZE}B -> ${NEW_SIZE}B ($RESIZER, resized=$RESIZED)"

# The JSON is built by python3, not by string interpolation: a path containing a
# quote or a backslash would otherwise emit malformed JSON, which the runtime
# would drop -- silently, which is the failure this whole file is about.
RESIZED="$RESIZED" RESIZER="$RESIZER" SIZE="$SIZE" NEW_SIZE="$NEW_SIZE" \
ORIG_PATH="$ORIG_PATH" python3 -c '
import json, os, sys

if os.environ["RESIZED"] == "yes":
    note = (
        "Note: this channel-received image was auto-resized to max 1024x1024 to "
        "protect the context window (was %sB, now %sB, via %s). The full-resolution "
        "original is preserved at: %s -- Read that path if you need detailed "
        "analysis (OCR, fine detail inspection, image editing pre-process)."
        % (os.environ["SIZE"], os.environ["NEW_SIZE"], os.environ["RESIZER"], os.environ["ORIG_PATH"])
    )
else:
    note = (
        "Note: this channel-received image is %sB and resizing did NOT reduce it "
        "(%s produced a file that was not smaller), so the ORIGINAL bytes are being "
        "read. Expect a large context cost. A copy is also at: %s"
        % (os.environ["SIZE"], os.environ["RESIZER"], os.environ["ORIG_PATH"])
    )
json.dump(
    {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}},
    sys.stdout,
)
sys.stdout.write("\n")
' || die_loud "a hook kimeneti JSON-jat nem sikerult eloallitani"

exit 0
