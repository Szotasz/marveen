#!/usr/bin/env bash
# HOOKSTRIPFLEET924 -- channel-image-resize.sh must actually DO its job.
#
# Two defects this guards, both measured 2026-09-24, both SILENT:
#   1. The hook parsed its JSON with `jq`, which is not installed here. With
#      2>/dev/null on the call the tool name came back empty, the hook exited 0
#      and did nothing at all -- no copy, no resize, no output, no error. That
#      is what src/__tests__/hookstripfleet-channel-hooks.test.ts:160 was red
#      about: the test was right, the behaviour was broken.
#   2. `sips` is macOS-only, so on Linux the resize never ran -- while the
#      additionalContext still claimed "auto-resized to max 1024x1024" and
#      printed identical before/after byte counts. Check 3 below is the one
#      that catches THAT, and the old test did not have it.
#
# HOOK_SCRIPT overrides the script under test (to measure before/after).
#
# Run:  bash scripts/__tests__/channel-image-resize.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="${HOOK_SCRIPT:-$ROOT/scripts/hooks/channel-image-resize.sh}"
# MUSZER-ONIGAZOLAS (HEX merte 2026-09-24): 5 of the 10 of these assertions PASS against a
# script that does not exist, because a no-op assertion is satisfied by nothing
# just as well as by correct silence. The suite cannot tell "correctly did
# nothing" from "was not there at all" -- so it must first prove its own target.
# Same principle as the positive control below, pointed the other way.
[ -x "$HOOK" ] || { echo "FATAL: the script under test is missing or not executable: $HOOK" >&2; exit 2; }

FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

# A SKIP is the right answer on a laptop without ffmpeg, and the WRONG one in
# CI: there it would exit 0 having asserted NOTHING, and the run would go green
# on a suite that never executed. That is the same false green this file exists
# to catch, one level up. So the skip is loud where it matters. GitHub Actions
# (and most runners) set CI=true; locally it is unset and nothing changes.
missing() {  # missing <what>
  if [ -n "${CI:-}" ]; then
    echo "FATAL: $1 -- required in CI, where a skipped suite asserts nothing" >&2
    exit 1
  fi
  echo "SKIP: $1"
  exit 0
}

command -v ffmpeg >/dev/null 2>&1 || missing "ffmpeg is needed to build the fixture image"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/chimgresize.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
INBOX="$SANDBOX/channels/telegram/inbox"
mkdir -p "$INBOX"

# A REAL jpeg, noisy so it cannot compress below the 500KB gate.
ffmpeg -v error -f lavfi -i "color=c=gray:s=1600x1200,noise=alls=100:allf=t+u" \
       -frames:v 1 -q:v 2 -y "$SANDBOX/fixture.jpg" 2>/dev/null
[ -s "$SANDBOX/fixture.jpg" ] || missing "could not build the fixture image"

jpeg_dims() {  # prints "W H", or nothing when the file is missing/unreadable
  [ -f "$1" ] || return 0
  python3 -c '
import struct,sys
d=open(sys.argv[1],"rb").read(); i=2
while i < len(d)-9:
    if d[i]!=0xFF: break
    m=d[i+1]; ln=struct.unpack(">H",d[i+2:i+4])[0]
    if m in (0xC0,0xC1,0xC2):
        h,w=struct.unpack(">HH",d[i+5:i+9]); print(w,h); break
    i+=2+ln
' "$1"
}
size_of() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null; }
event() { python3 -c 'import json,sys; print(json.dumps({"tool_name":sys.argv[1],"tool_input":{"file_path":sys.argv[2]}}))' "$1" "$2"; }
run_hook() { printf '%s' "$1" | bash "$HOOK" 2>"$SANDBOX/stderr.txt"; }

# --- 0. POSITIVE CONTROL on the environment -------------------------------
# If jq were installed, defect 1 would not reproduce here and checks 1-3 would
# pass for the wrong reason. State the machine's actual condition.
if command -v jq >/dev/null 2>&1; then
  echo "NOTE: jq IS installed on this host -- defect 1 cannot reproduce here."
else
  echo "NOTE: jq is absent (as on the fleet host) -- defect 1 is reproducible here."
fi

# --- 1-3. The main path: >500KB inbox image -------------------------------
IMG="$INBOX/photo.jpg"
cp "$SANDBOX/fixture.jpg" "$IMG"
BEFORE_SIZE=$(size_of "$IMG")
BEFORE_DIMS=$(jpeg_dims "$IMG")
OUT="$(run_hook "$(event Read "$IMG")")"

ok "the original is copied to inbox/original/ (the context-protection contract)" \
   "$([ -f "$INBOX/original/photo.jpg" ] && echo 0 || echo 1)" \
   "no copy; hook stderr: $(cat "$SANDBOX/stderr.txt")"

ok "additionalContext points the agent at the preserved original" \
   "$(printf '%s' "$OUT" | grep -q 'original' && echo 0 || echo 1)" "stdout: $OUT"

# THE ONE THE OLD TEST LACKED: the image must really shrink, not just be
# described as shrunk.
AFTER_DIMS=$(jpeg_dims "$IMG")
AFTER_W=${AFTER_DIMS%% *}
ok "the inbox copy is ACTUALLY resized to max 1024 wide (was ${BEFORE_DIMS// /x})" \
   "$([ -n "${AFTER_W:-}" ] && [ "$AFTER_W" -le 1024 ] && echo 0 || echo 1)" \
   "still ${AFTER_DIMS// /x}, $(size_of "$IMG")B vs ${BEFORE_SIZE}B"

ok "the preserved original keeps its full resolution" \
   "$([ "$(jpeg_dims "$INBOX/original/photo.jpg")" = "$BEFORE_DIMS" ] && echo 0 || echo 1)" \
   "original is now $(jpeg_dims "$INBOX/original/photo.jpg")"

# A message that claims a resize must only appear when one happened.
if printf '%s' "$OUT" | grep -q 'auto-resized'; then
  ok "a message claiming 'auto-resized' is only emitted when the file really shrank" \
     "$([ -n "${AFTER_W:-}" ] && [ "$AFTER_W" -le 1024 ] && echo 0 || echo 1)" \
     "claimed a resize that did not happen"
else
  ok "no resize happened and the message does NOT claim one" 0
fi

# --- 4-7. The silent paths ------------------------------------------------
BIG="$SANDBOX/plain-big.jpg"; cp "$SANDBOX/fixture.jpg" "$BIG"
ok "a non-inbox Read is a clean no-op" \
   "$([ -z "$(run_hook "$(event Read "$BIG")")" ] && echo 0 || echo 1)"

mkdir -p "$INBOX/original"
cp "$SANDBOX/fixture.jpg" "$INBOX/original/second.jpg"
ok "a Read of a file already under original/ is a no-op" \
   "$([ -z "$(run_hook "$(event Read "$INBOX/original/second.jpg")")" ] && echo 0 || echo 1)"

SMALL="$INBOX/small.jpg"; head -c 1000 "$SANDBOX/fixture.jpg" > "$SMALL"
ok "an inbox image under 500KB is left alone" \
   "$([ -z "$(run_hook "$(event Read "$SMALL")")" ] && [ ! -f "$INBOX/original/small.jpg" ] && echo 0 || echo 1)"

cp "$SANDBOX/fixture.jpg" "$INBOX/other.jpg"
ok "a non-Read tool is a no-op" \
   "$([ -z "$(run_hook "$(event Write "$INBOX/other.jpg")")" ] && echo 0 || echo 1)"

ok "malformed JSON does not crash the hook (fail-open, exit 0)" \
   "$(printf 'not json at all' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo 1)"

echo
echo "$((N-FAILS))/$N passed  (hook under test: $HOOK)"
[ "$FAILS" = "0" ] || exit 1
