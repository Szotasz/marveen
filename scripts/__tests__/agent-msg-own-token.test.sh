#!/usr/bin/env bash
# agent-msg.sh sends with the SENDER's own dashboard token when it has one.
#
# WHAT THIS GUARDS. A sub-agent's own token (agents/<name>/.dashboard-token,
# src/web/agent-tokens.ts) lets the server hold a message's `from` to the
# calling agent. The helper is the fleet's mandated send route, so if it kept
# the shared store/.dashboard-token, most `from` claims would stay unbound.
# The own file is used only when it is a regular, non-symlink file of token
# length; an explicit MARVEEN_TOKEN_FILE still wins; everything else keeps the
# shared token.
#
# Nothing leaves the machine: a curl stub records the Authorization header.
#
# Run:  bash scripts/__tests__/agent-msg-own-token.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/msgtoken.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
INST="$SANDBOX/install"; BIN="$SANDBOX/bin"
mkdir -p "$INST/scripts" "$INST/store" "$INST/agents/agent-a" "$INST/agents/agent-b" "$BIN"
cp "$ROOT/scripts/agent-msg.sh" "$INST/scripts/"
SHARED="$(printf 's%.0s' $(seq 64))"; OWN_A="$(printf 'a%.0s' $(seq 64))"
printf '%s\n' "$SHARED" > "$INST/store/.dashboard-token"
printf '%s' "$OWN_A" > "$INST/agents/agent-a/.dashboard-token"; chmod 600 "$INST/agents/agent-a/.dashboard-token"

cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in -H) case "$2" in Authorization:*) printf '%s\n' "$2" >> "$CURL_LOG" ;; esac; shift 2; continue ;; esac
  shift
done
printf '%s\n200' '{"id":1,"status":"pending"}'
STUB
chmod +x "$BIN/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"; chmod +x "$BIN/sleep"

# send <from> [VAR=value ...]: prints the bearer the helper used.
send() {
  local from="$1"; shift
  : > "$SANDBOX/curl.log"
  env -u MARVEEN_TOKEN_FILE PATH="$BIN:$PATH" CURL_LOG="$SANDBOX/curl.log" MARVEEN_HOMOGLYPH_BIN=/nonexistent "$@" \
    /bin/bash "$INST/scripts/agent-msg.sh" "$from" main-agent "hello" >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
  sed -n 's/^Authorization: Bearer //p' "$SANDBOX/curl.log" | head -1
}
is() { [ "$1" = "$2" ] && echo 0 || echo 1; }

ok "a sender with its own token file sends with it" "$(is "$(send agent-a)" "$OWN_A")" "out=$(cat "$SANDBOX/out.txt")"
ok "a sender without one keeps the shared token" "$(is "$(send agent-b)" "$SHARED")"
ok "the main agent (no agents/<main>/ token) keeps the shared token" "$(is "$(send main-agent)" "$SHARED")"
printf '%s' "$SHARED" > "$SANDBOX/explicit"
ok "an explicit MARVEEN_TOKEN_FILE still wins" "$(is "$(send agent-a MARVEEN_TOKEN_FILE="$SANDBOX/explicit")" "$SHARED")"
ok "a path-like sender name never selects a file" "$(is "$(send ../agents/agent-a)" "$SHARED")"
ln -s "$INST/agents/agent-a/.dashboard-token" "$INST/agents/agent-b/.dashboard-token"
ok "a symlinked token file is not used" "$(is "$(send agent-b)" "$SHARED")"
rm "$INST/agents/agent-b/.dashboard-token"; printf 'short' > "$INST/agents/agent-b/.dashboard-token"
ok "a truncated token file is not used" "$(is "$(send agent-b)" "$SHARED")"

echo "$((N-FAILS))/$N passed"
[ "$FAILS" = 0 ]
