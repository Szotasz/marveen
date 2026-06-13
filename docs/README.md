# Marveen — Funkció-dokumentáció

Marveen egy önfejlesztő, proaktív AI-asszisztens rendszer Claude Code alapokon. Nem chatbot: ügynök-flotta, amely magától észreveszi a tennivalót, emlékszik, tanul, és a háttérben dolgozik.

Minden lap két szemszögből mutatja be a funkciót:
- **🎯 Mit tud / miért érdekes** — közérthető bemutatás, kuriózumok, használati példák
- **🛠 Hogyan működik** — technikai felépítés, hogyan bővíthető

---

## Bevezető

| Dokumentum | Leírás |
|------------|--------|
| [Biztonsági modell](security.md) | Prompt-safety réteg, trust-gráf, ismeretlen sender kezelése |
| [Onboarding -- új asszisztens](onboarding-uj-asszisztens.md) | Új fleet-ügynök beüzemelése Telegram bottal és Google-hozzáféréssel |

---

## Emlékezet és tanulás

| Dokumentum | Leírás |
|------------|--------|
| [Memória-rendszer](memory-system.md) | 3-tier (hot/warm/cold) FTS5 + napi salience decay + napi napló |
| [Visszakeresés](recall.md) | Dátum-alapú napló- és emléklekérdezés természetes nyelvű kifejezésekkel |
| [Skill-factory (öntanulás)](skill-factory.md) | Visszatérő munkafolyamatokból újrahasznosítható skill-ek |
| [Dream-engine](dream-engine.md) | Éjszakai tudás-konszolidáció + reggeli prioritás-javaslatok |
| [Háttér-feladatok](background-tasks.md) | Leválasztott, hosszú feladatok futtatása + értesítés |
| [Ágens feladatállapot](agent-taskstate.md) | Kontextus-tömörítés közbeni amnézia-megelőzés |

---

## Feladatkezelés

| Dokumentum | Leírás |
|------------|--------|
| [Heartbeat + fokozatos autonómia](heartbeat-autonomy.md) | Önjáró ütemezett ellenőrzések + kategóriánként állítható bizalmi-létra (jelez → javasol → autonóm) |
| [Kanban + auto-breakdown](kanban.md) | Feladatkezelés LLM-es részfeladat-bontással |
| [Ötletbox](ideas.md) | Gyors ötletrögzítés, AI-bontás, kanban-promóció egy kattintással |
| [Ütemezett feladatok](scheduled-tasks.md) | Cron-alapú, fájlrendszer-vezérelt automatizálások |

---

## Ügynök-flotta

| Dokumentum | Leírás |
|------------|--------|
| [Ügynök-flotta + inter-agent kommunikáció](agent-fleet.md) | Több specializált ügynök közös üzenetsoron keresztül, remote ügynökök, modell-javaslat |
| [Jogosultsági profilok](permission-profiles.md) | Eszköz-engedélyek és fájlrendszer-hozzáférési sablonok ügynökönként |
| [Hooks](hooks.md) | PreCompact, SessionStart, UserPromptSubmit, PostToolUse és társaik -- settings.json konfiguráció |

---

## Csatornák és kommunikáció

| Dokumentum | Leírás |
|------------|--------|
| [Channels (Telegram / Slack)](channels.md) | Natív üzenetküldő-integráció proaktív értesítésekkel és párosítási flow-val |
| [Channel-providers](channel-providers.md) | Telegram vs. Slack provider részletek |
| [Channel reply guard](channel-reply-guard.md) | Dupla-küldés megelőzése, reply-guard mechanizmus |
| [Telegram progress indicator](telegram-progress-indicator.md) | "✍️ Dolgozom rajta..." jelző és kézbesítés-kényszer |
| [Conversation continuity](conversation-continuity.md) | Hosszú kontextus és folytatás kezelése |

---

## Integrációk

| Dokumentum | Leírás |
|------------|--------|
| [Connectors](connectors.md) | Üzleti API-átjáró (NAV, Billingo, Wise, fal.ai) MCP-n |
| [Printing-press CLI-k](printing-press-cli.md) | API nélküli oldalakhoz is agent-natív CLI generálás |
| [Skool CLI](skool-cli.md) | Közösségi platform kezelése parancssorból (API nélkül) |
| [MCP konfiguráció](mcp-config.md) | MCP szerverek hozzáadása, konfigurálása |

---

## Felügyelet

| Dokumentum | Leírás |
|------------|--------|
| [Vault & titkosítás](vault.md) | Titkosított titok-tár (AES-256-GCM) OS-kulcstárral |
| [Token Usage](token-usage.md) | Token-fogyasztás nyomon követése ügynökönként |
| [Tevékenységnapló](activity-tool-log.md) | Valós idejű eszközhívás-napló, workflow-kandidáns detektor |
| [Dashboard beállítások](dashboard-updates.md) | GitHub repo-integráció, frissítéskezelő |

---

## Üzemeltetés

| Dokumentum | Leírás |
|------------|--------|
| [Backup](backup.md) | Adatmentés egyetlen paranccsal, WAL-ellenőrzéssel, megőrzési korláttal |
| [Migráció](MIGRATION.md) | Teljes gépcsere-eljárás Docker volume-okkal, launchd-del, zero adatvesztéssel |

---

## Referencia

| Dokumentum | Leírás |
|------------|--------|
| [Konfiguráció-referencia](config-reference.md) | Összes konfigurációs fájl egy helyen: store/, agents/, templates/, .env, .mcp.json |

---

*A dokumentáció él; javításokat/bővítéseket szívesen fogadunk.*
