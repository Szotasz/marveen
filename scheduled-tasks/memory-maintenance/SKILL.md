---
name: memory-maintenance
description: Daily memory tier-resorting and version history pruning via POST /api/memories/resort
---

# Memory Maintenance Job

## Mikor használd

Naponta egyszer (default: 03:00) automatikusan fut. Elvégzi:
1. hot/warm -> cold átsorolás: ha 30 napja egyetlen ágenstől sem olvasódott (shared kategória kizárva)
2. cold -> warm emelés: ha az utolsó 24 órában 2+ különböző ágens olvasta
3. memory_versions prune: 180 napnál régebbi verziók törlése

## Eljárás

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
RESULT=$(curl -s -X POST http://localhost:3420/api/memories/resort \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}')
echo "$RESULT"
```

A válasz: `{"ok":true,"warmToCold":N,"coldToWarm":N,"prunedVersions":N}`

Csak akkor jelents Telegramra, ha valamelyik szám > 0.

## Freshness push (F2b)

A heartbeat skillek a stale memóriákat az alábbi módon kérhetik le:

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/memories/stale?agent_id=jarvis"
```

Shared memóriáknál (`category = 'shared'`) érdemes figyelni: ha a válasz nem üres,
ezek a memóriák frissültek azóta, hogy az ágens utoljára olvasta őket.

## Egyéni threshold override

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
curl -s -X POST http://localhost:3420/api/memories/resort \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"warm_to_cold_days":14,"cold_to_warm_hours":48,"min_agents":3,"version_ttl_days":90}'
```

## Telepítés

```bash
cp -r scheduled-tasks/memory-maintenance ~/.claude/scheduled-tasks/
# Majd a dashboardon vagy API-n keresztül: enabled = true
```

## Buktatók

- A `shared` kategória soha nem kerül cold-ba automatikusan (minden ágensnek szól)
- Ha a szerver nem fut, a feladat kihagyódik (skipIfBusy: true)
- A prune visszafordíthatatlan: a kitörölt memory_versions sorok nem állíthatók vissza
