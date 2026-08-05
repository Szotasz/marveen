#!/bin/bash
# Contract tests for scripts/patch-telegram-reply-to.mjs -- the idempotent local
# patch that reinjects Telegram quote-reply metadata the upstream plugin drops
# (issue #929 workaround). No real plugin is touched: the patcher's --self-test
# runs against a hermetic temp fixture, and the wiring checks below read source.
# Run: bash scripts/__tests__/patch-telegram-reply-to.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PATCHER="$INSTALL_DIR/scripts/patch-telegram-reply-to.mjs"
WATCHDOG="$INSTALL_DIR/scripts/channel-watchdog.sh"
SERVICE="$INSTALL_DIR/scripts/systemd/marveen-channels.service"
MACOS_INSTALL="$INSTALL_DIR/install-macos.sh"

RUNNER="node"
command -v node >/dev/null 2>&1 || RUNNER="bun"

echo "patch-telegram-reply-to tests"
echo "============================="

# (1) The patcher's own hermetic self-test (patch -> idempotent re-run -> no-anchor).
echo ""
echo "(1) patcher self-test"
if "$RUNNER" "$PATCHER" --self-test; then
  pass "self-test exits 0"
else
  fail "self-test exits 0"
fi

# (2) Idempotency + correct injection against a fixture that mirrors the real
#     plugin meta block, driven through --file (the path the watchdog uses).
echo ""
echo "(2) --file patch on a plugin-shaped fixture"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FIX="$TMP/server.ts"
cat > "$FIX" <<'EOF'
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...(imagePath ? { image_path: imagePath } : {}),
      },
    },
  })
EOF

OUT1="$("$RUNNER" "$PATCHER" --file "$FIX" 2>&1)"
if echo "$OUT1" | grep -q "patched"; then pass "first --file run reports patched"; else fail "first --file run reports patched ($OUT1)"; fi
if grep -q "reply_to_message_id: String(ctx.message.reply_to_message.message_id)" "$FIX"; then
  pass "reply_to_message_id injected"
else
  fail "reply_to_message_id injected"
fi
if grep -q "reply_to_text:" "$FIX"; then pass "reply_to_text injected"; else fail "reply_to_text injected"; fi
# Injection must sit between the ts anchor and the image_path spread, indented to 8 spaces.
if grep -qE '^        \.\.\.\(ctx\.message\?\.reply_to_message \? \{' "$FIX"; then
  pass "injected spread at 8-space indent"
else
  fail "injected spread at 8-space indent"
fi

SUM1="$(cksum "$FIX")"
OUT2="$("$RUNNER" "$PATCHER" --file "$FIX" 2>&1)"
SUM2="$(cksum "$FIX")"
if echo "$OUT2" | grep -q "already"; then pass "second --file run is a no-op (already)"; else fail "second --file run is a no-op ($OUT2)"; fi
if [ "$SUM1" = "$SUM2" ]; then pass "idempotent: file byte-identical on re-run"; else fail "idempotent: file byte-identical on re-run"; fi
MARK_COUNT="$(grep -c "marveen-patch:reply-to" "$FIX")"
if [ "$MARK_COUNT" = "1" ]; then pass "exactly one patch marker after two runs"; else fail "exactly one patch marker (got $MARK_COUNT)"; fi

# (3) no-anchor path: a reshaped meta block must NOT be corrupted.
echo ""
echo "(3) reshaped anchor is left untouched"
FIX2="$TMP/reshaped.ts"
sed 's/ts: new Date/timestamp: new Date/' "$TMP/server.ts" >/dev/null 2>&1 || true
cat > "$FIX2" <<'EOF'
      meta: {
        chat_id,
        timestamp: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      },
EOF
BEFORE="$(cksum "$FIX2")"
OUT3="$("$RUNNER" "$PATCHER" --file "$FIX2" 2>&1)"
AFTER="$(cksum "$FIX2")"
if echo "$OUT3" | grep -q "no-anchor"; then pass "reshaped block reports no-anchor"; else fail "reshaped block reports no-anchor ($OUT3)"; fi
if [ "$BEFORE" = "$AFTER" ]; then pass "no-anchor leaves file untouched"; else fail "no-anchor leaves file untouched"; fi

# (4) Auto-reapply is wired into the existing heartbeat + channel start.
echo ""
echo "(4) auto-reapply wiring"
if grep -q "patch-telegram-reply-to.mjs" "$WATCHDOG"; then
  pass "channel-watchdog.sh invokes the patcher (heartbeat reapply)"
else
  fail "channel-watchdog.sh invokes the patcher"
fi
if grep -q "patch-telegram-reply-to.mjs" "$SERVICE"; then
  pass "marveen-channels.service reapplies on start (ExecStartPre)"
else
  fail "marveen-channels.service reapplies on start"
fi
# macOS has no ExecStartPre/systemd-timer, so the same two reapply paths live in
# install-macos.sh's launchd plists: (a) the channels plist wraps channels.sh so
# the patcher runs before the bridge starts, and (b) a periodic reply-to-patch
# plist re-runs it on an interval. Both must invoke the patcher.
if grep -qE 'patch-telegram-reply-to\.mjs.*exec.*channels\.sh' "$MACOS_INSTALL"; then
  pass "install-macos.sh channels plist runs the patcher before channels.sh (start-time reapply)"
else
  fail "install-macos.sh channels plist runs the patcher before channels.sh"
fi
if grep -q 'com.${SERVICE_ID}.reply-to-patch' "$MACOS_INSTALL" && grep -q 'StartInterval' "$MACOS_INSTALL"; then
  pass "install-macos.sh installs the periodic reply-to-patch launchd job (watchdog-cycle reapply)"
else
  fail "install-macos.sh installs the periodic reply-to-patch launchd job"
fi
if grep -q 'launchctl load "$PLIST_DIR/${REPLY_PATCH_PLIST}.plist"' "$MACOS_INSTALL"; then
  pass "install-macos.sh loads the reply-to-patch launchd job"
else
  fail "install-macos.sh loads the reply-to-patch launchd job"
fi

# (4b) The watchdog reapply must be observable when it CANNOT run (no node/bun),
#      not silent -- the nvm/minimal-PATH failure mode (review #3).
echo ""
echo "(4b) watchdog logs a skipped patcher"
if grep -qE 'reply-to patch: SKIPPED' "$WATCHDOG"; then
  pass "channel-watchdog.sh logs when no runner is found (patcher did not start)"
else
  fail "channel-watchdog.sh logs when no runner is found"
fi

# (5) Portability: no baked-in home path or hardcoded plugin version.
echo ""
echo "(5) portability"
if grep -qE '/home/[a-z]+/' "$PATCHER"; then
  fail "patcher has an absolute /home path"
else
  pass "patcher resolves paths at runtime (no /home literal)"
fi
if grep -qE "telegram/0\.0\.[0-9]" "$PATCHER"; then
  fail "patcher hardcodes a plugin version"
else
  pass "patcher does not hardcode a plugin version"
fi

echo ""
echo "-----------------------------------------"
echo "patch-telegram-reply-to: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
