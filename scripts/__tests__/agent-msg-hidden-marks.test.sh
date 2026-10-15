#!/usr/bin/env bash
# c4e47223 (3) -- the send route WARNS about marks nobody can see, and still sends.
#
# WHAT THIS GUARDS. The homoglyph gate in front of the send (MSGGATE924,
# agent-msg-homoglyph.test.sh) refuses a Latin word with a Cyrillic or Greek
# letter in it. It does not look at the other invisible class: zero-width and
# other format characters, the no-break and typographic spaces, U+2028/U+2029,
# control characters. Measured 2026-09-30 on the live helper: a zero-width
# space, a no-break space and an em dash all went out with rc 0 and no word.
# They read right and match nothing, same as a homoglyph.
#
# THE DECISION FOR THIS CLASS IS A WARNING (c4e47223, 2026-09-30): the
# marks are named by code point and position on stderr, and the text is sent
# UNCHANGED. So every case below asserts both halves: curl WAS called with the
# original text, AND the warning is there (or, for clean text, is not).
#
# Run:  bash scripts/__tests__/agent-msg-hidden-marks.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HELPER="${HELPER_BIN:-$ROOT/scripts/agent-msg.sh}"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

[ -r "$HELPER" ] || { echo "FATAL: the helper is missing: $HELPER" >&2; exit 2; }
[ -r "$ROOT/scripts/lib/hidden_marks.py" ] || { echo "FATAL: the sweep is missing" >&2; exit 2; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/hiddenmarks.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
printf 'test-token\n' > "$SANDBOX/token"

# curl stub: nothing leaves the machine, and the call is RECORDED, so "it was
# sent" is a measured claim, and so is WHAT was sent.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${CURL_CALLS:-/dev/null}"
printf '{"id":4343}\n200'
STUB
chmod +x "$BIN/curl"
for t in python3 sed tail cat printf date mktemp rm; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN/$t"
done

ch() { python3 -c 'import sys; sys.stdout.write(chr(int(sys.argv[1], 16)))' "$1"; }
send() {
  : > "$SANDBOX/calls.txt"
  OUT="$(env PATH="$BIN:$PATH" CURL_CALLS="$SANDBOX/calls.txt" \
             MARVEEN_TOKEN_FILE="$SANDBOX/token" ${ENVX:-} \
             /bin/bash "$HELPER" igor hex "$1" 2>"$SANDBOX/err.txt")"
  RC=$?
  ERR="$(cat "$SANDBOX/err.txt")"
  CALLED="$([ -s "$SANDBOX/calls.txt" ] && echo yes || echo no)"
}
sent_ok() { [ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && printf '%s' "$OUT" | grep -q 'id=4343'; }
# The report must name the mark by code point and must NOT carry the mark itself.
raw_in_err() { printf '%s' "$ERR" | python3 -c 'import sys; t=sys.stdin.read(); sys.exit(0 if sys.argv[1] in t else 1)' "$1"; }

# POSITIVE CONTROL: clean text is sent and draws no warning. Without this, a
# sweep that warns on everything would pass every case below.
ENVX= send "tiszta magyar szoveg, arvizturo tukorfurogep -- tabbal	es ujsorral
masodik sor"
ok "clean text (with tab and newline) is sent" "$(sent_ok && echo 0 || echo 1)" "rc=$RC called=$CALLED"
ok "  ...and draws no warning" "$(printf '%s' "$ERR" | grep -q 'FIGYELEM' && echo 1 || echo 0)" "stderr: $ERR"

ZW="$(ch 200B)"
ENVX= send "keres${ZW}heto szo"
ok "a zero-width space is SENT (warning only)" "$(sent_ok && echo 0 || echo 1)" "rc=$RC called=$CALLED"
ok "  ...and the warning names U+200B" "$(printf '%s' "$ERR" | grep -q '<U+200B> ZERO WIDTH SPACE' && echo 0 || echo 1)" "stderr: $ERR"
ok "  ...with its position (line 1, column 6)" "$(printf '%s' "$ERR" | grep -q '1. sor, 6. oszlop' && echo 0 || echo 1)" "stderr: $ERR"
ok "  ...and the warning does not carry the mark itself" "$(raw_in_err "$ZW" && echo 1 || echo 0)"
# What goes out is the text the sender typed: json.dumps writes the mark as \u200b.
ok "  ...and the text went out UNCHANGED" "$(grep -qF '\u200b' "$SANDBOX/calls.txt" && echo 0 || echo 1)"

for cp in 00A0 202F 2028 2029 0085 00AD FEFF 202E 2060; do
  M="$(ch $cp)"
  ENVX= send "elotte${M}utana"
  ok "U+$cp is sent and warned about" \
     "$(sent_ok && printf '%s' "$ERR" | grep -q "U+$cp" && echo 0 || echo 1)" "rc=$RC called=$CALLED stderr: $ERR"
done

# Position on a later line: the column counts characters, not bytes.
ENVX= send "elso sor
ab${ZW}cd"
ok "the position counts lines and characters (line 2, column 3)" "$(printf '%s' "$ERR" | grep -q '2. sor, 3. oszlop' && echo 0 || echo 1)" "stderr: $ERR"

# An emoji ZWJ sequence is what the joiner is for: no warning.
EMO="$(ch 1F468)$(ch 200D)$(ch 1F4BB)"
ENVX= send "worker $EMO kesz"
ok "an emoji ZWJ sequence is sent without a warning" "$(sent_ok && ! printf '%s' "$ERR" | grep -q 'FIGYELEM' && echo 0 || echo 1)" "stderr: $ERR"
# ...but the same joiner between two letters is the invisible kind.
ENVX= send "ab$(ch 200D)cd"
ok "  ...while a joiner between letters is warned about" "$(printf '%s' "$ERR" | grep -q 'U+200D' && echo 0 || echo 1)" "stderr: $ERR"

# THE EXISTING REFUSAL IS UNCHANGED, AND IT RUNS FIRST: a mixed-script word is
# still refused with nothing sent, whatever else the text carries.
CY="$(ch 043E)"
ENVX= send "sz${CY}veg es ${ZW} jel"
ok "a mixed-script word is still REFUSED (rc 3), nothing sent" "$([ "$RC" = "3" ] && [ "$CALLED" = "no" ] && echo 0 || echo 1)" "rc=$RC called=$CALLED"

# A warn-only step must never be the reason a message did not arrive.
ENVX="MARVEEN_HIDDEN_MARKS_BIN=$SANDBOX/none.py" send "szoveg${ZW}jellel"
ok "a missing sweep: sent, and it says so" "$(sent_ok && printf '%s' "$ERR" | grep -q 'hidden-mark sweep not found' && echo 0 || echo 1)" "rc=$RC stderr: $ERR"
printf 'import sys\nsys.exit(7)\n' > "$SANDBOX/crash.py"
ENVX="MARVEEN_HIDDEN_MARKS_BIN=$SANDBOX/crash.py" send "szoveg${ZW}jellel"
ok "a crashing sweep: sent, and it says so" "$(sent_ok && printf '%s' "$ERR" | grep -q 'hidden-mark sweep failed (rc=7)' && echo 0 || echo 1)" "rc=$RC stderr: $ERR"

echo "---- $((N-FAILS))/$N passed"
[ "$FAILS" = "0" ]
