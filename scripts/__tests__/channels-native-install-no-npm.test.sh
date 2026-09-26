#!/bin/bash
# Contract tests for the Claude Code install/update block in scripts/channels.sh
# on hosts that use Anthropic's NATIVE installer.
#
# Why this exists (2026-09-17): a host that had migrated to the native installer
# (~/.local/bin/claude -> ~/.local/share/claude/versions/<v>) still ran the daily
# `npm install -g` from channels.sh, which re-created a SECOND, independent claude
# under the npm global prefix. The main session then came up on the npm copy
# (2.1.274) while the rest of the fleet ran the native one (2.1.265). Two installs
# on one machine is the vector that had already broken the install four times in
# one day in July.
#
# What is pinned:
#   1. native host, launcher present      -> npm is NOT called (update skipped)
#   2. native host, launcher missing       -> relinked to the newest version, npm NOT called
#   3. non-native claude, stale stamp      -> npm IS called (daily check unchanged)
#   4. no claude and no native versions    -> npm IS called (self-heal unchanged)
# 3 and 4 are the positive controls: the guard must not switch the npm path off
# for hosts that really are npm installs.
#
# The block is extracted from channels.sh (from `CLAUDE_UPDATE_STAMP=` up to the
# `CLAUDE="$(command -v claude)"` line) and run against a throwaway HOME, with
# `npm` stubbed on PATH to record every call. Nothing touches the real system.
# Negative control: CHANNELS_BIN=<pre-fix channels.sh> makes cases 1 and 2 fail.
# Run: bash scripts/__tests__/channels-native-install-no-npm.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

BLOCK="$(awk '/^CLAUDE_UPDATE_STAMP=/{on=1} /^CLAUDE="\$\(command -v claude\)"/{on=0} on' "$SRC")"
if [ -z "$BLOCK" ]; then
  echo "FAIL: could not extract the install/update block from $SRC"
  exit 1
fi

# run_case <setup-fn>  -> sets NPM_CALLS, LINK_TARGET, ERR in the caller
run_case() {
  local setup="$1" root
  root="$(mktemp -d)"
  mkdir -p "$root/home" "$root/stub" "$root/install/store"
  # npm stub: records the call, installs nothing
  cat > "$root/stub/npm" <<EOF
#!/bin/sh
echo "npm \$*" >> "$root/npm.log"
exit 0
EOF
  chmod +x "$root/stub/npm"
  "$setup" "$root"
  ERR="$(
    HOME="$root/home" \
    PATH="$root/stub:$root/home/.local/bin:/usr/bin:/bin" \
    INSTALL_DIR="$root/install" CLAUDE_PKG="@anthropic-ai/claude-code" AVX_LESS=0 \
    bash -c "$BLOCK
wait" 2>&1 >/dev/null
  )"
  NPM_CALLS="$( { wc -l < "$root/npm.log"; } 2>/dev/null | tr -d ' ')"
  NPM_CALLS="${NPM_CALLS:-0}"
  LINK_TARGET="$(readlink "$root/home/.local/bin/claude" 2>/dev/null || true)"
  LINK_TARGET="${LINK_TARGET#$root/home/}"
  rm -rf "$root"
}

make_version() {  # make_version <root> <version>
  mkdir -p "$1/home/.local/share/claude/versions"
  printf '#!/bin/sh\necho %s\n' "$2" > "$1/home/.local/share/claude/versions/$2"
  chmod +x "$1/home/.local/share/claude/versions/$2"
}

setup_native_present() {
  make_version "$1" 2.1.265
  mkdir -p "$1/home/.local/bin"
  ln -s "$1/home/.local/share/claude/versions/2.1.265" "$1/home/.local/bin/claude"
}
setup_native_launcher_missing() {
  make_version "$1" 2.1.9
  make_version "$1" 2.1.265
}
setup_npm_host() {
  printf '#!/bin/sh\necho 2.1.265\n' > "$1/stub/claude"
  chmod +x "$1/stub/claude"
}
setup_nothing() { :; }

echo "channels.sh native-install guard"

run_case setup_native_present
if [ "$NPM_CALLS" = "0" ]; then pass "native host: daily check does not call npm"
else fail "native host: daily check does not call npm" "0 npm calls" "$NPM_CALLS"; fi

run_case setup_native_launcher_missing
if [ "$NPM_CALLS" = "0" ]; then pass "native host, launcher gone: no npm self-heal"
else fail "native host, launcher gone: no npm self-heal" "0 npm calls" "$NPM_CALLS"; fi
if [ "$LINK_TARGET" = ".local/share/claude/versions/2.1.265" ]; then
  pass "native host, launcher gone: relinked to the NEWEST version"
else
  fail "native host, launcher gone: relinked to the NEWEST version" \
    ".local/share/claude/versions/2.1.265" "${LINK_TARGET:-<no link>}"
fi

run_case setup_npm_host
if [ "$NPM_CALLS" = "1" ]; then pass "npm host: daily check still calls npm (positive control)"
else fail "npm host: daily check still calls npm (positive control)" "1 npm call" "$NPM_CALLS"; fi

run_case setup_nothing
if [ "$NPM_CALLS" = "1" ]; then pass "no claude, no native versions: npm self-heal still runs (positive control)"
else fail "no claude, no native versions: npm self-heal still runs (positive control)" "1 npm call" "$NPM_CALLS"; fi

echo "channels.sh native-install guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
