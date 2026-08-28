---
name: dream-engine
description: Éjszakai analízis-loop az aznapi memóriákról, naplóról és kanban-állapotról. Generál 4 priorizált akció-javaslatot reggelre.
last_synced: 2026-08-28
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
# FONTOS (2026-08-03, Jonas 2x korrigalta): a vektorizaltsagot az embedding_blob (BLOB) oszlopon merd,
# NEM az embedding (TEXT) oszlopon -- az utobbi URES, COUNT(embedding)=0 FELREVEZET (teves "0% vektorizalt").
# A backfill {"count":0} = NINCS mit backfillelni (minden kesz), NEM 0 vektorizalt.
# A vec_memories sqlite-vec (vec0) virtualis tabla a sqlite3 CLI-bol NEM elerheto ("no such module: vec0"), ne abbol szamolj.
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT COUNT(*) as total, COUNT(embedding_blob) as with_emb FROM memories"
# Ha NEM 100%, hívd meg a backfill endpoint-ot (Ollamaval embeddeli a hianyzo ID-kat):
curl -s -X POST http://localhost:{{WEB_PORT}}/api/memories/backfill -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)"

# Antikvált hot-tier (>7 napos hot, nem hivatkozott a memories_fts-en az elmúlt 24h-ban)
# FONTOS: CAST(... AS INTEGER) kötelező, lásd Buktatók.
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, content, accessed_at FROM memories WHERE category='hot' AND COALESCE(accessed_at, created_at) < CAST(strftime('%s', 'now', '-7 days') AS INTEGER)"
```

### ⚠️ Buktató: COALESCE + strftime = mindig igaz (2026-07-13)
Az `COALESCE(accessed_at, created_at) < strftime('%s','now','-7 days')` alak SQLite-ban MINDIG igazat ad, tehát MINDEN hot memóriát "antikváltnak" mutat. Ok: a `strftime` TEXT-et ad vissza, és a COALESCE-kifejezésnek (ellentétben egy sima oszlopnévvel) NINCS típus-affinitása, így nem történik numerikus konverzió. Javítás: **mindig** `CAST(strftime(...) AS INTEGER)`, ha COALESCE-t vagy bármilyen kifejezést hasonlítasz időbélyeghez. Ellenőrzés a mozgatás előtt: írasd ki a találatok `datetime(...,'unixepoch','localtime')` értékét, és nézd meg, hogy tényleg régiek-e.

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

# Magas impact, alacsony effort ötletek az ötletládából (score = impact - effort, magasabb = jobb)
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "SELECT id, title, category, impact, effort, (impact - effort) AS score FROM idea_box WHERE status IN ('new','reviewed') AND impact IS NOT NULL AND effort IS NOT NULL ORDER BY score DESC, impact DESC LIMIT 5"
```

Csoportosíts project szerint. A daily naplóban (utolsó 7 nap) nézd hogy melyik projekten van aktív mozgás (commit, PR, kanban-átmozgás). A top-3 javaslatba a kanban kártyák mellé vehetsz be max 1 magas-score (score>=2) ötletlada-tételt is, ha van ilyen -- jelöld `[Ötletláda]` prefixszel.

Output: 3 sor, mindegyik formátum `<project/kategória>: <kártya cím / akció> -- <indok 1 mondatban>`.

### Bucket 4 — 🌐 External opportunities (új skill-repo ajánlások)

Hetente 1-2 alkalommal (NEM minden éjszaka — kerüljük a zajos napi javaslatot) végezz WebSearch-öt új Claude Code / agentic AI / produktivitás-skillekért. Szűrés:
- GitHub stars >100
- Recent activity (utolsó 90 napban commit)
- README clarity (skill mit csinál, hogyan kell telepíteni)

Limitáció: ha az utolsó 7 napban már volt ajánlás (nézd a DREAM.md utolsó 7 napos archívumát vagy egy `external-ops-last-run` markerfile-t), skip-eld.

Output (max 1 ajánlás): repo URL + 1 mondat indok hogy MIÉRT releváns {{OWNER_NAME}}nak (figyelembe véve: AI tartalomgyártás, magyar piac, fejlesztési flotta menedzsment, marketing).

### Bucket 5 — 🛠 Skill-flotta health (csak NEM-pinned skillek)

**VAN HASZNÁLATI NAPLÓ** (2026-08-28-i javítás). Korábban ez a szekció azt állította,
hogy "nincs use-log", ezért a Dream Engine minden nap azt írta, hogy nem mérhető. Tévedés volt:
a `skill_usage` tábla LÉTEZIK és MŰKÖDIK (2026-07-15 óta gyűjt, mind a 10 ágens ír bele,
tool_call és skill_read típussal). A bucket kimenete ("utolsó használat >30 nap") épp ezt
igényli -- csak a lekérdezés hiányzott innen.

```bash
# 1) Mit használtak az elmúlt 30 napban:
sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db \
  "SELECT skill_name, COUNT(*) n, datetime(MAX(created_at),'unixepoch','localtime') utolso
   FROM skill_usage WHERE created_at > strftime('%s','now','-30 days')
   GROUP BY skill_name ORDER BY n DESC;"

# 2) Pinned-védelem (ezeket sosem javasoljuk törlésre):
grep -L "^pinned:" ~/.claude/skills/*/SKILL.md
```

**BUKTATÓ a skill-lista összeállításánál** (2026-08-28, Jarvis saját hibája mérés közben):
a skillek HÁROM helyen élnek, és aki csak egy-két könyvtárat listáz, hamis "antikvált" listát kap:
  `~/.claude/skills/`                      (globális)
  `{{INSTALL_DIR}}/.claude/skills/`        (projekt-szintű)
  plugin- és rendszer-skillek (artifact-design, dataviz, claude-api, docx, pdf, pptx stb.)
Az első mérésnél a `.git` könyvtár is "antikvált skillként" jelent meg, és 20 létező
plugin-skill "már nem létezik" címkét kapott. Ha egy skill a naplóban szerepel, de a
listádban nincs, az valószínűleg a TE listád hiányos, nem a skill tűnt el.
Törlést CSAK akkor javasolj, ha a skill fizikailag megvan és 30 napja nincs használva.

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
