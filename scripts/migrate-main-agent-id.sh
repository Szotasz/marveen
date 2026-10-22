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

# Read BOT_NAME from .env as a LITERAL, never by sourcing the file: .env is data
# (a fleet import writes its identity values into it), and `source` would run
# any $(...) or backticks a value holds (FLEETIMPORTFOLLOW1021). The shapes
# source accepted read the same: "..." or '...' quotes, an export prefix, a
# trailing " # comment" on a bare value, the last assignment wins. Without a
# BOT_NAME line the caller's environment applies, then the default.
# A function, not a heredoc inside $(...): bash 3.2 (macOS) misparses a quote
# in a heredoc that sits inside a command substitution.
read_env_bot_name() {
  python3 - "$1" <<'PYEOF'
import re, sys
val = None
with open(sys.argv[1], encoding='utf-8', errors='replace') as fh:
    for line in fh:
        m = re.match(r'\s*(?:export\s+)?BOT_NAME=(.*)$', line.rstrip('\r\n'))
        if not m:
            continue
        v = m.group(1).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        else:
            v = re.split(r'\s+#', v, maxsplit=1)[0].strip()
        val = v
print(val or '', end='')
PYEOF
}
ENV_BOT_NAME="$(read_env_bot_name .env)"
BOT_NAME="${ENV_BOT_NAME:-${BOT_NAME:-Marveen}}"
NEW_SLUG=$(python3 - "$BOT_NAME" <<'PYEOF'
import sys, unicodedata, re
s = sys.argv[1].strip()
s = unicodedata.normalize('NFKD', s).encode('ASCII', 'ignore').decode()
s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
print(s or 'marveen')
PYEOF
)

# An id the message layer already owns, or a sub-agent's name, cannot become the
# main agent's (FLEETRESERVEDNAME1021): 'system' is refused on every POST, so a
# main agent named that could not send. Checked before anything is stopped.
# The fixed list is FIXED_RESERVED_AGENT_IDS in src/web/sanitize.ts; a test keeps
# them equal.
# The voice channel id is configurable (VOICECHANNELID1022): it is VOICE_CHANNEL_ID
# resolved EXACTLY as the dashboard resolves it, so the id refused here is the one
# the dashboard reserves. Two halves, both mirrored:
#   * the .env grammar of src/env-parse.ts parseEnvContent, NOT the BOT_NAME reader
#     above: no "export" prefix, no trailing "# comment" (both stay part of the key
#     or the value), one pair of matching quotes stripped, JS String.trim()
#     whitespace, the last assignment wins, a missing .env reads as empty;
#   * the rule of resolveVoiceChannelId in src/config.ts: a canonical agent id
#     that is not a fixed reserved id, else 'hanna'.
# src/__tests__/voice-channel-id-script-parity.test.ts runs this resolver against
# the dashboard's on the same .env files. A function for the same bash 3.2 reason
# as read_env_bot_name above.
RESERVED_AGENT_IDS="system heartbeat telegram-coordinator channel-coordinator"
resolve_voice_channel_id() {
  python3 - "$@" <<'PYEOF'
import re, sys
env_path, fixed = sys.argv[1], sys.argv[2].split()
JS_WS = ('\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
         '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
def trim(t):
    return t.strip(JS_WS)
try:
    with open(env_path, encoding='utf-8', errors='replace') as fh:
        content = fh.read()
except OSError:
    content = ''
env = {}
for line in content.split('\n'):
    t = trim(line)
    if not t or t.startswith('#'):
        continue
    i = t.find('=')
    if i == -1:
        continue
    key, val = trim(t[:i]), trim(t[i + 1:])
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        val = val[1:-1]
    env[key] = val
v = trim(env.get('VOICE_CHANNEL_ID', ''))
if v and len(v) <= 50 and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', v) and v not in fixed:
    print(v, end='')
else:
    print('hanna', end='')
PYEOF
}
VOICE_CHANNEL_ID="$(resolve_voice_channel_id "$INSTALL_DIR/.env" "$RESERVED_AGENT_IDS")"
RESERVED_AGENT_IDS="$RESERVED_AGENT_IDS $VOICE_CHANNEL_ID"
case " $RESERVED_AGENT_IDS " in
  *" $NEW_SLUG "*)
    echo "ERROR: BOT_NAME=\"$BOT_NAME\" gives the id \"$NEW_SLUG\", which is reserved by the system." >&2
    echo "Nothing was changed. Set another BOT_NAME in .env and rerun." >&2
    exit 1 ;;
esac
# "marveen" is the id the install already runs under: nothing to rename there.
if [ "$NEW_SLUG" != "marveen" ] && [ -d "$INSTALL_DIR/agents/$NEW_SLUG" ]; then
  echo "ERROR: BOT_NAME=\"$BOT_NAME\" gives the id \"$NEW_SLUG\", which is already a sub-agent (agents/$NEW_SLUG)." >&2
  echo "Nothing was changed. Set another BOT_NAME in .env and rerun." >&2
  exit 1
fi

if [ "$NEW_SLUG" = "marveen" ]; then
  echo "BOT_NAME=\"$BOT_NAME\" → slug \"marveen\" (default). Nothing to migrate."
  # Still write MAIN_AGENT_ID into .env for forward compatibility if missing.
  if ! grep -q '^MAIN_AGENT_ID=' .env; then
    echo "MAIN_AGENT_ID=marveen" >> .env
    echo "✓ MAIN_AGENT_ID=marveen added to .env"
  fi
  exit 0
fi

DB="$INSTALL_DIR/store/claudeclaw.db"

# Preflight, BEFORE anything is stopped: the DB rewrite below is the first step
# that can fail on a stock host, and it runs after the services are stopped and
# disabled. It used to call the sqlite3 CLI, which install-linux.sh does not
# install, so the script died with 127 there and left the bot down, nothing
# renamed. python3 is already required above; check its sqlite3 module too.
if [ -f "$DB" ] && ! python3 -c 'import sqlite3' 2>/dev/null; then
  echo "ERROR: python3 has no sqlite3 module; the DB rows cannot be rewritten." >&2
  echo "Nothing was changed. Install a python3 with sqlite3 support and rerun." >&2
  exit 1
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
tmux kill-session -t "=marveen-channels:" 2>/dev/null || true

# DB rewrite, through python3's stdlib sqlite3 (see the preflight above), in one
# transaction: either every table is rewritten or none is. The success line is
# printed only after the commit, with the counts.
if [ -f "$DB" ]; then
  if ! python3 - "$DB" "$NEW_SLUG" <<'PYEOF'
import sqlite3, sys
db, slug = sys.argv[1], sys.argv[2]
cols = [('memories', 'agent_id'), ('daily_logs', 'agent_id'),
        ('agent_messages', 'from_agent'), ('agent_messages', 'to_agent'),
        ('kanban_cards', 'assignee')]
con = sqlite3.connect(db, timeout=30)
try:
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    total, missing = 0, []
    with con:
        for table, col in cols:
            if table not in have:
                missing.append(table)
                continue
            total += con.execute(f'UPDATE {table} SET {col} = ? WHERE {col} = ?',
                                 (slug, 'marveen')).rowcount
finally:
    con.close()
note = f" (no table: {', '.join(sorted(set(missing)))})" if missing else ''
print(f'✓ DB rows rewritten: {total}{note}')
PYEOF
  then
    echo "ERROR: DB rewrite failed; no row was changed (single transaction)." >&2
    echo "The old services are STOPPED and nothing has been renamed yet." >&2
    echo "Fix the error above and rerun this script." >&2
    exit 1
  fi
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
_SCHED_CLI="$INSTALL_DIR/dist/web/schedule-registry-cli.js"
_SCHED_CLI_OK=0
if [ -f "$_SCHED_CLI" ] && command -v node >/dev/null 2>&1; then _SCHED_CLI_OK=1; fi
# Scheduled-task registry: the rewrite below changes task-config.json
# bytes, so the runner's registry hashes stop matching. Re-registering every
# rewritten task would launder a never-registered or tampered (planted) task
# that happens to target "marveen". So the registry verdict of each candidate
# is recorded BEFORE the rewrite, and afterwards only a task that was trusted
# then is re-registered; the rest is listed for operator review.
_SCHED_PRE_OK=""
_SCHED_PRE_UNKNOWN=""
if [ -d "$SCHED_DIR" ] && [ "$_SCHED_CLI_OK" = "1" ]; then
  _SCHED_CANDIDATES="$(python3 - "$SCHED_DIR" <<'PYEOF'
import sys, json, pathlib, re
root = pathlib.Path(sys.argv[1])
for cfg in sorted(root.glob('*/task-config.json')):
    try:
        data = json.loads(cfg.read_text())
    except Exception:
        continue
    if isinstance(data, dict) and data.get('agent') == 'marveen' and re.fullmatch(r'[a-z0-9-]+', cfg.parent.name):
        print(cfg.parent.name)
PYEOF
)"
  # The same three-way verdict as update.sh's sched_task_verified_ok.
  # Exit 1 is a REAL not-ok verdict only together with the CLI's own
  # "<verdict> <name>" line (a node crash also exits 1); registry-error, a usage
  # exit 2 (a CLI without `verify`) or a crash is UNKNOWN, not "not trusted".
  for _n in $_SCHED_CANDIDATES; do
    _sv_rc=0
    _sv_out="$(node "$_SCHED_CLI" verify "$_n" 2>/dev/null)" || _sv_rc=$?
    if [ "$_sv_rc" = "0" ]; then
      _SCHED_PRE_OK="$_SCHED_PRE_OK $_n"
    elif [ "$_sv_rc" = "1" ] && printf '%s\n' "$_sv_out" | grep -xE "[a-z-]+ $_n" | grep -qv '^registry-error '; then
      :
    else
      _SCHED_PRE_UNKNOWN="$_SCHED_PRE_UNKNOWN $_n"
    fi
  done
fi
_SCHED_REWRITTEN_LIST="$(mktemp)"
if [ -d "$SCHED_DIR" ]; then
  python3 - "$SCHED_DIR" "$NEW_SLUG" "$_SCHED_REWRITTEN_LIST" <<'PYEOF'
import sys, json, pathlib
root = pathlib.Path(sys.argv[1]); slug = sys.argv[2]
rewritten = []
fixed = 0
for cfg in root.glob('*/task-config.json'):
    try:
        data = json.loads(cfg.read_text())
    except Exception:
        continue
    if isinstance(data, dict) and data.get('agent') == 'marveen':
        data['agent'] = slug
        cfg.write_text(json.dumps(data, indent=2))
        fixed += 1
        rewritten.append(cfg.parent.name)
pathlib.Path(sys.argv[3]).write_text(''.join(n + '\n' for n in rewritten))
if fixed:
    print(f'✓ Scheduled task configs updated ({fixed} file(s))')
PYEOF
fi
_SCHED_REREGISTER=""
_SCHED_REVIEW=""
_SCHED_REVIEW_UNKNOWN=""
while IFS= read -r _n; do
  [ -n "$_n" ] || continue
  case "$_n" in *[!a-z0-9-]*) _SCHED_REVIEW="$_SCHED_REVIEW $_n"; continue ;; esac
  case " $_SCHED_PRE_OK " in
    *" $_n "*) _SCHED_REREGISTER="$_SCHED_REREGISTER $_n"; continue ;;
  esac
  case " $_SCHED_PRE_UNKNOWN " in
    *" $_n "*) _SCHED_REVIEW_UNKNOWN="$_SCHED_REVIEW_UNKNOWN $_n" ;;
    *) _SCHED_REVIEW="$_SCHED_REVIEW $_n" ;;
  esac
done < "$_SCHED_REWRITTEN_LIST"
rm -f "$_SCHED_REWRITTEN_LIST"
if [ -n "$_SCHED_REREGISTER" ]; then
  # shellcheck disable=SC2086 # word-splitting the name list is intended
  node "$_SCHED_CLI" register --source migrate-agent-id $_SCHED_REREGISTER >/dev/null \
    && echo "✓ Scheduled task registry re-registered:$_SCHED_REREGISTER" \
    || echo "WARNING: scheduled-task registry re-registration failed; run: node $_SCHED_CLI status" >&2
fi
if [ -n "$_SCHED_REVIEW" ]; then
  if [ "$_SCHED_CLI_OK" = "1" ]; then
    echo "WARNING: rewritten scheduled tasks NOT re-registered (they were not trusted before the rewrite -- unregistered or changed on disk):$_SCHED_REVIEW" >&2
    echo "         The runner skips them. Review their files, then: node $_SCHED_CLI register <name>" >&2
  else
    echo "WARNING: rewritten scheduled tasks are not re-registered (no dist/web/schedule-registry-cli.js):$_SCHED_REVIEW" >&2
    echo "         If this install has never run a build with the scheduled-task registry, its first start registers them (one-time backfill); otherwise review them and run: node $_SCHED_CLI register <name>" >&2
  fi
fi
if [ -n "$_SCHED_REVIEW_UNKNOWN" ]; then
  echo "WARNING: rewritten scheduled tasks NOT re-registered (their registry verdict before the rewrite is UNKNOWN -- the registry CLI crashed, has no verify, or could not read the registry):$_SCHED_REVIEW_UNKNOWN" >&2
  echo "         If this install's dashboard has not yet run its one-time registry backfill, its next start registers AND fires them as they are now: review them NOW. Otherwise the runner skips them until: node $_SCHED_CLI register <name>" >&2
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
