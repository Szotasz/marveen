#!/bin/bash
# DEPRECATED no-op (#1305, ISSUE1305HOOKSCOPE).
#
# This installer used to copy channel-image-resize.sh into ~/.claude/hooks and
# patch the USER-GLOBAL ~/.claude/settings.json. Writing fleet hooks into the
# user-global file made them fire in the owner's own, unrelated Claude Code
# sessions (#1305), so no fleet installer may touch that file anymore.
#
# The hook is now repo-shipped: the tracked <repo>/.claude/settings.json
# registers PreToolUse(Read) -> "$CLAUDE_PROJECT_DIR/scripts/hooks/channel-image-resize.sh"
# in project scope, which Claude Code loads by cwd. There is nothing to install.
#
# The file stays because scripts/sync-hooks.sh runs every install-*-hook.sh on
# update; deleting it on old installs would only happen after their next pull,
# so a loud no-op is the safe shape. Cleanup of the old ~/.claude/hooks copies
# and stale user-global entries belongs to the global-prune round, not here.

echo "⊙ install-channel-image-hook.sh: deprecated no-op (#1305) -- the hook is repo-shipped in .claude/settings.json (project scope)"
exit 0
