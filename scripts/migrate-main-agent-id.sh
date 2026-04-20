#!/usr/bin/env bash
# Migrate an existing install from the hardcoded "marveen" main agent id
# to the configurable MAIN_AGENT_ID slug derived from BOT_NAME. Run this
# once after pulling the release that introduces MAIN_AGENT_ID.
#
# Behaviour:
#   * Reads BOT_NAME from .env, computes the slug.
#   * If the slug is "marveen" (default install), prints a note and exits --
#     nothing to migrate, the defaults already match.
#   * Otherwise: stops the launchd services, rewrites the DB rows from
#     "marveen" to the new slug, renames the plist files + Label keys,
#     writes MAIN_AGENT_ID into .env, and restarts.

set -e

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $INSTALL_DIR. Run install.sh first." >&2
  exit 1
fi

# Load BOT_NAME (and existing MAIN_AGENT_ID if present).
set -a
# shellcheck disable=SC1091
source .env
set +a

BOT_NAME="${BOT_NAME:-Marveen}"
NEW_SLUG=$(python3 - "$BOT_NAME" <<'PYEOF'
import sys, unicodedata, re
s = sys.argv[1].strip()
s = unicodedata.normalize('NFKD', s).encode('ASCII', 'ignore').decode()
s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
print(s or 'marveen')
PYEOF
)

if [ "$NEW_SLUG" = "marveen" ]; then
  echo "BOT_NAME=\"$BOT_NAME\" → slug \"marveen\" (default). Nothing to migrate."
  # Still write MAIN_AGENT_ID into .env for forward compatibility if missing.
  if ! grep -q '^MAIN_AGENT_ID=' .env; then
    echo "MAIN_AGENT_ID=marveen" >> .env
    echo "✓ MAIN_AGENT_ID=marveen added to .env"
  fi
  exit 0
fi

echo "Migrating main agent id: marveen → $NEW_SLUG (BOT_NAME=\"$BOT_NAME\")"
read -r -p "This will restart the launchd services and update the DB. Continue? (y/N) " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

PLIST_DIR="$HOME/Library/LaunchAgents"
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  launchctl unload "$PLIST_DIR/com.marveen.channels.plist" 2>/dev/null || true
  launchctl unload "$PLIST_DIR/com.marveen.dashboard.plist" 2>/dev/null || true
fi
tmux kill-session -t marveen-channels 2>/dev/null || true

# DB rewrite. Use the SQLite CLI that ships with the project.
DB="$INSTALL_DIR/store/claudeclaw.db"
if [ -f "$DB" ]; then
  sqlite3 "$DB" <<SQL
UPDATE memories        SET agent_id   = '$NEW_SLUG' WHERE agent_id   = 'marveen';
UPDATE daily_logs      SET agent_id   = '$NEW_SLUG' WHERE agent_id   = 'marveen';
UPDATE agent_messages  SET from_agent = '$NEW_SLUG' WHERE from_agent = 'marveen';
UPDATE agent_messages  SET to_agent   = '$NEW_SLUG' WHERE to_agent   = 'marveen';
UPDATE kanban_cards    SET assignee   = '$NEW_SLUG' WHERE assignee   = 'marveen';
SQL
  echo "✓ DB rows rewritten"
fi

# Rename plists + patch Label.
if [ "$OS" = "Darwin" ]; then
  for kind in channels dashboard; do
    OLD="$PLIST_DIR/com.marveen.${kind}.plist"
    NEW="$PLIST_DIR/com.${NEW_SLUG}.${kind}.plist"
    if [ -f "$OLD" ]; then
      mv "$OLD" "$NEW"
      # /bin/sed -i '' works on macOS; use a temp to stay portable.
      python3 - "$NEW" "$NEW_SLUG" "$kind" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); slug = sys.argv[2]; kind = sys.argv[3]
p.write_text(p.read_text().replace(f"com.marveen.{kind}", f"com.{slug}.{kind}"))
PYEOF
      echo "✓ Renamed $OLD → $NEW"
    fi
  done
fi

# Persist MAIN_AGENT_ID into .env (replace or append).
if grep -q '^MAIN_AGENT_ID=' .env; then
  python3 - "$NEW_SLUG" <<'PYEOF'
import sys, pathlib, re
p = pathlib.Path(".env"); slug = sys.argv[1]
p.write_text(re.sub(r'^MAIN_AGENT_ID=.*$', f'MAIN_AGENT_ID={slug}', p.read_text(), flags=re.M))
PYEOF
else
  echo "MAIN_AGENT_ID=$NEW_SLUG" >> .env
fi
echo "✓ .env updated (MAIN_AGENT_ID=$NEW_SLUG)"

if [ "$OS" = "Darwin" ]; then
  launchctl load "$PLIST_DIR/com.${NEW_SLUG}.dashboard.plist" 2>/dev/null || true
  launchctl load "$PLIST_DIR/com.${NEW_SLUG}.channels.plist" 2>/dev/null || true
  echo "✓ Services restarted as com.${NEW_SLUG}.*"
fi

echo ""
echo "Done. Dashboard: http://localhost:3420"
echo "tmux attach -t ${NEW_SLUG}-channels   (was marveen-channels)"
