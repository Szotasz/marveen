#!/usr/bin/env bash
# MSGGATE924 -- the mandated send route must not carry invisible letters.
#
# WHAT THIS GUARDS. A Cyrillic letter inside a Hungarian word is invisible and
# breaks every later search for that word: the text looks right and matches
# nothing. Measured 2026-09-24 across three agents: two had built a private
# wrapper with this check, independently, because both had been bitten; the
# third had none. And no CLAUDE.md prescribes those wrappers -- they all name
# scripts/agent-msg.sh, which had no check at all. The predictable result: the
# agent who WROTE such a wrapper called this script directly all day, with the
# checker run BESIDE it in a separate command rather than in front of it. One
# message went out contaminated while the checker printed "NEM KULDOM EL" next
# to it. A rule that has to be remembered is not a rule.
#
# The gate sits on the RAW text, before json.dumps: an encoded body shows the
# letter as \uXXXX, where a checker would no longer see a letter at all.
#
# Run:  bash scripts/__tests__/agent-msg-homoglyph.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HELPER="${HELPER_BIN:-$ROOT/scripts/agent-msg.sh}"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

# The instrument proves its own target first: every "nothing was sent"
# assertion below is satisfied by a missing helper just as well as by a
# working gate.
[ -r "$HELPER" ] || { echo "FATAL: the helper is missing: $HELPER" >&2; exit 2; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/msggate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
printf 'test-token\n' > "$SANDBOX/token"

# curl stub: nothing leaves the machine, and the call is RECORDED -- that record
# is what turns "was refused" into a measurable claim instead of an absence.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${CURL_CALLS:-/dev/null}"
printf '{"id":4242}\n200'
STUB
chmod +x "$BIN/curl"
for t in python3 sed tail cat printf date mktemp rm; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN/$t"
done

CY="$(python3 -c 'print(chr(0x43E))')"   # CYRILLIC SMALL LETTER O
send() {  # send <content-or-dash> [extra env assignments via ENVX]
  : > "$SANDBOX/calls.txt"
  OUT="$(env PATH="$BIN:$PATH" CURL_CALLS="$SANDBOX/calls.txt" \
             MARVEEN_TOKEN_FILE="$SANDBOX/token" ${ENVX:-} \
             /bin/bash "$HELPER" igor hex "$1" 2>"$SANDBOX/err.txt")"
  RC=$?
  ERR="$(cat "$SANDBOX/err.txt")"
  CALLED="$([ -s "$SANDBOX/calls.txt" ] && echo yes || echo no)"
}

# POSITIVE CONTROL: clean text must still go out. A gate that refuses
# everything would pass every "was not sent" assertion below.
ENVX= send "tiszta magyar szoveg, arvizturo tukorfurogep"
ok "clean text is still sent" "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED"
ok "  ...and the helper reports the id" "$(printf '%s' "$OUT" | grep -q 'id=4242' && echo 0 || echo 1)" "out: $OUT"

# THE ASSERTION THAT FAILS WITHOUT THE GATE.
ENVX= send "szennyezett sz${CY}veg egy lathatatlan betuvel"
ok "contaminated text is REFUSED" "$([ "$RC" = "3" ] && echo 0 || echo 1)" "rc=$RC (expected 3)"
ok "  ...and NOTHING was sent" "$([ "$CALLED" = "no" ] && echo 0 || echo 1)" "curl was called anyway"
ok "  ...and the refusal names the letter" "$(printf '%s' "$ERR" | grep -qi 'CYRILLIC' && echo 0 || echo 1)" "stderr: $ERR"
# The message must steer to the right fix, or the next person reaches for the
# override and the gate ends up switched off.
ok "  ...and it names the word to rewrite instead of offering a cleaner" \
   "$(printf '%s' "$ERR" | grep -q 'ird UJRA' && printf '%s' "$ERR" | grep -q 'Automatikus csere nincs' && echo 0 || echo 1)" \
   "stderr: $ERR"
# The report must not CARRY the contaminated form: a report that quotes it is
# itself contaminated, becomes the next scan's hit, and whoever "fixes" the
# report deletes the evidence. Same masking as src/homoglyph.ts.
ok "  ...and the report masks the letter instead of pasting it" \
   "$(printf '%s' "$ERR" | python3 -c 'import sys,unicodedata; t=sys.stdin.read(); sys.exit(1 if [c for c in t if ord(c)>127 and "CYRILLIC" in unicodedata.name(c,"")] else 0)' && echo 0 || echo 1)" \
   "stderr carries the raw Cyrillic letter: $ERR"

# STDIN form takes the same route -- it is the form used for long messages.
: > "$SANDBOX/calls.txt"
OUT="$(printf 'stdin sz%sveg' "$CY" | env PATH="$BIN:$PATH" CURL_CALLS="$SANDBOX/calls.txt" \
        MARVEEN_TOKEN_FILE="$SANDBOX/token" /bin/bash "$HELPER" igor hex - 2>/dev/null)"
ok "the STDIN form is gated too" "$([ "$?" = "3" ] && [ ! -s "$SANDBOX/calls.txt" ] && echo 0 || echo 1)"

# --- THE RULE IS THE MIXED-SCRIPT WORD, not the presence of a script --------
# Requested in the 2026-09-24 review: this gate refused a plain Russian quote
# and a standalone Greek symbol that the outgoing-copy hook (#1509) passes.
# Two gates disagreeing about what is legitimate teach the sender that the rule
# depends on which script they happened to call.
ENVX= send "Idezet oroszul: Идёт дождь -- ennyi"
ok "a pure foreign-language quote is SENT (not a mixed word)" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED err: $ERR"
ENVX= send "A kesleltetes Δ = 12 ms volt"
ok "a standalone Greek symbol is SENT (technical notation)" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED err: $ERR"
# ...but Greek INSIDE a Latin word is still the bug this gate exists for.
GR="$(python3 -c 'print(chr(0x3BF))')"   # GREEK SMALL LETTER OMICRON
ENVX= send "gorog hom${GR}glifa egy szoban"
ok "Greek mixed INTO a Latin word is refused" "$([ "$RC" = "3" ] && [ "$CALLED" = "no" ] && echo 0 || echo 1)" "rc=$RC"
ok "  ...and the refusal names GREEK" "$(printf '%s' "$ERR" | grep -qi 'GREEK' && echo 0 || echo 1)" "stderr: $ERR"

# --- UNIT AND FORMULA NOTATION IS NOT A MIXED-SCRIPT WORD -------------------
# HOMOGLYPHMICRO924 (#1548) fixed this on the outgoing-copy hook ONLY, because
# that is where the rule lived. This path kept blocking "40 us": a super/
# subscript digit is not \d, so the word tokenizer takes it into the word, and
# the FIRST WORD of the Unicode name ("MICRO", "SUPERSCRIPT", "SUBSCRIPT") is
# not a script -- it is the name of the sign. SCRIPT_NEUTRAL now lives in
# scripts/lib/mixed_script.py with the rule itself, so both paths get it.
#
# THESE THREE CASES EXIST BECAUSE OF THE REBASE. The exception sat in the hook
# file that this branch rewrites; a rebase that resolves only the hook-side
# conflict drops it silently and "40 us" is blocked again on BOTH paths, with
# every test still green. So the measurement is here, on the send path, where
# #1548's own tests never reached.
MU="$(python3 -c 'print(chr(0xB5))')"     # MICRO SIGN
SUP2="$(python3 -c 'print(chr(0xB2))')"   # SUPERSCRIPT TWO
SUB2="$(python3 -c 'print(chr(0x2082))')" # SUBSCRIPT TWO
ENVX= send "a kesleltetes 40 ${MU}s volt"
ok "the micro sign in a unit is SENT (40 us)" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED err: $ERR"
ENVX= send "a felulet 100 m${SUP2} volt"
ok "a superscript digit is SENT (100 m2)" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED err: $ERR"
ENVX= send "a keplet H${SUB2}O marad"
ok "a subscript digit is SENT (H2O)" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED err: $ERR"
# ...and the exception must stay NARROW. "Every non-letter is neutral" would be
# the tempting simplification, and it would let ROMAN NUMERAL ONE through --
# a non-letter that looks exactly like a latin I. That is the homoglyph this
# gate exists for, so it has to stay caught.
RN1="$(python3 -c 'print(chr(0x2160))')"  # ROMAN NUMERAL ONE
ENVX= send "verz${RN1}o egy szoban"
ok "the neutral list stays narrow: ROMAN NUMERAL ONE is still refused" \
   "$([ "$RC" = "3" ] && [ "$CALLED" = "no" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED"

# --- THE TWO PATHS MUST NOT DRIFT -------------------------------------------
# The anti-drift guarantee is not "we copied the rule carefully", it is this
# measurement: one corpus, both implementations, identical verdicts. The rule
# now lives in scripts/lib/mixed_script.py and both import it; if anyone
# re-implements either side, this check is what fails.
cat > "$SANDBOX/parity.py" <<'PYP'
import os
import subprocess
import sys

root = sys.argv[1]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from mixed_script import mixed_script_words

CY, GR = chr(0x43E), chr(0x3BF)
corpus = [
    "tiszta magyar szoveg", "arvizturo tukorfurogep", "plain ascii text",
    "emoji is fine \U0001F600", "Idezet: \u0418\u0434\u0451\u0442 \u0434\u043e\u0436\u0434\u044c",
    "Delta: \u0394 = 12 ms", "\u03c0 r^2",
    "szennyezett sz%sveg" % CY, "hom%sglifa" % GR, "MIXED%sCASE" % CY.upper(),
    "url https://example.com/a?b=1", "szam 12345 es -- kotojel",
    # HOMOGLYPHMICRO924: neutral on BOTH paths, or the rule drifted again.
    "40 \u00b5s", "100 m\u00b2", "5 cm\u00b3", "H\u2082O",
    # ...but a non-letter that DISGUISES a latin letter is not neutral.
    "verz\u2160o",
    "kev%srt sz%s egyben" % (CY, GR),
]
bad = 0
for text in corpus:
    hook = bool(mixed_script_words(text))
    rc = subprocess.run(
        [sys.executable, os.path.join(root, "scripts", "lib", "homoglyph.py")],
        input=text, capture_output=True, text=True).returncode
    gate = (rc == 3)
    if hook != gate:
        sys.stderr.write("DRIFT on %r: hook=%s gate=%s\n" % (text, hook, gate))
        bad += 1
sys.exit(1 if bad else 0)
PYP
PARITY=0
PARITY_ERR="$(python3 "$SANDBOX/parity.py" "$ROOT" 2>&1 >/dev/null)" || PARITY=1
ok "the send gate and the outgoing-copy hook agree on the whole corpus" "$PARITY" "$PARITY_ERR"

# --- THE AUTOMATIC REPLACEMENT IS GONE, AND MUST STAY GONE ------------------
# Dropped on the reviewer's request, and it is a decision, not a missing
# feature: a look-alike maps by SHAPE, while the intended word often needs a
# different letter (Cyrillic ER looks like `p`, the word wanted `r`), and the
# old table mixed shape-based with sound-based mappings. So the old override
# must not quietly still work -- someone with TISZTIT=1 in their muscle memory
# has to get the refusal, not a silently rewritten message.
ENVX="TISZTIT=1" send "tisztitando sz${CY}veg"
ok "TISZTIT=1 no longer cleans: the text is still REFUSED" \
   "$([ "$RC" = "3" ] && [ "$CALLED" = "no" ] && echo 0 || echo 1)" "rc=$RC curl-called=$CALLED"

# --- A BROKEN CHECKER IS NOT A VERDICT ON THE TEXT --------------------------
# Measured in the review: a checker exiting 0 with EMPTY stdout made this
# helper send an EMPTY message and report OK, because the helper took the
# checker's stdout as the payload. The exit code is the verdict; the text that
# goes out is the text the sender typed.
cat > "$SANDBOX/empty-checker.py" <<'EC'
import sys
sys.stdin.read()
sys.exit(0)
EC
ENVX="MARVEEN_HOMOGLYPH_BIN=$SANDBOX/empty-checker.py" send "ezt a szoveget kell elkuldeni"
ok "a checker with empty stdout does NOT empty the message" \
   "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC"
ok "  ...the ORIGINAL text reaches the payload" \
   "$(python3 -c "
import json, sys
sent = None
for a in open('$SANDBOX/calls.txt', encoding='utf-8').read().splitlines():
    try:
        d = json.loads(a)
    except Exception:
        continue
    if isinstance(d, dict) and 'content' in d:
        sent = d['content']
sys.exit(0 if sent == 'ezt a szoveget kell elkuldeni' else 1)
" && echo 0 || echo 1)" "the payload was not the text that was typed"

# A CRASHING checker must get its own message and its own exit code: "refused"
# would send the author off to rewrite a word that may be perfectly fine.
cat > "$SANDBOX/crash-checker.py" <<'CC'
import sys
raise SystemExit(9)
CC
ENVX="MARVEEN_HOMOGLYPH_BIN=$SANDBOX/crash-checker.py" send "tiszta szoveg torott checkerrel"
ok "a CRASHING checker is not reported as a refusal" \
   "$([ "$RC" = "4" ] && [ "$CALLED" = "no" ] && echo 0 || echo 1)" "rc=$RC (expected 4) curl-called=$CALLED"
ok "  ...and it says the checker crashed, not that the text was refused" \
   "$(printf '%s' "$ERR" | grep -q 'CRASHED' && echo 0 || echo 1)" "stderr: $ERR"

# A missing checker must FAIL OPEN -- this helper is the fleet's mandated route,
# and blocking every message on an install without the lib file would be a new,
# worse failure. But it must not be silent: that silence is today's bug.
ENVX="MARVEEN_HOMOGLYPH_BIN=$SANDBOX/nincs-ilyen.py" send "tiszta szoveg checker nelkul"
ok "a missing checker still sends (fail-open)" "$([ "$RC" = "0" ] && [ "$CALLED" = "yes" ] && echo 0 || echo 1)" "rc=$RC"
ok "  ...but says so out loud" "$(printf '%s' "$ERR" | grep -q 'UNCHECKED' && echo 0 || echo 1)" "stderr: $ERR"

echo
echo "$((N-FAILS))/$N passed  (helper under test: $HELPER)"
[ "$FAILS" = "0" ] || exit 1
