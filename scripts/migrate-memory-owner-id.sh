#!/usr/bin/env bash
# Backfill owner_id on memories written before multi-tenant isolation shipped.
# Safe to run multiple times (idempotent: only updates rows where owner_id IS NULL).
#
# Strategy: records without owner_id were written in a single-tenant context,
# so we assign them to ALLOWED_CHAT_ID from .env. This preserves full read
# access for the existing owner while new writes carry explicit owner_id values.
#
# Run after pulling the release that adds the owner_id column.

set -e

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $INSTALL_DIR. Run install.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ALLOWED_CHAT_ID="${ALLOWED_CHAT_ID:-}"
if [ -z "$ALLOWED_CHAT_ID" ]; then
  echo "ERROR: ALLOWED_CHAT_ID not set in .env" >&2
  exit 1
fi

DB="$INSTALL_DIR/store/claudeclaw.db"
if [ ! -f "$DB" ]; then
  echo "ERROR: Database not found at $DB" >&2
  exit 1
fi

UNOWNED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories WHERE owner_id IS NULL")
echo "Memories without owner_id: $UNOWNED"

if [ "$UNOWNED" -eq 0 ]; then
  echo "Nothing to migrate."
  exit 0
fi

echo "Assigning owner_id='$ALLOWED_CHAT_ID' to $UNOWNED records..."
sqlite3 "$DB" "UPDATE memories SET owner_id = '$ALLOWED_CHAT_ID' WHERE owner_id IS NULL"
echo "Done."
