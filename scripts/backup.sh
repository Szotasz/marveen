#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/claudeclaw.db (+ -shm/-wal; WAL-checkpointed before copy)
#     store/.dashboard-token   (dashboard bearer)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
# Retention: keeps the most recent 14 archives, prunes the rest.
#
# Restore (preserve modes so the 0600 token files stay private):
#   tar -xpzf <archive> -C /tmp/restore        # inspect first
#   then copy repo/* into the project root and home/* into $HOME.
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
KEEP=14

mkdir -p "${BACKUP_DIR}"
cd "${REPO_ROOT}"

# Checkpoint WAL into the main DB file so the snapshot is self-contained.
# Tolerate a missing sqlite3 CLI -- just fall back to copying the files as-is.
if [[ -f store/claudeclaw.db ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
STAGE="$(mktemp -d -t claudeclaw-stage.XXXXXX)"
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"; rm -rf "${STAGE}"' EXIT

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-shm
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-wal
add_if "${REPOLIST}" "${REPO_ROOT}" store/.dashboard-token
add_if "${REPOLIST}" "${REPO_ROOT}" store/config-overrides.json
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
fi

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
fi

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "Restore: tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME."
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )
echo "backup: wrote ${ARCHIVE} ($(wc -c < "${ARCHIVE}" | awk '{print $1}') bytes)"

# The archive contains sensitive tokens (dashboard bearer, channel bot tokens,
# project .env secrets). Do not auto-sync ${BACKUP_DIR} to iCloud, Dropbox,
# Google Drive, or any other cloud-backup folder. Keep it local.
echo "backup: WARNING -- archive contains sensitive tokens; keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${KEEP} archives, drop the rest. while-read (not mapfile)
# for macOS bash 3.2 compatibility.
ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  rm -f "${f}"
  echo "backup: pruned $(basename "${f}")"
done
