#!/bin/bash
# OLLAMACURLTIMEOUT: the Ollama step of install-linux.sh must not wait forever on an Ollama API whose packets are silently
# dropped (firewall DROP, a remote OLLAMA_URL behind a filtered LAN). Three of its probes ran curl without --max-time: the
# "is the service up" check, the 15-try wait loop after `systemctl enable --now ollama`, and the "already pulled" /api/tags
# check in ollama_pull(). Measured on a re-run over an installed host: the installer sat there 30 minutes.
# A fake curl stands in for the black hole: called WITHOUT --max-time it never returns (the dropped-packet case); with it, it
# gives up at once with curl's timeout code (28). The real blocks of install-linux.sh run against it, so a probe that loses
# its --max-time again hangs this test, and the outer timeout turns that into a FAIL.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
INST="$REPO/install-linux.sh"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
# curl: --max-time present -> timeout code at once; absent -> hang (the DROP). /api/version can be told to answer
# (FAKE_VERSION_OK=1), for the ollama_pull case whose own up-check already carries --max-time.
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
echo "curl $*" >> "$FAKE_LOG"
case "$*" in *"/api/version"*) [ "${FAKE_VERSION_OK:-}" = 1 ] && { echo '{"version":"0"}'; exit 0; } ;; esac
case " $* " in *" --max-time "*) exit 28 ;; esac
exec /bin/sleep 3600   # absolute: the PATH sleep is stubbed for the wait loop
EOF
# the wait loop sleeps between tries and starts the service through sudo/systemctl: none of that may touch the host
for b in sleep sudo systemctl; do printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/$b"; done
chmod +x "$TMP/bin/"*

# the "service up / wait loop" block: from `if ! curl ... /api/version` to its closing `fi`
START_BLOCK="$(awk '/^if ! curl -s.*\/api\/version/{p=1} p{print} p&&/^fi$/{exit}' "$INST")"
# ollama_pull() up to its first "already pulled" answer (the function body is cut where the pull itself starts)
PULL_FN="$(awk '/^ollama_pull\(\) \{/{p=1} p{print} p&&/letoltese \(\$size\)/{exit}' "$INST")"
[ -n "$PULL_FN" ] && PULL_FN="$PULL_FN
}"
[ -n "$START_BLOCK" ] || fail "the service-up block was not found in install-linux.sh"
[ -n "$PULL_FN" ] || fail "ollama_pull() was not found in install-linux.sh"

run() {   # $1 = label, $2 = the snippet, $3 = extra env; the snippet gets 20 s, the old code would hang for an hour
  : > "$TMP/log"
  if env PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log" OLLAMA_API="http://10.255.255.1:11434" $3 \
       timeout -k 2 20 /bin/bash -c "ok() { :; }; warn() { :; }; _t() { :; }; $2" >/dev/null 2>&1; then rc=0; else rc=$?; fi
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then fail "$1: did not return within 20 s (a curl without --max-time waited on the black hole)"
  else pass "$1: returned (rc $rc) within 20 s"; fi
}

echo "1. the service-up check and the wait loop"
run "start block" "$START_BLOCK" ""
n="$(grep -c '/api/version' "$TMP/log" 2>/dev/null)"; n="${n:-0}"
if [ "$n" -ge 2 ] && ! grep '/api/version' "$TMP/log" | grep -qv -- '--max-time'; then
  pass "every /api/version probe of the block carried --max-time ($n calls)"
else
  fail "a /api/version probe of the block ran without --max-time ($(grep '/api/version' "$TMP/log" | grep -v -- '--max-time' | head -1))"
fi

echo "2. ollama_pull: the /api/tags 'already pulled' check"
run "ollama_pull up to the tags check" "$PULL_FN
ollama_pull nomic-embed-text 274MB" "FAKE_VERSION_OK=1"
if grep -q '/api/tags' "$TMP/log" && ! grep '/api/tags' "$TMP/log" | grep -qv -- '--max-time'; then
  pass "the /api/tags probe carried --max-time"
else
  fail "the /api/tags probe ran without --max-time, or not at all ($(grep '/api/tags' "$TMP/log" | head -1))"
fi

echo "3. NEGATIVE control: the fake really is a black hole without --max-time"
: > "$TMP/log"
if env PATH="$TMP/bin:$PATH" FAKE_LOG="$TMP/log" timeout -k 1 3 curl -s "http://10.255.255.1:11434/api/version" >/dev/null 2>&1; then rc=0; else rc=$?; fi
[ "$rc" -eq 124 ] && pass "a bare curl to the black hole hangs (killed by the 3 s timeout)" || fail "the fake curl did not hang (rc $rc): the test would prove nothing"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
