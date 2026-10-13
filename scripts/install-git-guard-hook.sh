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
# `rev-parse --git-common-dir` answers RELATIVE TO THE REPO (".git"), so the
# `git -C "$ROOT"` above only looks safe: resolving that answer with a bare `cd`
# resolves it against the CALLER's cwd. Measured: started from another checkout
# this installer wrote the force-push guard into THAT repository and printed its
# success line, leaving this repo unprotected -- silent non-enforcement, which
# is the one failure a guard must not have.
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in /*) ;; *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;; esac
HOOK_DIR="$(cd "$GIT_COMMON_DIR" && pwd)/hooks"
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

# Record a pre-push.d member in pre-push.required: its name and the sha256 of the bytes just
# written. The dispatcher refuses to run if a listed member is missing or no longer matches.
register_pre_push_member() {
  local name="$1" file="$2" sum
  sum="$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file") | cut -d' ' -f1)"
  touch "$HOOK_DIR/pre-push.required"
  grep -v "^${name} " "$HOOK_DIR/pre-push.required" > "$HOOK_DIR/pre-push.required.tmp" 2>/dev/null || true
  printf '%s %s\n' "$name" "$sum" >> "$HOOK_DIR/pre-push.required.tmp"
  mv "$HOOK_DIR/pre-push.required.tmp" "$HOOK_DIR/pre-push.required"
}
register_pre_push_member "10-no-force-push-protected" "$GUARD"

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
# The members that MUST be there (pre-push.required, one name per line, written by the
# installers). A required member that is missing is as off as one that cannot run: deleting a
# gate file must not make the dispatcher quietly run fewer checks.
REQ="\$HOOK_DIR/pre-push.required"
if [ -f "\$REQ" ]; then
  while read -r req want; do
    [ -n "\$req" ] || continue
    if [ ! -e "\$HOOK_DIR/pre-push.d/\$req" ]; then
      echo "pre-push: required member \$req is missing -- BLOCKING (a gate that was installed and is gone is a gate that is off)." >&2
      status=1
      continue
    fi
    # The recorded sha256 of the member as the installer wrote it: a member whose BYTES changed
    # (replaced by "exit 0", edited by a script) is as off as one that is gone. Reinstalling
    # re-records it.
    if [ -n "\$want" ]; then
      if command -v sha256sum >/dev/null 2>&1; then have="\$(sha256sum "\$HOOK_DIR/pre-push.d/\$req" | cut -d' ' -f1)"
      elif command -v shasum >/dev/null 2>&1; then have="\$(shasum -a 256 "\$HOOK_DIR/pre-push.d/\$req" | cut -d' ' -f1)"
      else have="none"; fi
      if [ "\$have" != "\$want" ]; then
        echo "pre-push: required member \$req does not match its recorded hash (\$have) -- BLOCKING (changed since install; reinstall to re-record)." >&2
        status=1
      fi
    fi
  done < "\$REQ"
fi
for h in "\$HOOK_DIR"/pre-push.d/*; do
  [ -e "\$h" ] || continue
  # A member that is present but not executable is a gate that is OFF. Skipping it silently
  # (the old behaviour) made \`chmod -x\` a one-command way to disable any push check.
  if [ ! -x "\$h" ]; then
    echo "pre-push: \$h is not executable -- BLOCKING (a hook that cannot run is a gate that is off)." >&2
    status=1
    continue
  fi
  printf '%s\n' "\$payload" | "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

echo "✓ git-guard: force-push protection for main/master installed."
