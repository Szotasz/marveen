#!/bin/bash
# SECSZIVEK1007: the values channels.sh and channel-watchdog.sh inline into the
# command string a later shell parses again (the main model, the main agent's
# config dir, the plan's secret id, the install and node paths) are quoted as
# ONE shell word each (sh_single_quote, the twin of shSingleQuote), and the
# resolved main model must have the shape of a model id.
#
# Every check uses a harmless value with an apostrophe and/or a space: after
# the fix it stays one argument.
# Run: bash scripts/__tests__/launch-scripts-quoting.test.sh

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CH="$REPO/scripts/channels.sh"; WD="$REPO/scripts/channel-watchdog.sh"

echo "launch scripts quote inlined values (SECSZIVEK1007)"

SG="$REPO/scripts/stuck-modal-guard.sh"
H1="$(grep '^sh_single_quote() {' "$CH")"; H2="$(grep '^sh_single_quote() {' "$WD")"; H3="$(grep '^sh_single_quote() {' "$SG")"
[ -n "$H1" ] && [ "$H1" = "$H2" ] && [ "$H1" = "$H3" ] && pass "sh_single_quote is defined, byte-identically, in all three scripts" || fail "sh_single_quote is defined, byte-identically, in all three scripts"

# --- the resolved main model must look like a model id ---
mk_root() { local r="$TMP/root$1"; mkdir -p "$r/scripts" "$r/store" "$r/.claude"; cp "$CH" "$r/scripts/channels.sh"; printf '%s\n' "$2" > "$r/.env"; echo "$r"; }
R="$(mk_root 1 "MAIN_AGENT_MODEL=claude-opus-5[1m]")"
assert_eq "a valid model id is resolved as is" "claude-opus-5[1m]" "$(bash "$R/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
R="$(mk_root 2 "MAIN_AGENT_MODEL=\"it's model\"")"
OUT="$(bash "$R/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
assert_eq "a value that is not a model id resolves EMPTY (the launch runs the CLI default)" "" "$OUT"
grep -q "not a valid model id" "$R/store/channels-failures.log" 2>/dev/null && pass "...and the refusal is named in channels-failures.log" || fail "...and the refusal is named in channels-failures.log"
grep -q "it's model" "$R/store/channels-failures.log" 2>/dev/null && fail "the refused value itself is not echoed into the log" || pass "the refused value itself is not echoed into the log"

# --- the command-string fragments, cut out of each script and re-parsed ---
# The fragments are the script's own lines; a stub "node" prints its argv so the
# token-mode fragment can be checked without any real secret.
cat > "$TMP/node" <<'STUB'
#!/bin/bash
printf '%s|' "$#" "$@"
STUB
chmod +x "$TMP/node"
for S in "$CH" "$WD"; do
  name="$(basename "$S")"
  {
    grep '^sh_single_quote() {' "$S"
    grep -E '^\[ -n "\$MAIN_MODEL" \] && MODEL_FLAG=' "$S"
    grep -E '^      CFG_ENV="export CLAUDE_CONFIG_DIR=' "$S" | sed -n '1p' | sed 's/^      CFG_ENV=/CFG_EXPLICIT=/'
    grep -E '^      CFG_ENV="export CLAUDE_CONFIG_DIR=' "$S" | sed -n '2p' | sed 's/^      CFG_ENV=/CFG_TOKEN=/'
    grep -E '^      CFG_ENV="export CLAUDE_CONFIG_DIR=' "$S" | sed -n '3p' | sed 's/^      CFG_ENV=/CFG_ISOLATED=/'
  } > "$TMP/frag-$name.sh"
  [ "$(grep -c '^CFG_' "$TMP/frag-$name.sh")" = 3 ] && [ "$(grep -c 'MODEL_FLAG=' "$TMP/frag-$name.sh")" = 1 ] \
    && pass "$name: the MODEL_FLAG line and the three CFG_ENV lines were found" || fail "$name: the MODEL_FLAG line and the three CFG_ENV lines were found"

  RESULT="$(env -i PATH="$PATH" bash -c '
    MAIN_MODEL="it'"'"'s model"; _cfg_dir="/tmp/it'"'"'s dir"; _cfg_token_secret="plan'"'"'s id"
    INSTALL_DIR="/tmp/it'"'"'s install"; _node_bin="$1"; NODE_BIN="$1"; MODEL_FLAG=""
    . "$2"
    # MODEL_FLAG re-parsed: exactly two words, the second the whole model value.
    eval "set -- $MODEL_FLAG"; printf "flag:%s:%s\n" "$#" "$2"
    # Each CFG_ENV re-parsed by a shell, followed by a probe of what it exported.
    bash -c "${CFG_EXPLICIT}printf \"explicit:%s\n\" \"\$CLAUDE_CONFIG_DIR\""
    bash -c "${CFG_TOKEN}printf \"token:%s:%s\n\" \"\$CLAUDE_CONFIG_DIR\" \"\$CLAUDE_CODE_OAUTH_TOKEN\""
    bash -c "${CFG_ISOLATED}printf \"isolated:%s\n\" \"\$CLAUDE_CONFIG_DIR\"" 2>/dev/null
  ' _ "$TMP/node" "$TMP/frag-$name.sh" 2>&1)"
  assert_eq "$name: --model stays ONE argument with the whole value" "flag:2:it's model" "$(printf '%s\n' "$RESULT" | grep '^flag:')"
  assert_eq "$name: explicit/rotated CFG_ENV exports the whole dir" "explicit:/tmp/it's dir" "$(printf '%s\n' "$RESULT" | grep '^explicit:')"
  assert_eq "$name: token-mode CFG_ENV hands node exactly 4 args, the secret id whole" "token:/tmp/it's dir:4|/tmp/it's install/scripts/resolve-plan-token-env.mjs|plan's id|/tmp/it's install/store/.claude-oauth-token|/tmp/it's install/store/channels-failures.log|" "$(printf '%s\n' "$RESULT" | grep '^token:')"
  assert_eq "$name: isolated CFG_ENV exports the whole dir" "isolated:/tmp/it's dir" "$(printf '%s\n' "$RESULT" | grep '^isolated:')"
done

# --- LAUNCHQUOTEREST1008: stuck-modal-guard.sh builds the same CFG_ENV ---
{
  grep '^sh_single_quote() {' "$SG"
  grep -E '^ +CFG_ENV="export CLAUDE_CONFIG_DIR=' "$SG" | sed -n '1p' | sed -E 's/^ +CFG_ENV=/CFG_EXPLICIT=/'
  grep -E '^ +CFG_ENV="export CLAUDE_CONFIG_DIR=' "$SG" | sed -n '2p' | sed -E 's/^ +CFG_ENV=/CFG_TOKEN=/'
  grep -E '^ +CFG_ENV="export CLAUDE_CONFIG_DIR=' "$SG" | sed -n '3p' | sed -E 's/^ +CFG_ENV=/CFG_ISOLATED=/'
} > "$TMP/frag-sg.sh"
[ "$(grep -c '^CFG_' "$TMP/frag-sg.sh")" = 3 ] && pass "stuck-modal-guard.sh: the three CFG_ENV lines were found" || fail "stuck-modal-guard.sh: the three CFG_ENV lines were found"
RESULT="$(env -i PATH="$PATH" bash -c '
  _cfg_dir="/tmp/it'"'"'s dir"; _cfg_token_secret="plan'"'"'s id"; INSTALL_DIR="/tmp/it'"'"'s install"; NODE_BIN="$1"
  . "$2"
  bash -c "${CFG_EXPLICIT}printf \"explicit:%s\n\" \"\$CLAUDE_CONFIG_DIR\""
  bash -c "${CFG_TOKEN}printf \"token:%s:%s\n\" \"\$CLAUDE_CONFIG_DIR\" \"\$CLAUDE_CODE_OAUTH_TOKEN\""
  bash -c "${CFG_ISOLATED}printf \"isolated:%s\n\" \"\$CLAUDE_CONFIG_DIR\"" 2>/dev/null
' _ "$TMP/node" "$TMP/frag-sg.sh" 2>&1)"
assert_eq "stuck-modal-guard.sh: explicit/rotated CFG_ENV exports the whole dir" "explicit:/tmp/it's dir" "$(printf '%s\n' "$RESULT" | grep '^explicit:')"
assert_eq "stuck-modal-guard.sh: token-mode CFG_ENV hands node exactly 4 args, the secret id whole" "token:/tmp/it's dir:4|/tmp/it's install/scripts/resolve-plan-token-env.mjs|plan's id|/tmp/it's install/store/.claude-oauth-token|/tmp/it's install/store/channels-failures.log|" "$(printf '%s\n' "$RESULT" | grep '^token:')"
assert_eq "stuck-modal-guard.sh: isolated CFG_ENV exports the whole dir" "isolated:/tmp/it's dir" "$(printf '%s\n' "$RESULT" | grep '^isolated:')"

# --- LAUNCHQUOTEREST1008: the channel state dir and the auth pane file ---
for S in "$CH" "$WD"; do
  name="$(basename "$S")"
  {
    grep '^sh_single_quote() {' "$S"
    grep -E 'STATE_DIR_ENV="export \$\{STATE_ENV_VAR\}=' "$S" | sed -E 's/^.*(STATE_DIR_ENV=)/\1/'
  } > "$TMP/state-$name.sh"
  [ "$(grep -c '^STATE_DIR_ENV=' "$TMP/state-$name.sh")" = 1 ] && pass "$name: the STATE_DIR_ENV line was found" || fail "$name: the STATE_DIR_ENV line was found"
  OUT="$(env -i PATH="$PATH" bash -c '
    STATE_ENV_VAR=TELEGRAM_STATE_DIR; MAIN_CHAN_DIR="/tmp/it'"'"'s chan dir"
    . "$1"
    bash -c "${STATE_DIR_ENV}printf \"%s\" \"\$TELEGRAM_STATE_DIR\""
  ' _ "$TMP/state-$name.sh" 2>&1)"
  assert_eq "$name: STATE_DIR_ENV exports the whole state dir" "/tmp/it's chan dir" "$OUT"
done
{
  grep '^sh_single_quote() {' "$CH"
  grep -E '^      AUTH_PANE_ENV="\. ' "$CH" | sed -E 's/^ +//'
} > "$TMP/auth.sh"
[ "$(grep -c '^AUTH_PANE_ENV=' "$TMP/auth.sh")" = 1 ] && pass "channels.sh: the AUTH_PANE_ENV line was found" || fail "channels.sh: the AUTH_PANE_ENV line was found"
mkdir -p "$TMP/it's auth"
printf 'export AUTH_PROBE=sourced\n' > "$TMP/it's auth/pane.env"
OUT="$(env -i PATH="$PATH" bash -c '
  _auth_file="$2"; . "$1"
  bash -c "${AUTH_PANE_ENV}printf \"%s\" \"\$AUTH_PROBE\""
' _ "$TMP/auth.sh" "$TMP/it's auth/pane.env" 2>&1)"
assert_eq "channels.sh: AUTH_PANE_ENV sources the whole file path" "sourced" "$OUT"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
