# Konfiguráció-referencia

> Melyik fájl mire jó, hol van, mit tartalmaz. Egy helyen az összes konfigurációs fájl áttekintése.

---

## store/ -- futásidejű állapot

Ezek a fájlok a dashboard által kezelt, futásidőben módosuló konfigurációk. Nem kerülnek be a gitbe (`.gitignore`).

| Fájl | Módosítható | Leírás |
|------|-------------|--------|
| `store/.dashboard-token` | nem | Dashboard Bearer token -- minden `/api/*` híváshoz kell |
| `store/autonomy-config.json` | dashboard UI | Heartbeat autonómia-szintek kategóriánként (1=jelz, 2=javasol, 3=autonóm) |
| `store/dashboard-settings.json` | dashboard UI | GitHub repo integráció, frissítési beállítások |
| `store/agents-desired.json` | dashboard UI | Melyik sub-ágenseket kell életben tartani (auto-restart lista) |
| `store/auto-restart.json` | dashboard UI | Ágensenként auto-restart konfiguráció (enabled, mode, dailyTime) |
| `store/vault.json` | dashboard UI | Titkosított titkos kulcsok (AES-256-GCM) |
| `store/.vault-key` | nem | Vault visszafejtési kulcs (OS keychain-be migrált, ha elérhető) |
| `store/schedule-last-run.json` | automatikus | Ütemezett feladatok utolsó futási időbélyege (crash-safe skip) |
| `store/kanban-audit-state.json` | automatikus | Kanban audit utolsó futása |
| `store/claudeclaw.db` | nem direktben | SQLite adatbázis -- memória, kanban, üzenetek, token-log, stb. |
| `store/config-overrides.json` | dashboard UI | Beállítások-oldal által mentett felülbírálatok (plain értékek, sosem tartalmaz titkokat) |
| `store/update.pid` | automatikus | Frissítési folyamat PID fájl (concurrency lock) |

### A dashboard nyelve

A sidebar bal alsó sarkában egy `HU / EN` feliratú gomb jelenik meg. Rákattintva a teljes felület azonnal vált -- a navigáció, a gombok, az üzenetek és a Dokumentáció oldal egyaránt az újonnan választott nyelven jelenik meg újra. A választás a böngésző session-jén belül megmarad.

Ha azt szeretnéd, hogy a dashboard minden új megnyitáskor alapból egy adott nyelvű legyen, a `DASHBOARD_LANG` értékét állítsd be a Beállítások oldal Rendszer moduljában (`hu` vagy `en`). A kliensoldali gomb a szerver-alapértelmezést felülírja; ha nincs kliensoldali beállítás, a `DASHBOARD_LANG` érvényesül.

A Dokumentáció oldal a globális beállítást követi -- nincs külön dokumentáció-váltó.

---

### Beállítások oldal

A dashboard bal oldali navigációjában a "Beállítások" menüpont megnyitja a konfigurációs felületet, ahol az env-alapú paramétereket közvetlenül a böngészőből lehet megtekinteni és módosítani -- `.env` szerkesztés vagy szerver-hozzáférés nélkül.

**Hogyan módosíts egy értéket?**

A beállítások modul-csoportokba rendezve jelennek meg (Kanban, Rendszer, Heartbeat). Minden sor tartalmaz:
- a kulcs nevét és leírását,
- a jelenlegi értéket egy szerkeszthető inputban (egész számoknál beviteli mező az érvényes tartomány jelzésével, színeknél színválasztó az aktuális szín előnézetével, enum-jellegü kulcsoknál legördülő lista).

Az input módosítása megjelöli a sort piszkosként (dirty). Az oldal alján egy rögzített mentési sáv jelenik meg, amely mutatja a módosított sorok számát, és két gombot kínál:
- **Mentés** -- az összes piszkos sort egyszerre menti. A sikertelen sorok (validációs hiba) jelzést kapnak, a többi elmentődik.
- **Visszaállítás** -- minden módosítást visszaállít az utoljára betöltött értékre, a mentési sáv eltűnik.

**Mit jelent a validációs hiba?**

Ha érvénytelen értéket adsz meg (pl. 150-et, ahol a maximum 100, vagy nem `#rrggbb` formátumú szín), a hibaüzenet közvetlenül a sor alatt jelenik meg mentés után. A többi sor elmentődik, csak a hibás sor marad piszkosként. Javítsd az értéket és kattints Mentés-re újra.

**Elhagyási figyelmeztetés**

Ha el szeretnéd hagyni a Beállítások oldalt (másik menüpontra kattintasz, vagy bezárod a böngésző fület) miközben van mentetlen módosítás, a böngésző megerősítési ablakot jelenít meg. Ha visszautasítod a navigációt, az oldal és a piszkos értékek megmaradnak.

**Mikor kell újraindítás?**

Egyes beállítások mellett "Újraindítást igényel" feliratú badge látható -- ha ilyen értéket módosítasz (pl. `DASHBOARD_PUBLIC_URL`, `OLLAMA_URL`, `HEARTBEAT_AGENT_ENABLED`), a változás csak a szerver következő újraindítása után lép életbe. A kanban és heartbeat időablak-beállítások (pl. `KANBAN_WIP_*`, `KANBAN_AGING_*`, `HEARTBEAT_START_HOUR`) azonnal hatnak, újraindítás nélkül.

**Mit állíthatsz be?**

A beállítások három modulba vannak csoportosítva:

*Kanban* -- a kanban-tábla viselkedése:
- WIP-limitek és badge-színek: melyik oszlop hány kártyáig zöld/sárga/piros (v1 óta elérhető)
- Kártya-öregedés: hány óra után jelenik meg a sárga/narancs/piros öregedési jelzés, és milyen színnel -- ha a csapat ritka iterációkban dolgozik, az alapértelmezett 24h/72h/168h küszöbök felfelé állíthatók
- Archiválás: hány nappal a lezárás után kerüljenek a "done" kártyák automatikusan az archívumba (alapértelmezett 30 nap)
- Swimlane alapértelmezés: a kanban tábla milyen csoportosításban nyíljon meg ("nincs", "felelős szerint", "prioritás szerint")

*Rendszer* -- infrastruktúra paraméterek:
- A dashboard nyilvánosan elérhető URL-je (webhookoknál és külső hivatkozásoknál használja a rendszer; újraindítás szükséges)
- Az Ollama embedding szerver URL-je (memória-kereséshez; újraindítás szükséges)
- Felület alapértelmezett nyelve (`DASHBOARD_LANG`): `hu` vagy `en` -- a sidebar gomb kliensoldali választása ezt felülírja, de ha nincs kliensoldali beállítás, ez az érték érvényesül minden új megnyitásnál (újraindítás nélkül hat)

*Heartbeat* -- a háttér összefoglaló ügynök:
- Be/kikapcsolás: "1" = aktív, "0" = leállítva (újraindítás szükséges)
- Aktív időablak: melyik óráktól meddig futhasson (pl. 9-23 = csak napközben)

---

### Beállítások rendszer (Settings)

A dashboard Beállítások oldala egy háromrétegű konfigurációs rendszert kezel.

**Feloldási sorrend (priority order, az első találat nyer):**
1. `store/config-overrides.json` -- a dashboard által mentett felülbírálatok
2. `.env` -- project szintű értékek (induláskor és minden lekérésnél frissen olvassa)
3. Registry alapértelmezett érték (`src/config-registry.ts`)

**`store/config-overrides.json` struktúra:**

```json
{
  "KANBAN_WIP_PLANNED": 10,
  "KANBAN_WIP_WARN_PCT": 80,
  "KANBAN_WIP_OK_COLOR": "#6b7280"
}
```

Csak a felülbírált kulcsok jelennek meg; a többi a registry alapértékét kapja. Az írás atomi (tmp fájl + rename), így részleges írás nem fordulhat elő.

**Beállítás-registry (`src/config-registry.ts`):**

Minden dashboard-szerkeszthető beállítás egy bejegyzésként szerepel a registry-ben, az alábbi mezőkkel:

| Mező | Típus | Leírás |
|------|-------|--------|
| `key` | string | ENV-kompatibilis kulcs (pl. `KANBAN_WIP_PLANNED`) |
| `type` | `int` / `color` / `string` / `boolean` | Érték típusa (validáció + UI widget). A `boolean` ki/be kapcsoló (checkbox), kanonikus `"1"`/`"0"` értékkel |
| `default` | any | Fallback érték, ha nincs override és nincs .env |
| `description` | string | Felhasználói leírás (UI-ban megjelenik) |
| `module` | string | Csoportosítás a Beállítások oldalon (pl. `kanban`) |
| `secret` | boolean | Ha `true`: az API nem adja vissza az értéket, POST sem engedélyezett |
| `requiresRestart` | boolean | Ha `true`: a badge jelzi, hogy az érték csak újraindítás után lép életbe |
| `min` / `max` | number? | Int típusnál határértékek |
| `valueSet` | string[]? | Ha megadott: csak ezek közül lehet választani (select widget) |

**Registry -- Kanban modul:**

| Kulcs | Típus | Alapérték | Korlát | Újraindítás |
|-------|-------|-----------|--------|-------------|
| `KANBAN_WIP_PLANNED` | int | 0 (korlátlan) | max 100 | nem |
| `KANBAN_WIP_IN_PROGRESS` | int | 0 | max 100 | nem |
| `KANBAN_WIP_WAITING` | int | 0 | max 100 | nem |
| `KANBAN_WIP_DONE` | int | 0 | max 100 | nem |
| `KANBAN_WIP_WARN_PCT` | int | 80 | min 1, max 100 | nem |
| `KANBAN_WIP_OK_COLOR` | color | `#6b7280` | #rrggbb | nem |
| `KANBAN_WIP_WARN_COLOR` | color | `#c9a000` | #rrggbb | nem |
| `KANBAN_WIP_FULL_COLOR` | color | `#d46b00` | #rrggbb | nem |
| `KANBAN_WIP_OVER_COLOR` | color | `#c53030` | #rrggbb | nem |
| `KANBAN_ARCHIVE_DONE_DAYS` | int | 30 | min 1, max 365 | nem |
| `KANBAN_AGING_WARN_H` | int | 24 | min 1, max 8760 | nem |
| `KANBAN_AGING_CAUTION_H` | int | 72 | min 1, max 8760 | nem |
| `KANBAN_AGING_CRITICAL_H` | int | 168 | min 1, max 8760 | nem |
| `KANBAN_AGING_WARN_COLOR` | color | `#c9a000` | #rrggbb | nem |
| `KANBAN_AGING_CAUTION_COLOR` | color | `#d46b00` | #rrggbb | nem |
| `KANBAN_AGING_CRITICAL_COLOR` | color | `#c53030` | #rrggbb | nem |
| `KANBAN_SWIMLANE_DEFAULT_GROUP` | string | `none` | `none`, `assignee`, `priority` | nem |
| `KANBAN_SWIMLANE_SEPARATOR_COLOR` | color | `#374151` | #rrggbb | nem |

**Registry -- Rendszer modul:**

| Kulcs | Típus | Alapérték | Leírás | Újraindítás |
|-------|-------|-----------|--------|-------------|
| `DASHBOARD_PUBLIC_URL` | string | (üres) | A dashboard nyilvánosan elérhető URL-je | igen |
| `OLLAMA_URL` | string | `http://localhost:11434` | Ollama API alap-URL | igen |

**Registry -- Heartbeat modul:**

| Kulcs | Típus | Alapérték | Korlát | Újraindítás |
|-------|-------|-----------|--------|-------------|
| `HEARTBEAT_START_HOUR` | int | 9 | min 0, max 22 | nem |
| `HEARTBEAT_END_HOUR` | int | 23 | min 1, max 24 | nem |
| `HEARTBEAT_AGENT_ENABLED` | string | `1` | `0` vagy `1` | igen |
**Registry -- Ötletláda modul:**

| Kulcs | Típus | Alapérték | Korlát | Újraindítás |
|-------|-------|-----------|--------|-------------|
| `IDEA_BREAKDOWN_MAX_SUBTASKS` | int | 10 | min 2, max 20 | nem |
| `IDEA_STALE_DAYS` | int | 7 | min 1, max 365 | nem |

**Registry -- Csatornák modul:**

| Kulcs | Típus | Alapérték | Platform | Újraindítás |
|-------|-------|-----------|----------|-------------|
| `MAIN_AGENT_ISOLATED_CONFIG` | boolean | `0` (ki) | csak macOS | igen |

#### `MAIN_AGENT_ISOLATED_CONFIG` -- a fő agent config-izolációja (macOS)

**Mire szolgál.** Ki-be kapcsolható javítás a fő channels-agent macOS-en jelentkező
periodikus `401 Invalid authentication credentials` / „Please run /login" hibájára.
A tünet: a fő bot időnként elnémul, kézi `/login` kell, pár nap múlva megismétlődik --
miközben a sub-agentek sosem esnek ki.

**A gyökérok.** A fő channels-agent alapból a közös `~/.claude` config dir-t
használja. macOS-en ez a **rotálódó Keychain OAuth-sessionből** hitelesít, ami
periodikusan lejár → 401. A sub-agentek ezzel szemben saját, izolált
`CLAUDE_CONFIG_DIR`-rel és a hosszú élettartamú fleet setup-tokennel
(`store/.claude-oauth-token`) futnak, ezért ők stabilak.

**Mit csinál bekapcsolva.** A fő agent is megkapja a sub-agentekével AZONOS izolált
config dir-t (`<install>/.channels-config`, symlinkelt megosztott résekkel, de saját
`settings.json`/`plugins/` állapottal és `.credentials.json` NÉLKÜL). Így a fő agent
a stabil `CLAUDE_CODE_OAUTH_TOKEN`-ből hitelesít, nem a lejáró Keychainből.

**Egységes kapu.** A be/ki döntést egyetlen helper (`ensureMainAgentIsolatedConfigDir`)
hozza, ami az effektív beállítást olvassa (feloldás: `config-overrides.json` >
`.env` > default `0`). Ezt a helpert hívja MINDHÁROM fő-agent indítási út, így a
kapcsoló egységesen vezérli az összeset:
1. a `scripts/channels.sh` boot (indító helper),
2. a dashboard channel-monitor `--continue` resume respawn-ja,
3. a dashboard channel-monitor fresh hard-restart respawn-ja.

**Kapuk (mikor no-op).** Nincs hatása (marad a közös `~/.claude`), ha: nem macOS a
gép; nincs érvényes fleet setup-token; vagy nincs build-elt `dist/`. Linuxon a
rotálódó `credentials.json`-t ehelyett a külön credentials-guard kezeli.

**Bekapcsolás.** Dashboard: *Beállítások → Csatornák → `MAIN_AGENT_ISOLATED_CONFIG`*
(a kapcsoló a `store/config-overrides.json`-ba ír). Vagy kézzel: `.env`-ben
`MAIN_AGENT_ISOLATED_CONFIG=1`. A módosítás a channels session újraindításakor lép
életbe (a `requiresRestart` badge is ezt jelzi).

**Visszaállítás.** Kapcsold KI (dashboard) vagy `MAIN_AGENT_ISOLATED_CONFIG=0`
(`.env`), majd indítsd újra a channels sessiont -- mindhárom indítási út visszaáll
a közös `~/.claude` viselkedésre.

**API végpontok:**

`GET /api/settings` -- összes nem-titkos beállítás lekérése:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/settings
```

Válasz: `{ "settings": [ { "key", "type", "value", "default", "description", "module", "requiresRestart", "min", "max", "valueSet" }, ... ] }`

`POST /api/settings` -- egy beállítás mentése:

```bash
curl -s -X POST http://localhost:3420/api/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"key": "KANBAN_WIP_WARN_PCT", "value": 75}'
```

Válasz siker esetén: `{ "ok": true, "key": "KANBAN_WIP_WARN_PCT", "value": 75, "requiresRestart": false }`

Hiba esetén: `{ "error": "..." }` (400 validációs hiba, 403 titkos kulcs, 404 ismeretlen kulcs)

**Hot-reload:** a POST sikeres mentés után a `/api/marveen` `kanbanWip` blokkja azonnal az új értékkel tér vissza (nincs szükség újraindításra, ha `requiresRestart: false`).

**Change-log:** minden sikeres POST audit-sort ír a `config_change_log` SQLite táblába (kulcs, régi érték, új érték, actor, timestamp). Titkos kulcsoknál az érték `null`-ként kerül rögzítésre. UI nincs hozzá; a tábla közvetlenül lekérdezhető.

```sql
SELECT key, old_value, new_value, actor, datetime(created_at, 'unixepoch', 'localtime')
FROM config_change_log ORDER BY created_at DESC LIMIT 20;
```

---

### autonomy-config.json struktúra

```json
{
  "version": 1,
  "categories": [
    {
      "key": "kanban_archive_done",
      "label": "7+ napos done kártya archiválás",
      "level": 2,
      "locked": false,
      "maxLevel": 3
    }
  ]
}
```

Autonómia szintek: `1` = csak jelez, `2` = javasol + jóváhagyás kell, `3` = autonóm + utólag jelent. `locked: true` esetén max szint 1 (hard safety szabály miatt nem emelhető).

---

## agents/<name>/ -- sub-ágensek konfigurációja

Minden sub-ágens mappája gitignore-olt (`agents/` mappa), így a titkos kulcsok biztonságban maradnak.

| Fájl | Módosítható | Leírás |
|------|-------------|--------|
| `agents/<name>/agent-config.json` | dashboard UI | Modell, team hierarchia, permission profil |
| `agents/<name>/.mcp.json` | kézzel | MCP szerverek listája az ágensnek (gitignore-olt!) |
| `agents/<name>/.claude/settings.json` | scaffold + kézzel | Claude Code jogosultságok, hook-ok, engedélyezett eszközök |
| `agents/<name>/CLAUDE.md` | kézzel | Az ágens instrukciói és személyisége |
| `agents/<name>/SOUL.md` | kézzel | Opcionális mélyebb személyiség-leíró |
| `agents/<name>/avatar.png` | kézzel | Az ágens Telegram bot profilképe |

### agent-config.json struktúra

```json
{
  "model": "claude-sonnet-4-6",
  "profileId": "developer-senior",
  "memoryIsolation": false,
  "team": {
    "role": "member",
    "reportsTo": "marveen",
    "delegatesTo": [],
    "autoDelegation": false,
    "trustFrom": []
  }
}
```

A `memoryIsolation` mező (opcionális, alapértelmezés: kikapcsolva) az ágens fájl-alapú auto-memóriáját választja le a közös, telepítés-szintű memóriáról. Bekapcsolva az ágens indításkor saját git-gyökeret kap (stub .git az agents/<név> alatt), így a Claude Code auto-memory a saját projekt-kulcsa alá kerül, és az ágens nem látja a közös MEMORY.md-t. A megosztott SQLite-emlékek és a CLAUDE.md továbbra is elérnek hozzá.

Mikor kapcsold be: több-felhasználós (több megbízós) telepítésen, ágensenként, hogy az egyes megbízók memóriái ne szivárogjanak át egymáshoz. Egy-felhasználós telepítésen hagyd kikapcsolva: ott a közös MEMORY.md a flotta-szabályok szándékolt terítő-csatornája. Életbe lépés: az ágens következő (újra)indítása. Visszavonás: a mező törlése és az `agents/<név>/.git` stub eltávolítása. A fő ágensre nem alkalmazható (a dashboard el is rejti ott a kapcsolót).

---

## Linux OAuth-token race + CLAUDE_CREDENTIALS_GUARD

Linuxon a `~/.claude/.credentials.json` egy rövid életű, magától rotálódó OAuth tokent tárol, OS-szintű fájlzárolás nélkül. Ha több agent egyszerre ér a token lejáratához (jellemzően éjjel), a frissítő írásaik egymásra futnak és elrontják a fájlt, ezért reggelente minden agent `/login`-t kér. macOS-en a Keychain sorbarendezi az írásokat, ott nincs ez a hiba.

A megoldás: egy 1 éves, nem rotálódó setup-token (`claude setup-token`) a `store/.claude-oauth-token` fájlban, amit az agent-indító `CLAUDE_CODE_OAUTH_TOKEN`-ként exportál minden lokális agentnek. Ezzel a Claude Code-nak nincs szüksége a rotálódó `credentials.json`-ra. A `CLAUDE_CREDENTIALS_GUARD=1` flag bekapcsolja, hogy az indító a rotálódó `credentials.json`-t félretegye (`.credentials.json.bak`), így megszűnik a verseny.

- **Alapértelmezés: KIKAPCSOLVA.** A flag nélkül semmi nem történik (a jelenlegi viselkedés bájtra változatlan). Egy pilot-hoston kapcsold be a `.env`-ben (`CLAUDE_CREDENTIALS_GUARD=1`), ne mindenhol egyszerre.
- **Csak Linux**, macOS-en no-op (ott nincs is credentials.json).
- **Guardolt**: a rename CSAK akkor fut, ha van érvényes setup-token (formátum-ellenőrzés + egyszeri éles teszthívás, token-értékhez kötött cache-sel). Érvénytelen/hiányzó token esetén a credentials.json érintetlen marad, hogy egyetlen agent se essen ki.
- **Idempotens és visszaállítható**: a rename `.bak`-ra megy, visszavonás `mv .credentials.json.bak .credentials.json`.
- **Fontos install-konzisztencia**: a fő channels-agent a `.env` `CLAUDE_CODE_OAUTH_TOKEN`-jét használja, a sub-agentek a `store/.claude-oauth-token`-t. Bekapcsolás előtt győződj meg róla, hogy a kettő UGYANAZ az érvényes token, különben a fő agent kieshet.
- A token SOHA nem kerül logba, commitba vagy chatbe.

---

## templates/ -- ágens-létrehozási sablonok

Ezek a sablonok az ágens scaffold során töltődnek ki és kerülnek az `agents/<name>/` mappába.

| Fájl / Mappa | Leírás |
|--------------|--------|
| `templates/CLAUDE.md.template` | Alapértelmezett CLAUDE.md sablon új ágensekhez |
| `templates/SOUL.md.template` | Alapértelmezett SOUL.md sablon |
| `templates/settings.json.template` | Claude Code settings sablon (hook-ok, jogosultságok) |
| `templates/profiles/` | Permission profil sablonok (JSON fájlok) |
| `templates/scheduled-tasks/` | Beépített ütemezett feladatok (reggeli napindító, memoria-heartbeat, stb.) |

### Permission profilok (templates/profiles/)

| Profil | permissionMode | Leírás |
|--------|---------------|--------|
| `default.json` | permissive | Alapértelmezett fallback, minden engedélyezett |
| `developer-senior.json` | permissive | SSH/AWS/sudo tiltva, egyébként szabad |
| `developer-junior.json` | strict | Szigorú sandbox, csak engedélyezett útvonalak |
| `marketer.json` | strict | Marketing-specifikus hozzáférések |
| `researcher.json` | strict | Kutató profil, korlátozott írás |

A profil beállítása az ágens `agent-config.json` `profileId` mezőjével történik, és a dashboard "Ágensek" felületén módosítható.

---

## ~/.claude/scheduled-tasks/ -- ütemezett feladatok

Minden feladat egy önálló mappa, benne két fájl. Részletes leírás: [scheduled-tasks.md](scheduled-tasks.md).

| Fájl | Leírás |
|------|--------|
| `SKILL.md` | YAML frontmatter (name, description) + a prompt törzse |
| `task-config.json` | Cron kifejezés, ágens, típus, viselkedési flagek |

---

## ~/.claude/channels/ -- csatorna-hozzáférés

| Fájl | Leírás |
|------|--------|
| `~/.claude/channels/telegram/access.json` | Telegram allowFrom lista, párosított senderek |
| `~/.claude/channels/slack/access.json` | Slack allowFrom lista |

---

## .mcp.json -- MCP szerverek

Az MCP konfigurációk scope-olva vannak: az ágensek `agents/<name>/.mcp.json` fájljaikban csak a számukra releváns szervereket tartalmazzák. A projekt gyökerében lévő `.mcp.json` a főágensre (marveen/Jarvis) vonatkozik.

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "...",
        "GITLAB_API_URL": "https://gitlab.com/api/v4"
      }
    },
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp", "serve"]
    }
  }
}
```

**Fontos:** az `agents/` mappa gitignore-olt, így az `.mcp.json` titkos kulcsai nem kerülnek a repositoryba. A projekt gyökerében lévő `.mcp.json` gitignore-olt (ellenőrizd a `.gitignore`-t!).

---

## Környezeti változók (.env / launchd plist)

A főbb konfigurációs változók a launchd plist-ben (`~/Library/LaunchAgents/com.marveen.dashboard.plist`) vagy a `.env` fájlban élnek.

| Változó | Leírás |
|---------|--------|
| `CHANNEL_PROVIDER` | `telegram` vagy `slack` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot API token |
| `ALLOWED_CHAT_ID` | Az egyetlen engedélyezett Telegram chat ID |
| `SLACK_BOT_TOKEN` | Slack bot token (ha Slack provider) |
| `SLACK_CHANNEL_ID` | Slack csatorna ID |
| `WEB_PORT` | Dashboard port (alapértelmezett: 3420) |
| `ANTHROPIC_API_KEY` | Claude API kulcs |
| `OWNER_NAME` | A tulajdonos neve (pl. "Jónás Gergő") |
| `BOT_NAME` | A főágens neve (pl. "Jarvis") |

---

## Kapcsolódó dokumentumok

- [Vault és titkosítás](vault.md)
- [MCP konfiguráció](mcp-config.md)
- [Ütemezett feladatok](scheduled-tasks.md)
- [Biztonsági modell](security.md)
- [Migrálás](MIGRATION.md)
