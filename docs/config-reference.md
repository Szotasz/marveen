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

### Beállítások oldal

A dashboard bal oldali navigációjában a "Beállítások" menüpont megnyitja a konfigurációs felületet, ahol az env-alapú paramétereket közvetlenül a böngészőből lehet megtekinteni és módosítani -- `.env` szerkesztés vagy szerver-hozzáférés nélkül.

**Hogyan módosíts egy értéket?**

A beállítások modul-csoportokba rendezve jelennek meg (pl. "kanban"). Minden sor tartalmaz:
- a kulcs nevét és leírását,
- a jelenlegi értéket egy szerkeszthető inputban (egész számoknál beviteli mező az érvényes tartomány jelzésével, színeknél színválasztó az aktuális szín előnézetével),
- egy "Mentés" gombot.

Kattints a "Mentés" gombra -- a változás azonnal életbe lép, a szerver többi beállítása érintetlen marad. Ha a kanban tábla oldalát ezután megnyitod, már az új értékeket mutatja.

**Mit jelent a validációs hiba?**

Ha érvénytelen értéket adsz meg (pl. 150-et, ahol a maximum 100, vagy nem `#rrggbb` formátumú szín), a hibaüzenet közvetlenül a sor alatt jelenik meg mentés gomb megnyomása után. Más sorok érintetlenek maradnak. Javítsd az értéket és próbáld újra.

**Mikor kell újraindítás?**

Egyes beállítások mellett "Újraindítást igényel" feliratú badge látható -- ha ilyen értéket módosítasz, a változás csak a szerver következő újraindítása után lép életbe. A v1-es kanban beállítások (WIP-limitek és badge-színek) mind azonnal hatnak, újraindítás nélkül.

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
| `type` | `int` / `color` / `string` | Érték típusa (validáció + UI widget) |
| `default` | any | Fallback érték, ha nincs override és nincs .env |
| `description` | string | Felhasználói leírás (UI-ban megjelenik) |
| `module` | string | Csoportosítás a Beállítások oldalon (pl. `kanban`) |
| `secret` | boolean | Ha `true`: az API nem adja vissza az értéket, POST sem engedélyezett |
| `requiresRestart` | boolean | Ha `true`: a badge jelzi, hogy az érték csak újraindítás után lép életbe |
| `min` / `max` | number? | Int típusnál határértékek |
| `valueSet` | string[]? | Ha megadott: csak ezek közül lehet választani (select widget) |

**v1 registry (9 kanban WIP kulcs):**

| Kulcs | Típus | Alapérték | Korlát |
|-------|-------|-----------|--------|
| `KANBAN_WIP_PLANNED` | int | 0 (korlátlan) | max 100 |
| `KANBAN_WIP_IN_PROGRESS` | int | 0 | max 100 |
| `KANBAN_WIP_WAITING` | int | 0 | max 100 |
| `KANBAN_WIP_DONE` | int | 0 | max 100 |
| `KANBAN_WIP_WARN_PCT` | int | 80 | min 1, max 100 |
| `KANBAN_WIP_OK_COLOR` | color | `#6b7280` | #rrggbb |
| `KANBAN_WIP_WARN_COLOR` | color | `#c9a000` | #rrggbb |
| `KANBAN_WIP_FULL_COLOR` | color | `#d46b00` | #rrggbb |
| `KANBAN_WIP_OVER_COLOR` | color | `#c53030` | #rrggbb |

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
  "team": {
    "role": "member",
    "reportsTo": "marveen",
    "delegatesTo": [],
    "autoDelegation": false,
    "trustFrom": []
  }
}
```

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
