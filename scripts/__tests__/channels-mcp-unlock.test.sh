#!/bin/bash
# Contract tests for the /mcp post-init unlock detector in scripts/channels.sh.
#
# Regression origin (2026-07-27): the detector was a literal case-glob,
# `*"plugin:telegram@"*"✗ Failed"*`. Claude Code 2.1.220 renders the row as
# `plugin:telegram:telegram · ✘ failed` -- a different server id AND a
# different glyph (U+2718, lowercase). Neither alternative matched, so the
# unlock logged "no Failed plugin row ... check manually" and returned on
# exactly the boots where the plugin HAD failed. The bun poller never started,
# nobody long-polled Telegram, and inbound messages piled up server-side with
# the channel silently mute (5 pending updates before a human noticed).
#
# Both directions matter and both are covered here:
#   - a failed row MUST fire the unlock (the regression), and
#   - a connected/disabled row MUST NOT (firing Up+Enter+Enter on a healthy
#     plugin lands on "Disable" and takes the channel down by hand).
#
# Driven through `channels.sh --classify-mcp-pane <provider>`, which reads a
# pane on stdin and exits before touching tmux, .env or the store.
# Run: bash scripts/__tests__/channels-mcp-unlock.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug (a green test that cannot go red is
# worse than no test -- it certifies health it never checked).
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

# $1 = label, $2 = provider, $3 = expected (failed|ok), $4 = pane text
expect_classify() {
  local got
  got="$(printf '%s' "$4" | bash "$CHANNELS" --classify-mcp-pane "$2" 2>/dev/null)"
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$3" "$got"; fi
}

echo "channels.sh /mcp unlock detector"

# --- the regression: Claude Code 2.1.220 label + glyph ------------------------
# Verbatim capture from the 2026-07-27 incident (turing-channels).
PANE_2_1_220_FAILED='   Manage MCP servers
   7 servers

     User MCPs (/home/ubuntu/.claude.json)
   ❯ gmail · ✔ connected · 14 tools
     google-calendar · ✔ connected · 13 tools

     Built-in MCPs (always available)
     plugin:telegram:telegram · ✘ failed

   ※ Run claude --debug to see error logs'
expect_classify "2.1.220 failed row (✘ failed) fires unlock" telegram failed "$PANE_2_1_220_FAILED"

# --- backward compatibility: the 2.1.159 label + glyph the old glob expected --
PANE_2_1_159_FAILED='   Manage MCP servers

     plugin:telegram@claude-plugins-official · ✗ Failed'
expect_classify "2.1.159 failed row (✗ Failed) still fires unlock" telegram failed "$PANE_2_1_159_FAILED"

# --- healthy rows must never fire (Up+Enter+Enter would hit "Disable") --------
PANE_CONNECTED='   Manage MCP servers

     plugin:telegram:telegram · ✔ connected · 8 tools'
expect_classify "connected row does not fire" telegram ok "$PANE_CONNECTED"

PANE_DISABLED='   Manage MCP servers

     plugin:telegram:telegram (disabled)'
expect_classify "disabled row does not fire" telegram ok "$PANE_DISABLED"

# A pane with no plugin row at all (capture failed, menu never opened) is
# inconclusive, not a failure -- the dashboard health monitor owns that case.
expect_classify "pane without a plugin row does not fire" telegram ok "   Manage MCP servers
   0 servers"
expect_classify "empty pane does not fire" telegram ok ""

# --- a scrollback mention of the plugin id is not the /mcp row ----------------
# The launch banner names the plugin, and an unrelated error elsewhere in the
# pane must not combine with it into a false positive.
PANE_BANNER_ONLY='  Listening for channel messages from: plugin:telegram@claude-plugins-official
  ⎿  Error: some unrelated tool call failed

     plugin:telegram:telegram · ✔ connected · 8 tools'
expect_classify "banner + unrelated error, plugin connected: does not fire" telegram ok "$PANE_BANNER_ONLY"

# --- other providers resolve their own pane id -------------------------------
# Keep in sync with pluginPaneId in src/channel-provider.ts.
expect_classify "slack failed row fires unlock" slack failed \
  '     plugin:slack-channel:marveen-marketplace · ✘ failed'
expect_classify "discord failed row fires unlock" discord failed \
  '     plugin:discord:discord · ✘ failed'
expect_classify "telegram detector ignores a failed slack row" telegram ok \
  '     plugin:slack-channel:marveen-marketplace · ✘ failed'

# --- other failure vocabulary (mirrors PLUGIN_FAILED_RX) ---------------------
expect_classify "disconnected row fires unlock" telegram failed \
  '     plugin:telegram:telegram · ✘ disconnected'

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
