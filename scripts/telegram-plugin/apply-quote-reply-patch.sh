#!/bin/bash
# Guard for the local quote-reply-meta patch on the OFFICIAL telegram plugin
# (anthropics/claude-plugins-official). The marketplace auto-updates and a new
# plugin version silently DROPS our patch -- this script detects and reapplies.
#
# Exit codes:
#   0  = patch present, nothing to do
#   10 = patch was missing (new factory version) and reapplied CLEANLY;
#        marveen-channels needs a restart to pick it up
#   20 = patch is missing and does NOT apply (factory code changed around it);
#        manual port needed -- alert the owner, do not retry blindly
# Upstream PR tracking: once the factory plugin ships reply_to_message_id
# itself, this script starts returning 0 forever and can be retired.
set -u
PLUGIN_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
PATCH_FILE="$(dirname "$0")/quote-reply-meta.patch"
MARKER='reply_to_excerpt'

latest="$(ls -1 "$PLUGIN_DIR" 2>/dev/null | sort -V | tail -1)"
if [ -z "$latest" ]; then
  echo "FAIL: no telegram plugin version dir under $PLUGIN_DIR"
  exit 20
fi
target="$PLUGIN_DIR/$latest/server.ts"
if [ ! -f "$target" ]; then
  echo "FAIL: $target missing (plugin layout changed?)"
  exit 20
fi

if grep -q "$MARKER" "$target"; then
  echo "OK: patch present in $latest"
  exit 0
fi

cp "$target" "$target.prepatch"
if patch --forward --silent "$target" "$PATCH_FILE"; then
  echo "REAPPLIED: patch applied to NEW factory version $latest -- restart marveen-channels to activate"
  exit 10
else
  mv "$target.prepatch" "$target"   # leave the factory file untouched on failure
  echo "CONFLICT: patch no longer applies to $latest -- factory code changed, manual port needed"
  exit 20
fi
