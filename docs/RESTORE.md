# Backup Restore Runbook

This document describes how to restore a Marveen backup created by `scripts/backup.sh`.

## Archive format

Each backup is a `.tar.gz` file with two top-level groups:

```
claudeclaw-YYYYmmdd-HHMMSS.tar.gz
├── MANIFEST.txt          (self-description, checksums)
├── repo/                 (extract under the project root)
│   ├── store/claudeclaw.db
│   ├── store/.dashboard-token
│   ├── .env
│   ├── agents/*/CLAUDE.md, SOUL.md, .mcp.json
│   └── ...
└── home/                 (extract under $HOME)
    ├── .claude/skills/
    ├── .claude/scheduled-tasks/
    └── ...
```

A `.sha256` sidecar file is written next to each archive for offline integrity verification.

## Verification before restore

Always verify the archive before restoring:

```bash
# 1. Checksum verification
sha256sum -c claudeclaw-YYYYmmdd-HHMMSS.sha256
# or on macOS:
shasum -a 256 -c claudeclaw-YYYYmmdd-HHMMSS.sha256

# 2. Archive integrity
gzip -t claudeclaw-YYYYmmdd-HHMMSS.tar.gz && echo "OK"

# 3. Full verification with DB integrity check (uses verify-restore.sh)
scripts/verify-restore.sh backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
```

`verify-restore.sh` also writes a row to the `restore_log` table in the live DB (if available) so every verification attempt is auditable.

## Restore procedure

### 1. Stop the running service

```bash
scripts/stop.sh
```

### 2. Inspect the archive

```bash
mkdir /tmp/restore-inspect
tar -xpzf backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz -C /tmp/restore-inspect
ls /tmp/restore-inspect/repo/
ls /tmp/restore-inspect/home/
```

### 3. Restore repo files

```bash
# Project root = the directory containing this repo (e.g. ~/marveen)
REPO_ROOT="$(pwd)"
tar -xpzf backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz -C /tmp/restore-inspect
cp -pR /tmp/restore-inspect/repo/. "${REPO_ROOT}/"
```

**Important:** The `-p` flag preserves file permissions. The `.dashboard-token` and channel `.env` files must remain mode `0600`.

### 4. Restore home files

```bash
cp -pR /tmp/restore-inspect/home/. "${HOME}/"
```

### 5. Verify DB integrity after restore

```bash
sqlite3 store/claudeclaw.db 'PRAGMA integrity_check;'
# expected output: ok
```

### 6. Restart the service

```bash
scripts/start.sh
```

### 7. Clean up

```bash
rm -rf /tmp/restore-inspect
```

## Retention and pruning

Backup retention is controlled by the `BACKUP_KEEP` setting (default: 30). The `scripts/backup.sh` script automatically prunes archives older than this limit, including their `.sha256` sidecars.

Configure via the dashboard Settings page (Backup module) or in `.env`:

```
BACKUP_KEEP=60
```

Allowed values: `10`, `30`, `60`, `180`.

## Scheduling automated backups

The recommended schedule is a nightly backup at 03:00 (heartbeat type, no notification on success). See `dashboard-schedule-crud` skill for setup instructions, or use:

```bash
POST /api/schedules
{
  "name": "nightly-backup",
  "cron": "0 3 * * *",
  "type": "heartbeat",
  "payload": { "skill": "backup", "command": "bash scripts/backup.sh" }
}
```

## Sensitive data warning

Archives contain dashboard bearer tokens, channel bot tokens, and `.env` secrets. **Do not sync the `backups/` directory to iCloud, Dropbox, Google Drive, or any other cloud-backup service.**

## See also

- `scripts/backup.sh` — backup creation
- `scripts/verify-restore.sh` — integrity verification helper
- `docs/MIGRATION.md` — full migration runbook (TCC, launchd paths, venv rebuild)
