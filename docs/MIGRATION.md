# Migrálási útmutató -- fleet áthelyezése új gépre

Cél: az egész Marveen fleet áthelyezése erősebb gépre **nulla adatvesztéssel** és minimális leállással. Olvasd végig, mielőtt elkezded.

A legfontosabb szabály: **EGY BOT = EGY POLLER.** Egy Telegram/Slack bot token csak egy futó session-ből pollozható hosszú időn át. **Ne** futtasd az új és a régi gépet egyszerre ugyanazzal a tokennel -- a második poller HTTP 409 Conflict-ot kap, és a bejövő üzenetek elvesznek/szétoszlanak. Előbb leállítod a régit, aztán indítod az újat -- soha nem fednek át.

---

## 1. Mi mozdul (leltár)

Három független tároló. A tarball (`scripts/backup.sh`) az (1) és (2) részt fedi; a Docker köteteket (3) **külön** kell átvinni.

**(1) Repo-relatív -- a projekt gyökér alatt (`repo/` csoport az archívumban)**
- `store/claudeclaw.db` (+ `-shm`/`-wal`) -- kanban, memória, üzenetek, ütemezés DB
- `store/.dashboard-token` -- dashboard bearer token
- `store/config-overrides.json` -- dashboard Beállítások-oldal által mentett felülbírálatok (plain értékek, sosem tartalmaz titkokat)
- `.env` -- projekt titkos kulcsok
- `scheduled-tasks.json` -- legacy, ha van
- `assets/meetings/**` -- találkozó-átiratok/feljegyzések
- `agents/*/CLAUDE.md`, `SOUL.md`, `.mcp.json` -- ágensenkénti azonosító
- `agents/*/.claude/channels/*/.env`, `access.json` -- sub-ágens csatorna tokenek + párosítás

**(2) Home-relatív -- `$HOME` alatt (`home/` csoport az archívumban)**
- `~/.claude/skills/**` -- az önépített skill könyvtár
- `~/.claude/scheduled-tasks/**` -- fájlalapú ütemezett feladatok (SKILL.md + task-config.json)
- `~/.claude/channels/*/.env` -- FŐ orchestrator csatorna token
- `~/.claude/channels/*/access.json`, `invites.json`, `approved/**` -- párosítási allowlist + jóváhagyások
- `~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist` -- launchd job-ok (az előtag a `MAIN_AGENT_ID`, alapértelmezetten `marveen`)

**(3) Docker kötetek -- NEM szerepelnek a tarball-ban, külön migrálj**
- `stack_influxdb-data`, `stack_influxdb-config` -- InfluxDB 2.7 idősorozat (Loxone előzmény)
- `stack_grafana-data` -- Grafana irányítópultok/adatforrások
- Forrás: `projects/loxonTSDB/` (compose stack). A kötetek Docker-kezeltek, nem a repo-ban vannak, tehát `git clone` + tar visszaállítás NEM hozza vissza őket. Ha ezt kihagyod, az összes historikus metrika elveszik.

**Nem migrálható (natívan újraépítendő, lásd buktatók):** `.venv-whisperx`, `.venv-diar`
(Python venvek Apple Silicon-natív wheel-ekkel), `node_modules/`, `dist/`.

---

## 2. A RÉGI gépen (előkészítés)

1. Rögzítsd a verziókat, hogy az új gépen ugyanazok legyenek:
   - `node -v` (jelenleg v22.x), `claude --version` (rögzített; auto-update KI),
     `docker --version`, `tailscale version`.
2. Futtass egy friss mentést és ellenőrizd:
   ```bash
   cd <repo> && bash scripts/backup.sh
   tar -tzf backups/claudeclaw-*.tar.gz | sed -E 's,(^[^/]+/[^/]+/).*,\1...,' | sort -u
   ```
   Győződj meg róla, hogy mind a `repo/...`, mind a `home/...` csoport és a `MANIFEST.txt` megvan.
3. Exportáld a Docker köteteket (idősorozat + irányítópultok):
   ```bash
   cd <repo>/projects/loxonTSDB && docker compose down   # leállítás az írók előtt
   for v in stack_influxdb-data stack_influxdb-config stack_grafana-data; do
     docker run --rm -v "$v":/from -v "$PWD":/to alpine \
       tar -czf "/to/${v}.tar.gz" -C /from .
   done
   ```
4. Másold az archívumot és a három `stack_*.tar.gz` fájlt az új gépre megbízható csatornán (USB / `scp` / Tailscale). **Soha** ne tedd token-tartalmú archívumot iCloudba/Dropboxba/Drive-ra.
5. **Ne állítsd le a jelenlegi fleet-et** -- tartsd futva, amíg az új gép nem ellenőrzött és készen nem állsz az átállásra (4. lépés).

---

## 3. Az ÚJ gépen (visszaállítás)

1. **Előfeltételek** (Apple Silicon natív): Homebrew, `node` (régi major verzió), Docker Desktop, Tailscale, `git`, `sqlite3`, `tmux`, `ffmpeg`, `python3`. A repo tartalmaz `install-macos.sh` scriptet -- használd az alaphoz, majd rögzítsd a `claude`-ot ugyanarra a verzióra, és kapcsold ki az auto-update-et (`DISABLE_AUTOUPDATER=1`).
2. **Klónozd a repo-t** lehetőleg ugyanarra az abszolút útvonalra (`/Users/<user>/marveen`). Más útvonal esetén minden launchd plist-et és abszolút hivatkozást frissíteni kell (lásd buktatók).
3. **Állítsd vissza a tarball-t**, megőrizve a jogosultságokat (a token fájlok `0600`-ak):
   ```bash
   mkdir -p /tmp/restore && tar -xpzf claudeclaw-YYYYmmdd-HHMMSS.tar.gz -C /tmp/restore
   # nézd meg a /tmp/restore/MANIFEST.txt-et, majd:
   rsync -a /tmp/restore/repo/  <repo>/         # repo csoport -> projekt gyökér
   rsync -a /tmp/restore/home/  "$HOME/"        # home csoport -> $HOME
   ```
   Ellenőrizd a jogosultságokat: `ls -l <repo>/store/.dashboard-token ~/.claude/channels/*/.env`
   `-rw-------`-t kell mutatnia.
4. **Fordítsd le az alkalmazást** (NE másold a `dist/`-t vagy `node_modules/`-t a régi gépről):
   ```bash
   cd <repo> && npm install && npm run build
   ```
5. **Állítsd vissza a Docker köteteket**, majd indítsd el a stack-et:
   ```bash
   for v in stack_influxdb-data stack_influxdb-config stack_grafana-data; do
     docker volume create "$v"
     docker run --rm -v "$v":/to -v "$PWD":/from alpine \
       sh -c "cd /to && tar -xzf /from/${v}.tar.gz"
   done
   cd <repo>/projects/loxonTSDB && docker compose up -d
   ```
6. **Építsd újra a Python venveket natívan** (NE másold -- lásd buktatók):
   hozd létre újra a `.venv-whisperx` és `.venv-diar` venveket `python3 -m venv`-vel, és telepítsd újra a csomagokat, hogy a torch/whisper wheel-ek arm64-esek legyenek.
7. **Javítsd és telepítsd a launchd job-okat:**
   - Ha a felhasználó/home/repo útvonal megváltozott, szerkeszd minden
     `~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist` fájlt (`ProgramArguments`,
     `WorkingDirectory`, `StandardOutPath`, `HOME`/`PATH` env) az új útvonalakra.
   - Töltsd be: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<MAIN_AGENT_ID>.<job>.plist`
     (az alap job-ok: `channels` és `dashboard`; töltsd be az összes `com.<MAIN_AGENT_ID>.*` job-ot).
8. **Adj macOS jogosultságokat (TCC):** az első alkalommal, amikor az új processzek Teljes Lemez Hozzáférést / Automatizálást / Akadálymentességet igényelnek, a macOS csendesen blokkolja őket, amíg nem engedélyezed a Rendszerbeállítások → Adatvédelem és biztonság menüben. Adj Teljes Lemez Hozzáférést a fleet terminál/`node`/`tmux` processzeknek.

---

## 4. Átállás (visszafordíthatatlan lépés -- ezt csináld utoljára)

1. A RÉGI gépen: állíts le mindent, ami bot tokent polloz, ebben a sorrendben:
   `launchctl bootout gui/$(id -u)/com.<MAIN_AGENT_ID>.channels` (és a dashboard,
   watchdog-ok), majd ellenőrizd, hogy nem maradt fenn `bun server.ts` / poller
   (`pgrep -fl "claude .*--channels"`). Ha a régi poller életben marad, az új 409-et kap.
2. Az ÚJ gépen: indítsd el a `com.<MAIN_AGENT_ID>.channels`-t (és a dashboardot). Ellenőrizd:
   `pgrep -P <channels_pid>` mutat egy `bun` gyermeket, megjelenik a `bot.pid`,
   és a `getWebhookInfo` `pending_update_count` nullára csökken.
3. Küldj egy teszt Telegram üzenetet -- el kell érnie az új fleet-et és választ kell kapnia.

---

## 5. Buktatók (olvasd el az átállás előtt)

- **EGY BOT = EGY POLLER.** Ismételve a hangsúly kedvéért: állítsd le a régi pollert, mielőtt elindítod az újat, különben 409-es hibák és elveszett üzenetek várnak. (Lásd még a `telegram-inbound-dead-poller` skill-t.)
- **macOS Teljes Lemez Hozzáférés / TCC.** Az új processzek blokkolva vannak a védett útvonalakon, amíg explicit engedélyt nem adsz; a hibaüzenet csendes. Előre add meg az FDA-t a fleet terminál/node/tmux processzeknek.
- **A launchd plist útvonalak abszolútak.** `ProgramArguments`
  (`/usr/local/bin/node`, `<repo>/dist/index.js`), `WorkingDirectory`, log
  útvonalak és `EnvironmentVariables` (`HOME`, `PATH`, `DISABLE_AUTOUPDATER`) mind
  hard-coded útvonalak. Ha a felhasználónév/home/node helye eltér, javítsd minden plist-ben.
- **A Python venvek nem hordozhatók.** `.venv-whisperx` / `.venv-diar` a régi CPU architektúrára (Intel x86_64) fordított torch/whisper wheel-eket tartalmaznak. Apple Siliconon **újra kell építeni** (`python3 -m venv` + újratelepítés) -- a másolt venv arch/dyld hibával összeomlik.
- **A Docker kötetek nincsenek a tarball-ban.** Az InfluxDB előzmény + Grafana irányítópultok `stack_*` Docker kötetekben élnek; exportáld/importáld őket külön (2.3 / 3.5 szekció). `git clone` + tar visszaállítás NEM hozza vissza őket.
- **Tailscale.** A dashboard külső elérése (`WEB_HOST`, `DASHBOARD_PUBLIC_URL`)
  a gép Tailscale azonosítójától függ. Telepítsd/jelentkezz be Tailscale-be az új gépen; a gép új tailnet nevet/IP-t kap, frissítsd az összes URL-t, ami a régi hostname-t rögzítette. (Lásd `marveen-dashboard-kulso-eleres` skill.)
- **claude auto-update.** Tartsd bekapcsolva a `DISABLE_AUTOUPDATER=1`-et; a globális telepítő felülírja a natív binárist és a `/usr/local/bin/claude` symlink eltűnhet csere közben -- "claude not found on PATH" gyors-hibás loop-ot okozva.
- **dist vs src.** Mindig futtass `npm run build`-et az új gépen; soha ne bízz egy másolt `dist/`-ben. A dashboard launchd job közvetlenül a `node dist/index.js`-t futtatja.

---

## 6. Migrálás utáni ellenőrző lista

- [ ] A dashboard elérhető a `http://localhost:3420`-on (és Tailscale-en keresztül, ha használod).
- [ ] `sqlite3 store/claudeclaw.db 'PRAGMA integrity_check;'` -- `ok`.
- [ ] Kanban, memória, ütemezések láthatók a dashboardon (DB visszaállítva).
- [ ] Beállítás-felülbírálatok visszaállítva: `cat store/config-overrides.json` (ha a fájl megvolt a régi gépen).
- [ ] Skill-ek megvannak: `ls ~/.claude/skills` megegyezik a régi számmal.
- [ ] Ütemezett feladatok megvannak: `ls ~/.claude/scheduled-tasks` megegyezik.
- [ ] Telegram be- és kimenő működik (teszt üzenet körbeér).
- [ ] Párosítás intact: a korábban jóváhagyott chatok még engedélyezve vannak (nem kell újrapárosítani).
- [ ] Az InfluxDB tartalmazza az előzményt: egy Flux `count()` a Loxone mérésre megegyezik a régi géppel; a Grafana irányítópultok renderelnek.
- [ ] Minden launchd job be van töltve: `launchctl list | grep com.<MAIN_AGENT_ID>`.
- [ ] A régi gép pollerjei teljesen leálltak (nincs 409).
