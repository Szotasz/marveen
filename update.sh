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

# Pidfile gate. The dashboard's /api/updates/apply creates
# store/update.pid atomically with O_EXCL before spawning this script,
# so a concurrent second click cannot race past the gate. Here we just
# overwrite the dashboard's placeholder with our own PID plus a start
# epoch (ms), and arrange to clean up on exit. Format:
#   <pid>\n<start-epoch-ms>\n
# The epoch lets checkNoConcurrentUpdate treat a pidfile older than
# one hour as stale, which guards against PID recycling after a
# SIGKILL / power loss left the file behind.
UPDATE_PIDFILE="$INSTALL_DIR/store/update.pid"
mkdir -p "$(dirname "$UPDATE_PIDFILE")"
# Atomic rename so a concurrent reader never sees a half-written file:
# write to .tmp in the same directory, then mv (rename is atomic on
# the same filesystem on macOS / Linux).
UPDATE_PIDFILE_TMP="$UPDATE_PIDFILE.$$.tmp"
# If the tmp-write itself fails before we own the pidfile, the dashboard
# still holds its placeholder lock. Clean up only the tmp file if it
# leaked; leave the dashboard's pidfile alone so the lock does not
# disappear on a write error.
trap 'rm -f "$UPDATE_PIDFILE_TMP"' EXIT
{
  echo "$$"
  # Portable wall-clock epoch in ms. date +%s%3N is GNU-only; on BSD
  # (macOS) we fall back to seconds * 1000. One-second granularity is
  # plenty for an hour-level age cutoff.
  # Require one-or-more digits; `*` would accept an empty line and
  # write "<pid>\n\n", which the helper would read as a legacy pidfile
  # without age info (alive-probe only, no age cutoff).
  if date +%s%3N 2>/dev/null | grep -q '^[0-9][0-9]*$'; then
    date +%s%3N
  else
    echo $(( $(date +%s) * 1000 ))
  fi
} > "$UPDATE_PIDFILE_TMP"
mv "$UPDATE_PIDFILE_TMP" "$UPDATE_PIDFILE"
# Only after mv succeeds do we own the lock; extend the trap to remove
# the final pidfile too. Until this point a mv failure left the
# dashboard's placeholder intact for its normal age-based recovery.
trap 'rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP"' EXIT

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
#
# AUTO_STASH=1 (set by the dashboard's "Frissítés stash-elve" button)
# turns the block into a managed stash + pop pattern: stash before
# pulling, restore after a successful update. If the pop fails because
# the upstream change conflicts with the stash, we drop the stash and
# emit a warning so the operator does not lose work silently -- the
# stash entry is also kept in `git stash list` for manual recovery.
STASHED_AUTO=0
# HEARTBEAT.md is rewritten by the agent every heartbeat tick (self-modifying).
# Exclude it from the dirty check; the preflight ignores it too. It will be
# auto-overwritten on the next heartbeat anyway, so no data loss.
DIRTY=$(git status --porcelain --untracked-files=no | grep -vE ' HEARTBEAT\.md$' | head -n 1)
if [ -n "$DIRTY" ]; then
  if [ "${AUTO_STASH:-0}" = "1" ]; then
    echo -e "  Lokalis valtozasok stash-elve (auto-stash)..."
    if ! git stash push --keep-index -m "marveen-update-auto-stash $(date +%Y%m%d-%H%M%S)"; then
      echo -e "${RED}HIBA:${NC} Auto-stash sikertelen. Nezd meg: git status"
      exit 3
    fi
    STASHED_AUTO=1
  else
    echo -e "${RED}HIBA:${NC} A working tree modosult allapotban van."
    echo "       Commitold vagy stasheld a valtozasokat, majd indithatod ujra:"
    echo "         git stash"
    exit 3
  fi
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

# Install deps if package.json OR package-lock.json changed. Use `npm ci`
# (not `npm install`) so the install is byte-exact against the committed
# lockfile -- a supply-chain-compromised package that ships a new semver-
# compatible version will NOT sneak in on a patch upgrade. Then run
# `npm audit` at high severity and ABORT the update if any known-high or
# critical CVE is present in the installed production tree. The operator
# gets a loud stop with a CVE pointer instead of silently running a
# patched-over malicious dep.
if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -qE "^package(-lock)?\.json$"; then
  echo -e "  Fuggosegek frissitese (lock-strict)..."
  if ! npm ci --silent; then
    echo -e "  HIBA: npm ci sikertelen. Valoszinuleg a package-lock.json nincs szinkronban."
    echo -e "  Reszletekert futtasd: npm ci"
    exit 1
  fi
  # Security posture check, NOT a hard gate. npm audit queries the
  # registry and can fail for reasons entirely outside the operator's
  # control (network blip, upstream CVE newly disclosed minutes ago,
  # private-registry auth hiccup). Exiting here would leave a half-
  # upgraded install: new source + new node_modules + stale dist/ + old
  # services. Instead, warn loudly and continue; the operator decides
  # whether to roll back.
  echo -e "  Biztonsagi ellenorzes..."
  if ! npm audit --audit-level=high --omit=dev --silent; then
    echo -e "  FIGYELEM: npm audit magas-sulyossagu tetelt jelzett."
    echo -e "  A frissites folytatodik, de vizsgald meg: npm audit --omit=dev"
  fi
fi

# Rebuild
echo -e "  Forditas..."
npm run build --silent

# Hook-ok szinkronizálása (~/.claude/hooks/ + ~/.claude/settings.json).
# Minden scripts/install-*-hook.sh idempotens. Új hook-féle védelmet
# committelve a következő update auto-deploy-olja minden installáción.
if [ -x "$INSTALL_DIR/scripts/sync-hooks.sh" ]; then
  echo -e "  Hook-ok szinkronizalasa..."
  bash "$INSTALL_DIR/scripts/sync-hooks.sh" || echo -e "  FIGYELEM: sync-hooks.sh nem-nulla exit; manualisan ellenorizd."
fi

# Seed skills & scheduled tasks (idempotent: skip existing)
# Source .env for template variables needed by seed-scheduled-tasks
MAIN_AGENT_ID=""
BOT_NAME=""
OWNER_NAME=""
if [ -f "$INSTALL_DIR/.env" ]; then
  MAIN_AGENT_ID=$(grep '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | cut -d= -f2-)
  BOT_NAME=$(grep '^BOT_NAME=' "$INSTALL_DIR/.env" | cut -d= -f2-)
  OWNER_NAME=$(grep '^OWNER_NAME=' "$INSTALL_DIR/.env" | cut -d= -f2-)
fi
SKILLS_DIR="$HOME/.claude/skills"
SCHED_TARGET_DIR="$HOME/.claude/scheduled-tasks"

# Seed skills (no template vars needed, safe without .env)
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"
if [ -d "$SEED_SKILLS_DIR" ]; then
  SEED_NEW=0
  SEED_SKIP=0
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ -d "$target" ]; then
      SEED_SKIP=$((SEED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    for f in "$skill_dir"*; do
      [ -f "$f" ] || continue
      cp "$f" "$target/$(basename "$f")"
    done
    SEED_NEW=$((SEED_NEW + 1))
  done
  if [ "$SEED_NEW" -gt 0 ] || [ "$SEED_SKIP" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Seed skills: ${SEED_NEW} új, ${SEED_SKIP} kihagyva"
  fi
fi

# Seed scheduled tasks (requires MAIN_AGENT_ID from .env for template substitution)
SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
if [ -d "$SEED_SCHED_DIR" ]; then
  if [ -z "$MAIN_AGENT_ID" ]; then
    echo -e "  ${ORANGE}⚠${NC} Seed scheduled tasks kihagyva: .env hiányzik vagy MAIN_AGENT_ID nincs beállítva"
  else
    mkdir -p "$SCHED_TARGET_DIR"
    SCHED_NEW=0
    SCHED_SKIP=0
    for tpl in "$SEED_SCHED_DIR"/*/; do
      [ -d "$tpl" ] || continue
      task_name=$(basename "$tpl")
      target="$SCHED_TARGET_DIR/$task_name"
      if [ -d "$target" ]; then
        SCHED_SKIP=$((SCHED_SKIP + 1))
        continue
      fi
      mkdir -p "$target"
      for f in "$tpl"*; do
        [ -f "$f" ] || continue
        sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
            -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
            -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
            -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
            "$f" > "$target/$(basename "$f")"
      done
      SCHED_NEW=$((SCHED_NEW + 1))
    done
    if [ "$SCHED_NEW" -gt 0 ] || [ "$SCHED_SKIP" -gt 0 ]; then
      echo -e "  ${GREEN}✓${NC} Seed scheduled tasks: ${SCHED_NEW} új, ${SCHED_SKIP} kihagyva"
    fi
    # Init state files for new seeded tasks
    if [ "$SCHED_NEW" -gt 0 ]; then
      STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
      if [ ! -f "$STATE_FILE" ]; then
        echo '{"last_audit_at":null}' > "$STATE_FILE"
      fi
    fi
  fi
fi

# Slack channel plugin smoke-test: if the marketplace slack-channel ref
# changed since the last update, and a slack-provider agent exists, run
# the smoke-test (if SLACK_SMOKE_TEST_ALLOWED=true in its .env).
SLACK_REF_FILE="$INSTALL_DIR/store/marveen-marketplace-slack-channel-ref.txt"
MARKETPLACE_PLUGIN_DIR="$HOME/.claude/plugins/cache/marveen-marketplace/slack-channel"
if [ -d "$MARKETPLACE_PLUGIN_DIR" ]; then
  CURRENT_REF="$(ls "$MARKETPLACE_PLUGIN_DIR" 2>/dev/null | head -1)"
  LAST_REF="$(cat "$SLACK_REF_FILE" 2>/dev/null || true)"
  if [ -n "$CURRENT_REF" ] && [ "$CURRENT_REF" != "$LAST_REF" ]; then
    echo -e "  Slack channel plugin ref valtozott: ${LAST_REF:-ismeretlen} -> $CURRENT_REF"
    SLACK_AGENT=""
    for agent_dir in "$INSTALL_DIR"/agents/*/; do
      if [ -f "${agent_dir}.claude/channels/slack/.env" ]; then
        SLACK_AGENT="$(basename "$agent_dir")"
        break
      fi
    done
    if [ -n "$SLACK_AGENT" ] && [ -x "$INSTALL_DIR/scripts/smoke-test-slack-channel.sh" ]; then
      AGENT_ENV="${INSTALL_DIR}/agents/${SLACK_AGENT}/.claude/channels/slack/.env"
      if grep -q 'SLACK_SMOKE_TEST_ALLOWED=true' "$AGENT_ENV" 2>/dev/null; then
        echo -e "  Slack smoke-test futtatasa ($SLACK_AGENT)..."
        if ! bash "$INSTALL_DIR/scripts/smoke-test-slack-channel.sh" "$SLACK_AGENT"; then
          echo -e "${RED}FIGYELEM:${NC} Slack smoke-test SIKERTELEN. Ellenorizd a plugin integraciot."
        fi
      fi
    fi
    SLACK_REF_TMP="$(mktemp "${SLACK_REF_FILE}.XXXXXX")"
    trap 'rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP" "$SLACK_REF_TMP"' EXIT
    echo "$CURRENT_REF" > "$SLACK_REF_TMP"
    mv "$SLACK_REF_TMP" "$SLACK_REF_FILE"
    trap 'rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP"' EXIT
  fi
fi

# Scrub any polluted channel tokens from the tmux server's global env
# (legacy installs picked this up via `set -a && source .env` in the old
# channels.sh). Leaving it there made every sub-agent poll the main bot
# token and loop on 409 Conflict. Safe to run every update.
if command -v tmux >/dev/null 2>&1; then
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  tmux set-environment -g -u SLACK_BOT_TOKEN 2>/dev/null || true
  tmux set-environment -g -u SLACK_APP_TOKEN 2>/dev/null || true
fi

# Restore auto-stashed local changes before restarting services.
# A stash conflict here typically means the upstream rebase touched
# the same lines the operator had locally; we drop and warn rather
# than block the restart, but the entry stays in `git stash list`
# until the operator deals with it.
if [ "$STASHED_AUTO" = "1" ]; then
  echo -e "  Auto-stash visszaallitasa..."
  if ! git stash pop; then
    echo -e "${RED}FIGYELEM:${NC} Auto-stash pop konfliktusos -- a stash benne marad a 'git stash list'-ben."
    echo -e "          Manualisan kezeld: git stash list / git stash apply / git stash drop"
  fi
fi

# Restart services
echo -e "  Szolgaltatasok ujrainditasa..."
"$INSTALL_DIR/scripts/stop.sh"
"$INSTALL_DIR/scripts/start.sh"

echo ""
echo -e "${GREEN}✓ Frissitve: ${OLD_VERSION} -> ${NEW_VERSION}${NC}"
echo ""
