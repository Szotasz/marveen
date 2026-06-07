#!/usr/bin/env bash
# Install an opt-in, per-repo GitNexus auto-rebuild post-commit hook.
#
# After each commit the hook runs an INCREMENTAL `gitnexus analyze`
# (skip-if-up-to-date, NOT --force) in the BACKGROUND so the commit returns
# instantly, with a single-flight lock so rapid commits don't pile up. It uses
# --skip-agents-md so the working tree is never dirtied post-commit (only the
# gitignored .gitnexus/ graph is refreshed).
#
# This closes the one gap vs Graphify (commit-triggered self-updating graph)
# while keeping GitNexus's deeper query/impact layer + the fleet's existing
# integration. Idempotent: re-running updates the managed block in place and
# preserves any pre-existing post-commit hook content.
#
# Usage: install-autorebuild.sh [repo-path]   (default: current git repo)
set -euo pipefail

REPO="${1:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "error: not a git repository (pass a repo path)." >&2
  exit 1
fi
if ! command -v gitnexus >/dev/null 2>&1; then
  echo "error: gitnexus not found on PATH. Install it first (npm i -g gitnexus)." >&2
  exit 1
fi

HOOK="$REPO/.git/hooks/post-commit"
BEGIN="# >>> gitnexus-autorebuild >>>"
END="# <<< gitnexus-autorebuild <<<"

BLOCK="$BEGIN
# Managed by scripts/gitnexus/install-autorebuild.sh -- do not edit between markers.
(
  command -v gitnexus >/dev/null 2>&1 || {
    PATH=\"/opt/homebrew/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH\"
    export PATH
  }
  command -v gitnexus >/dev/null 2>&1 || exit 0
  ROOT=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
  mkdir -p \"\$ROOT/.gitnexus\" 2>/dev/null || exit 0
  LOCK=\"\$ROOT/.gitnexus/.autorebuild.lock\"
  LOG=\"\$ROOT/.gitnexus/autorebuild.log\"
  # Stale-lock guard: a kill -9 mid-rebuild can orphan the lock dir, which would
  # then skip every future rebuild. If the lock is older than 15 min, reclaim it.
  if [ -d \"\$LOCK\" ] && [ -n \"\$(find \"\$LOCK\" -maxdepth 0 -mmin +15 2>/dev/null)\" ]; then
    rmdir \"\$LOCK\" 2>/dev/null || true
  fi
  # Single-flight: if a rebuild is already running, skip -- the next commit's
  # incremental pass catches up. mkdir is atomic across processes.
  mkdir \"\$LOCK\" 2>/dev/null || exit 0
  trap 'rmdir \"\$LOCK\" 2>/dev/null' EXIT
  cd \"\$ROOT\" || exit 0
  echo \"[\$(date -u +%FT%TZ)] incremental analyze after \$(git rev-parse --short HEAD 2>/dev/null)\" >>\"\$LOG\" 2>&1
  # Incremental (no --force) + --skip-agents-md so tracked files stay clean.
  gitnexus analyze --skip-agents-md >>\"\$LOG\" 2>&1
) >/dev/null 2>&1 &
$END"

mkdir -p "$REPO/.git/hooks"

# Pure-shell in-place replace of the managed block (no awk -- BSD/macOS awk
# rejects a multi-line value passed via -v). Emits the fresh BLOCK at the old
# block's position and preserves everything outside the markers.
replace_managed_block() {  # reads $HOOK on stdin -> stdout
  in_block=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$BEGIN" ]; then
      printf '%s\n' "$BLOCK"
      in_block=1
      continue
    fi
    if [ "$line" = "$END" ]; then
      in_block=0
      continue
    fi
    [ "$in_block" = 1 ] && continue
    printf '%s\n' "$line"
  done
}

if [ -f "$HOOK" ] && grep -qF "$BEGIN" "$HOOK"; then
  # Replace the existing managed block in place (preserve surrounding content).
  tmp="$(mktemp)"
  replace_managed_block < "$HOOK" >"$tmp"
  mv "$tmp" "$HOOK"
  echo "Updated gitnexus-autorebuild block in $HOOK"
elif [ -f "$HOOK" ]; then
  # Append our block, preserving the existing hook.
  printf '\n%s\n' "$BLOCK" >>"$HOOK"
  echo "Appended gitnexus-autorebuild block to existing $HOOK"
else
  printf '#!/usr/bin/env bash\n\n%s\nexit 0\n' "$BLOCK" >"$HOOK"
  echo "Created $HOOK"
fi
chmod +x "$HOOK"
echo "Done. Commits in $REPO now trigger a background incremental GitNexus re-index."
echo "Log: $REPO/.gitnexus/autorebuild.log"
