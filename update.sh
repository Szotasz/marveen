#!/bin/bash
# Marveen Updater

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
ORANGE='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"
# ── Language (saved by installer, falls back to HU) ──────────────────────────
MARVEEN_LANG="$(cat "${INSTALL_DIR}/.lang" 2>/dev/null || echo hu)"
export MARVEEN_LANG
# shellcheck source=install-lang.sh
source "$(dirname "$0")/install-lang.sh"

# --- Outcome reporting (kills the false-success UI) ---------------------------
RESULT_STATUS="failed"
RESULT_PHASE="init"
RESULT_MSG=""
RESULT_FILE="$INSTALL_DIR/store/update.last-result"
# Once the restart is handed off to the detached finalizer, that process owns
# the outcome file. update.sh may be reaped mid-restart on Linux (dashboard
# cgroup teardown), so its EXIT trap must NOT clobber the finalizer's verdict.
FINALIZE_LAUNCHED=0

_json_escape() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

write_result() {
  local code="${1:-$?}"
  [ "$FINALIZE_LAUNCHED" = "1" ] && return 0
  mkdir -p "$INSTALL_DIR/store" 2>/dev/null || true
  printf '{"status":%s,"phase":%s,"code":%s,"old":%s,"new":%s,"message":%s,"ts":%s}\n' \
    "$(_json_escape "$RESULT_STATUS")" "$(_json_escape "$RESULT_PHASE")" "$code" \
    "$(_json_escape "${OLD_VERSION:-unknown}")" "$(_json_escape "${NEW_VERSION:-unknown}")" \
    "$(_json_escape "$RESULT_MSG")" "$(date +%s)" > "$RESULT_FILE" 2>/dev/null || true
}

retry() {
  local tries="$1" pause="$2"; shift 2
  local i=1
  while true; do
    if "$@"; then return 0; fi
    if [ "$i" -ge "$tries" ]; then return 1; fi
    echo -e "  ${DIM}retry $i/$tries...${NC}"; sleep "$pause"; pause=$(( pause * 2 )); i=$(( i + 1 ))
  done
}

health_ok() {
  local port="${WEB_PORT:-3420}" i=0
  while [ "$i" -lt 20 ]; do
    if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${port}/" 2>/dev/null; then return 0; fi
    sleep 1; i=$(( i + 1 ))
  done
  return 1
}
# ─────────────────────────────────────────────────────────────────────────────


# --- Optional modes (CLI flags or env vars) ---------------------------------
# The default run is unchanged: it pulls, installs deps, and seeds only the
# fleet skills/tasks that are MISSING (skip-if-exists), never touching copies
# the operator already has.
#
#   --reseed-fleet  (RESEED_FLEET=1)   Force-refresh the fleet-canonical seeds
#       (seed-skills/ + seed-scheduled-tasks/) to the repo's current version,
#       overwriting the already-installed copies. This is how a corrected
#       canonical seed -- e.g. a security/identity cleanup -- reaches installs
#       that already seeded the old one. User-authored skills/tasks (anything
#       NOT present under seed-*) are never touched. Runs even when the code is
#       already up to date.
#   --regen-claudemd  (REGEN_CLAUDEMD=1)   Re-render the main CLAUDE.md from
#       templates/CLAUDE.md.template using this install's .env identity. Opt-in
#       and backed up first, because the operator may have hand-edited it.
RESEED_FLEET="${RESEED_FLEET:-0}"
REGEN_CLAUDEMD="${REGEN_CLAUDEMD:-0}"
#   --rebuild  (FORCE_REBUILD=1)   Force a rebuild + restart even when the code
#       is already up to date. Manual escape hatch for the case where the
#       compiled dist/ is stale relative to the checked-out source (see the
#       build-marker self-heal in the already-latest branch below). The marker
#       normally heals this automatically; --rebuild is the explicit override.
FORCE_REBUILD="${FORCE_REBUILD:-0}"
for arg in "$@"; do
  case "$arg" in
    --reseed-fleet|--security-reseed) RESEED_FLEET=1 ;;
    --regen-claudemd) REGEN_CLAUDEMD=1 ;;
    --rebuild) FORCE_REBUILD=1 ;;
  esac
done

# Pin Node to the version the RUNNING dashboard service uses, so the native
# better-sqlite3 rebuild yields a binding the service node can load. The old
# hardcoded nvm version disagreed with .nvmrc (22) and package.json engines
# (<24); compiling for the wrong ABI crash-looped the service. Resolution:
#   1) the node exe of the live dashboard process; 2) .nvmrc via nvm; 3) PATH node.
resolve_service_node_dir() {
  local pid exe
  pid="$(pgrep -f "$INSTALL_DIR/dist/index.js" 2>/dev/null | head -n1)"
  if [ -n "$pid" ]; then
    if command -v lsof >/dev/null 2>&1; then
      exe="$(lsof -p "$pid" -Fn 2>/dev/null | awk '/\/node$/{print substr($0,2); exit}')"
    fi
    [ -z "$exe" ] && [ -r "/proc/$pid/exe" ] && exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null)"
    if [ -n "$exe" ] && [ -x "$exe" ]; then dirname "$exe"; return 0; fi
  fi
  if [ -f "$INSTALL_DIR/.nvmrc" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    local want cand
    want="$(tr -d ' \n' < "$INSTALL_DIR/.nvmrc")"
    cand="$(ls -d "$HOME"/.nvm/versions/node/v"$want"* 2>/dev/null | sort -V | tail -n1)"
    [ -n "$cand" ] && [ -x "$cand/bin/node" ] && { echo "$cand/bin"; return 0; }
  fi
  return 1
}
NODE_PIN_DIR="$(resolve_service_node_dir || true)"
if [ -n "$NODE_PIN_DIR" ] && [ -x "$NODE_PIN_DIR/node" ]; then
  export PATH="$NODE_PIN_DIR:$PATH"
  echo -e "  ${DIM}Node pin: $(node -v) (matches the running dashboard, better-sqlite3 ABI)${NC}"
fi

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
trap 'rc=$?; write_result "$rc"; rm -f "$UPDATE_PIDFILE_TMP"' EXIT
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
trap 'rc=$?; write_result "$rc"; rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP"' EXIT

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
if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
  echo -e "${BOLD}Marveen update...${NC} [$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
else
  echo -e "${BOLD}Marveen frissítés...${NC} [$(date -u +%Y-%m-%dT%H:%M:%SZ)]"
fi
echo ""

# Guard 1: derive the release branch from the current checkout and refuse
# only a detached HEAD. The pull below targets origin/<CURRENT_BRANCH>, so
# an install tracking any release branch (main, develop, ...) self-updates
# instead of being hardcoded to main. A detached HEAD is the one state with
# no branch to pull, so it is still rejected. Because the dashboard launches
# this script detached with stdio: 'ignore', a silent non-zero exit would be
# invisible to the operator (the UI just reloads on the same pending-commit
# list), so the guards exit with a readable message. The same detached-HEAD
# pre-check also exists server-side in /api/updates/apply as a 409;
# this is defense-in-depth for manual invocations.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$CURRENT_BRANCH" = "HEAD" ] || [ -z "$CURRENT_BRANCH" ]; then
  if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
    echo -e "${RED}ERROR:${NC} The repo is in detached-HEAD state."
  else
    echo -e "${RED}HIBA:${NC} A repo detached-HEAD állapotban van."
  fi
  echo "       Allj at egy release branchre, majd indithatod ujra a frissitest, pl.:"
  echo "         git checkout main"
  exit 2
fi
# The branch must exist on origin, otherwise 'git pull' below cannot find a
# ref to fast-forward to (e.g. a local-only feature branch). Fail early with
# a clear message instead of letting set -e abort mid-run.
if ! git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
  if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
    echo -e "${RED}ERROR:${NC} Branch '${CURRENT_BRANCH}' does not exist on origin."
  else
    echo -e "${RED}HIBA:${NC} A '${CURRENT_BRANCH}' branch nem létezik az origin-on."
  fi
  echo "       Csak az origin-on is meglevo (kovetett) branchrol lehet frissiteni."
  echo "       Allj at egy release branchre, pl.:"
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
    if ! git stash push -u -m "marveen-update-auto-stash $(date +%Y%m%d-%H%M%S)"; then
      if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
        echo -e "${RED}ERROR:${NC} Auto-stash failed. Check: git status"
      else
        echo -e "${RED}HIBA:${NC} Auto-stash sikertelen. Nézd meg: git status"
      fi
      exit 3
    fi
    STASHED_AUTO=1
  else
    if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
      echo -e "${RED}ERROR:${NC} The working tree has uncommitted changes."
    else
      echo -e "${RED}HIBA:${NC} A working tree módosult állapotban van."
    fi
    echo "       Commitold vagy stasheld a valtozasokat, majd indithatod ujra:"
    echo "         git stash"
    exit 3
  fi
fi

# Restore an auto-stash before an EARLY exit (AHEAD-check / pull-failure /
# build-failure below) -- any exit between the stash push above and the
# normal restore point further down would otherwise strand the operator's
# local files with no restore. Incident (2026-07-12): the AHEAD-check exit
# left scripts/imap-business-mail/*.py, billingo-report, crm-report etc.
# stashed for hours until manually recovered via `git stash apply`.
restore_stash_before_exit() {
  if [ "$STASHED_AUTO" = "1" ]; then
    echo -e "  Auto-stash visszaallitasa (korai kilepes elott)..."
    if git stash pop; then
      STASHED_AUTO=0
    else
      if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
        echo -e "${RED}WARNING:${NC} Auto-stash pop had conflicts; the stash remains in 'git stash list'."
      else
        echo -e "${RED}FIGYELEM:${NC} Auto-stash pop konfliktusos; a stash benne marad a 'git stash list'-ben."
      fi
      echo "          Manualisan kezeld: git stash list / git stash apply / git stash drop"
    fi
  fi
}

# Save current version
OLD_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Full SHA snapshot for a safe rollback: ff-only means OLD is a strict ancestor
# of NEW, so reset --hard $OLD_VERSION_FULL reverts without a force-push.
OLD_VERSION_FULL=$(git rev-parse HEAD 2>/dev/null || echo "")

# Ahead-detect: local commits not on upstream make ff-only refuse. Report it
# actionably instead of dying silently under set -e (the dominant failure).
RESULT_PHASE="pull"
AHEAD=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
if [ "${AHEAD:-0}" -gt 0 ]; then
  RESULT_MSG="A helyi checkout ${AHEAD} committal elore van az upstreamhez kepest; a fast-forward frissites nem lehetseges. Nezd meg: git log @{u}..HEAD"
  echo -e "${RED}HIBA:${NC} a helyi checkout ${AHEAD} committal elore van az upstreamhez kepest; fast-forward nem lehetseges. Nezd: git log @{u}..HEAD"
  restore_stash_before_exit
  exit 5
fi

# Pull latest, NON-fatal under set -e so a diverged/network failure is reported.
echo -e "  Letoltes (origin/${CURRENT_BRANCH})..."
if ! retry 3 3 git pull --ff-only origin "$CURRENT_BRANCH"; then
  RESULT_MSG="git pull --ff-only sikertelen (divergencia vagy halozati hiba). Nezd: git status; git log @{u}..HEAD"
  echo -e "${RED}HIBA:${NC} git pull --ff-only sikertelen origin/${CURRENT_BRANCH}."
  restore_stash_before_exit
  exit 5
fi
NEW_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# Full SHA for the build-marker (dist/.built-commit). HEAD does not change
# again in this script (no checkout), so this is the commit any build below
# produces and the value we compare the marker against.
NEW_VERSION_FULL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILT_COMMIT_FILE="$INSTALL_DIR/dist/.built-commit"

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  # Already on the latest commit -- but "no new commits" does NOT guarantee the
  # compiled dist/ matches the source. A prior update can pull new source and
  # then ABORT before building (set -e on a transient build/npm error, run
  # detached with stdio:'ignore' so the failure is invisible). That leaves
  # git=NEW + dist=OLD, and because this branch used to `exit 0`, every later
  # re-run skipped the build too -- the stale dist never self-healed (the
  # "two updates + a reboot didn't fix it" symptom). We detect it with a
  # build-marker: dist/.built-commit records the commit dist was built from.
  # If it is missing or != HEAD (or --rebuild was passed), the dist is stale,
  # so we fall through to the normal build + restart instead of exiting.
  BUILT_COMMIT="$(cat "$BUILT_COMMIT_FILE" 2>/dev/null || echo "")"
  DIST_STALE=0
  if [ ! -d "$INSTALL_DIR/dist" ] || [ "$BUILT_COMMIT" != "$NEW_VERSION_FULL" ]; then
    DIST_STALE=1
  fi

  if [ "$FORCE_REBUILD" = "1" ] || [ "$DIST_STALE" = "1" ]; then
    # Self-heal (or forced): do NOT exit, do NOT set SKIP_BUILD -- let the
    # build block below run and the script reach the end-of-run restart.
    # The dep-install diff (OLD..NEW) is empty here, so npm ci stays skipped;
    # only the rebuild + restart we actually need will run.
    if [ "$FORCE_REBUILD" = "1" ]; then
      echo -e "  ${ORANGE}↻${NC} Mar a legfrissebb verzion ($NEW_VERSION), de --rebuild -> ujraforditas + restart"
    else
      echo -e "  ${ORANGE}↻${NC} Mar a legfrissebb verzion ($NEW_VERSION), de a dist elavult (built=${BUILT_COMMIT:-none}) -> ongyogyito ujraforditas + restart"
    fi
  elif [ "$RESEED_FLEET" != "1" ] && [ "$REGEN_CLAUDEMD" != "1" ]; then
    if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
      echo -e "  ${GREEN}✓${NC} Already on the latest version ($NEW_VERSION)"
    else
      echo -e "  ${GREEN}✓${NC} Már a legfrissebb verzión vagy ($NEW_VERSION)"
    fi
    # Nothing to pull, but an auto-stash may still be sitting on top of HEAD
    # (dashboard's "stash + update" run against an already-current checkout).
    # Without this, the operator's local files stay stashed with no restore.
    restore_stash_before_exit
    exit 0
  else
    # --reseed-fleet / --regen-claudemd are explicit refresh requests, so they
    # run even when the code is already current. dist is verified fresh (marker
    # == HEAD), so skip the dep-install + build below and jump to the
    # seed/identity refresh.
    if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
      echo -e "  ${GREEN}✓${NC} Already on the latest version ($NEW_VERSION), continuing due to fleet-reseed/regen flag"
    else
      echo -e "  ${GREEN}✓${NC} Már a legfrissebb verzión ($NEW_VERSION), folytatás a kért fleet-reseed/regen miatt"
    fi
    SKIP_BUILD=1
  fi
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
  RESULT_PHASE="npm-ci"
  if ! retry 3 3 npm ci --silent; then
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
    if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
      echo -e "  WARNING: npm audit reported high-severity item(s)."
    else
      echo -e "  FIGYELEM: npm audit magas-súlyosságú tételt jelzett."
    fi
    echo -e "  A frissites folytatodik, de vizsgald meg: npm audit --omit=dev"
  fi
fi

# Native module rebuild for current Node ABI (critical when Node version changes;
# better-sqlite3 NODE_MODULE_VERSION must match the running node binary).
# Skipped on an already-up-to-date --reseed-fleet/--regen-claudemd run: the
# compiled tree did not change, only the seeded skills/tasks need refreshing.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  RESULT_PHASE="build"
  retry 2 3 npm rebuild better-sqlite3 --build-from-source --silent || true

  # Rebuild. On failure, auto-rollback to the pre-update commit (safe ff-only
  # ancestor) and rebuild that, leaving the box on a WORKING old version rather
  # than git=NEW/dist=OLD.
  echo -e "  Forditas..."
  if ! retry 2 3 npm run build --silent; then
    echo -e "${RED}HIBA:${NC} build sikertelen. Visszaallitas a korabbi verziora (${OLD_VERSION})..."
    if [ -n "$OLD_VERSION_FULL" ]; then
      git reset --hard "$OLD_VERSION_FULL" >/dev/null 2>&1 || true
      npm rebuild better-sqlite3 --build-from-source --silent 2>/dev/null || true
      npm run build --silent 2>/dev/null || true
      [ -d "$INSTALL_DIR/dist" ] && echo "$OLD_VERSION_FULL" > "$BUILT_COMMIT_FILE"
    fi
    RESULT_STATUS="rolled-back"
    RESULT_MSG="A build elbukott; a rendszer visszaallt a korabbi mukodo verziora (${OLD_VERSION}). A frissites nem ment ki."
    restore_stash_before_exit
    exit 6
  fi

  # Stamp the build-marker AFTER a successful build (set -e means we only
  # reach this line if the build succeeded). dist/.built-commit records the
  # commit dist was built from, so the already-latest branch above can detect
  # a stale dist on a later run and self-heal. `tsc` emits into dist/ without
  # wiping it, so a marker written here survives subsequent incremental builds;
  # dist/ is gitignored, so the marker is a pure runtime artifact.
  if [ -d "$INSTALL_DIR/dist" ]; then
    echo "$NEW_VERSION_FULL" > "$BUILT_COMMIT_FILE"
  fi
fi

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

# Seed skills (no template vars needed, safe without .env).
# Default: only seed MISSING skills (skip-if-exists), never clobbering the
# operator's copies. With --reseed-fleet: force-refresh the canonical copy of
# every skill that ships under seed-skills/. The loop only ever iterates the
# seed-skills/ source, so a user-authored skill that has no seed-skills/
# counterpart is never visited -- it stays untouched either way.
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"
if [ -d "$SEED_SKILLS_DIR" ]; then
  SEED_NEW=0
  SEED_SKIP=0
  SEED_FORCED=0
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    forced=0
    if [ -d "$target" ]; then
      if [ "$RESEED_FLEET" = "1" ]; then
        rm -rf "$target"
        forced=1
      else
        SEED_SKIP=$((SEED_SKIP + 1))
        continue
      fi
    fi
    mkdir -p "$target"
    for f in "$skill_dir"*; do
      [ -f "$f" ] || continue
      cp "$f" "$target/$(basename "$f")"
    done
    if [ "$forced" = "1" ]; then SEED_FORCED=$((SEED_FORCED + 1)); else SEED_NEW=$((SEED_NEW + 1)); fi
  done
  if [ "$SEED_NEW" -gt 0 ] || [ "$SEED_SKIP" -gt 0 ] || [ "$SEED_FORCED" -gt 0 ]; then
    echo -e "  ${GREEN}✓${NC} Seed skills: ${SEED_NEW} új, ${SEED_FORCED} frissítve, ${SEED_SKIP} kihagyva"
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
    SCHED_FORCED=0
    # Default skip-if-exists; --reseed-fleet force-refreshes the canonical task
    # content (SKILL.md + task-config.json). Task RUN-STATE lives in store/ (not
    # in the task dir), so it is preserved across a force-reseed. Tasks the user
    # authored themselves have no seed-scheduled-tasks/ source -> never visited.
    for tpl in "$SEED_SCHED_DIR"/*/; do
      [ -d "$tpl" ] || continue
      task_name=$(basename "$tpl")
      target="$SCHED_TARGET_DIR/$task_name"
      forced=0
      if [ -d "$target" ]; then
        if [ "$RESEED_FLEET" = "1" ]; then
          rm -rf "$target"
          forced=1
        else
          SCHED_SKIP=$((SCHED_SKIP + 1))
          continue
        fi
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
      if [ "$forced" = "1" ]; then SCHED_FORCED=$((SCHED_FORCED + 1)); else SCHED_NEW=$((SCHED_NEW + 1)); fi
    done
    if [ "$SCHED_NEW" -gt 0 ] || [ "$SCHED_SKIP" -gt 0 ] || [ "$SCHED_FORCED" -gt 0 ]; then
      echo -e "  ${GREEN}✓${NC} Seed scheduled tasks: ${SCHED_NEW} új, ${SCHED_FORCED} frissítve, ${SCHED_SKIP} kihagyva"
    fi
    # Init state files for new seeded tasks
    if [ "$SCHED_NEW" -gt 0 ]; then
      STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
      if [ ! -f "$STATE_FILE" ]; then
        echo '{"last_audit_at":null}' > "$STATE_FILE"
      fi
    fi

    # Seed bumblebee threat-intel catalogs into ~/.claude/tools/
    BB_SEED_TI="$SEED_SCHED_DIR/bumblebee-hygiene-scan/threat-intel"
    BB_TARGET_TI="$HOME/.claude/tools/bumblebee-threat-intel"
    if [ -d "$BB_SEED_TI" ] && [ ! -d "$BB_TARGET_TI" ]; then
      mkdir -p "$BB_TARGET_TI"
      cp "$BB_SEED_TI"/*.json "$BB_TARGET_TI/" 2>/dev/null
      echo -e "  ${GREEN}✓${NC} Bumblebee threat-intel katalógusok telepítve"
    fi
  fi
fi

# --- Main CLAUDE.md identity check / optional regen (fleet-reseed only) ------
# A stale install can carry hardcoded references to agents that do not exist
# here (the origin fleet's roster baked into an old template). We never know
# those names statically -- and must not bake them into the shipped updater --
# so we detect the SYMPTOM generically: inter-agent delegation targets in the
# main CLAUDE.md that are neither this install's main agent nor a real local
# sub-agent under agents/. Warn only; the operator decides (or opts into regen).
if [ "$RESEED_FLEET" = "1" ] || [ "$REGEN_CLAUDEMD" = "1" ]; then
  CLAUDE_MD="$INSTALL_DIR/CLAUDE.md"
  if [ "$REGEN_CLAUDEMD" = "1" ] && [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
    # Opt-in: re-render from the canonical template with this install's identity.
    # Back up first -- the operator may have hand-edited CLAUDE.md.
    [ -f "$CLAUDE_MD" ] && cp "$CLAUDE_MD" "$CLAUDE_MD.backup-$(date +%Y%m%d-%H%M%S)"
    REGEN_CHAT_ID=""
    [ -f "$INSTALL_DIR/.env" ] && REGEN_CHAT_ID=$(grep '^CHAT_ID=' "$INSTALL_DIR/.env" | cut -d= -f2-)
    sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
        -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
        -e "s/{{CHAT_ID}}/$REGEN_CHAT_ID/g" \
        -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
        -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
        "$INSTALL_DIR/templates/CLAUDE.md.template" > "$CLAUDE_MD"
    echo -e "  ${GREEN}✓${NC} CLAUDE.md újrarenderelve a sablonból (előző verzió mentve: CLAUDE.md.backup-*)"
  elif [ -f "$CLAUDE_MD" ]; then
    KNOWN_IDS=" ${MAIN_AGENT_ID} ${BOT_NAME} "
    if [ -d "$INSTALL_DIR/agents" ]; then
      for d in "$INSTALL_DIR"/agents/*/; do
        [ -d "$d" ] && KNOWN_IDS="${KNOWN_IDS}$(basename "$d") "
      done
    fi
    UNKNOWN=""
    while IFS= read -r tgt; do
      [ -z "$tgt" ] && continue
      case "$tgt" in *[A-Z]*) continue ;; esac           # UPPERCASE placeholder, not an id
      case "$KNOWN_IDS" in *" $tgt "*) continue ;; esac   # a real local agent
      case " $UNKNOWN " in *" $tgt "*) continue ;; esac   # dedupe
      UNKNOWN="$UNKNOWN $tgt"
    done <<INNER_EOF
$(grep -oE '"to"[[:space:]]*:[[:space:]]*"[a-z][a-z0-9_-]*"' "$CLAUDE_MD" 2>/dev/null | sed -E 's/.*"([a-z][a-z0-9_-]*)".*/\1/')
INNER_EOF
    if [ -n "$UNKNOWN" ]; then
      echo -e "  ${ORANGE}⚠${NC} A fő CLAUDE.md olyan inter-agent címzett(ek)re hivatkozik ami NEM létezik ezen az installon:${UNKNOWN}"
      echo -e "     Ez tipikusan egy régi sablon maradéka. Tisztítsd kézzel, vagy futtasd: ./update.sh --regen-claudemd"
    fi
  fi
fi

# Seed config: merge missing keys into existing store/ configs.
# Fresh install: copy if target absent. Existing install: merge new
# categories into autonomy-config.json without touching user-set levels.
SEED_CONFIG_DIR="$INSTALL_DIR/seed-config"
if [ -d "$SEED_CONFIG_DIR" ]; then
  for cfg in "$SEED_CONFIG_DIR"/*.json; do
    [ -f "$cfg" ] || continue
    cfg_name=$(basename "$cfg")
    target="$INSTALL_DIR/store/$cfg_name"
    if [ ! -f "$target" ]; then
      cp "$cfg" "$target"
      echo -e "  ${GREEN}✓${NC} Seed config: $cfg_name"
    elif [ "$cfg_name" = "autonomy-config.json" ] && command -v node >/dev/null 2>&1; then
      MERGED=$(node -e "
        const seed = JSON.parse(require('fs').readFileSync('$cfg','utf8'));
        const live = JSON.parse(require('fs').readFileSync('$target','utf8'));
        const existing = new Set(live.categories.map(c => c.key));
        let added = 0;
        for (const c of seed.categories) {
          if (!existing.has(c.key)) { live.categories.push(c); added++; }
        }
        if (added) {
          live.updated_at = Math.floor(Date.now()/1000);
          require('fs').writeFileSync('$target', JSON.stringify(live,null,2)+'\n');
        }
        console.log(added);
      " 2>/dev/null || echo "0")
      if [ "$MERGED" != "0" ] && [ -n "$MERGED" ]; then
        echo -e "  ${GREEN}✓${NC} autonomy-config.json: ${MERGED} uj kategoria merge-elve"
      fi
    fi
  done
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
          if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
            echo -e "${RED}WARNING:${NC} Slack smoke-test FAILED. Check the plugin integration."
          else
            echo -e "${RED}FIGYELEM:${NC} Slack smoke-test SIKERTELEN. Ellenőrizd a plugin integrációt."
          fi
        fi
      fi
    fi
    SLACK_REF_TMP="$(mktemp "${SLACK_REF_FILE}.XXXXXX")"
    trap 'rc=$?; write_result "$rc"; rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP" "$SLACK_REF_TMP"' EXIT
    echo "$CURRENT_REF" > "$SLACK_REF_TMP"
    mv "$SLACK_REF_TMP" "$SLACK_REF_FILE"
    trap 'rc=$?; write_result "$rc"; rm -f "$UPDATE_PIDFILE" "$UPDATE_PIDFILE_TMP"' EXIT
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
#
# Incident (2026-07-12): the build above (SKIP_BUILD branch aside) compiles
# whatever is on disk AT THAT POINT -- the pulled commit WITHOUT the
# operator's stashed local files, since the stash is not popped until here.
# A locally-added source file (e.g. a new route) therefore never made it into
# dist/, even though `git stash pop` puts it back on disk right after: the
# pop happens too late for the build that already ran. Rebuild again below,
# only when the pop actually restored something, to close that gap without
# moving the pop earlier -- an earlier pop would put local edits back on disk
# before the build-failure rollback further up, so a failed build's
# `git reset --hard` would destroy them instead of leaving them safe in the
# stash.
if [ "$STASHED_AUTO" = "1" ]; then
  echo -e "  Auto-stash visszaallitasa..."
  if git stash pop; then
    STASHED_AUTO=0
    if [ "${SKIP_BUILD:-0}" != "1" ]; then
      echo -e "  Ujraforditas a visszaallitott helyi valtozasokkal..."
      if ! retry 2 3 npm run build --silent; then
        if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
          echo -e "${RED}WARNING:${NC} Rebuild after stash-restore failed; dist/ may not reflect local changes."
        else
          echo -e "${RED}FIGYELEM:${NC} Az ujraforditas a stash-visszaallitas utan sikertelen; a dist/ lehet hogy nem tartalmazza a helyi valtozasokat."
        fi
        echo -e "          Futtasd kezzel: npm run build"
      elif [ -d "$INSTALL_DIR/dist" ]; then
        echo "$NEW_VERSION_FULL" > "$BUILT_COMMIT_FILE"
      fi
    fi
  else
    if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
      echo -e "${RED}WARNING:${NC} Auto-stash pop had conflicts; the stash remains in 'git stash list'."
    else
      echo -e "${RED}FIGYELEM:${NC} Auto-stash pop konfliktusos; a stash benne marad a 'git stash list'-ben."
    fi
    echo -e "          Manualisan kezeld: git stash list / git stash apply / git stash drop"
  fi
fi

# Restart services -- via a DETACHED finalizer.
#
# Two hard constraints force this shape:
#   1) Self-kill: when triggered from the dashboard, update.sh runs INSIDE the
#      marveen-*-dashboard systemd cgroup. stop.sh tears that cgroup down, which
#      reaps THIS script before start.sh runs -> services stay dead. setsid is
#      NOT enough (same cgroup); only a separate cgroup (systemd-run --scope)
#      survives. So the restart must run OUTSIDE our cgroup.
#   2) Health-check + rollback must ALSO survive our death. Since update.sh may
#      be reaped at stop.sh, the whole restart -> health-poll -> rollback-on-fail
#      -> write final result sequence lives in a standalone finalizer script that
#      we launch detached and then exit. The finalizer, not update.sh, owns the
#      outcome file from here on (FINALIZE_LAUNCHED guards the EXIT trap).
#
# XDG_RUNTIME_DIR is derived if unset (service env sometimes trims it), so the
# systemd-run scope can be created instead of silently falling back to a direct
# restart that self-kills and bricks the box.
FINALIZE_SCRIPT="$INSTALL_DIR/store/update-finalize.sh"
cat > "$FINALIZE_SCRIPT" <<'FINALIZE_EOF'
#!/usr/bin/env bash
# Detached update finalizer. Args:
#   $1 INSTALL_DIR  $2 OLD_FULL_SHA  $3 OLD_SHORT  $4 PORT
#   $5 RESULT_FILE  $6 BUILT_COMMIT_FILE  $7 NEW_SHORT  $8 NODE_PIN_DIR
#   $9 NOTIFY (1 = also send a channel report after the outcome; used by the
#             unattended auto-update task, silent for a dashboard-triggered run)
INSTALL_DIR="$1"; OLD_FULL="$2"; OLD_SHORT="$3"; PORT="$4"
RESULT_FILE="$5"; BUILT="$6"; NEW_SHORT="$7"; NODE_PIN_DIR="$8"; NOTIFY="${9:-0}"
[ -n "$NODE_PIN_DIR" ] && export PATH="$NODE_PIN_DIR:$PATH"
cd "$INSTALL_DIR" 2>/dev/null || true

_esc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }
_write() { # status phase code message
  printf '{"status":%s,"phase":%s,"code":%s,"old":%s,"new":%s,"message":%s,"ts":%s}\n' \
    "$(_esc "$1")" "$(_esc "$2")" "$3" "$(_esc "$OLD_SHORT")" "$(_esc "$NEW_SHORT")" \
    "$(_esc "$4")" "$(date +%s)" > "$RESULT_FILE" 2>/dev/null || true
}
# Channel report for the unattended auto-update. Plugin-independent (Bot API via
# notify.sh), because at 4am the Telegram plugin may be down and the finalizer
# runs detached with no tmux session. Silent (NOTIFY!=1) for manual runs, where
# the dashboard UI already polls /api/updates/status.
_notify() { # status
  [ "$NOTIFY" = "1" ] || return 0
  [ -x "$INSTALL_DIR/scripts/notify.sh" ] || [ -f "$INSTALL_DIR/scripts/notify.sh" ] || return 0
  local msg
  case "$1" in
    success)     msg="✅ Auto-update kesz: ${OLD_SHORT} -> ${NEW_SHORT}. A dashboard ujraindult es valaszol (health OK)." ;;
    rolled-back) msg="⚠️ Auto-update: a frissites nem sikerult (a dashboard nem indult), visszaalltunk a korabbi mukodo verziora (${OLD_SHORT}). Reszletek: store/update.log" ;;
    *)           msg="🔴 Auto-update SIKERTELEN: a dashboard a frissites ES a rollback utan sem valaszol a ${PORT} porton. Kezi beavatkozas kell. Reszletek: store/update.log" ;;
  esac
  bash "$INSTALL_DIR/scripts/notify.sh" "$msg" >/dev/null 2>&1 || true
}
_finish() { _write "$1" "$2" "$3" "$4"; _notify "$1"; exit "$3"; }
_health() { local i=0; while [ "$i" -lt 20 ]; do
  curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && return 0
  sleep 1; i=$(( i + 1 )); done; return 1; }
_restart() { "$INSTALL_DIR/scripts/stop.sh"; "$INSTALL_DIR/scripts/start.sh"; }

_restart
if _health; then _finish success restart 0 ""; fi

# Restart did not bring the dashboard back -> auto-rollback to the pre-update
# commit (safe: ff-only ancestor, no force-push, no local-change discard) and
# restart that, so the box ends on a WORKING old version.
if [ -n "$OLD_FULL" ]; then
  git reset --hard "$OLD_FULL" >/dev/null 2>&1 || true
  npm ci --silent 2>/dev/null || true
  npm rebuild better-sqlite3 --build-from-source --silent 2>/dev/null || true
  npm run build --silent 2>/dev/null || true
  [ -d "$INSTALL_DIR/dist" ] && echo "$OLD_FULL" > "$BUILT"
  _restart
fi
if _health; then
  _finish rolled-back health-check 6 "A frissites utan a dashboard nem indult el; visszaalltunk a korabbi mukodo verziora (${OLD_SHORT}). A frissites nem ment ki."
else
  _finish failed health-check 1 "A dashboard a frissites es a visszaallitas utan sem valaszol a ${PORT} porton. Kezi beavatkozas szukseges."
fi
FINALIZE_EOF
chmod +x "$FINALIZE_SCRIPT"

echo -e "  Szolgaltatasok ujrainditasa..."
RESULT_PHASE="restart"
# The finalizer owns the result file from here; do not let our EXIT trap write.
FINALIZE_LAUNCHED=1
# MARVEEN_UPDATE_NOTIFY=1 (set by the unattended auto-update task) makes the
# finalizer send a channel report after the restart+health outcome. A manual
# dashboard-triggered run leaves it unset -> silent (the UI polls the status).
FINALIZE_ARGS=("$INSTALL_DIR" "$OLD_VERSION_FULL" "$OLD_VERSION" "${WEB_PORT:-3420}" "$RESULT_FILE" "$BUILT_COMMIT_FILE" "$NEW_VERSION" "${NODE_PIN_DIR:-}" "${MARVEEN_UPDATE_NOTIFY:-0}")
XDG_RUN="${XDG_RUNTIME_DIR:-/run/user/$(id -u 2>/dev/null)}"
if command -v systemd-run >/dev/null 2>&1 && [ -d "$XDG_RUN" ]; then
  # Linux/systemd: the finalizer runs inside a transient scope whose OWN cgroup
  # is separate from the dashboard cgroup, so it survives stop.sh tearing that
  # cgroup down (which reaps update.sh). Cgroup separation -- not foreground/bg
  # -- is what guarantees survival, so we background it and return promptly; if
  # scope creation fails, fall back to a plain detached setsid run.
  XDG_RUNTIME_DIR="$XDG_RUN" systemd-run --user --scope --collect --quiet \
    bash "$FINALIZE_SCRIPT" "${FINALIZE_ARGS[@]}" \
    || setsid bash "$FINALIZE_SCRIPT" "${FINALIZE_ARGS[@]}" < /dev/null > /dev/null 2>&1 &
elif command -v setsid >/dev/null 2>&1; then
  # macOS/launchd or no user-systemd: no cgroup self-kill. Detach in the
  # background so a parent signal during restart cannot abort the health/
  # rollback sequence and update.sh returns promptly.
  setsid bash "$FINALIZE_SCRIPT" "${FINALIZE_ARGS[@]}" < /dev/null > /dev/null 2>&1 &
else
  bash "$FINALIZE_SCRIPT" "${FINALIZE_ARGS[@]}" < /dev/null > /dev/null 2>&1 &
fi

echo ""
if [[ "${MARVEEN_LANG:-hu}" == "en" ]]; then
  echo -e "${GREEN}✓ Update applied (${OLD_VERSION} -> ${NEW_VERSION}); restarting and health-checking...${NC}"
else
  echo -e "${GREEN}✓ Frissites alkalmazva (${OLD_VERSION} -> ${NEW_VERSION}); ujrainditas es health-check folyamatban...${NC}"
fi
echo ""
