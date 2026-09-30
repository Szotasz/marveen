#!/bin/bash
# Contract tests for the installers' Telegram pairing step (INSTPAIRPATH930).
# Run: bash scripts/__tests__/install-pairing-access-path.test.sh
#
# Since #915 channels.sh moves the shared $HOME/.claude/channels/<provider> dir into
# the install on its first start, and the plugin writes the pending pairing code
# THERE. The pairing step kept reading the legacy path: Linux printed "access.json
# nem talalhato", macOS skipped the pairing in silence, and every interactive
# install since #915 ended up unpaired.
#
# Hermetic: _pairing_access_file is extracted from each installer and run against
# throwaway dirs; the rest are structural pins on the installer text.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

resolve() {  # $1 = installer file, $2 = install dir, $3 = legacy channel dir
  local fn
  fn="$(awk '/^_pairing_access_file\(\) \{/,/^\}$/' "$1")"
  [ -n "$fn" ] || { echo "NO-FUNCTION"; return; }
  INSTALL_DIR="$2" CHANNEL_DIR="$3" CHANNEL_PROVIDER=telegram bash -c "$fn
_pairing_access_file"
}

for INSTALLER in install-linux.sh install-macos.sh; do
  F="$REPO/$INSTALLER"
  echo "$INSTALLER: which access.json the pairing uses"
  I="$TMP/$INSTALLER/inst"; L="$TMP/$INSTALLER/legacy"
  mkdir -p "$I/.claude/channels/telegram" "$L"

  echo '{}' >"$L/access.json"
  assert_eq "only the legacy file exists (bridge not migrated yet): legacy" "$L/access.json" "$(resolve "$F" "$I" "$L")"

  echo '{}' >"$I/.claude/channels/telegram/access.json"
  assert_eq "both exist: the install-scoped one wins" "$I/.claude/channels/telegram/access.json" "$(resolve "$F" "$I" "$L")"

  rm -f "$L/access.json"
  assert_eq "migrated (legacy moved away): install-scoped" "$I/.claude/channels/telegram/access.json" "$(resolve "$F" "$I" "$L")"

  rm -f "$I/.claude/channels/telegram/access.json"
  assert_eq "neither exists: the legacy path, so the warning names a path" "$L/access.json" "$(resolve "$F" "$I" "$L")"

  # Structural: resolved AFTER the code is typed (the bot writes the pending entry
  # only after the owner's message), and read + write go to that one variable.
  TXT="$(cat "$F")"
  READ_LINE="$(grep -n 'read -rp "$(_t prompt_pair_code)" PAIR_CODE' "$F" | head -1 | cut -d: -f1)"
  RES_LINE="$(grep -n 'ACCESS_FILE="$(_pairing_access_file)"' "$F" | head -1 | cut -d: -f1)"
  if [ -n "$READ_LINE" ] && [ -n "$RES_LINE" ] && [ "$RES_LINE" -gt "$READ_LINE" ]; then
    pass "resolved after the code is read ($READ_LINE < $RES_LINE)"
  else
    fail "resolved after the code is read (read=$READ_LINE resolve=$RES_LINE)"
  fi
  assert_eq "no pairing path hardcoded to the legacy dir any more" "0" "$(grep -c 'ACCESS_FILE="$CHANNEL_DIR/access.json"' "$F")"
  assert_contains "the approval writes the same file it read" "$TXT" "with open('\$ACCESS_FILE', 'w') as f:"
  assert_contains "a missing file is said out loud" "$TXT" 'warn "access.json nem talalhato: $ACCESS_FILE"'
  echo ""
done

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
