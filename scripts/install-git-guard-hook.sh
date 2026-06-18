#!/usr/bin/env bash
# Idempotent installer: protect main/master from force-pushes (history rewrites)
# with a pre-push hook. Auto-run by scripts/sync-hooks.sh on update.
#
# Composes with any existing pre-push hook via a pre-push.d/ dispatcher: each
# executable in pre-push.d/ receives the ref list on stdin and can veto the push.
#
# Override an intentional rewrite of a protected branch:
#   ALLOW_FORCE_PUSH=1 git push ...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)/hooks"
DISPATCH="$HOOK_DIR/pre-push"
GUARD="$HOOK_DIR/pre-push.d/10-no-force-push-protected"
MARK="marveen-pre-push-dispatcher"
mkdir -p "$HOOK_DIR/pre-push.d"

# 1. The guard sub-hook: reject a non-fast-forward push to a protected branch.
cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# Reject a non-fast-forward (force / rebase / amend) push to a protected branch.
# A normal fast-forward or merge keeps the remote tip as an ancestor of the
# local tip; a rewrite does not. Override: ALLOW_FORCE_PUSH=1 git push ...
set -euo pipefail
ZERO="0000000000000000000000000000000000000000"
fail=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue            # branch deletion
  case "$remote_ref" in refs/heads/main|refs/heads/master) ;; *) continue ;; esac
  [ "$remote_sha" = "$ZERO" ] && continue           # brand-new branch
  if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    if [ "${ALLOW_FORCE_PUSH:-0}" = "1" ]; then
      echo "pre-push: ALLOW_FORCE_PUSH=1 set; permitting force-push to ${remote_ref#refs/heads/}." >&2
    else
      echo "" >&2
      echo "BLOCKED: non-fast-forward (force) push to ${remote_ref#refs/heads/}." >&2
      echo "This rewrites shared history. If truly intended: ALLOW_FORCE_PUSH=1 git push ..." >&2
      fail=1
    fi
  fi
done
exit $fail
EOF
chmod +x "$GUARD"

# 2. Dispatcher pre-push: replay stdin (the ref list) to every pre-push.d/* hook.
if [ -f "$DISPATCH" ] && ! grep -q "$MARK" "$DISPATCH" 2>/dev/null; then
  # Preserve a pre-existing, non-dispatcher pre-push by moving it under pre-push.d.
  mv "$DISPATCH" "$HOOK_DIR/pre-push.d/00-existing-prepush"
  chmod +x "$HOOK_DIR/pre-push.d/00-existing-prepush"
  echo "  (preserved existing pre-push as pre-push.d/00-existing-prepush)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $MARK : run every executable in pre-push.d/, passing the ref list to each.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
payload="\$(cat)"
status=0
for h in "\$HOOK_DIR"/pre-push.d/*; do
  [ -x "\$h" ] || continue
  printf '%s\n' "\$payload" | "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

echo "✓ git-guard: force-push protection for main/master installed."
