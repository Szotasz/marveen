# 💭 Dream Engine — 2026-06-01 02:08

## 💡 Skill-javaslatok
- Nincs új javaslat. A tegnapi 5+ tool-os workflow-k már skillbe öntve: `saas-finance-source-onboard` (új), `fleet-agent-control` + `zoho-mcp-connector-setup` patchelve. Nincs további 3x-ismételt, lefedetlen pattern.
- Nincs skill-patch szükséges: a kategória-váltás buktatója (PUT /api/memories/:id content-tel, sqlite3 CLI FTS-trigger tiltás) MÁR dokumentálva a `memoria-kategoria-frissites` skill Buktatók szekciójában. Ma is azt követve sikerült (CLI némán nem hatott, API ment).

## 🧹 Memória-egészség
344 / 344 lefedett (4 vektorizálatlan a fire-and-forget embedding-jobra vár, az rendezi). 5 memória cold-tier-be mozgatva az API-n: 3 antikvált hot (22, 39, 43 — régi storyboard + 05-24 éjszakai kutatások), 2 duplikált teszt-bejegyzés (339, 340). Törlés nem történt.
Megjegyzés: a sqlite3 CLI `UPDATE memories SET category` némán nem hat (FTS virtual-table trigger). A PUT /api/memories/:id (content+category) a működő út.

## 🎯 Top-3 holnapi javaslat
1. INFRA (kritikus): Agent restart-loop megszüntetése — a 9 ágens 1-2 percenként újraindul (gyanú: friss PID-cleanup/orphan-takarító a channel-safety mergeből), emiatt az éjszakai kutatások nem futnak megbízhatóan. Attila döntésére vár, ez blokkolja a teljes flottát.
2. fiREG pénzügy: SaaS kontrolling (454937c0, in_progress, saldo) Fázis 1 reconciliation — tegnap MINDEN forrás bekötve (Stripe, Wise, Billingo, Zoho, Google költség+terv/tény, Raiffeisen), ez a legaktívabb projekt, kész az első számokra.
3. tester: Playwright smoke-teszt élesítése — a böngésző bekötve és verifikálva, már csak a teszt-fiók + IMAP credek kellenek a vaultba (a tegnapi mail várja Attila válaszát).

## 🌐 External opportunity
Skip — konzervatív heti limit, nincs új ellenőrzés ütemezve, kerülöm a napi zajt.

## 🛠 Skill-flotta health
Minden skill aktív vagy releváns. A 33 mappából a nem-pinned skillek mind a fiREG-flotta célzott eszközei, egyik sem antikvált (>30 nap használat nélkül). Nincs törlés/frissítés javaslat.

## ⚠️ Hibák
- A scheduled-task template rossz útvonalakat tartalmaz (/Users/marvin/ClaudeClaw/, "Szabolcs", boni/deeper/iris/samu/zara). A buckets a valós környezeten (/Users/macbook/marveen, store/claudeclaw.db) futottak. A dream-engine task-config promptját érdemes egyszer véglegesen a marveen útvonalakra javítani.
- Nyitott infra-blokkoló: agent restart-loop (Top-3 #1), Attila döntésére vár.

*Marveen, 02:09 — most már alszom én is.*
