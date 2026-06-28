#!/usr/bin/env bash
# Marveen off-site backup: full archive (DB + secrets + agents + skills +
# scheduled-tasks via backup.sh) -> ownCloud WebDAV, with remote retention.
#
# Off-site DR so that if the droplet dies, a new server can be rebuilt from:
#   git clone (fork)  +  the newest archive from ownCloud /Backups-Marveen/
#
# Creds: store/.owncloud-creds (OC_USER, OC_PASS, OC_DAV). Run by the daily
# scheduled task "napi-backup-offsite-push". Local retention is handled by
# backup.sh (keeps 14); this prunes the remote to the same depth.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Shared ownCloud folder (URL-encoded) so the operator sees it under "fiREG közös".
REMOTE_DIR="fiREG%20k%c3%b6z%c3%b6s/Backups-Marveen"
PASS_FILE="store/.backup-passphrase"
KEEP=30

# shellcheck disable=SC1091
set -a; . store/.owncloud-creds; set +a
: "${OC_USER:?missing OC_USER}"; : "${OC_PASS:?missing OC_PASS}"; : "${OC_DAV:?missing OC_DAV}"
[ -f "$PASS_FILE" ] || { echo "[backup-offsite] ERROR: missing $PASS_FILE" >&2; exit 1; }

echo "[backup-offsite] creating local archive..."
bash scripts/backup.sh

ARCH="$(ls -t backups/*.tar.gz | head -1)"
BASE="$(basename "$ARCH")"
echo "[backup-offsite] newest archive: $BASE ($(du -h "$ARCH" | cut -f1))"

# Encrypt (AES-256, pbkdf2) before it leaves the box -- the archive holds tokens.
ENC="backups/${BASE}.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$ARCH" -out "$ENC" -pass "file:$PASS_FILE"
echo "[backup-offsite] encrypted -> $(basename "$ENC")"

# Ensure remote collection exists (idempotent: 201 created / 405 exists).
curl -s -o /dev/null -u "$OC_USER:$OC_PASS" -X MKCOL "$OC_DAV/$REMOTE_DIR/" || true

echo "[backup-offsite] uploading encrypted archive to ownCloud..."
code=$(curl -s -o /dev/null -w "%{http_code}" -u "$OC_USER:$OC_PASS" -T "$ENC" "$OC_DAV/$REMOTE_DIR/${BASE}.enc")
if [ "$code" != "201" ] && [ "$code" != "204" ]; then
  echo "[backup-offsite] ERROR: upload HTTP $code" >&2
  exit 1
fi
echo "[backup-offsite] uploaded OK (HTTP $code)"

# Remote retention: keep the newest $KEEP claudeclaw-*.tar.gz, delete the rest.
mapfile -t REMOTE < <(curl -s -u "$OC_USER:$OC_PASS" -X PROPFIND "$OC_DAV/$REMOTE_DIR/" -H "Depth: 1" \
  | grep -oE 'claudeclaw-[0-9]{8}-[0-9]{6}\.tar\.gz\.enc' | sort -u)
total=${#REMOTE[@]}
echo "[backup-offsite] remote archives: $total (keep $KEEP)"
if [ "$total" -gt "$KEEP" ]; then
  # names sort chronologically (timestamp in filename); delete oldest overflow
  del=$(( total - KEEP ))
  for f in $(printf '%s\n' "${REMOTE[@]}" | sort | head -n "$del"); do
    dc=$(curl -s -o /dev/null -w "%{http_code}" -u "$OC_USER:$OC_PASS" -X DELETE "$OC_DAV/$REMOTE_DIR/$f")
    echo "[backup-offsite] pruned remote $f (HTTP $dc)"
  done
fi

echo "[backup-offsite] done."
