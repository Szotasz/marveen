#!/bin/bash
# Marveen Updater

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

# Pidfile gate: the dashboard's /api/updates/apply refuses to spawn a
# second update.sh while this PID is alive. Written before the tee
# setup so that a stale log write from a runaway process cannot be
# mistaken for "an update is running". Trap EXIT removes the pidfile
# on any exit path (success, preflight reject, or error).
UPDATE_PIDFILE="$INSTALL_DIR/store/update.pid"
mkdir -p "$(dirname "$UPDATE_PIDFILE")"
echo "$$" > "$UPDATE_PIDFILE"
trap 'rm -f "$UPDATE_PIDFILE"' EXIT

# Tee the full run into store/update.log so failures are inspectable
# after the fact. The dashboard launches this script detached with
# stdio: 'ignore', so without the log there is no record of why a
# run exited non-zero.
#
# Size-based rotation: if the log is over 1 MiB, roll once to .1 and
# start fresh. No dated history, no cap on .1, just enough to keep
# the store/ directory bounded while preserving one prior run.
UPDATE_LOG="$INSTALL_DIR/store/update.log"
mkdir -p "$(dirname "$UPDATE_LOG")"
if [ -f "$UPDATE_LOG" ]; then
  LOG_SIZE=$(wc -c <"$UPDATE_LOG" 2>/dev/null | tr -d ' ')
  if [ -n "$LOG_SIZE" ] && [ "$LOG_SIZE" -gt 1048576 ]; then
    mv "$UPDATE_LOG" "$UPDATE_LOG.1" 2>/dev/null || true
  fi
fi
# Pre-touch the log before the tee redirect. If the filesystem is
# read-only or out of inodes, fail here with a clear message on the
# caller's stderr instead of blowing up later via SIGPIPE when tee
# cannot open its target and the next echo writes to a closed pipe.
if ! : >> "$UPDATE_LOG" 2>/dev/null; then
  echo "HIBA: nem lehet irni a naplofajlba: $UPDATE_LOG" >&2
  echo "       ellenorizd a store/ jogosultsagait es szabad helyet." >&2
  exit 4
fi
# Redirect stdout+stderr through tee. When this shell exits, the
# write-end of the pipe closes, tee reads EOF, flushes its buffer,
# and exits -- so no explicit wait is needed.
exec > >(tee -a "$UPDATE_LOG") 2>&1

echo ""
echo -e "${BOLD}Marveen frissites...${NC} [$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
echo ""

# Guard 1: refuse to run from a non-main branch.
# 'git pull --ff-only origin main' below would exit non-zero on any
# branch whose tip is not an ancestor of origin/main -- for example
# every feature branch whose PR was squash-merged upstream. Because
# the dashboard launches this script detached with stdio: 'ignore',
# that exit is invisible to the operator: the UI silently reloads on
# the same pending-commit list. Same guard also exists server-side
# in /api/updates/apply as a 409 pre-check; this is defense-in-depth
# for manual invocations.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$CURRENT_BRANCH" = "HEAD" ] || [ -z "$CURRENT_BRANCH" ]; then
  echo -e "${RED}HIBA:${NC} A repo detached-HEAD allapotban van."
  echo "       Allj at a main branchre, majd indithatod ujra a frissitest:"
  echo "         git checkout main"
  exit 2
fi
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo -e "${RED}HIBA:${NC} A jelenlegi branch '${CURRENT_BRANCH}', nem 'main'."
  echo "       A 'git pull --ff-only origin main' csak a main branchrol fut tisztan."
  echo "       Allj at elobb a main branchre:"
  echo "         git checkout main"
  exit 2
fi

# Guard 2: refuse to run with a dirty tracked working tree.
# Untracked files (CLAUDE.md.backup-*, SOUL.md mid-edit, agent-generated
# scratchpads) are allowed -- the --untracked-files=no flag excludes
# them. Only staged or unstaged modifications to already-tracked files
# are a block.
DIRTY=$(git status --porcelain --untracked-files=no | head -n 1)
if [ -n "$DIRTY" ]; then
  echo -e "${RED}HIBA:${NC} A working tree modosult allapotban van."
  echo "       Commitold vagy stasheld a valtozasokat, majd indithatod ujra:"
  echo "         git stash"
  exit 3
fi

# Save current version
OLD_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Pull latest
echo -e "  Letoltes..."
git pull --ff-only origin main
NEW_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo -e "  ${GREEN}✓${NC} Mar a legfrissebb verzion vagy ($NEW_VERSION)"
  exit 0
fi

# Install deps if package.json changed
if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -q "package.json"; then
  echo -e "  Fuggosegek frissitese..."
  npm install --silent
fi

# Rebuild
echo -e "  Forditas..."
npm run build --silent

# Scrub any polluted TELEGRAM_BOT_TOKEN from the tmux server's global env
# (legacy installs picked this up via `set -a && source .env` in the old
# channels.sh). Leaving it there made every sub-agent poll the main bot
# token and loop on 409 Conflict. Safe to run every update.
if command -v tmux >/dev/null 2>&1; then
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
fi

# Restart services
echo -e "  Szolgaltatasok ujrainditasa..."
"$INSTALL_DIR/scripts/stop.sh"
"$INSTALL_DIR/scripts/start.sh"

echo ""
echo -e "${GREEN}✓ Frissitve: ${OLD_VERSION} -> ${NEW_VERSION}${NC}"
echo ""
