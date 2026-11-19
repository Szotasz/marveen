#!/bin/bash
# Contract tests for scripts/watchdog.sh carrying the Bash sandbox of an agent on BASH_SANDBOX_AGENTS
# (WDSANDBOXMARKER1119).
#
# The watchdog's restart used to decide by the presence of store/bash-sandbox/<id>.settings.json: a deleted file
# restarted a listed agent with no --settings (unsandboxed), and an edited file was passed on as it was. Wanted: the
# restart produces the file the way the dashboard's start does (scripts/bash-sandbox-sync.mjs -> the dashboard's own
# syncBashSandboxSettings, from the owner's list and sources), and does NOT start a listed agent when it cannot.
#
# HERMETIC: a fixture install INSIDE the project tree (node finds node_modules by walking up) with its own copy of
# dist/, its own .env (the owner's list), its own HOME and a private TMUX_TMPDIR; tmux / ps / claude / sleep are stubs
# first on PATH, so no live session or live install is touched. Part 1 drives `watchdog.sh --sandbox-flag <id>`, part
# 2 runs the whole script once and reads the relaunch commands the tmux stub recorded.
# Run: bash scripts/__tests__/watchdog-bash-sandbox.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to confirm it fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
HELPER="${SYNC_HELPER_BIN:-$REPO_DIR/scripts/bash-sandbox-sync.mjs}"

if [ ! -f "$REPO_DIR/dist/web/bash-sandbox.js" ]; then
  echo "dist/ not built -- building now (npm run build)..." >&2
  ( cd "$REPO_DIR" && npm run build ) >&2 || { echo "FAIL: npm run build failed" >&2; exit 1; }
fi

TMP="$(mktemp -d "$REPO_DIR/tmp.wdsandbox.XXXXXX")"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

FX="$TMP/install"
mkdir -p "$FX/scripts" "$FX/store" "$FX/agents" "$FX/logs"
cp "$WATCHDOG" "$FX/scripts/watchdog.sh"
cp "$HELPER" "$FX/scripts/bash-sandbox-sync.mjs"
cp -R "$REPO_DIR/dist" "$FX/dist"
echo '[]' > "$FX/store/agent-package-hidden.json"
# The owner's list, where the dashboard reads it from (an .env line that adds an agent is honoured).
printf 'BASH_SANDBOX_AGENTS=sbx\n' > "$FX/.env"
FH="$TMP/home"
mkdir -p "$FH"
WD="$FX/scripts/watchdog.sh"
SB="$FX/store/bash-sandbox"
NODE_DIR="$(dirname "$(command -v node)")"

make_agent() {
  local d="$FX/agents/$1"
  mkdir -p "$d/.claude/channels/telegram"
  echo "# $1" > "$d/CLAUDE.md"; echo "# $1" > "$d/SOUL.md"
  echo '{"model":"claude-test-model"}' > "$d/agent-config.json"
  echo "TELEGRAM_BOT_TOKEN=000:fixture" > "$d/.claude/channels/telegram/.env"
}
make_agent sbx
make_agent free
# The dashboard keeps the directory read-only between writes; a test that plants a file opens it first.
plant() { mkdir -p "$SB"; chmod 755 "$SB"; rm -f "$SB/$1.settings.json"; printf '%s\n' "$2" > "$SB/$1.settings.json"; }
flag() { HOME="$FH" PATH="$NODE_DIR:/usr/bin:/bin" bash "$WD" --sandbox-flag "$1"; }
# The file is the dashboard's shape: the sandbox on, strict allowlist, no unsandboxed commands.
dashboard_shape() {
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sandbox;
    process.exit(s.enabled===true&&s.failIfUnavailable===true&&s.allowUnsandboxedCommands===false&&s.network.strictAllowlist===true?0:1)' "$1" 2>/dev/null
}
WANT="flag= --settings '$SB/sbx.settings.json'"

echo "watchdog Bash sandbox contract:"

# ── Part 1: the piece ────────────────────────────────────────────────────
OUT="$(flag sbx)"
[ "$OUT" = "$WANT" ] && pass "listed, no file: the restart writes it and carries --settings" || fail "listed, no file: the restart writes it and carries --settings" "$OUT"
dashboard_shape "$SB/sbx.settings.json" && pass "listed, no file: the written file is the dashboard's shape" || fail "listed, no file: the written file is the dashboard's shape" "$(cat "$SB/sbx.settings.json" 2>&1)"

plant sbx '{"sandbox":{"enabled":false}}'
OUT="$(flag sbx)"
[ "$OUT" = "$WANT" ] && dashboard_shape "$SB/sbx.settings.json" && pass "listed, a looser file: rewritten from the owner's sources" || fail "listed, a looser file: rewritten from the owner's sources" "$OUT / $(cat "$SB/sbx.settings.json")"

plant sbx 'not json'
OUT="$(flag sbx)"
[ "$OUT" = "$WANT" ] && dashboard_shape "$SB/sbx.settings.json" && pass "listed, an invalid file: rewritten from the owner's sources" || fail "listed, an invalid file: rewritten from the owner's sources" "$OUT / $(cat "$SB/sbx.settings.json")"

OUT="$(flag free)"
[ "$OUT" = "flag=" ] && pass "unlisted, no file: no --settings" || fail "unlisted, no file: no --settings" "$OUT"

plant free '{}'
OUT="$(flag free)"
[ "$OUT" = "flag=" ] && [ ! -e "$SB/free.settings.json" ] && pass "unlisted, a stale file: removed, no --settings (as the dashboard's start)" || fail "unlisted, a stale file: removed, no --settings (as the dashboard's start)" "$OUT"

# An owner source the dashboard cannot read: the dashboard refuses the start, so does the restart.
printf 'not json\n' > "$FX/store/egress-vendor-hosts.json"
OUT="$(flag sbx)"
[ "$OUT" = "flag=REFUSED" ] && pass "listed, an unreadable owner host list: refused" || fail "listed, an unreadable owner host list: refused" "$OUT"
OUT="$(flag free)"
[ "$OUT" = "flag=" ] && pass "unlisted, an unreadable owner host list: unaffected" || fail "unlisted, an unreadable owner host list: unaffected" "$OUT"
rm -f "$FX/store/egress-vendor-hosts.json"

# The dashboard's code missing (no dist): the list cannot be read, so no agent is started blind.
mv "$FX/dist" "$FX/dist.off"
OUT="$(flag sbx)"
[ "$OUT" = "flag=REFUSED" ] && pass "no dist: refused" || fail "no dist: refused" "$OUT"
OUT="$(flag free)"
[ "$OUT" = "flag=REFUSED" ] && pass "no dist: an unlisted agent too (the list cannot be read)" || fail "no dist: an unlisted agent too (the list cannot be read)" "$OUT"
mv "$FX/dist.off" "$FX/dist"

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
  # First run: sbx listed with its file deleted, and the owner's write-path list not readable as one (a JSON array),
  # so the dashboard's sync throws for it -> sbx refused; free (unlisted) started.
  chmod 755 "$SB"; rm -f "$SB/sbx.settings.json"
  printf '[]\n' > "$FX/store/bash-sandbox-write-paths.json"
  : > "$FX/logs/watchdog.log"
  env -u TMUX HOME="$FH" TMUX_TMPDIR="$TMP/tmux-sock" PATH="$STUBS:$NODE_DIR:/usr/bin:/bin" bash "$WD" >/dev/null 2>&1
  cmd_of() { awk -F'\t' -v s="agent-$1" '$1 == s { print $2 }' "$CMDS"; }
  [ -z "$(cmd_of sbx)" ] && pass "relaunch: a listed agent whose file cannot be produced is NOT started" || fail "relaunch: a listed agent whose file cannot be produced is NOT started" "$(cmd_of sbx)"
  grep -q "sbx: not started: bash-sandbox settings could not be produced (fail-closed, BASH_SANDBOX_AGENTS)" "$FX/logs/watchdog.log" \
    && pass "relaunch: the refusal is a log line" || fail "relaunch: the refusal is a log line" "$(cat "$FX/logs/watchdog.log")"
  case "$(cmd_of free)" in
    *"--channels plugin:telegram@claude-plugins-official") pass "relaunch: an unlisted agent starts as before, no --settings" ;;
    *) fail "relaunch: an unlisted agent starts as before, no --settings" "$(cmd_of free)" ;;
  esac

  # Second run: the owner's sources readable again -> sbx comes back WITH its sandbox, its file deleted or not.
  rm -f "$FX/store/bash-sandbox-write-paths.json"
  chmod 755 "$SB"; rm -f "$SB/sbx.settings.json"
  : > "$CMDS"
  env -u TMUX HOME="$FH" TMUX_TMPDIR="$TMP/tmux-sock" PATH="$STUBS:$NODE_DIR:/usr/bin:/bin" bash "$WD" >/dev/null 2>&1
  case "$(cmd_of sbx)" in
    *"--channels plugin:telegram@claude-plugins-official --settings '$SB/sbx.settings.json'") pass "relaunch: a listed agent with its file deleted comes back with --settings" ;;
    *) fail "relaunch: a listed agent with its file deleted comes back with --settings" "$(cmd_of sbx)" ;;
  esac
  dashboard_shape "$SB/sbx.settings.json" && pass "relaunch: the file it names is the dashboard's shape" || fail "relaunch: the file it names is the dashboard's shape" "$(cat "$SB/sbx.settings.json" 2>&1)"
fi

# ── Part 3: which node (WDSANDBOXNODE1119) ──────────────────────────────
# The dashboard records the node it runs on in store/bash-sandbox/.node; the watchdog uses it first, falls back to the
# node on PATH (logged) when it is missing or not one line holding an absolute path to an executable file with no quote
# or colon, and never runs a value it did not accept. A recorded value that would be accepted points at a wrapper that
# marks its use and runs the real node; each rejected value points at a trap that marks if it is ever run.
echo "watchdog node resolution:"
REAL_NODE="$(node -p process.execPath)"
NONODE_PATH="/usr/bin:/bin"
LOGF="$FX/logs/watchdog.log"
USED="$TMP/recorded-node.used"; TRAPPED="$TMP/trap-node.ran"; POISONED="$TMP/path-node.ran"
mkdir -p "$TMP/nvm/bin" "$TMP/it's" "$TMP/two"$'\n'"lines" "$TMP/co:lon" "$TMP/rel/bin"
printf '#!/bin/bash\necho used >> %q\nexec %q "$@"\n' "$USED" "$REAL_NODE" > "$TMP/nvm/bin/node"
for t in "$TMP/it's/node" "$TMP/two"$'\n'"lines/node" "$TMP/co:lon/node" "$TMP/rel/bin/node"; do
  printf '#!/bin/bash\necho ran >> %q\nexec %q "$@"\n' "$TRAPPED" "$REAL_NODE" > "$t"
done
chmod +x "$TMP/nvm/bin/node" "$TMP/it's/node" "$TMP/two"$'\n'"lines/node" "$TMP/co:lon/node" "$TMP/rel/bin/node"
# record VALUE: written as the dashboard writes it (the value and one newline); "-" removes the file.
record() { mkdir -p "$SB"; chmod 755 "$SB"; rm -f "$SB/.node"; [ "$1" = - ] || printf '%s\n' "$1" > "$SB/.node"; chmod 555 "$SB"; }
# flag_in PATH ID: --sandbox-flag from inside $TMP/rel (a relative value would resolve there), under the given PATH.
flag_in() { ( cd "$TMP/rel" && HOME="$FH" PATH="$1" bash "$WD" --sandbox-flag "$2" ); }
reset_marks() { rm -f "$USED" "$TRAPPED" "$POISONED"; : > "$LOGF"; }
FALLBACK_LINE="dashboard node not recorded or not usable"

if [ -n "$(env PATH="$NONODE_PATH" /bin/bash -c 'command -v node')" ]; then
  fail "a PATH without node can be built here (refusing to run part 3)" "$(env PATH="$NONODE_PATH" /bin/bash -c 'command -v node')"
else
  reset_marks; record "$TMP/nvm/bin/node"
  OUT="$(flag_in "$NONODE_PATH" sbx)"
  [ "$OUT" = "$WANT" ] && [ -f "$USED" ] && ! grep -q "$FALLBACK_LINE" "$LOGF" \
    && pass "no node on PATH, the dashboard's node recorded: it runs the helper, --settings" \
    || fail "no node on PATH, the dashboard's node recorded: it runs the helper, --settings" "$OUT / used=$([ -f "$USED" ] && echo y || echo n) / $(cat "$LOGF")"

  reset_marks; record -
  OUT="$(flag_in "$NODE_DIR:$NONODE_PATH" sbx)"
  [ "$OUT" = "$WANT" ] && grep -q "$FALLBACK_LINE.*using the node on PATH: $NODE_DIR/node" "$LOGF" \
    && pass "nothing recorded: the node on PATH, and the log says so" \
    || fail "nothing recorded: the node on PATH, and the log says so" "$OUT / $(cat "$LOGF")"

  # Each trap exists and is executable: only the shape check stands between it and a run.
  for bad in "bin/node|relative" "$TMP/it's/node|a quote" "$TMP/two"$'\n'"lines/node|two lines" "$TMP/co:lon/node|a colon" "$TMP/nope/node|nonexistent" "$TMP/nvm/bin|a directory"; do
    val="${bad%|*}"; what="${bad##*|}"
    reset_marks; record "$val"
    OUT="$(flag_in "$NODE_DIR:$NONODE_PATH" sbx)"
    [ "$OUT" = "$WANT" ] && [ ! -f "$TRAPPED" ] && [ ! -f "$USED" ] && grep -q "$FALLBACK_LINE.*using the node on PATH: $NODE_DIR/node" "$LOGF" \
      && pass "recorded value $what: never run, the node on PATH (logged)" \
      || fail "recorded value $what: never run, the node on PATH (logged)" "$OUT / trapped=$([ -f "$TRAPPED" ] && echo y || echo n) used=$([ -f "$USED" ] && echo y || echo n) / $(cat "$LOGF")"
  done

  reset_marks; record "$TMP/it's/node"
  OUT="$(flag_in "$NONODE_PATH" sbx)"
  [ "$OUT" = "flag=REFUSED" ] && [ ! -f "$TRAPPED" ] && grep -q "using the node on PATH: none" "$LOGF" \
    && pass "a rejected value and no node on PATH: refused, as today" \
    || fail "a rejected value and no node on PATH: refused, as today" "$OUT / $(cat "$LOGF")"
  reset_marks; record -
  OUT="$(flag_in "$NONODE_PATH" sbx)"
  [ "$OUT" = "flag=REFUSED" ] && grep -q "using the node on PATH: none" "$LOGF" \
    && pass "nothing recorded and no node on PATH: refused, as today" \
    || fail "nothing recorded and no node on PATH: refused, as today" "$OUT / $(cat "$LOGF")"
fi

# The whole run. Its own PATH puts $HOME/.local/bin first, so a node there that fails and marks stands in for "the
# node on PATH is not the dashboard's" on any host (here Homebrew's node would otherwise be found).
if [ "$RESOLVED" = "$STUBS/tmux:$STUBS/claude" ]; then
  printf '#!/bin/bash\necho ran >> %q\nexit 1\n' "$POISONED" > "$STUBS/node"; chmod +x "$STUBS/node"
  run_all() { : > "$CMDS"; env -u TMUX HOME="$FH" TMUX_TMPDIR="$TMP/tmux-sock" PATH="$STUBS:$NONODE_PATH" bash "$WD" >/dev/null 2>&1; }
  chmod 755 "$SB"; rm -f "$SB/sbx.settings.json"
  reset_marks; record "$TMP/nvm/bin/node"; run_all
  case "$(cmd_of sbx)" in
    *"--channels plugin:telegram@claude-plugins-official --settings '$SB/sbx.settings.json'")
      [ -f "$USED" ] && [ ! -f "$POISONED" ] && pass "relaunch: the recorded node is used, the listed agent starts with --settings" \
        || fail "relaunch: the recorded node is used, the listed agent starts with --settings" "used=$([ -f "$USED" ] && echo y || echo n) poisoned=$([ -f "$POISONED" ] && echo y || echo n)" ;;
    *) fail "relaunch: the recorded node is used, the listed agent starts with --settings" "$(cmd_of sbx) / $(cat "$LOGF")" ;;
  esac

  reset_marks; record -; run_all
  [ -z "$(cmd_of sbx)" ] && [ -f "$POISONED" ] && grep -q "sbx: not started: bash-sandbox settings could not be produced" "$LOGF" && grep -q "$FALLBACK_LINE" "$LOGF" \
    && pass "relaunch: nothing recorded -> the node on PATH (logged); it fails here, so the listed agent is refused" \
    || fail "relaunch: nothing recorded -> the node on PATH (logged); it fails here, so the listed agent is refused" "$(cmd_of sbx) / $(cat "$LOGF")"

  # The dashboard down: npm start runs with the recorded node's directory first, so npm and its node are that one.
  printf '#!/bin/bash\nexit 0\n' > "$STUBS/ps"
  printf '#!/bin/bash\ncommand -v node > %q\n' "$TMP/npm.node" > "$TMP/nvm/bin/npm"; chmod +x "$TMP/nvm/bin/npm"
  reset_marks; record "$TMP/nvm/bin/node"; rm -f "$TMP/npm.node"; run_all
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/npm.node" ] && break; /bin/sleep 0.2; done
  [ "$(cat "$TMP/npm.node" 2>/dev/null)" = "$TMP/nvm/bin/node" ] \
    && pass "dashboard down: npm start runs from the recorded node's directory" \
    || fail "dashboard down: npm start runs from the recorded node's directory" "$(cat "$TMP/npm.node" 2>&1)"
fi

echo "watchdog-bash-sandbox: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
