#!/usr/bin/env bash
# ClaudeClaw backup.
#
# What we snapshot:
#   - store/claudeclaw.db (SQLite; WAL-checkpointed before copy)
#   - store/.dashboard-token
#   - agents/*/CLAUDE.md, SOUL.md, .mcp.json
#   - agents/*/.claude/channels/telegram/.env, access.json
#   - .env (project root)
#   - scheduled-tasks.json (if present)
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
# Retention: keeps the most recent 14 archives, prunes the rest.

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

# Collect relative paths that actually exist. tar refuses missing entries
# otherwise and the whole backup fails on a fresh machine where, e.g., no
# agents have been created yet.
TMPLIST="$(mktemp -t claudeclaw-backup.XXXXXX)"
trap 'rm -f "${TMPLIST}"' EXIT

maybe_add() {
  local path="$1"
  if [[ -e "${path}" ]]; then echo "${path}" >> "${TMPLIST}"; fi
}

maybe_add store/claudeclaw.db
maybe_add store/claudeclaw.db-shm
maybe_add store/claudeclaw.db-wal
maybe_add store/.dashboard-token
maybe_add .env
maybe_add scheduled-tasks.json

# Glob across all agents. Using find so a missing dir isn't an error.
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${TMPLIST}"
fi

if [[ ! -s "${TMPLIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

tar -czf "${ARCHIVE}" -T "${TMPLIST}"
echo "backup: wrote ${ARCHIVE} ($(wc -c < "${ARCHIVE}" | awk '{print $1}') bytes)"

# Keep the newest ${KEEP} archives, drop the rest.
# Use a while-read loop instead of mapfile so this works on macOS's default
# bash 3.2 (mapfile is a bash-4 builtin).
ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  rm -f "${f}"
  echo "backup: pruned $(basename "${f}")"
done
