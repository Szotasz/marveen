#!/bin/bash
# patch-telegram-outbound-only.sh
#
# Adds an outbound-only guard to the Telegram channel plugin's getUpdates loop.
# The plugin runs its bot.start() long-poll inside an IIFE. We prefix that IIFE
# with `if (process.env.TELEGRAM_OUTBOUND_ONLY !== '1')` so that, when the env
# var is set, the plugin still exposes its reply/react/edit/download MCP tools
# (outbound) but does NOT poll getUpdates (inbound). The standalone
# marveen-channel-coordinator owns inbound polling instead -- one poller per
# token, no 409 Conflict.
#
# WHY A SCRIPT (not a committed file): the plugin lives outside this repo, in
# ~/.claude/plugins/.../telegram/server.ts, and a plugin update can overwrite it
# (upstream-drift risk). This script is idempotent and re-runnable, so it can be
# wired into deploy / post-plugin-update hooks. Ideal long-term fix is an
# upstream PR adding the flag natively.
#
# Usage: scripts/patch-telegram-outbound-only.sh [--check]
#   (no args)  apply the guard if missing (idempotent)
#   --check    exit 0 if already patched, 1 if not (no modification)

set -euo pipefail

GUARD="if (process.env.TELEGRAM_OUTBOUND_ONLY !== '1') "
ANCHOR="void (async () => {"

# Resolve the plugin server.ts. Prefer the marketplace external_plugins copy
# (the one channels.sh launches via PLUGIN_ID), fall back to the cache copy.
CANDIDATES=(
  "$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts"
  "$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6/server.ts"
)

TARGET=""
for c in "${CANDIDATES[@]}"; do
  if [ -f "$c" ]; then TARGET="$c"; break; fi
done

if [ -z "$TARGET" ]; then
  echo "ERROR: telegram plugin server.ts not found in any known location" >&2
  exit 2
fi

already_patched() {
  grep -qF "$GUARD$ANCHOR" "$TARGET"
}

if [ "${1:-}" = "--check" ]; then
  if already_patched; then
    echo "patched: $TARGET"
    exit 0
  fi
  echo "NOT patched: $TARGET" >&2
  exit 1
fi

if already_patched; then
  echo "Already patched (idempotent no-op): $TARGET"
  exit 0
fi

# The anchor must appear exactly once at column 0 (the top-level IIFE). Guard
# against an unexpected plugin layout rather than patching the wrong line.
COUNT="$(grep -cF "$ANCHOR" "$TARGET" || true)"
if [ "$COUNT" != "1" ]; then
  echo "ERROR: expected exactly 1 occurrence of anchor, found $COUNT in $TARGET (plugin changed?)" >&2
  exit 3
fi

# In-place prefix the anchor line with the guard. `if (cond) <expr-stmt>` is
# valid JS with no braces, so wrapping the IIFE this way needs no closing brace.
TMP="$(mktemp)"
# Use awk for a precise whole-line match (avoids sed delimiter/escaping pitfalls).
awk -v anchor="$ANCHOR" -v guard="$GUARD" '
  $0 == anchor { print guard $0; next }
  { print }
' "$TARGET" > "$TMP"

if ! grep -qF "$GUARD$ANCHOR" "$TMP"; then
  echo "ERROR: patch did not apply cleanly, leaving original untouched" >&2
  rm -f "$TMP"
  exit 4
fi

# Preserve permissions, then swap in.
cat "$TMP" > "$TARGET"
rm -f "$TMP"
echo "Patched: $TARGET"
echo "Set TELEGRAM_OUTBOUND_ONLY=1 (via COORDINATOR_INBOUND=1 in .env) to activate outbound-only mode."
