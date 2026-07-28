#!/bin/bash
# INSTWIZ1 headless-install contract tests for install-linux.sh.
#
# Sources ONLY the helper block (between the INSTWIZ1 BEGIN/END markers, minus
# the EXIT trap) from install-linux.sh and verifies the preset/default logic,
# the MARVEEN_PROGRESS / MARVEEN_RESULT protocol, and secret redaction.
# Run: bash tests/headless-install-contract.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$SCRIPT_DIR/../install-linux.sh"
HELPERS="$(mktemp)"
trap 'rm -f "$HELPERS"' EXIT

# Extract the helper block; drop the trap line (tests manage their own exits).
sed -n '/INSTWIZ1 headless-install helpers (contract) BEGIN/,/INSTWIZ1 headless-install helpers (contract) END/p' \
  "$INSTALLER" | grep -v '^trap on_exit_emit_result EXIT$' > "$HELPERS"

[ -s "$HELPERS" ] || { echo "FAIL: helper block not found in install-linux.sh"; exit 1; }

PASS=0
FAIL=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "ok   - $name"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $name"
    echo "       expected: $(printf '%q' "$expected")"
    echo "       actual:   $(printf '%q' "$actual")"
  fi
}

# Helper: run a snippet in a fresh bash with the helpers sourced.
run_case() { # env-assignments... -- snippet
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -i PATH="$PATH" ${envs[@]+"${envs[@]}"} bash -c "source '$HELPERS'; $1" 2>&1
}

# 1) Non-interactive, no preset env -> the documented default is used,
#    even with stdin CLOSED (the EOF-abort case the contract exists for).
out="$(run_case MARVEEN_NONINTERACTIVE=1 -- '
  prompt_or_preset OWNER_NAME "Neved: " "Owner" "MARVEEN_OWNER_NAME"
  printf "%s" "$OWNER_NAME"
' </dev/null)"
check "noninteractive default (OWNER_NAME=Owner, stdin closed)" "Owner" "$out"

# 2) Non-interactive, preset env set -> preset wins over default.
out="$(run_case MARVEEN_NONINTERACTIVE=1 MARVEEN_OWNER_NAME="Teszt Elek" -- '
  prompt_or_preset OWNER_NAME "Neved: " "Owner" "MARVEEN_OWNER_NAME"
  printf "%s" "$OWNER_NAME"
' </dev/null)"
check "noninteractive preset wins (MARVEEN_OWNER_NAME)" "Teszt Elek" "$out"

# 3) Non-interactive, empty default, no preset -> empty value (BOT_TOKEN skip).
out="$(run_case MARVEEN_NONINTERACTIVE=1 -- '
  prompt_or_preset BOT_TOKEN "Token: " "" "MARVEEN_BOT_TOKEN"
  printf "[%s]" "$BOT_TOKEN"
' </dev/null)"
check "noninteractive empty default (BOT_TOKEN skip)" "[]" "$out"

# 4) Non-interactive CONTINUE_MCP has no preset env and always resolves to
#    "i" -> the MCP warning branch can never exit the installer headless.
out="$(run_case MARVEEN_NONINTERACTIVE=1 -- '
  prompt_or_preset CONTINUE_MCP "Folytatod? " "i"
  if [ "$CONTINUE_MCP" != "i" ]; then echo WOULD_EXIT; else echo CONTINUES; fi
' </dev/null)"
check "noninteractive CONTINUE_MCP never exits" "CONTINUES" "$out"

# 5) Interactive mode (no MARVEEN_NONINTERACTIVE) -> falls back to read, the
#    typed value wins and the preset env is IGNORED.
out="$(printf 'gepelt-ertek\n' | run_case MARVEEN_BOT_NAME="PresetNev" -- '
  prompt_or_preset BOT_NAME "Nev: " "Marveen" "MARVEEN_BOT_NAME"
  printf "%s" "$BOT_NAME"
')"
check "interactive read wins, preset ignored" "gepelt-ertek" "$out"

# 6) Interactive empty input + call-site default pattern (VAR=${VAR:-def})
#    behaves exactly like the pre-change script.
out="$(printf '\n' | run_case -- '
  prompt_or_preset AUTH_MODE "Mod: " "3" "MARVEEN_AUTH_MODE"
  AUTH_MODE=${AUTH_MODE:-2}
  printf "%s" "$AUTH_MODE"
')"
check "interactive empty input -> call-site default applies" "2" "$out"

# 7) emit_progress is silent without MARVEEN_JSON_PROGRESS=1.
out="$(run_case MARVEEN_NONINTERACTIVE=1 -- 'emit_progress prerequisites start')"
check "emit_progress silent when JSON progress off" "" "$out"

# 8) emit_progress emits the contract line shape.
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- 'emit_progress prerequisites start')"
check "emit_progress line shape" \
  'MARVEEN_PROGRESS {"step":"prerequisites","status":"start"}' "$out"

# 9) emit_progress detail is JSON-escaped.
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- 'emit_progress build fail "quote \" and back\\slash"')"
check "emit_progress detail JSON-escaped" \
  'MARVEEN_PROGRESS {"step":"build","status":"fail","detail":"quote \" and back\\slash"}' "$out"

# 10) Secret-looking detail is redacted (sk-ant token must never leak).
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- 'emit_progress claude-auth fail "bad key sk-ant-oat01-abc123"')"
check "emit_progress redacts sk-ant" \
  'MARVEEN_PROGRESS {"step":"claude-auth","status":"fail","detail":"[redacted]"}' "$out"

# 11) emit_result success with bundle + WEB_PORT.
out="$(run_case MARVEEN_JSON_PROGRESS=1 WEB_PORT=3421 -- 'emit_result true "" "QkFTRTY0"')"
check "emit_result ok with bundle" \
  'MARVEEN_RESULT {"ok":true,"dashboardPort":3421,"enrollBundle":"QkFTRTY0"}' "$out"

# 12) emit_result success without bundle -> enrollBundle is JSON null.
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- 'emit_result true')"
check "emit_result ok, enrollBundle null, default port" \
  'MARVEEN_RESULT {"ok":true,"dashboardPort":3420,"enrollBundle":null}' "$out"

# 13) emit_result failure carries the error and is once-only (second call is
#     a no-op, so fail() + EXIT trap can never double-emit).
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- '
  emit_result false "step npm-install: npm install sikertelen"
  emit_result true "" "SHOULD_NOT_APPEAR"
')"
check "emit_result fail + once-only" \
  'MARVEEN_RESULT {"ok":false,"dashboardPort":3420,"enrollBundle":null,"error":"step npm-install: npm install sikertelen"}' "$out"

# 14) set_step closes the previous step with ok and opens the next with start.
out="$(run_case MARVEEN_JSON_PROGRESS=1 -- '
  INSTALL_STEP="init"
  set_step prerequisites
  set_step npm-install
')"
expected='MARVEEN_PROGRESS {"step":"prerequisites","status":"start"}
MARVEEN_PROGRESS {"step":"prerequisites","status":"ok"}
MARVEEN_PROGRESS {"step":"npm-install","status":"start"}'
check "set_step transition protocol (init not closed)" "$expected" "$out"

# 15) Static regression guard: every wizard prompt goes through the helper --
#     no bare read -rp/-p prompt may remain outside the helper definition.
stray="$(grep -nE '^\s*read -r?p ' "$INSTALLER" | grep -cv '"\$__prompt"')"
check "no bare read prompts outside prompt_or_preset" "0" "$stray"

echo ""
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
