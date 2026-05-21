# Marveen / ClaudeClaw — Funkció-dokumentáció

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
| Skill-factory (öntanulás) *(hamarosan)* | Visszatérő munkafolyamatokból újrahasznosítható skill-ek |
| Channels (Telegram / Slack) *(hamarosan)* | Natív üzenetküldő-integráció proaktív értesítésekkel |
| Printing-press CLI-k *(hamarosan)* | API nélküli oldalakhoz is agent-natív CLI generálás |
| Dream-engine *(hamarosan)* | Éjszakai tudás-konszolidáció + reggeli prioritás-javaslatok |

*A lista bővül, ahogy a dokumentáció készül.*
