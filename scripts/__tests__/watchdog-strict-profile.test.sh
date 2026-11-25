#!/bin/bash
# Contract tests for scripts/watchdog.sh leaving strict / unknown security profiles to the dashboard (AGENTISO1123
# PR-A).
#
# The watchdog's restart launches every sub-agent with --dangerously-skip-permissions and writes no profile settings,
# so a strict agent restarted here would run in bypass, and an agent whose configured profile is missing would start
# where the dashboard refuses it. Wanted: such an agent is NOT started by the watchdog (one log line, no attempt); an
# agent with no profile configured, or a permissive one, restarts exactly as before.
#
# HERMETIC, as watchdog-bash-sandbox.test.sh: a fixture install INSIDE the project tree with its own dist/, templates,
# HOME and TMUX_TMPDIR; tmux / ps / claude / sleep are stubs first on PATH. Part 1 drives
# `watchdog.sh --check-profile <dir>`, part 2 runs the whole script once and reads what the tmux stub recorded.
# Run: bash scripts/__tests__/watchdog-strict-profile.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to confirm it fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"

if [ ! -f "$REPO_DIR/dist/web/bash-sandbox.js" ]; then
  echo "dist/ not built -- building now (npm run build)..." >&2
  ( cd "$REPO_DIR" && npm run build ) >&2 || { echo "FAIL: npm run build failed" >&2; exit 1; }
fi

TMP="$(mktemp -d "$REPO_DIR/tmp.wdprofile.XXXXXX")"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

FX="$TMP/install"
mkdir -p "$FX/scripts" "$FX/store" "$FX/agents" "$FX/logs" "$FX/templates"
cp "$WATCHDOG" "$FX/scripts/watchdog.sh"
cp "$REPO_DIR/scripts/bash-sandbox-sync.mjs" "$FX/scripts/bash-sandbox-sync.mjs"
cp -R "$REPO_DIR/dist" "$FX/dist"
cp -R "$REPO_DIR/templates/profiles" "$FX/templates/profiles"
printf '{ "id": "half a file' > "$FX/templates/profiles/zz-broken.json"
echo '[]' > "$FX/store/agent-package-hidden.json"
: > "$FX/.env"
FH="$TMP/home"
mkdir -p "$FH"
WD="$FX/scripts/watchdog.sh"
NODE_DIR="$(dirname "$(command -v node)")"

# make_agent NAME CONFIG-JSON
make_agent() {
  local d="$FX/agents/$1"
  mkdir -p "$d/.claude/channels/telegram"
  echo "# $1" > "$d/CLAUDE.md"; echo "# $1" > "$d/SOUL.md"
  printf '%s\n' "$2" > "$d/agent-config.json"
  echo "TELEGRAM_BOT_TOKEN=000:fixture" > "$d/.claude/channels/telegram/.env"
}
make_agent plain    '{"model":"claude-test-model"}'
make_agent dflt     '{"model":"claude-test-model","securityProfile":"default"}'
make_agent perm     '{"model":"claude-test-model","securityProfile":"researcher"}'
make_agent lead     '{"model":"claude-test-model","team":{"role":"leader"}}'
make_agent strict   '{"model":"claude-test-model","securityProfile":"developer-junior"}'
make_agent missing  '{"model":"claude-test-model","securityProfile":"no-such-profile"}'
make_agent broken   '{"model":"claude-test-model","securityProfile":"zz-broken"}'

check() { HOME="$FH" PATH="$NODE_DIR:/usr/bin:/bin" bash "$WD" --check-profile "$FX/agents/$1/"; }
expect() { local got; got="$(check "$1")"; [ "$got" = "$2" ] && pass "$3" || fail "$3" "$got"; }

echo "watchdog strict/unknown profile contract:"

# ── Part 1: the predicate ────────────────────────────────────────────────
expect plain   "profile="        "no profile configured: may start"
expect dflt    "profile="        "securityProfile default: may start"
expect perm    "profile="        "a permissive configured profile: may start"
expect lead    "profile="        "a leader with no profile (role-derived applier): may start"
expect strict  "profile=strict"  "a strict configured profile: refused"
expect missing "profile=unknown" "a missing configured profile: refused"
expect broken  "profile=unknown" "an unreadable configured profile: refused"

# ── Part 2: the real relaunch ────────────────────────────────────────────
STUBS="$FH/.local/bin"
mkdir -p "$STUBS" "$TMP/tmux-sock"
CMDS="$TMP/new-session.cmds"
: > "$CMDS"
cat > "$STUBS/tmux" <<EOF
#!/bin/bash
case "\$1" in
  has-session) case "\$*" in *-channels:*) exit 0 ;; *) exit 1 ;; esac ;;
  new-session) printf '%s\t%s\n' "\$4" "\$5" >> "$CMDS"; exit 0 ;;
esac
exit 0
EOF
printf '#!/bin/bash\necho "501 4242 1 0 0:00 ?? 0:00.00 node dist/index.js"\n' > "$STUBS/ps"
printf '#!/bin/bash\nexit 0\n' > "$STUBS/claude"
printf '#!/bin/bash\nexit 0\n' > "$STUBS/sleep"
chmod +x "$STUBS"/*

RESOLVED="$(HOME="$FH" bash -c 'export PATH="$HOME/.local/bin:$PATH"; command -v tmux'):$(HOME="$FH" bash -c 'export PATH="$HOME/.local/bin:$PATH"; command -v claude')"
if [ "$RESOLVED" != "$STUBS/tmux:$STUBS/claude" ]; then
  fail "stubs resolve first (refusing to run the whole script)" "$RESOLVED"
else
  : > "$FX/logs/watchdog.log"
  env -u TMUX HOME="$FH" TMUX_TMPDIR="$TMP/tmux-sock" PATH="$STUBS:$NODE_DIR:/usr/bin:/bin" bash "$WD" >/dev/null 2>&1
  cmd_of() { awk -F'\t' -v s="agent-$1" '$1 == s { print $2 }' "$CMDS"; }
  for a in strict missing broken; do
    [ -z "$(cmd_of "$a")" ] && pass "relaunch: $a is NOT started" || fail "relaunch: $a is NOT started" "$(cmd_of "$a")"
    [ "$(grep -c "\[watchdog\] $a: not started: strict/unknown profile" "$FX/logs/watchdog.log")" = 1 ] \
      && pass "relaunch: $a gets exactly one log line" || fail "relaunch: $a gets exactly one log line" "$(cat "$FX/logs/watchdog.log")"
  done
  grep -q "agent-strict" "$CMDS" && fail "relaunch: no command at all for the strict agent" "$(cat "$CMDS")" \
    || pass "relaunch: no command at all for the strict agent (no --dangerously-skip-permissions launch)"
  for a in plain dflt perm lead; do
    case "$(cmd_of "$a")" in
      *"--dangerously-skip-permissions --model 'claude-test-model' --channels plugin:telegram@claude-plugins-official") pass "relaunch: $a starts as before" ;;
      *) fail "relaunch: $a starts as before" "$(cmd_of "$a")" ;;
    esac
  done
fi

echo
echo "watchdog-strict-profile: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
