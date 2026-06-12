# Ügynök-flotta + inter-agent kommunikáció

> Nem egy asszisztens, hanem egy csapat. Specializált ügynökök, akik közvetlenül üzennek egymásnak és együtt visznek végig projekteket.

---

## 🎯 Mit tud / miért érdekes

Marveen egy **orchestrator** (PM-szerep), aki egy specializált ügynök-flottát koordinál — mindegyiknek megvan a maga szerepe (pl. backend-fejlesztés, marketing/frontend, videó, kutatás). Egy nagy feladatnál az orchestrator felbontja a munkát, kiosztja a megfelelő ügynöknek, és összefogja az eredményt.

Az ügynökök **közvetlenül üzennek egymásnak** egy közös üzenetsoron keresztül — nem rajtad keresztül megy minden. Az orchestrator delegál, a szakértő-ügynök dolgozik és visszajelez, te csak a lényeget kapod.

**Kuriózum:** a flotta órákon át önállóan visz végig komplex, több-lépéses projekteket — pl. az egyik ügynök kész a PR-rel, a marketing-ügynök ugyanabból a munkamenetből megírja a bejelentés-szöveget, mindkettő Telegramra értesít. Te a mérföldköveket kapod, nem a belső csevegést.

---

## 🛠 Hogyan működik

### Felépítés

- Minden ügynök egy külön **tmux-session**-ben futó Claude Code példány, saját munkakönyvtárral és `CLAUDE.md`-vel (szerep-specifikus instrukciók).
- Az orchestrator (fő-agent) a dashboardot + a channel-integrációt is futtatja; a sub-agentek a feladataikon dolgoznak.

### Inter-agent üzenetek

Közös SQLite üzenetsor + API:

```
POST /api/messages   { "from": "<agent>", "to": "<agent>", "content": "..." }
GET  /api/messages?agent=<agent>      # státusz
```

A rendszer az üzenetet a célpont ügynök tmux-session-jébe juttatja (`[Uzenet @<felado>-tol]: ...` formátumban), aki feldolgozza és a saját csatornáján válaszol. Csak futó (tmux-session-nel rendelkező) ügynöknek lehet üzenni. Távoli ügynöknél ez azt jelenti, hogy az ssh-kapcsolat és a laptop tmux-szervere elérhető kell legyen a delivery-loop ciklusában; ha nem az, az üzenet a sorban marad és visszakapcsoláskor kézbesül (lásd [Távoli ügynökök](#-távoli-remote-ügynökök)).

### Életciklus

```
POST /api/agents/<name>/start   # ügynök indítása (tmux + claude --continue)
POST /api/agents/<name>/stop
GET  /api/agents/<name>/status
GET  /api/agents                # flotta-lista
```

Az indítás kezeli a Claude Code "resume summary" modal automatikus elutasítását, hogy a friss session ne ragadjon be.

A teljes életciklus (start/stop/status/lista) és az inter-agent üzenetküldés **távoli ügynöknél is működik**, ssh-n keresztül (lásd lentebb) -- a helyi ügynökök viselkedése változatlan.

---

## 🌐 Távoli (remote) ügynökök

Marveen egy always-on orchestrator gépen fut. Egy ügynök beállítható úgy, hogy a **tmux-session-je egy távoli gépen** (pl. egy fejlesztői gépen) fusson egy ott megadott munkakönyvtárban, miközben Marveen az orchestratorról indítja, állítja le, kérdezi le és üzen neki -- mindezt ssh-n keresztül.

### ⭐ Alapelv: az ügynök élete független az ssh-kapcsolattól

A távoli ügynök egy **detached tmux-session**-ben fut a távoli gép saját tmux-szerverén (`tmux new-session -d`), így a `claude` process a tmux-szerver gyereke, NEM az ssh-é. Következmények:

- Egy ssh-szakadás SOHA nem állítja le a távoli ügynököt. A távoli gépen tovább fut és dolgozik; csak Marveen üzenés/megfigyelés képessége szünetel, és visszakapcsoláskor folytatódik.
- A sorban álló inter-agent üzenetek és ütemezett feladatok kivárják a szakadást, és visszakapcsoláskor kézbesülnek (a router 1 óra után dob el egy üzenetet, ha addig nem elérhető).
- A dashboard `unreachable` állapotot mutat (nem `stopped`), és az auto-restart NEM indítja újra az elérhetetlen ügynököt.
- Leállás CSAK explicit `POST /stop`-ra történik.

### Beállítás

```
PUT /api/agents/<name>/remote   { "host": "devbox", "workdir": "/home/user/projekt" }
PUT /api/agents/<name>/remote   { "host": "", "workdir": "" }   # törlés -> újra helyi
```

- `host`: ssh-destination -- alias a `~/.ssh/config`-ból (ajánlott) vagy `user@host`. **NINCS `:port`** a host-stringben; a portot a `~/.ssh/config` `Port` direktívájába tedd. Shell-metakarakter nem engedett.
- `workdir`: **abszolút** elérési út a távoli gépen (relatív/tilde nem engedett, hogy a `--continue` projekt-kódolás determinisztikus legyen).
- Csak ha MINDKETTŐ érvényes, lesz az ügynök távoli; félig konfigurált ügynök helyi marad. A fő ügynök (`marveen`) mindig helyi.
- A `GET /api/agents` válaszban megjelenik a `remoteHost`, `remoteWorkdir` és a `runState` (`running` | `stopped` | `unreachable`).

### ssh-config előfeltétel (orchestrator oldal)

A kód minden ControlMaster/keepalive/ConnectTimeout/BatchMode opciót `-o` flag-gel ad át, így egy minimális stanza elég:

```
Host devbox
  HostName <tavoli-ip-vagy-host>
  User <username>
  # Port 22   # ha nem a default
```

Kell még: jelszó nélküli ssh-kulcs az orchestratortól a távoli gépig (a `BatchMode=yes` miatt soha nem blokkol promptra). A kód `ControlMaster`-multiplexinget használ egy privát socket-könyvtárban (`$XDG_RUNTIME_DIR/marveen-ssh`, mode 0700), hogy az 5mp-es delivery-loop és a watcherek egy kapcsolatot újrahasználjanak.

### Indítás / auth előfeltétel a távoli gépen

- `tmux` és `claude` legyen PATH-on a távoli gépen, és a `claude` legyen bejelentkezve.
- **Ellenőrizd nem-interaktív ssh-kontextusban** (a macOS Keychain nem feltétlenül elérhető ssh-spawnolt processznek):

  ```
  ssh devbox 'which claude && claude --version'
  ```

  Ennek sikerülnie kell. Ha az OAuth-credential nem elérhető nem-interaktívan, állítsd a távoli `claude`-ot API-kulcsos loginra. A `start` egyébként eleve elutasítja az indítást, ha a `which claude` elbukik.

### Működési modell: launch-only, channel-less

A távoli ügynök a távoli gép SAJÁT `~/.claude` loginját és a távoli munkakönyvtár `CLAUDE.md`-jét használja. Nem visz át channel-tokent/vault-titkot/settings.json-t -- inter-agent only (Marveen delegál, az ügynök inter-agent üzenetben jelez vissza).

### Scaffolding-szinkron

Az `agents/<name>/` mappa **gitignore-olt**, így a távoli ügynök viselkedését a távoli munkakönyvtár `CLAUDE.md`-je + a távoli gép `~/.claude` loginja adja -- az orchestrator-oldali persona-fájlok (CLAUDE.md/SOUL.md/skillek) nem szinkronizálódnak automatikusan a távoli gépre.

Ha azt akarod, hogy a távoli ügynök a flotta personáját vigye, tedd azokat a fájlokat a távoli munkakönyvtárba (annak saját git/sync-csatornáján át), vagy vedd fel az `agents/<name>/`-t egy szinkronizált útvonalra. Ez üzemeltetői (infra) döntés, nem repo-változtatás.

### Delegálási elv

Egyértelmű szerep-feladatnál az orchestrator magától delegál (nem kérdez minden lépésnél). A feladat kanban-kártyán fut (lásd [kanban](kanban.md)), az `assignee` a felelős ügynök. Az asset-előállító ügynökök (pl. videó) a végeredményt közvetlenül a felhasználó csatornájára küldik.

---

## 🔍 Persona-modell megfelelőség elemzés

> Minden ügynökhöz hozzárendelt modell **elemzésre és optimalizálásra alkalmas** a tényleges terhelési jelek alapján.

### Mi ez?

Az Ügynökök képernyőn elérhető **"Model javaslat"** gomb kiértékeli, hogy az egyes agensekhez rendelt Claude-modell összhangban van-e a persona szerepével és a mért terhelési mutatókkal. Az elemzés eredménye:

- Megerősítés ("a jelenlegi modell megfelelő"), vagy
- Modellváltási javaslat indoklással (pl. "ez az ágens egyszerű, rövid feladatokat végez -- Haiku elegendő és olcsóbb")

Ha van olyan ágens, amelynél váltás javasolt, a rendszer rákérdez: kerüljön-e kanban-kártya a változtatáshoz.

### Mikor érdemes futtatni?

- Új ágens létrehozásakor (az alapértelmezett modell általános, nem persona-specifikus)
- A flotta bővítése vagy átszervezése után
- Ha a token-fogyasztás (lásd [Token Usage](token-usage.md)) meglepően magas egy ágenseknél

### Mért jelek (AgentSignals)

Az elemzés öt TIER-1 jelzőből dolgozik -- ezeket a rendszer az ügynök tényleges tevékenységéből gyűjti:

| Mező | Leírás |
|------|--------|
| `tokenAvgInputPerCall` | Átlagos bemeneti token/hívás |
| `kanbanOpenCount` | Nyitott kanban-kártyák száma |
| `kanbanUrgentCount` | Urgent prioritású kártyák száma |
| `scheduledFreqPerDay` | Ütemezett feladatok napi gyakorisága |
| `mcpServerCount` | Bekötött MCP-szerverek száma |

### Küszöbök és hatásuk

| Feltétel | Hatás |
|----------|-------|
| `tokenAvgInputPerCall > 10 000` | +1 pont Opus irányba (nagy kontextus-igény) |
| `mcpServerCount >= 4` | +1 pont Opus irányba (mély integráció) |
| `kanbanUrgentCount >= 2` | +1 pont Opus irányba (magas terhelés, üzleti kritikus) |
| `scheduledFreqPerDay >= 10` | +1 pont Haiku irányba (ismétlődő, egyszerű feladatok) |

### Javaslat-szöveg struktúrája

Minden ágenshez generált szöveg hat szekcióból áll:

1. **Jelenlegi modell** -- az aktuálisan beállított modell neve
2. **Megfigyelt használat** -- token-fogyasztás, kanban-terhelés, ütemezési frekvencia, integráció-mélység
3. **Szempont-értékelés** -- ✅ / ⚠️ / ❌ jelölésekkel az egyes jelek értékelése
4. **Ajánlás** -- javasolt modell + a két legmeghatározóbb szempont kiemelve
5. **Becsült költséghatás** -- a modellváltás várható token-költség-változása
6. **Bizonytalanság** -- adathiány vagy alacsony mintaszám esetén jelzés

### API

```
POST /api/agents/model-suggest     # összes agensre lefuttatja az elemzést
```

Válasz: ágensenként `{ agent, currentModel, suggestedModel, reason, changeAdvised }`.

### Kanban integráció

Ha `changeAdvised: true` bármely agensnél, és a felhasználó megerősíti, a rendszer automatikusan kanban-kártyát hoz létre az érintett ügynökhöz (`assignee: marveen`, státusz: `planned`).
