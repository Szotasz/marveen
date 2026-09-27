#!/bin/bash
# Contract tests for the Linux (systemd) branch of scripts/migrate-main-agent-id.sh.
# Run: bash scripts/__tests__/migrate-agent-id-linux.test.sh
#
# Regression guard (RENAMELINUX905): on Linux the script rewrote the DB and
# .env, then printed "Done." while the service stop, the unit rename and the
# restart were all behind Darwin guards -- a half-renamed install that claimed
# success. The script must now do the systemd side, and must NOT claim success
# when a service fails to start.
#
# The script branches on `uname -s`, so a PATH shim fakes uname=Linux (plus
# systemctl/tmux recorders); the test therefore runs on any host, macOS
# included. python3 is the real binary.
#
# The DB fixture and the DB check go through lib/sqlite-oracle.sh (python3
# stdlib), not the sqlite3 CLI, which install-linux.sh does not install
# (7ac77433). The script itself rewrites the rows with python3's sqlite3 module
# too (67c8f449): it used to call the CLI, died with 127 after the services were
# stopped and disabled, and left the bot down. A trapping sqlite3 shim on PATH
# proves it no longer calls the CLI, even on a host that has one.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/scripts/__tests__/lib/sqlite-oracle.sh"

# --- throwaway install tree ---------------------------------------------------
INSTALL="$TMP/install"
mkdir -p "$INSTALL/scripts" "$INSTALL/store"
cp "$REPO/scripts/migrate-main-agent-id.sh" "$INSTALL/scripts/"
echo 'BOT_NAME="Test Bot"' > "$INSTALL/.env"

oracle_exec "$INSTALL/store/claudeclaw.db" - <<'SQL'
CREATE TABLE memories (agent_id TEXT);
CREATE TABLE daily_logs (agent_id TEXT);
CREATE TABLE agent_messages (from_agent TEXT, to_agent TEXT);
CREATE TABLE kanban_cards (assignee TEXT);
INSERT INTO memories VALUES ('marveen');
INSERT INTO agent_messages VALUES ('marveen', 'samu');
INSERT INTO kanban_cards VALUES ('marveen');
SQL

# --- fake HOME with the installer's unit set ----------------------------------
FAKE_HOME="$TMP/home"
UNITS="$FAKE_HOME/.config/systemd/user"
mkdir -p "$UNITS/marveen-dashboard.service.d" "$UNITS/marveen-channels.service.d"
for unit in dashboard.service channels.service morning.service morning.timer host-watchdog.service 'notify@.service'; do
  printf '[Unit]\nDescription=Marveen %s\n' "$unit" > "$UNITS/marveen-${unit}"
done
printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-dashboard.service.d/onfailure.conf"
printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-channels.service.d/onfailure.conf"

# --- PATH shim ----------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
LOG="$TMP/systemctl.log"
: > "$LOG"

cat > "$BIN/uname" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "-s" ]; then echo Linux; else echo Linux; fi
EOF
cat > "$BIN/systemctl" <<EOF
#!/bin/bash
echo "\$@" >> "$LOG"
if [ -n "\${SYSTEMCTL_FAIL_ON:-}" ]; then
  case "\$*" in *"\$SYSTEMCTL_FAIL_ON"*) exit 1;; esac
fi
exit 0
EOF
cat > "$BIN/tmux" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$BIN/sqlite3" <<EOF
#!/bin/bash
echo "SQLITE3-CLI-CALLED \$*" >> "$LOG"
exit 127
EOF
chmod +x "$BIN/uname" "$BIN/systemctl" "$BIN/tmux" "$BIN/sqlite3"

run_migrate() {
  HOME="$FAKE_HOME" PATH="$BIN:$PATH" SYSTEMCTL_FAIL_ON="${1:-}" \
    bash "$INSTALL/scripts/migrate-main-agent-id.sh" <<< "y" > "$TMP/out.log" 2> "$TMP/err.log"
}

# Pre-migration state again: marveen-* units, marveen rows, no MAIN_AGENT_ID.
reset_state() {
  rm -rf "$UNITS"
  mkdir -p "$UNITS/marveen-dashboard.service.d" "$UNITS/marveen-channels.service.d"
  for unit in dashboard.service channels.service morning.service morning.timer host-watchdog.service 'notify@.service'; do
    printf '[Unit]\nDescription=Marveen %s\n' "$unit" > "$UNITS/marveen-${unit}"
  done
  printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-dashboard.service.d/onfailure.conf"
  printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-channels.service.d/onfailure.conf"
  oracle_exec "$INSTALL/store/claudeclaw.db" "UPDATE kanban_cards SET assignee='marveen'"
  sed -i.bak '/^MAIN_AGENT_ID=/d' "$INSTALL/.env"
  : > "$LOG"
}

# ==============================================================================
echo "migrate-main-agent-id.sh -- Linux systemd branch"

run_migrate ""
RC=$?

[ "$RC" -eq 0 ] && pass "exit 0 on the happy path" || fail "exit 0 on the happy path (got $RC; err: $(cat "$TMP/err.log"))"

grep -q '^MAIN_AGENT_ID=test-bot$' "$INSTALL/.env" \
  && pass ".env got MAIN_AGENT_ID=test-bot" || fail ".env got MAIN_AGENT_ID=test-bot"

DB_SLUG=$(oracle_query "$INSTALL/store/claudeclaw.db" "SELECT assignee FROM kanban_cards")
[ "$DB_SLUG" = "test-bot" ] && pass "DB rows rewritten to the new slug" || fail "DB rows rewritten (got '$DB_SLUG')"

MSG=$(oracle_query "$INSTALL/store/claudeclaw.db" "SELECT from_agent || '>' || to_agent FROM agent_messages")
[ "$MSG" = "test-bot>samu" ] && pass "only 'marveen' values are rewritten" || fail "only 'marveen' rewritten (got '$MSG')"

grep -q 'SQLITE3-CLI-CALLED' "$LOG" \
  && fail "the sqlite3 CLI is not called (not an install dependency)" \
  || pass "the sqlite3 CLI is not called (not an install dependency)"

# memories 1 + agent_messages.from_agent 1 + kanban_cards 1; the success line
# carries the count, printed only after the commit.
grep -q '^✓ DB rows rewritten: 3$' "$TMP/out.log" \
  && pass "the success line reports the rewritten row count" \
  || fail "success line with the count (out: $(grep 'DB rows' "$TMP/out.log"))"

OLD_LEFT=$(find "$UNITS" -maxdepth 1 -name 'marveen-*' | wc -l | tr -d ' ')
[ "$OLD_LEFT" = "0" ] && pass "no marveen-* unit files left behind" || fail "no marveen-* left behind ($OLD_LEFT remain)"

ALL_NEW=1
for unit in dashboard.service channels.service morning.service morning.timer host-watchdog.service 'notify@.service'; do
  [ -f "$UNITS/test-bot-${unit}" ] || { ALL_NEW=0; fail "renamed unit exists: test-bot-${unit}"; }
done
[ "$ALL_NEW" = "1" ] && pass "all six units renamed to test-bot-*"

grep -q 'test-bot-notify@%n.service' "$UNITS/test-bot-dashboard.service.d/onfailure.conf" 2>/dev/null \
  && pass "OnFailure drop-in renamed AND patched to the new notifier" \
  || fail "OnFailure drop-in renamed AND patched (dashboard)"

grep -q 'stop marveen-channels.service' "$LOG" \
  && pass "old units were stopped before the rename" || fail "old units were stopped"

grep -q 'daemon-reload' "$LOG" \
  && pass "daemon-reload ran after the rename" || fail "daemon-reload ran"

grep -q 'enable --now test-bot-dashboard.service' "$LOG" \
  && pass "new dashboard unit enabled and started" || fail "new dashboard unit enabled --now"

grep -q 'enable --now test-bot-channels.service' "$LOG" \
  && pass "new channels unit enabled and started" || fail "new channels unit enabled --now"

grep -q 'enable --now test-bot-morning.timer' "$LOG" \
  && pass "morning timer enabled and started" || fail "morning timer enabled --now"

if grep -q 'enable test-bot-host-watchdog.service' "$LOG" \
   && ! grep -q 'enable --now test-bot-host-watchdog.service' "$LOG"; then
  pass "host-watchdog enabled WITHOUT --now (oneshot, must not run mid-migration)"
else
  fail "host-watchdog enabled WITHOUT --now"
fi

# --- failure honesty: a failed start must not end in Done. --------------------
# Rebuild the pre-migration state and make enabling the channels unit fail.
rm -rf "$UNITS"
mkdir -p "$UNITS/marveen-dashboard.service.d" "$UNITS/marveen-channels.service.d"
for unit in dashboard.service channels.service morning.service morning.timer host-watchdog.service 'notify@.service'; do
  printf '[Unit]\nDescription=Marveen %s\n' "$unit" > "$UNITS/marveen-${unit}"
done
printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-dashboard.service.d/onfailure.conf"
printf '[Unit]\nOnFailure=marveen-notify@%%n.service\n' > "$UNITS/marveen-channels.service.d/onfailure.conf"
oracle_exec "$INSTALL/store/claudeclaw.db" "UPDATE kanban_cards SET assignee='marveen'"
sed -i.bak '/^MAIN_AGENT_ID=/d' "$INSTALL/.env"
: > "$LOG"

run_migrate "enable --now test-bot-channels.service"
RC=$?

[ "$RC" -ne 0 ] && pass "failed service start exits non-zero" || fail "failed service start exits non-zero"

grep -q '^Done\.' "$TMP/out.log" \
  && fail "no 'Done.' claim when a service failed to start" \
  || pass "no 'Done.' claim when a service failed to start"

grep -q 'FAILED to start' "$TMP/err.log" \
  && pass "the failure is named on stderr" || fail "the failure is named on stderr"

# --- preflight: no sqlite3 module -> nothing is stopped ------------------------
# The DB rewrite runs after the services are stopped and disabled; a host that
# cannot do it must be refused before that, not half-way.
reset_state
NOSQL="$TMP/nosqlite"
mkdir -p "$NOSQL"
echo 'raise ImportError("no sqlite3 in this python (test)")' > "$NOSQL/sqlite3.py"
PYTHONPATH="$NOSQL" run_migrate ""
RC=$?
[ "$RC" -eq 1 ] && pass "no sqlite3 module: exit 1" || fail "no sqlite3 module: exit 1 (got $RC)"
grep -q 'stop' "$LOG" \
  && fail "no sqlite3 module: no service was stopped" \
  || pass "no sqlite3 module: no service was stopped"
[ -f "$UNITS/marveen-dashboard.service" ] && ! grep -q '^MAIN_AGENT_ID=' "$INSTALL/.env" \
  && pass "no sqlite3 module: units and .env untouched" || fail "no sqlite3 module: units and .env untouched"
grep -q 'Nothing was changed' "$TMP/err.log" \
  && pass "no sqlite3 module: stderr says nothing changed" || fail "no sqlite3 module: stderr says nothing changed"

# --- a failing rewrite stops before the rename, and says the services are down -
reset_state
cp "$INSTALL/store/claudeclaw.db" "$TMP/good.db"
echo "this is not a database" > "$INSTALL/store/claudeclaw.db"
run_migrate ""
RC=$?
[ "$RC" -eq 1 ] && pass "broken DB: exit 1" || fail "broken DB: exit 1 (got $RC)"
grep -q '✓ DB rows rewritten' "$TMP/out.log" \
  && fail "broken DB: no 'rows rewritten' claim" || pass "broken DB: no 'rows rewritten' claim"
[ -f "$UNITS/marveen-dashboard.service" ] && ! grep -q '^MAIN_AGENT_ID=' "$INSTALL/.env" \
  && pass "broken DB: nothing renamed, .env untouched" || fail "broken DB: nothing renamed, .env untouched"
grep -q 'services are STOPPED' "$TMP/err.log" \
  && pass "broken DB: stderr says the services are stopped" || fail "broken DB: stderr says the services are stopped"
cp "$TMP/good.db" "$INSTALL/store/claudeclaw.db"

# ==============================================================================
echo ""
echo "migrate-agent-id-linux: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]