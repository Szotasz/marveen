---
name: memory-link-maintenance
description: Nightly memory link-graph maintenance via POST /api/memories/links/maintain
last_synced: 2026-08-28
# last_synced konvenció: lásd scheduled-tasks/reggeli-napindito/SKILL.md
---

# Memory Link Maintenance Job

## Mikor hasznald

Ejjelente egyszer (default: 04:00) automatikusan fut. Elvegzi:
1. Re-embeddalas: az embedding nelkuli, nemreg frissult emlekek vektorizalasa
2. Szomszed-linkelohivot frisstese a meroleg frissult emlekkekhez
3. Gyenge elek torlete (weight < 0.1 alatti memory_links sorok)
4. Arva emlekek szamlalasa (van embedding, de 0 kimeneti semantic link)

## Eljaras

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
RESULT=$(curl -s -X POST http://localhost:3420/api/memories/links/maintain \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}')
echo "$RESULT"
```

A valasz: `{"ok":true,"reembedded":N,"linksCreated":N,"linksPruned":N,"orphans":N}`

Csak akkor jelents Telegramon, ha:
- reembedded > 0, linksCreated > 0, linksPruned > 10, vagy orphans > 20

Egyebkent csendes heartbeat (type: heartbeat).

## Threshold override

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
curl -s -X POST http://localhost:3420/api/memories/links/maintain \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"weight_threshold":0.2,"max_age_seconds":259200}'
```

## Telepites

```bash
cp -r scheduled-tasks/memory-link-maintenance ~/.claude/scheduled-tasks/
# Majd a dashboardon vagy API-n: enabled = true
```

## Buktatok

- Ha Ollama nem fut, a reembedded es linksCreated nulla lesz -- ez normalis, nem hiba
- A pruning visszafordithatatlan; az alacsony kuszobot (0.05) ovatosan allisd
- Orphan szam > 50 azt jelzi, hogy az Ollama hosszan nem futott -- backfill kell
