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

# ==============================================================================
# MCPDUP806: the input-line probe bracketing the unlock round.
#
# Regression origin (2026-08-06, fresh 0.3.9 install): "/mcp" typed via
# send-keys only opens the MCP manager from an EMPTY idle prompt. Two boots in
# a row typed it into a non-idle pane; each round's text parked in the input
# box, the second appended to the first ("/mcp/mcp"), the combined text was
# submitted as a PROMPT -- and while parked, the router read the session as
# busy and stopped delivering inter-agent messages to it.
#
# The probe delegates to the compiled dist/pane-state.js (the instruments the
# dashboard recovery stack trusts). dist/ is a build product and absent from a
# fresh clone, so the suite points CHANNELS_PANE_STATE_JS at a real build when
# one exists; without one the probe paths are SKIPPED loudly (the unverifiable
# path and the residue classifier below run regardless -- they are node-free).
# ==============================================================================

# $1 = label, $2 = expected first line, $3 = pane text (piped as stdin)
expect_probe() {
  local got
  got="$(printf '%s' "$3" | bash "$CHANNELS" --probe-input-state 2>/dev/null)"
  if [ "$got" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$got"; fi
}

BOX_SEP='──────────────────────────────'
PANE_STATE_JS="${CHANNELS_PANE_STATE_JS:-$INSTALL_DIR/dist/pane-state.js}"

if command -v node >/dev/null 2>&1 && [ -f "$PANE_STATE_JS" ]; then
  export CHANNELS_PANE_STATE_JS="$PANE_STATE_JS"

  PROBE_IDLE="scrollback text
$BOX_SEP
 ❯
$BOX_SEP
  ? for shortcuts"
  expect_probe "probe: empty idle prompt -> idle" idle "$PROBE_IDLE"

  PROBE_PARKED="scrollback text
$BOX_SEP
 ❯ /mcp/mcp
$BOX_SEP
  ? for shortcuts"
  expect_probe "probe: parked /mcp/mcp -> parked (the incident shape)" \
    "parked:/mcp/mcp" "$PROBE_PARKED"

  PROBE_PARKED_MSG="scrollback text
$BOX_SEP
 ❯ deploy the thing to production
$BOX_SEP
  ? for shortcuts"
  expect_probe "probe: parked human/channel text -> parked" \
    "parked:deploy the thing to production" "$PROBE_PARKED_MSG"

  PROBE_BUSY="scrollback text
✳ Deliberating… (12s · 4.2k tokens · esc to interrupt)
$BOX_SEP
 ❯
$BOX_SEP
  ? for shortcuts"
  expect_probe "probe: busy turn -> busy (never type into it)" busy "$PROBE_BUSY"

  # Claude Code >=2.1.202 renders autocomplete/placeholder hints DIM (SGR 2)
  # inside an EMPTY box; a plain capture shows them as parked text. The probe
  # reads the coloured capture so the ghost strips away and the box reads idle.
  PROBE_GHOST="scrollback text
$BOX_SEP
 ❯ $(printf '\033[2m')Try \"refactor foo\"$(printf '\033[0m')
$BOX_SEP
  ? for shortcuts"
  expect_probe "probe: dim ghost suggestion in empty box -> idle" idle "$PROBE_GHOST"

  # Welcome screen without the idle footer: nothing confirms a live empty box,
  # so the probe must refuse to certify it (unknown, not idle).
  PROBE_WELCOME=" ▐▛███▜▌   Claude Code v2.1.x
  Try \"help\" to get started"
  expect_probe "probe: footer-less welcome screen -> not idle" unknown "$PROBE_WELCOME"
else
  echo "  SKIP: probe fixtures (node or a built pane-state.js not available;"
  echo "        set CHANNELS_PANE_STATE_JS to a real build to run them)"
fi

# The fail-closed arm needs no build: without an instrument the probe must say
# so, never certify emptiness it did not measure.
_got="$(printf 'anything' | CHANNELS_PANE_STATE_JS=/nonexistent/pane-state.js bash "$CHANNELS" --probe-input-state 2>/dev/null)"
if [ "$_got" = "unverifiable" ]; then
  pass "probe: missing pane-state.js -> unverifiable (fail closed)"
else
  fail "probe: missing pane-state.js -> unverifiable (fail closed)" "unverifiable" "$_got"
fi

# --- residue classifier: cleanup may only ever clear OUR OWN probe text -------
# $1 = label, $2 = expected (own|foreign), $3 = residue text
expect_residue() {
  local got
  got="$(printf '%s' "$3" | bash "$CHANNELS" --classify-unlock-residue 2>/dev/null)"
  if [ "$got" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$got"; fi
}

expect_residue "residue: single /mcp is ours" own '/mcp'
expect_residue "residue: /mcp/mcp (the incident shape) is ours" own '/mcp/mcp'
expect_residue "residue: spaced /mcp repeats are ours" own '  /mcp /mcp  '
expect_residue "residue: /mcp plus other text is NOT ours" foreign '/mcp deploy something'
expect_residue "residue: a delivered channel block is NOT ours" foreign \
  '<channel source="plugin:telegram" chat_id="123">hello</channel>'
expect_residue "residue: empty string is NOT ours (nothing to clear)" foreign ''

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
