#!/usr/bin/env bash
# install-monitor.sh — Tracked, reproducible monitor install.
#
# Creates a versioned release directory from the compiled dist/ files,
# records the source commit, and atomically symlinks releases/monitor-current.
#
# A branch switch in the developer checkout must not affect the running
# monitor — the systemd ExecStart points at releases/monitor-current/, not
# at the shared checkout.
#
# Rollback: re-run with --rollback to point to the previous release.
#
# Usage:
#   install-monitor.sh              # build + install current commit
#   install-monitor.sh --rollback   # revert to previous release
#   install-monitor.sh --list       # list available releases
#   install-monitor.sh --status     # show current + available rollback target

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES_DIR="$REPO_ROOT/releases"
CURRENT_LINK="$RELEASES_DIR/monitor-current"
PREVIOUS_LINK="$RELEASES_DIR/monitor-previous"
MANIFEST_FILE="release.json"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

current_target() {
  if [ -L "$CURRENT_LINK" ]; then
    readlink "$CURRENT_LINK"
  else
    echo ""
  fi
}

# ── --list ───────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--list" ]; then
  if [ -d "$RELEASES_DIR" ]; then
    for d in "$RELEASES_DIR"/monitor-*/; do
      [ -d "$d" ] || continue
      basename "$d"
      if [ -f "$d/$MANIFEST_FILE" ]; then
        echo "  commit:  $(python3 -c "import json; d=json.load(open('$d/$MANIFEST_FILE')); print(d.get('commit','?'))" 2>/dev/null || echo '?')"
        echo "  installed: $(python3 -c "import json; d=json.load(open('$d/$MANIFEST_FILE')); print(d.get('installedAt','?'))" 2>/dev/null || echo '?')"
      fi
    done
  else
    echo "(no releases installed)"
  fi
  current=$(current_target)
  [ -n "$current" ] && echo "current → $current"
  exit 0
fi

# ── --status ─────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--status" ]; then
  current=$(current_target)
  echo "current:  ${current:-NONE}"
  if [ -L "$PREVIOUS_LINK" ]; then
    echo "previous: $(readlink "$PREVIOUS_LINK")"
  else
    echo "previous: NONE"
  fi
  if [ -n "$current" ] && [ -f "$CURRENT_LINK/$MANIFEST_FILE" ]; then
    python3 -c "
import json
d = json.load(open('$CURRENT_LINK/$MANIFEST_FILE'))
print(f\"  commit:     {d.get('commit','?')}\")
print(f\"  installed:  {d.get('installedAt','?')}\")
print(f\"  files:      {len(d.get('files',[]))} entries\")
" 2>/dev/null || true
  fi
  exit 0
fi

# ── --rollback ───────────────────────────────────────────────────────────────

if [ "${1:-}" = "--rollback" ]; then
  if [ ! -L "$PREVIOUS_LINK" ]; then
    die "no previous release to roll back to (previous symlink missing)"
  fi
  prev_target=$(readlink "$PREVIOUS_LINK")
  prev_dir="$RELEASES_DIR/$prev_target"
  if [ ! -d "$prev_dir" ]; then
    die "previous release directory $prev_dir does not exist"
  fi

  current=$(current_target)
  echo "Rolling back: $(basename "$prev_target")"
  echo "  current was: ${current:-NONE}"

  # Save current as the new "previous" for undo
  if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then
    ln -sfn "$current" "$PREVIOUS_LINK"
  fi

  ln -sfn "$prev_target" "$CURRENT_LINK"
  echo "  current now: $(basename "$prev_target")"
  echo "Rollback complete. systemd will use the previous release on next timer tick."
  exit 0
fi

# ── install (default) ────────────────────────────────────────────────────────

COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
SHORT="${COMMIT:0:9}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
RELEASE_ID="monitor-${SHORT}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"

# Build TypeScript → dist/
echo "=== Building monitor ==="
cd "$REPO_ROOT"
npx tsc --project tsconfig.json 2>&1 || die "TypeScript build failed"

# Create release directory
mkdir -p "$RELEASE_DIR"

# Copy compiled JS files (the monitor and its dependencies)
for f in \
  dist/web/memory-pressure-monitor.js \
  dist/web/memory-pressure-types.js \
  dist/web/memory-pressure-gate.js \
  dist/web/memory-pressure-health.js \
; do
  [ -f "$REPO_ROOT/$f" ] || die "missing build artifact: $f"
  cp "$REPO_ROOT/$f" "$RELEASE_DIR/"
done

# Copy shell dependency (list-agent-rss.sh) — the monitor calls this at runtime
cp "$REPO_ROOT/scripts/list-agent-rss.sh" "$RELEASE_DIR/"

# Write release manifest
cat > "$RELEASE_DIR/$MANIFEST_FILE" << MANIFEST
{
  "releaseId": "$RELEASE_ID",
  "commit": "$COMMIT",
  "installedAt": "$TIMESTAMP",
  "builtFrom": "scripts/install-monitor.sh",
  "files": [
    "memory-pressure-monitor.js",
    "memory-pressure-types.js",
    "memory-pressure-gate.js",
    "memory-pressure-health.js",
    "list-agent-rss.sh"
  ]
}
MANIFEST

# Atomic symlink switch: save current as previous, install new as current
current=$(current_target)
if [ -n "$current" ] && [ -d "$RELEASES_DIR/$current" ]; then
  ln -sfn "$current" "$PREVIOUS_LINK"
  echo "Saved previous: $current"
fi

ln -sfn "$RELEASE_ID" "$CURRENT_LINK"
echo "=== Installed $RELEASE_ID → releases/monitor-current ==="
echo "  commit:    $COMMIT"
echo "  timestamp: $TIMESTAMP"
echo ""
echo "systemd ExecStart now points at: $CURRENT_LINK/memory-pressure-monitor.js"
echo "Rollback available: scripts/install-monitor.sh --rollback"
