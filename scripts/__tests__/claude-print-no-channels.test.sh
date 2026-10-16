#!/bin/bash
# MORNINGPOLLER1770 (#1770) pin: no `claude -p` / `claude --print` call under
# scripts/ may carry --channels. A print-mode run with a channel plugin starts
# the plugin's server, which takes the single Telegram getUpdates slot from the
# live channel session (morning-briefing.sh did exactly this at every 07:27
# fire). Long-running channel sessions (channels.sh, watchdog.sh, ...) launch
# claude WITHOUT -p and are not affected.
#
# The scan joins backslash-continued lines into one logical command, splits it
# at && || ; | and flags a segment that runs claude ($CLAUDE, ${CLAUDE_BIN}, a
# bare claude, quoted or not) in print mode AND carries --channels. The first
# block below is a positive control: the pre-fix morning-briefing call shape
# must be caught, so a scanner that silently matches nothing cannot pass.
# Run: bash scripts/__tests__/claude-print-no-channels.test.sh

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/scan.py" <<'PY'
import os, re, sys
CLAUDE = re.compile(r'(^|[\s/"\'(])(claude|\$\{?CLAUDE(_BIN)?\}?)(["\']?)(\s|$)')
PRINT = re.compile(r'\s(-p|--print)(\s|$|["\'])')
def logical_lines(text):
    buf, start = "", None
    for n, line in enumerate(text.split("\n"), 1):
        if start is None: start = n
        if line.endswith("\\"):
            buf += line[:-1] + " "; continue
        yield start, buf + line
        buf, start = "", None
def scan_file(path):
    hits = []
    try: text = open(path, encoding="utf-8", errors="replace").read()
    except Exception: return hits
    for n, line in logical_lines(text):
        if line.lstrip().startswith("#"): continue
        for seg in re.split(r'&&|\|\||;|\|', line):
            if CLAUDE.search(seg) and PRINT.search(seg) and "--channels" in seg:
                hits.append("%s:%d: %s" % (path, n, seg.strip()[:140]))
    return hits
root = sys.argv[1]
out = []
if os.path.isfile(root): out = scan_file(root)
else:
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in ("__tests__", "node_modules")]
        for f in files:
            if f.endswith((".sh", ".bash", ".py", ".mjs", ".js", ".ts")) or "." not in f:
                out += scan_file(os.path.join(d, f))
print("\n".join(out))
PY

echo "claude print-mode calls under scripts/ carry no --channels"

# Positive control: the exact pre-fix shape of scripts/morning-briefing.sh.
cat > "$TMP/control.sh" <<'CTRL'
CLAUDE_CODE_DISABLE_AGENT_VIEW=1 $CLAUDE --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "Reggeli napindito"
CTRL
cat > "$TMP/control2.sh" <<'CTRL'
"${CLAUDE_BIN}" --print "x" --channels plugin:slack-channel@marveen-marketplace && echo done
CTRL
cat > "$TMP/negative.sh" <<'CTRL'
$CLAUDE --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official
mkdir -p "$X" && claude --channels plugin:telegram@claude-plugins-official
claude -p "ping" --max-turns 1
CTRL
[ -n "$(python3 "$TMP/scan.py" "$TMP/control.sh")" ] && pass "control: the pre-fix morning-briefing shape is caught" || fail "control: the pre-fix morning-briefing shape is caught"
[ -n "$(python3 "$TMP/scan.py" "$TMP/control2.sh")" ] && pass "control: a quoted \${CLAUDE_BIN} --print ... --channels is caught" || fail "control: a quoted \${CLAUDE_BIN} --print ... --channels is caught"
NEG="$(python3 "$TMP/scan.py" "$TMP/negative.sh")"
[ -z "$NEG" ] && pass "control: a long-running --channels session (no -p) and a plain -p are NOT flagged" || fail "control: false positive: $NEG"

HITS="$(python3 "$TMP/scan.py" "$REPO/scripts")"
if [ -z "$HITS" ]; then
  pass "no claude -p / --print call under scripts/ carries --channels"
else
  fail "claude print-mode call(s) with --channels:"; printf '%s\n' "$HITS" | sed 's/^/      /'
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
