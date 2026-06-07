# Marveen — Funkció-dokumentáció

Marveen egy önfejlesztő, proaktív AI-asszisztens rendszer Claude Code alapokon. Nem chatbot: ügynök-flotta, amely magától észreveszi a tennivalót, emlékszik, tanul, és a háttérben dolgozik.

Minden lap két szemszögből mutatja be a funkciót:
- **🎯 Mit tud / miért érdekes** — közérthető bemutatás, kuriózumok, használati példák
- **🛠 Hogyan működik** — technikai felépítés, hogyan bővíthető

## Funkciók

| Funkció | Leírás |
|---------|--------|
| [Heartbeat + fokozatos autonómia](heartbeat-autonomy.md) | Önjáró ütemezett ellenőrzések + kategóriánként állítható bizalmi-létra (jelez → javasol → autonóm) |
| [Memória-rendszer](memory-system.md) | 3-tier (hot/warm/cold) FTS5 + napi salience decay + napi napló |
| [Kanban + auto-breakdown](kanban.md) | Feladatkezelés LLM-es részfeladat-bontással |
| [Ügynök-flotta + inter-agent kommunikáció](agent-fleet.md) | Több specializált ügynök közös üzenetsoron keresztül |
| [Skill-factory (öntanulás)](skill-factory.md) | Visszatérő munkafolyamatokból újrahasznosítható skill-ek |
| [Channels (Telegram / Slack)](channels.md) | Natív üzenetküldő-integráció proaktív értesítésekkel |
| [Printing-press CLI-k](printing-press-cli.md) | API nélküli oldalakhoz is agent-natív CLI generálás |
| [Skool CLI](skool-cli.md) | Közösségi platform kezelése parancssorból (API nélkül) |
| [connectors.hu](connectors-hu.md) | Üzleti API-átjáró (NAV, Billingo, Wise, fal.ai) MCP-n |
| [Vault & titkosítás](vault.md) | Titkosított titok-tár (AES-256-GCM) OS-kulcstárral |
| [Dream-engine](dream-engine.md) | Éjszakai tudás-konszolidáció + reggeli prioritás-javaslatok |
| [Háttér-feladatok](background-tasks.md) | Leválasztott, hosszú feladatok futtatása + értesítés |

*A dokumentáció él; javításokat/bővítéseket szívesen fogadunk.*
