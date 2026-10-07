#!/bin/bash
# TMUXEXACT1771 (#1771): every tmux -t target under scripts/ is the exact form
# "=NAME:" (or "=NAME:window"). tmux resolves a bare -t NAME exactly first and,
# when no session has that name, as a PREFIX: measured on tmux 3.6a (private
# socket), has-session -t agent-foo answered 0 while only agent-foo2 existed,
# and list-panes / capture-pane / the key-sender reached agent-foo2.
#
# 1. End to end with a REAL tmux, isolated by TMUX_TMPDIR (TMUX unset, the
#    socket path checked before anything is touched; kill-server is never
#    called): worker-tail.sh for a missing agent must say "stopped" while a
#    sibling with a longer name runs.
# 2. Pin: a command-position tmux call under scripts/ with a non-exact -t target
#    fails the suite. Positive controls prove the scanner catches the old forms;
#    the owner-facing text lines ("... tmux attach -t NAME ...") are text, not
#    calls, and stay as they are (a typed "=" would break in zsh).
# Run: bash scripts/__tests__/tmux-exact-targets.test.sh

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
STARTED=""
cleanup() {
  for s in $STARTED; do
    sock="$(env -u TMUX TMUX_TMPDIR="$TMP" tmux display-message -p -t "=$s:" '#{socket_path}' 2>/dev/null)"
    case "$sock" in *"$(basename "$TMP")"*) env -u TMUX TMUX_TMPDIR="$TMP" tmux kill-session -t "=$s:" 2>/dev/null ;; esac
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "tmux targets are exact (TMUXEXACT1771)"

if command -v tmux >/dev/null 2>&1; then
  env -u TMUX TMUX_TMPDIR="$TMP" tmux new-session -d -s agent-foo2 'sleep 300'
  STARTED="agent-foo2"
  SOCK="$(env -u TMUX TMUX_TMPDIR="$TMP" tmux display-message -p -t '=agent-foo2:' '#{socket_path}' 2>/dev/null)"
  case "$SOCK" in
    *"$(basename "$TMP")"*)
      OUT_MISSING="$(env -u TMUX TMUX_TMPDIR="$TMP" bash "$REPO/scripts/worker-tail.sh" foo 2>&1)"
      OUT_SIBLING="$(env -u TMUX TMUX_TMPDIR="$TMP" bash "$REPO/scripts/worker-tail.sh" foo2 2>&1)"
      case "$OUT_MISSING" in *"STATE: stopped"*) pass "worker-tail.sh foo -> stopped while agent-foo2 runs" ;; *) fail "worker-tail.sh foo -> stopped while agent-foo2 runs (got: $(printf '%s' "$OUT_MISSING" | head -2 | tr '\n' ' '))" ;; esac
      case "$OUT_SIBLING" in *"STATE: stopped"*) fail "positive control: worker-tail.sh foo2 sees the running session" ;; *) pass "positive control: worker-tail.sh foo2 sees the running session" ;; esac
      ;;
    *) fail "isolated tmux server could not be proven (socket: $SOCK) -- nothing was run against it" ;;
  esac
else
  echo "  SKIP: no tmux on this host (end-to-end part)"
fi

cat > "$TMP/scan.py" <<'PY'
import os, re, sys
TMUXW = re.compile(r'(^|[\s(;&|!]|\$\()("?\$\{?TMUX(?:_BIN)?\}?"?|tmux)(?=\s)')
TGT = re.compile(r'\s-t\s+("[^"]*"|\'[^\']*\'|\S+)')
def logical(text):
    buf, start = "", None
    for n, line in enumerate(text.split("\n"), 1):
        if start is None: start = n
        if line.endswith("\\"):
            buf += line[:-1] + " "; continue
        yield start, buf + line
        buf, start = "", None
def in_text(seg, pos):
    # Inside a double-quoted TEXT (log/echo/alert) when the quotes before the
    # tmux word are unbalanced and no "$(" opens a command substitution after the
    # last of them.
    # A "$(" that is already closed before the tmux word ("$(( n ))", "$(date)")
    # does not make it a call.
    before = seg[:pos]
    if before.count('"') % 2 == 0: return False
    tail = before[before.rfind('"'):]
    return tail.count('$(') - tail.count(')') <= 0
def scan(path):
    hits = []
    try: text = open(path, encoding="utf-8", errors="replace").read()
    except Exception: return hits
    for n, line in logical(text):
        if line.lstrip().startswith("#"): continue
        for seg in re.split(r'&&|\|\||;|(?<![|])\|(?![|])', line):
            m = TMUXW.search(seg)
            if not m or in_text(seg, m.start(2)): continue
            for t in TGT.finditer(seg[m.end(2):]):
                arg = t.group(1).strip('"\'')
                if not arg.startswith("="):
                    hits.append("%s:%d: -t %s" % (path, n, t.group(1)))
    return hits
root = sys.argv[1]
out = []
if os.path.isfile(root): out = scan(root)
else:
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in ("__tests__", "node_modules")]
        for f in files:
            if f.endswith((".sh", ".bash")) or "." not in f: out += scan(os.path.join(d, f))
print("\n".join(out))
PY

# Positive controls: the old forms are caught.
printf '%s\n' 'if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then' > "$TMP/c1.sh"
printf '%s\n' '  pane="$("$TMUX_BIN" capture-pane -t "$SESSION" -p 2>/dev/null || true)"' > "$TMP/c2.sh"
printf '%s\n' 'while $TMUX has-session -t "$SESSION" 2>/dev/null; do' > "$TMP/c3.sh"
printf '%s\n' 'tmux kill-session -t marveen-channels 2>/dev/null || true' > "$TMP/c4.sh"
printf '%s\n' 'tmux link-window -s "a:0" \' '  -t "$SESSION:1"' > "$TMP/c5.sh"
for c in c1 c2 c3 c4 c5; do
  [ -n "$(python3 "$TMP/scan.py" "$TMP/$c.sh")" ] && pass "control $c: a bare target is caught" || fail "control $c: a bare target is caught"
done
# Negative controls: exact forms, owner-facing text, comments.
printf '%s\n' 'if ! "$TMUX_BIN" has-session -t "=$SESSION:" 2>/dev/null; then' \
  '  log "Manual check needed: tmux attach -t $SESSION"' \
  '# tmux kill-session -t monitor' \
  'echo "tmux attach -t ${NEW_SLUG}-channels"' \
  'sort -t , -k 2 file' \
  '  alert_owner "stuck for $(( now - first ))s. Manual check: tmux attach -t ${SESSION}"' \
  'echo "$(date +%T) post-init: check manually: tmux attach -t $SESSION" >> "$LOG"' > "$TMP/n1.sh"
NEG="$(python3 "$TMP/scan.py" "$TMP/n1.sh")"
[ -z "$NEG" ] && pass "controls: exact forms, owner text, comments and non-tmux -t are not flagged" || fail "false positive: $NEG"

HITS="$(python3 "$TMP/scan.py" "$REPO/scripts")"
if [ -z "$HITS" ]; then pass "no bare tmux -t target under scripts/"; else fail "bare tmux -t targets:"; printf '%s\n' "$HITS" | sed 's/^/      /'; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
