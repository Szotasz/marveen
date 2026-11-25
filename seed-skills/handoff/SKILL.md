---
name: handoff
description: HANDOFF.md kontextusátadó dokumentum készítése a session folytonosságához. Akkor használd, ha sessiont váltasz, egy másik ágensnek adod át a munkát, vagy egy összetett feladat kontextusát kell megőrizned a kontextusablak visszaállítása előtt. A "/handoff" parancsra vagy az inter-agent üzenetek "handoff:" előtagjára indul.
---

# Handoff: a session kontextusának átadása

## Mikor használd

- Közel vagy a kontextus határához, és meg kell őrizned a feladat állapotát
- Egy feladatnak friss sessionben kell folytatódnia (a tiédben vagy egy másik ágensében)
- Összetett, többlépéses feladat delegálása másik ágensnek
- A felhasználó kifejezetten `/handoff`-ot ír, vagy azt kéri, hogy "mentsd el a kontextust későbbre"
- Egy `/checkpoint` előtt, ha a feladat túl összetett 3-5 felsoroláspontnak

## Argumentumok

| Argumentum | Kötelező | Leírás |
|----------|----------|-------------|
| `purpose` | IGEN | Mit kezdjen a következő session ezzel a kontextussal |
| `target` | nem | Ágensnév (pl. `target=dev2`): fájlírás helyett inter-agent üzenetben küldi |
| `output` | nem | A fájl útjának felülírása (alapértelmezés: `HANDOFF.md` a projekt gyökerében) |

Példák:
- `/handoff purpose="Continue the Pipedrive connector PR review and address CI failures"`
- `/handoff purpose="Finish the scheduler forceSend implementation" target=dev2`
- `/handoff purpose="Debug the auth redirect loop" output=/tmp/handoff-auth.md`

## Eljárás

### 1. Gyűjtsd össze a kontextust

Gyűjts adatot ezekből a forrásokból (hagyd ki, amelyik üreset ad):

```bash
# Active kanban cards (assigned to current agent or recently touched).
# Via the dashboard API, NOT the sqlite3 CLI: sqlite3 (and jq) are absent on a
# stock Linux install -- measured on two live hosts 2026-08-04, where the CLI
# call died with exit 127 while python3 was present on both.
AGENT_ID="$(echo $BOT_NAME | tr '[:upper:]' '[:lower:]')"
PORT="$(sed -n 's/^WEB_PORT=//p' .env 2>/dev/null | head -1 | tr -d '"')"; PORT="${PORT:-3420}"
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/kanban" | AGENT_ID="$AGENT_ID" python3 -c "
import json,os,sys
me=os.environ.get('AGENT_ID','')
rows=[c for c in json.load(sys.stdin)
      if not c.get('archived_at') and ((c.get('assignee') or '').lower()==me or c.get('status')=='in_progress')]
rank={'urgent':0,'high':1,'normal':2,'low':3}
rows.sort(key=lambda c:(rank.get(c.get('priority'),9), -(c.get('updated_at') or 0)))
for c in rows[:10]:
    print(c['id'], '|', c.get('status'), '|', c.get('priority'), '|', (c.get('assignee') or '-'), '|', c.get('title'))
"

# Hot memories from last 24h
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/memories?agent=$AGENT_ID&category=hot&limit=10"

# Recent warm memories (project context)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/memories?agent=$AGENT_ID&category=warm&limit=5"

# Today's daily log
DATE=$(date +%Y-%m-%d)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:$PORT/api/daily-log?agent=$AGENT_ID&date=$DATE"
```

A jelenlegi beszélgetésed kontextusából is vedd bele:
- Az utolsó jelentős felhasználói és társ-üzeneteket és döntéseket
- A hibamintákat és a hibakeresés megállapításait
- A fájlutakat és sorszámokat, amelyeken dolgoztál
- A git ágat, a nem commitolt változásokat, a nyitott PR-okat

### 2. Készítsd el a HANDOFF.md-t

Pontosan ezzel az 5 szakasszal építsd fel:

```markdown
# Handoff: {purpose}

Generated: {ISO timestamp}
From: {agent name}
To: {target agent or "next session"}

## Goal
{What the overall task is trying to accomplish. 2-3 sentences max.}

## Current Progress
{What has been done so far. Bullet list with specifics:
- File paths changed
- PRs opened (with URLs)
- Kanban card IDs and their status
- Key decisions made}

## What Worked
{Approaches, tools, or patterns that succeeded:
- Specific commands or API calls that gave good results
- Architecture decisions that held up
- Workarounds that solved blockers}

## What Didn't Work
{Dead ends, failed approaches, gotchas:
- Commands or approaches that failed and WHY
- Assumptions that turned out wrong
- Edge cases discovered}

## Next Steps
{Concrete, actionable items for the receiving session, each with its kanban card ID or the marker `KÁRTYA NÉLKÜL` (no card):
1. First thing to do (most specific) -- card #123
2. Second thing -- KÁRTYA NÉLKÜL
3. ...
Keep each step concrete enough to execute without asking questions.}
```

### 3. Kézbesítés

**Fájl mód** (alapértelmezés): írd a HANDOFF.md-t a projekt gyökerébe (vagy az `output` útra).

**Inter-agent mód** (ha meg van adva a `target=`): küldd el a HANDOFF.md teljes tartalmát inter-agent üzenetként:

```bash
curl -s -X POST http://localhost:$PORT/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d "{\"from\":\"$AGENT_ID\",\"to\":\"TARGET\",\"content\":\"[HANDOFF] purpose: ... \n\n$(cat HANDOFF.md)\"}"
```

### 4. Visszaigazolás

Jelentsd a felhasználónak vagy a hívónak:
- Hová került a handoff (fájlút vagy az inter-agent üzenet azonosítója)
- Összefoglaló: hány kanban-kártya, emlék és naplóbejegyzés került bele
- A `purpose` sort, gyors hivatkozásként

## Buktatók

- NE tegyél a handoffba titkot, tokent vagy .env-értéket
- NE tegyél bele teljes fájltartalmat: utakat és sorszámokat használj
- Méretkeret: cél 4000 karakter, plafon 8000. A handoff a következő session kontextusában MINDEN körben ott van,
  és minden context-guard újraindításkor újraíródik, tehát a méretét kétszer fizeted (mérve 2026-11-24-én egy
  7 ágenses flottán: 3,4-15,8 ezer bájtos handoffok, ágensenként 8-33 újraindulás 36 óra alatt). Állapotot vigyél,
  ne történetet: a lezárt munka egy sorban a napi naplóba megy, nem ide; a kártya-, komment- és üzenet-azonosítókat
  idézd a tartalmuk helyett; a kész tételek közül csak azokat sorold fel, amelyeket a következő session különben
  újra elvégezne.
- Ha a `target=` ágens nem fut (nézd meg a tmuxban), figyelmeztess, és térj vissza fájl módra
- A handoff pillanatkép, tehát elavul. Az időbélyeget tedd jól látható helyre

## Kapcsolat a többi megőrzési mechanizmussal

| Mechanizmus | Hatókör | A handoff így használja |
|-----------|-------|--------------------|
| checkpoint | Session-összefoglaló (SQLite) | Forrás: behúzza a friss checkpoint-adatot |
| DREAM.md | Éjszakai konszolidáció | Közvetlenül nem: túl magas szintű |
| hot memory | Aktív feladat állapota | Forrás: beleveszi az aktív hot emlékeket |
| warm memory | Stabil projektkontextus | Forrás: beleveszi a releváns warm kontextust |
| kanban | Feladatkövetés | Forrás: beleveszi a hozzárendelt és aktív kártyákat |
| daily log | Időrendi napló | Forrás: beleveszi a mai naplóbejegyzéseket |

A handoff OLVASSA ezeket a rendszereket, de nem VÁLTJA KI őket. Handoff után a fogadó sessionnek továbbra is meg kell néznie a kanban és a memória élő állapotát: a handoff a kiinduló kontextust gyorsítja, nem az igazság forrása. A kanban viszont nem is a teljes teendőlista: a handoff minden nyitott Next Steps tétele feladat a kanban-kártyák mellett, a `KÁRTYA NÉLKÜL` jelölésű is. A fogadó session az első körében minden ilyen tételhez kártyát hoz létre, vagy mellé írja, miért nincs rá szükség.
