#!/usr/bin/env bash
# Nightly backup wrapper: run scripts/backup.sh, then optionally keep a second
# copy of the newest archive in another directory (a second disk, a mounted
# share, a Windows drive under WSL).
#
# The second copy is OFF unless MARVEEN_BACKUP_COPY_DIR is set. Nothing about
# the target is built in: the archive carries live secrets (tokens, channel
# .env files), so pick a location that is not synced to a cloud service.
#
#   MARVEEN_BACKUP_COPY_DIR   directory for the second copy (unset/empty = off)
#   MARVEEN_BACKUP_COPY_KEEP  how many archives to keep there (default 7)
#   BACKUP_DIR                where backup.sh writes (default <repo>/backups)
#
# If a second copy was asked for and cannot be made (the directory is missing,
# the copy fails), the wrapper exits non-zero AFTER the primary backup
# succeeded, so a scheduler or alert sees it instead of a silent skip.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
export BACKUP_DIR

bash "${REPO_ROOT}/scripts/backup.sh"

DEST="${MARVEEN_BACKUP_COPY_DIR:-}"
if [[ -z "${DEST}" ]]; then
  exit 0
fi

KEEP="${MARVEEN_BACKUP_COPY_KEEP:-7}"
case "${KEEP}" in
  ''|*[!0-9]*|0) echo "backup-nightly: MARVEEN_BACKUP_COPY_KEEP must be a positive integer (got '${KEEP}')" >&2; exit 1 ;;
esac

if [[ ! -d "${DEST}" ]]; then
  echo "backup-nightly: MARVEEN_BACKUP_COPY_DIR '${DEST}' is not a directory; second copy NOT made" >&2
  exit 1
fi

latest="$(ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | head -1 || true)"
if [[ -z "${latest}" ]]; then
  echo "backup-nightly: no archive found in ${BACKUP_DIR}; second copy NOT made" >&2
  exit 1
fi

cp -p "${latest}" "${DEST}/"
# Retention applies only to our own archive names, never to other files there.
ls -1t "${DEST}"/claudeclaw-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup-nightly: copied $(basename "${latest}") to ${DEST} (keeping ${KEEP})"
