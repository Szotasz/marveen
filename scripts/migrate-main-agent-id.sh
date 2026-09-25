#!/usr/bin/env bash
# Migrate an existing install from the hardcoded "marveen" main agent id
# to the configurable MAIN_AGENT_ID slug derived from BOT_NAME. Run this
# once after pulling the release that introduces MAIN_AGENT_ID.
#
# Behaviour:
#   * Reads BOT_NAME from .env, computes the slug.
#   * If the slug is "marveen" (default install), prints a note and exits --
#     nothing to migrate, the defaults already match.
#   * Otherwise: stops the services (launchd on macOS, systemd user units on
#     Linux), rewrites the DB rows from "marveen" to the new slug, renames the
#     unit files (plist Label keys / systemd unit names + OnFailure drop-ins),
#     writes MAIN_AGENT_ID into .env, and restarts.

# Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"

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
SYSTEMD_DIR="$HOME/.config/systemd/user"
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  launchctl unload "$PLIST_DIR/com.marveen.channels.plist" 2>/dev/null || true
  launchctl unload "$PLIST_DIR/com.marveen.dashboard.plist" 2>/dev/null || true
elif [ "$OS" = "Linux" ]; then
  # Stop and disable the old-named units before the rename. Missing units are
  # fine (partial installs); a failure to stop a RUNNING unit is not, but stop
  # returns 0 for not-loaded units, so the || true only covers no-systemd hosts.
  systemctl --user stop marveen-channels.service marveen-dashboard.service marveen-morning.timer 2>/dev/null || true
  systemctl --user disable marveen-channels.service marveen-dashboard.service marveen-morning.timer marveen-host-watchdog.service 2>/dev/null || true
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
elif [ "$OS" = "Linux" ]; then
  # Rename the systemd user units the installer created (install-linux.sh
  # [7/7]): dashboard/channels/morning(.timer)/host-watchdog/notify@. The
  # morning timer binds to its service by name stem, so renaming both files
  # keeps the binding.
  for unit in dashboard.service channels.service morning.service morning.timer host-watchdog.service 'notify@.service'; do
    OLD="$SYSTEMD_DIR/marveen-${unit}"
    NEW="$SYSTEMD_DIR/${NEW_SLUG}-${unit}"
    if [ -f "$OLD" ]; then
      mv "$OLD" "$NEW"
      echo "✓ Renamed $OLD → $NEW"
    fi
  done
  # OnFailure drop-in dirs: rename the dir AND patch the notifier reference
  # inside, or every crash of the renamed units would fire a non-existent
  # marveen-notify@ unit (silently -- OnFailure on a missing unit just logs).
  for kind in dashboard channels; do
    OLDD="$SYSTEMD_DIR/marveen-${kind}.service.d"
    NEWD="$SYSTEMD_DIR/${NEW_SLUG}-${kind}.service.d"
    if [ -d "$OLDD" ]; then
      mv "$OLDD" "$NEWD"
      if [ -f "$NEWD/onfailure.conf" ]; then
        python3 - "$NEWD/onfailure.conf" "$NEW_SLUG" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); slug = sys.argv[2]
p.write_text(p.read_text().replace('marveen-notify@', f'{slug}-notify@'))
PYEOF
      fi
      echo "✓ Renamed $OLDD → $NEWD"
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

# Rewrite any "agent": "marveen" examples in the generated CLAUDE.md so the
# agent copying the curl snippet targets the right session. Keeps a backup.
if [ -f "$INSTALL_DIR/CLAUDE.md" ]; then
  CLAUDE_MATCHES=$(grep -c '"agent": "marveen"' "$INSTALL_DIR/CLAUDE.md" 2>/dev/null || echo 0)
  CLAUDE_MATCHES=$(echo "$CLAUDE_MATCHES" | tr -d '[:space:]')
  if [ -n "$CLAUDE_MATCHES" ] && [ "$CLAUDE_MATCHES" -gt 0 ]; then
    cp "$INSTALL_DIR/CLAUDE.md" "$INSTALL_DIR/CLAUDE.md.pre-migrate-$(date +%Y%m%d-%H%M%S)"
    python3 - "$INSTALL_DIR/CLAUDE.md" "$NEW_SLUG" <<'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); slug = sys.argv[2]
p.write_text(p.read_text().replace('"agent": "marveen"', f'"agent": "{slug}"'))
PYEOF
    echo "✓ CLAUDE.md agent example updated ($CLAUDE_MATCHES occurrence(s))"
  fi
fi

# Rewrite ~/.claude/scheduled-tasks/*/task-config.json agent fields: the
# scheduler routes by this name, and "marveen" now targets a non-existent
# session on non-default installs.
SCHED_DIR="$HOME/.claude/scheduled-tasks"
if [ -d "$SCHED_DIR" ]; then
  python3 - "$SCHED_DIR" "$NEW_SLUG" <<'PYEOF'
import sys, json, pathlib
root = pathlib.Path(sys.argv[1]); slug = sys.argv[2]
fixed = 0
for cfg in root.glob('*/task-config.json'):
    try:
        data = json.loads(cfg.read_text())
    except Exception:
        continue
    if data.get('agent') == 'marveen':
        data['agent'] = slug
        cfg.write_text(json.dumps(data, indent=2))
        fixed += 1
if fixed:
    print(f'✓ Scheduled task configs updated ({fixed} file(s))')
PYEOF
fi

if [ "$OS" = "Darwin" ]; then
  launchctl load "$PLIST_DIR/com.${NEW_SLUG}.dashboard.plist" 2>/dev/null || true
  launchctl load "$PLIST_DIR/com.${NEW_SLUG}.channels.plist" 2>/dev/null || true
  echo "✓ Services restarted as com.${NEW_SLUG}.*"
elif [ "$OS" = "Linux" ]; then
  # Restart under the new names. A failed start here must NOT end in "Done.":
  # the whole point of the migration is that the services come back.
  if ! systemctl --user daemon-reload 2>/dev/null; then
    echo "WARNING: systemctl --user daemon-reload failed (no user systemd?)" >&2
  fi
  START_FAILED=0
  for u in "${NEW_SLUG}-dashboard.service" "${NEW_SLUG}-channels.service" "${NEW_SLUG}-morning.timer"; do
    if [ -f "$SYSTEMD_DIR/$u" ]; then
      if ! systemctl --user enable --now "$u"; then
        echo "ERROR: failed to enable/start $u" >&2
        START_FAILED=1
      fi
    fi
  done
  # host-watchdog is a oneshot fired at login; enable it for the next boot but
  # do not run it now (a mid-migration run would race its btime state file).
  if [ -f "$SYSTEMD_DIR/${NEW_SLUG}-host-watchdog.service" ]; then
    if ! systemctl --user enable "${NEW_SLUG}-host-watchdog.service"; then
      echo "ERROR: failed to enable ${NEW_SLUG}-host-watchdog.service" >&2
      START_FAILED=1
    fi
  fi
  if [ "$START_FAILED" -ne 0 ]; then
    echo "Migration applied, but at least one service FAILED to start -- fix and start it manually (systemctl --user status ${NEW_SLUG}-*)." >&2
    exit 1
  fi
  echo "✓ Services restarted as ${NEW_SLUG}-*"
fi

echo ""
echo "Done. Dashboard: http://localhost:${WEB_PORT:-3420}"
echo "tmux attach -t ${NEW_SLUG}-channels   (was marveen-channels)"
