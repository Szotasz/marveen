#!/bin/bash
# #1878 item 4 -- scripts/__tests__/test-voice-install.sh must not act by default.
# Its Docker mode removes and starts a container; its self-test mode runs
# install-voice.sh (system packages). A plain run only prints usage, the Docker
# mode only touches a marveen-voice-test* container, and the self-test mode
# refuses outside a container. docker is a recording stub: nothing real runs.
# Run: bash scripts/__tests__/test-voice-install-guard.test.sh

set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/__tests__/test-voice-install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/docker-calls"
exit 0
EOF
chmod +x "$TMP/bin/docker"
# The installer the self-test mode would run: a recording stub that fails, so even
# a script version without the container check stops here instead of installing.
cat > "$TMP/fake-installer.sh" <<EOF
#!/bin/bash
echo "installer \$*" >> "$TMP/installer-calls"
exit 1
EOF
chmod +x "$TMP/fake-installer.sh"

run() { rm -f "$TMP/docker-calls" "$TMP/installer-calls"; env -u SKIP_DOCKER -u WITH_DOCKER -u VOICE_TEST_CONTAINER -u ALLOW_HOST_INSTALL \
  PATH="$TMP/bin:$PATH" VOICE_INSTALLER="$TMP/fake-installer.sh" "$@" bash "$SCRIPT" >"$TMP/out" 2>&1; echo $?; }
calls() { cat "$TMP/docker-calls" 2>/dev/null; }

echo "1. a plain run does nothing"
rc="$(run)"
[ "$rc" = "2" ] && pass "exit 2" || fail "exit 2" "2" "$rc"
[ -z "$(calls)" ] && pass "no docker call" || fail "no docker call" "none" "$(calls)"
grep -q "WITH_DOCKER=1" "$TMP/out" && pass "prints the usage" || fail "prints the usage" "WITH_DOCKER=1 in the output" "$(head -3 "$TMP/out")"

echo "2. the Docker mode only touches its own container"
rc="$(run VOICE_TEST_CONTAINER=prod-db WITH_DOCKER=1)"
[ "$rc" = "2" ] && [ -z "$(calls)" ] && pass "a foreign container name is refused, no docker call" || fail "foreign name refused" "rc 2, no calls" "rc $rc, $(calls)"
rc="$(run WITH_DOCKER=1)"
case "$(calls)" in
  "rm -f marveen-voice-test"*) pass "the default name is used (rc $rc)" ;;
  *) fail "the default name is used" "rm -f marveen-voice-test first" "$(calls | head -1)" ;;
esac
rc="$(run WITH_DOCKER=1 VOICE_TEST_CONTAINER=marveen-voice-test-ci)"
grep -q "^rm -f marveen-voice-test-ci$" "$TMP/docker-calls" 2>/dev/null && pass "a marveen-voice-test-* name is accepted" || fail "prefixed name accepted" "rm -f marveen-voice-test-ci" "$(calls | head -1)"

echo "3. the self-test mode refuses outside a container"
if [ -f /.dockerenv ]; then
  pass "skipped: this run is inside a container"
else
  rc="$(run SKIP_DOCKER=1 INSTALL_DIR="$TMP/voice")"
  [ "$rc" = "2" ] && pass "exit 2" || fail "exit 2" "2" "$rc"
  grep -q "Voice install acceptance test" "$TMP/out" && fail "stops before the test starts" "no test banner" "banner printed" || pass "stops before the test starts"
  [ ! -f "$TMP/installer-calls" ] && pass "the installer is never reached" || fail "the installer is never reached" "no call" "$(cat "$TMP/installer-calls")"
fi

echo "4. the installer path is the overridable one everywhere"
# A source check on purpose: a live positive control would have to let the
# self-test mode reach an installer, which is exactly what must never happen here.
hard="$(grep -nE 'bash[[:space:]]+/marveen/scripts/install-voice\.sh' "$SCRIPT" | head -3)"
over="$(grep -cE 'bash "\$VOICE_INSTALLER"' "$SCRIPT")"
[ -z "$hard" ] && [ "$over" -ge 1 ] && pass "every installer call goes through \$VOICE_INSTALLER ($over)" || fail "installer calls overridable" "no hardcoded call" "${hard:-none hardcoded, $over overridable}"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
