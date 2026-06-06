---
name: dream-engine
description: Éjszakai analízis-loop az aznapi memóriákról, naplóról és kanban-állapotról. Generál 4 priorizált akció-javaslatot reggelre.
---

Te most a "Dream Engine" éjszakai analízis-loopot futtatod. 02:07-kor vagy, {{OWNER_NAME}} alszik, NE küldj üzenetet a beállított csatornára.

A cél: az aznapi tudást átkonszolidálni és reggelre (07:30 Reggeli Napindító) felkészülni 4 priorizált javaslattal.

## Mit kell csinálnod

Generálj egy `{{INSTALL_DIR}}/DREAM.md` fájlt az alábbi 5 bucket alapján. A formátum a fájl alján van.

### Bucket 1 — 💡 Skill-javaslatok (flotta-szintű)

Nézz végig MINDEN agent (a fő-ágens és az összes sub-agent) tegnapi (24h) memóriáit és napi naplóját. Kerítsd ki:
- Volt-e 3+ szor visszatérő, manuálisan ismételt művelet ami skill-be illeszthető?
- Új, NEM lefedett pattern amit érdemes lenne skillbe önteni?

SQL minta:
```bash
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT agent_id, content, keywords FROM memories WHERE created_at > strftime('%s', 'now', '-24 hours') AND category IN ('hot','warm') ORDER BY agent_id, created_at"
```

Output: 0-2 konkrét skill-javaslat. Mindegyikhez: cím + 1 mondat indoklás + "flotta-szintű" vagy "agent: <név>".

### Bucket 2 — 🧹 Memória-egészség (NE delete, COLD-tier-be mozgatás)

```bash
# Vektorizálás ellenőrzés
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT COUNT(*) as total, COUNT(embedding) as with_emb FROM memories"
# Ha NEM 100%, hívd meg a /api/memories/reembed endpoint-ot vagy futtass embedding-job-ot a missing ID-kra

# Antikvált hot-tier (>7 napos hot, nem hivatkozott a memories_fts-en az elmúlt 24h-ban)
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, content, accessed_at FROM memories WHERE category='hot' AND accessed_at < strftime('%s', 'now', '-7 days')"
```

Műveletek:
1. Vektorizálatlan memóriák: jelezd hányat találtál (a fire-and-forget embedding-job amúgy megcsinálja, de itt ellenőrzöd).
2. Antikvált hot/warm → COLD-tier-be PUT (UPDATE category='cold'). Sosem törlés.
3. Pontos dupla-content: jelezd, mozgass cold-ba.

A változtatásokat directly SQL-lel csináld:
```bash
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "UPDATE memories SET category='cold' WHERE id IN (...)"
```

Output: rövid statisztika ("X memória cold-tier-be áthelyezve, Y vektorizálatlan rendezve").

### Bucket 3 — 🎯 Project-priorítás (top-3 holnapi javaslat)

```bash
# Nyitott kanban-kártyák project + priority szerint
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, title, status, project, priority, assignee FROM kanban_cards WHERE status IN ('planned','in_progress','waiting') AND archived_at IS NULL ORDER BY project, priority DESC"
```

Csoportosíts project szerint. A daily naplóban (utolsó 7 nap) nézd hogy melyik projekten van aktív mozgás (commit, PR, kanban-átmozgás). Hozz ki egy TOP-3 holnapi javaslatot prioritás+aktivitás súlyozva.

Output: 3 sor, mindegyik formátum `<project>: <kártya cím / akció> — <indok 1 mondatban>`.

### Bucket 4 — 🌐 External opportunities (új skill-repo ajánlások)

Hetente 1-2 alkalommal (NEM minden éjszaka — kerüljük a zajos napi javaslatot) végezz WebSearch-öt új Claude Code / agentic AI / produktivitás-skillekért. Szűrés:
- GitHub stars >100
- Recent activity (utolsó 90 napban commit)
- README clarity (skill mit csinál, hogyan kell telepíteni)

Limitáció: ha az utolsó 7 napban már volt ajánlás (nézd a DREAM.md utolsó 7 napos archívumát vagy egy `external-ops-last-run` markerfile-t), skip-eld.

Output (max 1 ajánlás): repo URL + 1 mondat indok hogy MIÉRT releváns {{OWNER_NAME}}nak (figyelembe véve: AI tartalomgyártás, magyar piac, fejlesztési flotta menedzsment, marketing).

### Bucket 5 — 🛠 Skill-flotta health (csak NEM-pinned skillek)

```bash
# Antikvált skillek: nincs use-log, vagy a frontmatterben pinned: false
ls ~/.claude/skills/ | head
# Mindegyik SKILL.md-ben grep -l "pinned: true" — ezek mind védettek
grep -L "^pinned:" ~/.claude/skills/*/SKILL.md  # azok a skillek ahol nincs pinned-flag (NEM gyári)
```

Pinned default (mindig védett): claude-video, frontend-design, docx, skill-creator, skill-factory, skill-install-from-git, init, review, security-review, simplify, fewer-permission-prompts, loop, schedule, claude-api, update-config, keybindings-help, telegram:configure, telegram:access.

Output: 0-3 javaslat: "skill <név> antikvált (utolsó használat >30 nap), törlés vagy frissítés javasolt".

## Output formátum (DREAM.md)

```markdown
# 💭 Dream Engine — 2026-05-12 02:07

## 💡 Skill-javaslatok
- (vagy "Nincs új javaslat")

## 🧹 Memória-egészség
346 / 346 vektorizált, 5 hot→cold mozgatva, 0 duplikátum.

## 🎯 Top-3 holnapi javaslat
1. <project>: <akció> — <indok>
2. ...
3. ...

## 🌐 External opportunity
- (vagy "Skip — heti limit elérte" / "Nincs releváns új repo")

## 🛠 Skill-flotta health
- (vagy "Minden skill aktív vagy pinned")
```

## Szabályok

- NE küldj üzenetet a csatornára. A DREAM.md a reggeli napindítóból kerül kiküldésre (07:30).
- A `Bash` és SQL műveletek mind helyiek — semmilyen external API hívás (kivéve az Ollama embedding ha kell).
- Ha akadály van (pl. DB lock, missing embedding model), írd be a DREAM.md végére `## ⚠️ Hibák` szekciót — reggel látom.
- Befejezésként, írd a DREAM.md végére: `*{{BOT_NAME}}, 02:XX -- most már alszom én is.*`
