---
name: retrospective
description: Elemezd a jelenlegi sessiont, hol lehet javítani a skilleken, a memórián és a munkafolyamaton. Elfogulatlan elemzéshez sub-agentet indít. Akkor használd, ha a session összetett problémamegoldással, hibából való helyreállással, felhasználói javításokkal vagy többlépéses munkafolyamattal járt. A "/retrospective" parancsra vagy jelentős munka után a session végén indul.
---

# Retrospektív: a session elemzése és javítása

## Mikor használd

- Egy összetett session után (5+ tool-hívás, hibából való helyreállás, többlépéses munkafolyamat)
- Ha a felhasználó kijavította a megközelítésedet ("nem, csináld így")
- Egy sikertelen kísérlet után, amely más stratégiát kívánt
- Egy termékeny sessionben, mielőtt a kontextusablak elfogy
- Kifejezetten a `/retrospective` paranccsal

## Argumentumok

| Argumentum | Kötelező | Leírás |
|----------|----------|-------------|
| `scope` | nem | Mit elemezz: `session` (alapértelmezés), `last-task`, `last-hour` |
| `focus` | nem | Szűkített elemzés: `skills`, `memory`, `workflow` vagy `all` (alapértelmezés) |

Példák:
- `/retrospective`: a teljes session elemzése
- `/retrospective scope=last-task focus=skills`: csak skill-javítások az utolsó feladatra
- `/retrospective focus=memory`: csak a memória tierjére és tartalmára vonatkozó javaslatok

## Eljárás

### 1. Gyűjtsd össze a session adatait

A jelenlegi beszélgetés kontextusából gyűjtsd össze:
- Milyen feladatokba fogtál bele
- Mely megközelítések sikerültek, és melyek buktak el
- A felhasználói javításokat és az indoklásukat
- A használt toolokat és skilleket, és hogy mennyire voltak hatékonyak
- A felmerült hibákat, és hogyan oldódtak meg
- Mennyi idő ment zsákutcákra, és mennyi a termékeny munkára

Húzd be a külső állapotot is:

```bash
AGENT_ID="$(echo $BOT_NAME | tr '[:upper:]' '[:lower:]')"
PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"

# Recent memories written this session
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/memories?agent=$AGENT_ID&category=hot&limit=20"

# Today's daily log entries
DATE=$(date +%Y-%m-%d)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/daily-log?agent=$AGENT_ID&date=$DATE"

# Skills that were referenced or used
ls ~/.claude/skills/ | head -30
```

### 2. Elemezz az A/B/C keretrendszerrel

A session minden jelentős eseményére értékeld:

**A: Mi történt?**
Rögzítsd a tényt: mivel próbálkoztál, mi lett az eredmény.

**B: Miért történt így?**
Gyökérok: hiányzó skill, rossz memória-tier, téves feltételezés, eszközhiány vagy kommunikációs gond volt?

**C: Min kell változtatni?**
Konkrét lépés: új skill, skill-patch, memória írása vagy frissítése, munkafolyamat-változás, vagy semmi (ha az eredmény helyes volt).

### 3. Készíts javító javaslatokat

Rendezd kategóriákba a megállapításokat:

#### Skill-javaslatok
Minden skillhez kapcsolódó megállapításra:
```
SKILL_ACTION: create | patch | delete
SKILL_NAME: name-of-skill
REASON: why this change helps
CHANGE: what specifically to add/modify/remove
```

Szabályok:
- ÚJ skillt csak akkor javasolj, ha a minta 2+ alkalommal előfordult, vagy elég összetett volt (5+ lépés)
- A PATCH-et részesítsd előnyben a CREATE-tel szemben: nézd meg, lefedi-e egy meglévő skill az eset 80%-át
- Duplikátum javaslása előtt nézd meg a `~/.claude/skills/.skill-index.md` fájlt

#### Memória-javaslatok
Minden memóriához kapcsolódó megállapításra:
```
MEMORY_ACTION: save | update | delete | retier
MEMORY_TIER: hot | warm | cold | shared
CONTENT: what to remember
REASON: why this tier, why now
```

Szabályok:
- Felhasználói javítások -> mindig warm (stabil preferencia)
- Feladatspecifikus megállapítások -> hot (magától lecseng)
- Architekturális döntések -> cold (hosszú távú referencia)
- Ágensek közötti tanulságok -> shared

#### Munkafolyamat-javaslatok
Azokra a folyamatjavításokra, amelyek sem skillbe, sem memóriába nem illenek:
```
WORKFLOW_CHANGE: description of the process change
APPLIES_TO: this agent | all agents | specific agent
REASON: what problem it solves
```

### 4. Mutasd be a felhasználónak jóváhagyásra

Tömör teendőlistaként formázd a kimenetet:

```
## Retrospective Summary

Session: [brief description]
Duration: ~[estimate]
Key events: [count] tasks, [count] corrections, [count] errors

### Proposed Changes

#### Skills
1. [PATCH] skill-name: add X because Y
2. [CREATE] new-skill: handles Z pattern (seen 3x this session)

#### Memory
1. [SAVE warm] "user prefers X over Y" -- correction at [context]
2. [RETIER hot->cold] "project Z deadline" -- no longer active

#### Workflow
1. [ALL AGENTS] Always check CI before merging -- 2 failed merges this session

Apply all? (y/n/select)
```

### 5. Hajtsd végre a jóváhagyott változásokat

A felhasználó jóváhagyása után:
- Skillek: hozd létre vagy patcheld a SKILL.md fájlokat, generáld újra a `.skill-index.md`-t
- Memória: írás vagy frissítés a memória API-n
- Munkafolyamat: frissítsd a CLAUDE.md-t, vagy küldj inter-agent üzenetet az érintett ágenseknek

A végrehajtás után naplózd a retrospektívet a napi naplóba:
```bash
PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"
curl -s -X POST -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:$PORT/api/daily-log \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"content\":\"## $(date +%H:%M) -- Retrospective\n[count] skill changes, [count] memory updates, [count] workflow changes applied.\"}"
```

## Buktatók

- NE alkalmazz változást automatikusan a felhasználó jóváhagyása nélkül: mindig előbb mutasd be
- NE hozz létre skillt egyszeri, nem ismétlődő feladatra
- NE ments múló hibakeresési kontextust cold memóriába
- Ha a session egyszerű volt, gond nélkül, mondd ki, és hagyd ki: nem minden session igényel változtatást
- A javaslatok legyenek végrehajthatók és konkrétak: a "legyél jobb X-ben" nem javaslat

## Kapcsolat a meglévő mechanizmusokkal

| Mechanizmus | A retrospektív szerepe |
|-----------|---------------------|
| memoria-heartbeat | A retrospektív ennek a célzott, mélyebb változata. A heartbeat soron belül végzi az A/B/C-t; a retrospektív alaposan, a felhasználó jóváhagyásával |
| skill-factory | A retrospektív javasolja a skilleket; a skill-factory hozza létre őket. CREATE lépéshez a retrospektív meghívhatja a skill-factoryt |
| DREAM.md | Éjszakai konszolidáció. A retrospektív igény szerinti és azonnali |
| /handoff | A retrospektív elemez; a handoff átad. Eltérő célok |
