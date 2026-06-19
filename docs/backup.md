# Backup

> Marveen adatainak mentése egyetlen paranccsal -- WAL-ellenőrzéssel, megőrzési korláttal, visszaállítási útmutatóval.

---

## Futtatás

```bash
cd <projekt-gyökér>
bash scripts/backup.sh
```

Kimenet: `backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz`

Az archívum **érzékeny tokeneket tartalmaz** (dashboard Bearer, channel bot tokenek, `.env` projekttitkok). A `backups/` mappát ki kell zárni a felhőszinkronizálásból (iCloud, Dropbox, Google Drive).

---

## Mi kerül a mentésbe

Az archívum két csoportból áll, hogy a visszaállítás egyértelmű legyen:

### `repo/` csoport -- a projekt gyökerére extraktálandó

| Fájl / Könyvtár | Leírás |
|-----------------|--------|
| `store/claudeclaw.db` (+ `-shm`, `-wal`) | SQLite fő adatbázis: memória, kanban, üzenetek, token-log |
| `store/.dashboard-token` | Dashboard Bearer token |
| `.env` | Projekttitkok (API kulcsok, bot tokenek) |
| `scheduled-tasks.json` | Legacy ütemezési fájl, ha létezik |
| `assets/meetings/**` | Meetingátiratok, emlékeztetők |
| `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` | Sub-ügynök identitás és MCP konfiguráció |
| `agents/*/.claude/channels/**/.env`, `access.json` | Sub-ügynök csatorna-tokenek és párosítási állapot |

### `home/` csoport -- a `$HOME` alá extraktálandó

| Fájl / Könyvtár | Leírás |
|-----------------|--------|
| `~/.claude/skills/**` | Az ügynökök által épített skill-könyvtár |
| `~/.claude/scheduled-tasks/**` | Fájl-alapú ütemezett feladatok (SKILL.md + task-config.json) |
| `~/.claude/channels/*/.env` | Főügynök csatorna-token |
| `~/.claude/channels/*/access.json`, `invites.json`, `approved/**` | Párosított senderek, meghívók, jóváhagyások |
| `~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist` | launchd jobdefiníciók |

### Ami NEM kerül bele

- `node_modules/`, `dist/` -- ezeket `npm install && npm run build` újragenerálja
- `.venv-whisperx`, `.venv-diar` -- platform-specifikus Python venvek, nem hordozhatók
- `store/github-repos/` -- klónozott GitHub repók, újraklónozhatók
- Docker volume-ok (InfluxDB, Grafana) -- külön exportálandók; lásd [MIGRATION.md](MIGRATION.md)

---

## SQLite WAL-ellenőrzés

A script futtatás előtt elvégzi a WAL (Write-Ahead Log) checkpointot:

```bash
sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

Ez biztosítja, hogy az archívum önálló, konzisztens pillanatképet tartalmaz -- nem részleges WAL fájlokkal. Ha `sqlite3` nem elérhető, a script ebbe beleesik és a fájlokat másolja.

---

## Megőrzési korlát

A script automatikusan megtartja a **legfrissebb 14** archívumot és törli a többit:

```
backups/claudeclaw-20260613-070000.tar.gz  ← legfrissebb
backups/claudeclaw-20260612-070000.tar.gz
...
backups/claudeclaw-20260531-070000.tar.gz  ← 14. (megmarad)
backups/claudeclaw-20260530-070000.tar.gz  ← törlődik
```

---

## Az archívum ellenőrzése

```bash
# Tartalom áttekintése (MANIFEST.txt + struktúra)
tar -tzf backups/claudeclaw-20260613-070000.tar.gz | head -20

# Csak a csoportok és a MANIFEST megtekintése
tar -tzf backups/claudeclaw-20260613-070000.tar.gz \
  | sed -E 's,(^[^/]+/[^/]+/).*,\1...,' | sort -u

# MANIFEST kiolvasása (host, repo, tartalom)
tar -xOzf backups/claudeclaw-20260613-070000.tar.gz MANIFEST.txt
```

Elvárt struktúra:
```
MANIFEST.txt
repo/store/claudeclaw.db
repo/store/.dashboard-token
repo/.env
home/.claude/skills/...
home/.claude/scheduled-tasks/...
...
```

---

## Visszaállítás (gyors)

```bash
# 1. Kicsomagolás ideiglenes mappába
mkdir -p /tmp/restore
tar -xpzf backups/claudeclaw-20260613-070000.tar.gz -C /tmp/restore

# 2. MANIFEST átnézése
cat /tmp/restore/MANIFEST.txt

# 3. repo/ csoport -> projekt gyökérbe
rsync -a /tmp/restore/repo/ <projekt-gyökér>/

# 4. home/ csoport -> $HOME-ba
rsync -a /tmp/restore/home/ "$HOME/"
```

A teljes visszaállítási eljáráshoz (gépcsere, launchd újratöltés, TCC jogosultságok, Docker volume-ok) lásd: [MIGRATION.md](MIGRATION.md).

---

## Automatizálás

A backup futtatható cron-nal vagy ütemezett feladatként:

```bash
# Például: minden nap reggel 3:00-kor
0 3 * * * cd <projekt-gyökér> && bash scripts/backup.sh >> logs/backup.log 2>&1
```

Dashboard API-n keresztül is futtatható:

```bash
curl -s -X POST http://localhost:3420/api/backup \
  -H "Authorization: Bearer $(cat store/.dashboard-token)"
```

---

## Kapcsolódó dokumentumok

- [MIGRATION.md](MIGRATION.md) -- teljes gépcsere-eljárás Docker volume-okkal, launchd-vel
- [Vault](vault.md) -- a `.vault-key` / OS Keychain nem kerül a backup-ba (csak a titkosított `vault.json`)
- [Ütemezett feladatok](scheduled-tasks.md) -- a `~/.claude/scheduled-tasks/` a backup részét képezi
