#!/bin/bash
# Test: scripts/backup.sh takes the per-agent state and the systemd user units,
# and scripts/backup-nightly.sh makes an optional second copy that is OFF unless
# MARVEEN_BACKUP_COPY_DIR is set.
# Run: bash scripts/__tests__/backup-agent-state-and-nightly.test.sh
#
# Hermetic: a throwaway repo and HOME under one temp dir, never the live store.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "backup.sh: per-agent state + systemd units; backup-nightly.sh: optional second copy"
echo "===================================================================================="

FAKE="$TMP/repo"; FHOME="$TMP/home"; OUT="$TMP/out"; COPY="$TMP/copy"
mkdir -p "$FAKE/scripts/lib" "$FAKE/store" "$OUT" "$COPY" \
  "$FHOME/.claude/skills/demo" "$FHOME/.claude/scheduled-tasks/demo" \
  "$FHOME/.config/systemd/user"
cp "$REPO/scripts/backup.sh" "$REPO/scripts/backup-nightly.sh" "$FAKE/scripts/"
cp "$REPO/scripts/lib/archive-list-has.sh" "$FAKE/scripts/lib/"

# Load-bearing markers backup.sh insists on.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$FAKE/store/claudeclaw.db" 'CREATE TABLE t(x);'
else
  printf 'db' > "$FAKE/store/claudeclaw.db"
fi
printf 'x' > "$FHOME/.claude/skills/demo/SKILL.md"
printf 'x' > "$FHOME/.claude/scheduled-tasks/demo/SKILL.md"

# Per-agent state, the MAIN agent's isolated-config memory, a systemd unit.
A="$FAKE/agents/alpha"
mkdir -p "$A/.claude/skills/own" "$A/secrets" "$A/.claude-config/projects/p1/memory" \
  "$A/.claude-config/projects/p1/transcripts" "$FAKE/.channels-config/projects/p1/memory" \
  "$FAKE/.channels-config/projects/p1/transcripts"
printf '{}' > "$A/agent-config.json"
printf '{}' > "$A/.claude/settings.local.json"
printf 'x' > "$A/.claude/skills/own/SKILL.md"
printf 'k' > "$A/secrets/key"
printf 'm' > "$A/.claude-config/projects/p1/memory/note.md"
printf 't' > "$A/.claude-config/projects/p1/transcripts/log.jsonl"
printf 'm' > "$FAKE/.channels-config/projects/p1/memory/note.md"
printf 't' > "$FAKE/.channels-config/projects/p1/transcripts/log.jsonl"
# This fleet's units (default prefix: marveen-), a drop-in and an enable link,
# next to another application's unit that must stay out.
SD="$FHOME/.config/systemd/user"
mkdir -p "$SD/marveen-channels.service.d" "$SD/default.target.wants"
printf '[Unit]' > "$SD/marveen-channels.service"
printf '[Unit]' > "$SD/marveen-backup.timer"
printf '[Service]' > "$SD/marveen-channels.service.d/onfailure.conf"
ln -s "$SD/marveen-channels.service" "$SD/default.target.wants/marveen-channels.service"
printf '[Service]\nEnvironment=OTHER_APP_SETTING=1\n' > "$SD/other-app.service"
ln -s "$SD/other-app.service" "$SD/default.target.wants/other-app.service"
printf 'SECRET=1' > "$A/.claude/skills/own/.env"
printf 'k' > "$A/.claude/skills/own/deploy.key"
printf 't' > "$A/.claude/skills/own/credentials.json"
mkdir -p "$A/.claude/skills/own/scripts"
printf 'x' > "$A/.claude/skills/own/scripts/run.sh"

set +e
OUTPUT="$(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" bash scripts/backup.sh 2>&1)"
RC=$?
if [ "$RC" -eq 0 ]; then pass "backup.sh exits 0"; else
  fail "backup.sh exited $RC"; echo "$OUTPUT" | tail -15; fi

ARCHIVE="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
LIST="$TMP/archive.list"
[ -n "$ARCHIVE" ] && tar -tzf "$ARCHIVE" > "$LIST" 2>/dev/null || : > "$LIST"

for p in repo/agents/alpha/agent-config.json \
         repo/agents/alpha/.claude/settings.local.json \
         repo/agents/alpha/.claude/skills/own/SKILL.md \
         repo/agents/alpha/.claude-config/projects/p1/memory/note.md \
         repo/.channels-config/projects/p1/memory/note.md \
         repo/agents/alpha/.claude/skills/own/scripts/run.sh \
         home/.config/systemd/user/marveen-channels.service \
         home/.config/systemd/user/marveen-backup.timer \
         home/.config/systemd/user/marveen-channels.service.d/onfailure.conf \
         home/.config/systemd/user/default.target.wants/marveen-channels.service; do
  if grep -qx "$p" "$LIST"; then pass "in the archive: $p"; else fail "missing from the archive: $p"; fi
done

# Credential files inside a skill folder and other applications' units stay out.
for p in repo/agents/alpha/.claude/skills/own/.env \
         repo/agents/alpha/.claude/skills/own/deploy.key \
         repo/agents/alpha/.claude/skills/own/credentials.json \
         home/.config/systemd/user/other-app.service \
         home/.config/systemd/user/default.target.wants/other-app.service; do
  if grep -qx "$p" "$LIST"; then fail "kept-out file is in the default archive: $p"; else pass "kept out of the default archive: $p"; fi
done

# agents/*/secrets/ is opt-in: absent by default.
if grep -qx "repo/agents/alpha/secrets/key" "$LIST"; then
  fail "secrets/ is in the archive although MARVEEN_BACKUP_AGENT_SECRETS is unset"
else
  pass "secrets/ is NOT in the archive by default"
fi
for v in 0 yes true; do
  rm -rf "$OUT"; mkdir -p "$OUT"
  (cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" MARVEEN_BACKUP_AGENT_SECRETS="$v" bash scripts/backup.sh >/dev/null 2>&1)
  A2="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
  if [ -n "$A2" ] && tar -tzf "$A2" | grep -qx "repo/agents/alpha/secrets/key"; then
    fail "secrets/ taken with MARVEEN_BACKUP_AGENT_SECRETS=$v (only 1 enables it)"
  else
    pass "MARVEEN_BACKUP_AGENT_SECRETS=$v does not enable secrets/"
  fi
done
rm -rf "$OUT"; mkdir -p "$OUT"
OUTPUT1="$(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" MARVEEN_BACKUP_AGENT_SECRETS=1 bash scripts/backup.sh 2>&1)"; RC1=$?
A1="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
if [ "$RC1" -eq 0 ]; then pass "backup.sh exits 0 with MARVEEN_BACKUP_AGENT_SECRETS=1"; else
  fail "backup.sh exited $RC1 with MARVEEN_BACKUP_AGENT_SECRETS=1"; echo "$OUTPUT1" | tail -10; fi
if [ -n "$A1" ] && tar -tzf "$A1" | grep -qx "repo/agents/alpha/secrets/key"; then
  pass "secrets/ is in the archive with MARVEEN_BACKUP_AGENT_SECRETS=1"
else
  fail "secrets/ is missing with MARVEEN_BACKUP_AGENT_SECRETS=1"
fi
for f in .env deploy.key credentials.json; do
  if [ -n "$A1" ] && tar -tzf "$A1" | grep -qx "repo/agents/alpha/.claude/skills/own/$f"; then
    pass "skills/own/$f is in the archive with MARVEEN_BACKUP_AGENT_SECRETS=1"
  else
    fail "skills/own/$f is missing with MARVEEN_BACKUP_AGENT_SECRETS=1"
  fi
done

# SERVICE_ID in .env moves the unit prefix.
printf 'SERVICE_ID=acme\n' > "$FAKE/.env"
printf '[Unit]' > "$FHOME/.config/systemd/user/acme-dashboard.service"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" bash scripts/backup.sh >/dev/null 2>&1)
A3="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
if [ -n "$A3" ] && tar -tzf "$A3" | grep -qx "home/.config/systemd/user/acme-dashboard.service" \
   && ! tar -tzf "$A3" | grep -qx "home/.config/systemd/user/marveen-channels.service"; then
  pass "SERVICE_ID in .env selects the unit prefix"
else
  fail "SERVICE_ID in .env did not select the unit prefix"
fi
rm -f "$FAKE/.env" "$FHOME/.config/systemd/user/acme-dashboard.service"
rm -rf "$OUT"; mkdir -p "$OUT"
(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" bash scripts/backup.sh >/dev/null 2>&1)

for p in repo/agents/alpha/.claude-config/projects/p1/transcripts/log.jsonl \
         repo/.channels-config/projects/p1/transcripts/log.jsonl; do
  if grep -qx "$p" "$LIST"; then fail "transcript leaked into the archive: $p"; else pass "kept out: $p"; fi
done

# A repo with none of these paths must still back up cleanly.
BARE="$TMP/bare"; BHOME="$TMP/bhome"
mkdir -p "$BARE/scripts/lib" "$BARE/store" "$BHOME/.claude/skills/demo" "$BHOME/.claude/scheduled-tasks/demo" "$TMP/bout"
cp "$REPO/scripts/backup.sh" "$BARE/scripts/"; cp "$REPO/scripts/lib/archive-list-has.sh" "$BARE/scripts/lib/"
cp "$FAKE/store/claudeclaw.db" "$BARE/store/"
printf 'x' > "$BHOME/.claude/skills/demo/SKILL.md"; printf 'x' > "$BHOME/.claude/scheduled-tasks/demo/SKILL.md"
mkdir -p "$BARE/agents/beta"
BOUT="$(cd "$BARE" && HOME="$BHOME" BACKUP_DIR="$TMP/bout" bash scripts/backup.sh 2>&1)"; BRC=$?
if [ "$BRC" -eq 0 ]; then pass "an agent with none of the extra paths backs up cleanly"; else
  fail "bare agent dir: backup.sh exited $BRC"; echo "$BOUT" | tail -10; fi

# --- backup-nightly.sh -------------------------------------------------------
nightly() { ( cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" "$@" bash scripts/backup-nightly.sh 2>&1 ); }

echo "  -- second copy off by default"
BEFORE="$(ls -1 "$COPY" | wc -l | tr -d ' ')"
nightly env >/dev/null; RC=$?
AFTER="$(ls -1 "$COPY" | wc -l | tr -d ' ')"
if [ "$RC" -eq 0 ]; then pass "nightly exits 0 with the copy unset"; else fail "nightly exited $RC with the copy unset"; fi
if [ "$BEFORE" = "$AFTER" ]; then pass "nothing is copied when MARVEEN_BACKUP_COPY_DIR is unset"; else fail "a copy was made without MARVEEN_BACKUP_COPY_DIR"; fi

echo "  -- second copy on, retention"
for stamp in 20200101-000001 20200101-000002 20200101-000003; do
  printf 'old' > "$COPY/claudeclaw-$stamp.tar.gz"
done
printf 'keep me' > "$COPY/unrelated.txt"
touch -d '2020-01-01 00:00:01' "$COPY/claudeclaw-20200101-000001.tar.gz"
touch -d '2020-01-01 00:00:02' "$COPY/claudeclaw-20200101-000002.tar.gz"
touch -d '2020-01-01 00:00:03' "$COPY/claudeclaw-20200101-000003.tar.gz"
nightly env MARVEEN_BACKUP_COPY_DIR="$COPY" MARVEEN_BACKUP_COPY_KEEP=2 >/dev/null; RC=$?
if [ "$RC" -eq 0 ]; then pass "nightly exits 0 with the copy on"; else fail "nightly exited $RC with the copy on"; fi
NEWEST="$(ls -1t "$OUT"/claudeclaw-*.tar.gz | head -1)"
if [ -f "$COPY/$(basename "$NEWEST")" ]; then pass "the newest archive is in the copy dir"; else fail "the newest archive was not copied"; fi
N="$(ls -1 "$COPY"/claudeclaw-*.tar.gz | wc -l | tr -d ' ')"
if [ "$N" = "2" ]; then pass "retention keeps 2 archives"; else fail "retention left $N archives, expected 2"; fi
if [ -f "$COPY/unrelated.txt" ]; then pass "retention leaves other files alone"; else fail "retention deleted an unrelated file"; fi

echo "  -- a requested copy that cannot be made is loud"
OUTPUT="$(nightly env MARVEEN_BACKUP_COPY_DIR="$TMP/does-not-exist")"; RC=$?
if [ "$RC" -ne 0 ]; then pass "missing copy dir: non-zero exit"; else fail "missing copy dir exited 0 (silent skip)"; fi
if echo "$OUTPUT" | grep -q 'NOT made'; then pass "missing copy dir: says so"; else fail "missing copy dir: no message"; fi
nightly env MARVEEN_BACKUP_COPY_DIR="$COPY" MARVEEN_BACKUP_COPY_KEEP=abc >/dev/null; RC=$?
if [ "$RC" -ne 0 ]; then pass "bad MARVEEN_BACKUP_COPY_KEEP: non-zero exit"; else fail "bad MARVEEN_BACKUP_COPY_KEEP accepted"; fi

# Nothing host-specific may be built into either script.
if grep -nE '/mnt/|/home/[a-z]+' "$REPO/scripts/backup-nightly.sh" "$REPO/scripts/backup.sh" >/dev/null; then
  fail "a host-specific path is built into a backup script"
else
  pass "no host-specific path in the backup scripts"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
