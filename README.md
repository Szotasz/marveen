# Marveen

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Slack](https://img.shields.io/badge/Slack-Socket_Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/)
[![GitHub stars](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)

> AI csapatod, ami fut amíg te alszol.

Marveen egy AI asszisztens keretrendszer, ami Claude Code-ra épül. Saját AI csapatot építhetsz, akik Telegramon vagy Slacken kommunikálnak veled, önállóan dolgoznak, és egymással is együttműködnek.

## Funkciók

- **AI Csapat**: Több ágens, mindegyik saját csatornával (Telegram vagy Slack), személyiséggel és memóriával
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezeléséhez
- **Inter-agent kommunikáció**: Az ágensek delegálhatnak egymásnak feladatokat
- **Ütemezések**: Cron-alapú feladatok automatikus futtatása
- **Kanban**: Feladattábla AI auto-bontással; Jira-szerű nézetek — swimlane (csoportosítás felelős vagy prioritás szerint), oszloponkénti WIP-limit, beakadt-kártya jelzés (card-aging), alfeladat-beágyazás és kártya-szerkesztő
- **Heartbeat**: Csendes háttér-monitorozás, csak fontosnál szól (naptár, email, kanban)
- **Memória**: Hot/Warm/Cold tier rendszer, hibrid kereséssel (FTS5 + vektor) és gráf nézettel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack és más szolgáltatások
- **Skillek**: Újrahasználható képességek az ágenseknek
- **Öntanulás**: Az ágensek automatikusan tanulnak a munkájukból és skill-eket hoznak létre

## 📚 Dokumentáció

Részletes, funkciónkénti leírások a [`docs/`](docs/README.md) mappában — mindegyik lap két szemszögből: 🎯 *mit tud / miért érdekes* + 🛠 *hogyan működik*.

| Funkció | Lap |
|---------|-----|
| Heartbeat + fokozatos autonómia | [docs/heartbeat-autonomy.md](docs/heartbeat-autonomy.md) |
| Memória-rendszer (FTS5 + vektor + RRF) | [docs/memory-system.md](docs/memory-system.md) |
| Kanban (auto-breakdown, swimlane, WIP-limit, card-aging) | [docs/kanban.md](docs/kanban.md) |
| Ügynök-flotta + inter-agent | [docs/agent-fleet.md](docs/agent-fleet.md) |
| Skill-factory (öntanulás) | [docs/skill-factory.md](docs/skill-factory.md) |
| Channels (Telegram / Slack) | [docs/channels.md](docs/channels.md) |
| Printing-press CLI-k | [docs/printing-press-cli.md](docs/printing-press-cli.md) |
| Skool CLI | [docs/skool-cli.md](docs/skool-cli.md) |
| connectors.hu | [docs/connectors-hu.md](docs/connectors-hu.md) |
| Vault & titkosítás | [docs/vault.md](docs/vault.md) |
| Dream-engine | [docs/dream-engine.md](docs/dream-engine.md) |
| Háttér-feladatok | [docs/background-tasks.md](docs/background-tasks.md) |
| Ütemezett feladatok | [docs/scheduled-tasks.md](docs/scheduled-tasks.md) |
| Költöztetés (másik gépre) | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Beszélgetés-folytonosság | [docs/conversation-continuity.md](docs/conversation-continuity.md) |
| Channel reply-guard | [docs/channel-reply-guard.md](docs/channel-reply-guard.md) |
| Telegram haladásjelző | [docs/telegram-progress-indicator.md](docs/telegram-progress-indicator.md) |
| Új asszisztens onboarding | [docs/onboarding-uj-asszisztens.md](docs/onboarding-uj-asszisztens.md) |

## Öntanulás & Seed-ek

Az ágensek automatikusan tanulnak a munkájukból: komplex feladat vagy hiba-recovery után újrahasznosítható skill-t (recept) írnak maguknak, a meglévőket pedig célzottan patch-elik. A skill-ek token-hatékonyan, 3 szinten töltődnek (progressive disclosure). A flotta-szintű skill-ek és ütemezett feladatok a `seed-skills/` és `seed-scheduled-tasks/` mappából terjednek minden telepítésre (idempotens: a meglévő testreszabást nem írja felül).

→ **Részletek:** [docs/skill-factory.md](docs/skill-factory.md)

## Memória rendszer

Minden ágens saját, réteges memóriával rendelkezik (hot / warm / cold / shared), SQLite-ban tárolva. A keresés hibrid: FTS5 full-text + szemantikus vektor (Ollama `nomic-embed-text`), RRF-fel fúzionálva. A memóriák salience decay-en mennek át (a régi, nem használt tételek halványulnak, de sosem törlődnek), és minden este napi napló készül. A `PreCompact` hook a kontextus-tömörítés előtt automatikusan elmenti a fontos döntéseket. A dashboardon gráf-nézet is van.

→ **Részletek:** [docs/memory-system.md](docs/memory-system.md)

## Telepítés

### macOS / Linux

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

### Windows (WSL)

```powershell
irm https://raw.githubusercontent.com/Szotasz/marveen/main/install-windows.ps1 | iex
```

Vagy manuálisan:
```powershell
git clone https://github.com/Szotasz/marveen.git
cd marveen
.\install-windows.ps1
```

A Windows telepítő automatikusan beállítja a WSL-t (Windows Subsystem for Linux) és azon belül telepíti a Marveen-t.

> **Ha a PowerShell ablak bezárul / a telepítő nem jut túl a WSL+Ubuntu lépésen:** nyisd meg az Ubuntu-t (Start menü → Ubuntu), majd a WSL Ubuntu shellben futtasd közvetlenül a Linux-telepítőt (a PowerShell wrapper megkerülése):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh -o install.sh && bash install.sh
> ```
> Ez a megbízható út, ha a `wsl.exe`/Windows-claude környezet összeakad.

A telepítő végigvezet a beállításokon:
1. Függőségek ellenőrzése és telepítése
2. Claude Code bejelentkezés
3. Telegram bot létrehozása
4. Személyes beállítások (a bot neve és a termék/márka neve)
5. Szolgáltatások indítása

### Branding (saját márkanév)

A platform szabadon márkázható telepítéskor. Két, egymástól **független** beállítás:

| Beállítás | Mi ez | Default |
|-----------|-------|---------|
| `BOT_NAME` | A fő ágens megjelenített neve (pl. `MyAssistant`) | `Marveen` |
| `BRAND_NAME` | A termék / rendszer neve a dashboard fejlécében (böngésző-cím, oldalsáv, mobil topbar) | `BOT_NAME` |

A telepítő mindkettőt megkérdezi. Ha csak Entert nyomsz, minden marad `Marveen` (a viselkedés változatlan a meglévő telepítésekhez képest). Ha külön márkanevet adsz meg, a teljes felület és az OS szolgáltatás-azonosítók is azzal jönnek létre:

```bash
# Példa: az ágens neve "MyAssistant", a terméké "AcmeAI"
#   Mi legyen a botod neve? [Marveen]: MyAssistant
#   Mi a termék/márka neve? [MyAssistant]: AcmeAI
```

A `.env`-ben ezek a kulcsok jelennek meg (lásd `.env.example`):

```env
BOT_NAME=MyAssistant
BRAND_NAME=AcmeAI
MAIN_AGENT_ID=myassistant   # belső ágens-azonosító (a BOT_NAME ASCII slug-ja)
SERVICE_ID=acmeai           # OS szolgáltatás-azonosító (a BRAND_NAME ASCII slug-ja)
```

A `MAIN_AGENT_ID` és `SERVICE_ID` értékeket a telepítő automatikusan származtatja; ritkán kell kézzel szerkeszteni. Ha a `BRAND_NAME` megegyezik a `BOT_NAME`-mel (a default), a `SERVICE_ID` megegyezik a `MAIN_AGENT_ID`-vel, így a launchd/systemd unit-nevek byte-azonosak a márkázatlan telepítéssel: a helyben történő frissítés nem törik el.

## Használat

### Dashboard
Nyisd meg: http://localhost:3420

### Csatorna (Telegram vagy Slack)

A telepítés során választhatsz csatorna providert. Az alapértelmezett a Telegram.

#### Telegram (alapértelmezett)
Írj a botodnak Telegramon -- Marveen válaszol.

#### Slack (alternatív)

Slack használatához a telepítő automatikusan végigvezet, de manuálisan is beállíthatod:

1. Hozz létre egy Slack App-ot a [Slack API](https://api.slack.com/apps) oldalon
2. Engedélyezd a Socket Mode-ot (Settings > Socket Mode > Enable)
3. Generálj egy App-Level Token-t (`xapp-...`) a `connections:write` scope-pal
4. Add hozzá a Bot Token Scopes-okat (OAuth & Permissions): `chat:write`, `channels:read`, `files:write`, `files:read`
5. Installáld az App-ot a workspace-edbe -- megkapod a Bot User OAuth Token-t (`xoxb-...`)
6. Hívd meg a botot a kívánt csatornába (`/invite @BotNev`)
7. A `.env` fájlban állítsd be:
   ```
   CHANNEL_PROVIDER=slack
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C01234ABCDE
   ```
8. A Slack channel plugin automatikusan települ: `slack@jeremylongshore/claude-code-slack-channel`

A csatorna váltáshoz futtasd újra a `./install.sh`-t vagy szerkeszd a `.env` fájlt manuálisan.

### Ágensek
A Csapat oldalon hozz létre új ágenseket. Mindegyik:
- Saját Telegram bot
- Saját személyiség (SOUL.md)
- Saját utasítások (CLAUDE.md)
- Saját memória és skillek

### Telegram bot profilkép

A telepítő automatikusan generál egy pixel-art avatart és Telegramon elküldi neked a beállítási utasításokkal. Ha egyedi képet szeretnél:

1. Tedd a fájlt `agents/<AGENT_NEVE>/avatar.png` alá (png/jpg/jpeg/webp)
2. Indítsd újra a szolgáltatást (`./scripts/stop.sh && ./scripts/start.sh`)
3. Az install-flow újra elküldi az avatart a Telegram chatbe

**Beállítás a Telegram botodra:**
1. Nyisd meg a [@BotFather](https://t.me/BotFather) chatet
2. Küld a `/setuserpic` parancsot
3. Válaszd ki a botodat a listából
4. Küldd be a kapott képet

A dashboardon (Csapat oldal) is cserélhetsz avatart: kattints a bot kártyájára, válassz a galériából vagy tölts fel sajátot -- a rendszer automatikusan elküldi a Telegram chatbe.

### Ütemezések
Időzített feladatok és heartbeat monitorok beállítása:
- Lista, napi idővonal és heti nézet
- Feladat: mindig szól az eredménnyel
- Heartbeat: csendes ellenőrzés, csak fontosnál értesít

### Vault & Titkosítás

Az MCP szerverek API kulcsait, tokenjeit és jelszavait egy titkosított Vault kezeli (AES-256-GCM), a master key macOS-en a Keychain-ben (Linuxon fájl-alapú fallback). A `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak — a plaintext kulcsok nem hevernek olvashatóan. A dashboard Vault-oldalán kezelheted a titkokat, a Scan & Import megtalálja a meglévő plaintext kulcsokat.

→ **Részletek:** [docs/vault.md](docs/vault.md)

### Ágens monitorozás

A `monitor_agents.sh` script összefogja az összes futó ágens tmux session-jét egyetlen `monitor` session-be, iTerm2 Control Mode-dal (`-CC`) minden ágens külön iTerm tab-ként jelenik meg.

```bash
# Lokálisan (a gépen ahol az ágensek futnak):
./scripts/monitor_agents.sh

# Távolról (laptopról SSH-n, iTerm2-vel):
ssh macmini -t "~/marveen/scripts/monitor_agents.sh"

# Ha új ágens indult és nem látod a monitorban -- kill + újraindítás:
ssh macmini "/opt/homebrew/bin/tmux kill-session -t monitor" && \
  ssh macmini -t "~/marveen/scripts/monitor_agents.sh"
```

A script automatikusan felderíti a futó `agent-*` és `marveen-channels` session-öket. A monitor session törlése nem érinti az ágens session-öket -- csak a linked-window referenciákat szünteti meg.

### Frissítés
```bash
./update.sh
```

### Leállítás / Indítás
```bash
./scripts/stop.sh
./scripts/start.sh
```

### VPS / AWS EC2 telepítés (szerver)

Linux VPS-en (Ubuntu 22+, Debian 12+) az `./install.sh` automatikusan az `install-linux.sh`-t futtatja. Headless szerveren a bejelentkezéshez OAuth token kell, mert nincs böngésző.

```bash
# 1. A SAJÁT gépeden (ahol van böngésző):
claude setup-token
# Másold ki a generált tokent (sk-ant-oat01-...)

# 2. A VPS-en:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh    # automatikusan install-linux.sh-t futtat
```

A token 1 évig érvényes. Ne állíts be `ANTHROPIC_API_KEY`-t mellé.

**Fontos VPS-specifikus tudnivalók:**
- **RAM**: legalább 2 GB ajánlott (t3.small). 1 GB-os gépen az npm build swap nélkül elbukhat -- a telepítő figyelmeztet és felajánl swap-létrehozást.
- **claude.ai MCP-k**: ha a claude.ai fiókodban sok MCP connector van engedélyezve, a headless claude session megpróbálja betölteni mindet, ami instabilitást okozhat. Telepítés előtt tiltsd le a felesleges MCP-ket a claude.ai Settings oldalán.
- **Közvetlen futtatás**: `./install-linux.sh` (Linux) vagy `./install-macos.sh` (macOS) ha az OS-detekciót ki akarod hagyni.

## Követelmények

- macOS, Linux, vagy Windows 10/11 (WSL-lel)
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók vagy Slack workspace

## Közösség és támogatás

Kérdésed van? Csatlakozz az AI a mindennapokban közösséghez:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban) -- oktatóanyagok, kérdések, tapasztalatcsere
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban) -- videók, tutorialok
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

## Támogasd a projektet

Ha hasznos számodra a Marveen, támogasd a fejlesztést:

[![Támogatás](https://img.shields.io/badge/Támogatás-Donably-orange)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## Köszönet

A Marveen több külső projektre és koncepcióra épít. A teljes felsorolás (forrás, szerző, licensz, hogyan használjuk) az [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) fájlban található. Köszönet a Perplexity AI-nek (Bumblebee), Artem Zhutovnak (handoff / retrospective / skill-management skill suite), Mike Van Hornnak (printing-press), Andrej Karpathynak (CLAUDE.md pattern), és Matt Pococknak (handoff design tippek) a munkájukért.

## Készítette

**Szota Szabolcs** -- AI konzultáns, az "AI a mindennapokban" csatorna készítője

[![GitHub](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)
