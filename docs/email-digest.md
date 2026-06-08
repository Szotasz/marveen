# Email-digest (cím-alapú postafiók-triage)

> A postafiók magától rendet tart: a szemét az Archive-ba kerül, a fontosak Telegramra pingelnek, és csak azt olvassa el egy modell, amit te kifejezetten engedélyezel.

---

## 🎯 Mit tud / miért érdekes

Egy IMAP-postafiókot rendez a **feladó címe** alapján, három viselkedéssel:

- **important** → minden új olvasatlan egyszer pingel Telegramon (feladó + tárgy + dátum), és bent marad az inboxban.
- **archive** → az ilyen feladók levelei az Archive mappába kerülnek (mozgatás, sosem törlés), és bekerülnek a napi számszerű jelentésbe.
- **ai_analysis** → cím-alapon nem eldönthető (monitoring-riasztás, rendszer-riport): ezeket egy LLM-task elolvassa és összefoglalja, mi történt.

**A fő érv a privacy-modell.** A szűrés tisztán a feladó CÍME alapján történik -- a levél törzse és tárgya SOHA nem hagyja el a postafiókot egy LLM/felhő felé. Az **egyetlen** kivétel az `ai_analysis` allowlist, ahova te magad teszel be feladókat, kifejezetten azért, hogy a tartalmukat AI elemezze. Az IMAP-jelszó kizárólag a **vaultban** él, futásidőben kérdezi le a szkript -- nincs a repóban.

---

## 🛠 Hogyan működik

### Szabályok (`store/email-rules.json`)

A `store/` gitignore-olt, így a valódi listáid privátok maradnak. Egy lista-elem:

- `@domain.com` → az egész domain ÉS az aldomainjei (`@shop.com` fogja a `news.shop.com`-ot is)
- `valaki@ceg.com` → pontos feladó

**Specificitás:** a pontos cím mindig erősebb a domainnél, bármelyik listában is van. Így egy domain mehet archívba, miközben pár cím belőle fontos marad (pl. `@social.example` archív, de `messages-noreply@social.example` fontos).

**Carve-out-ok:**
- A `\Flagged` (IMAP "fontos"/csillag) levelet SOSEM mozgatja -- bent marad az inboxban.
- Az `ai_analysis` feladókat a watch békén hagyja (az AI-task kezeli).

**Routes** (opcionális): feladó + tárgy-kulcsszó → tetszőleges mappa (+ping). Pl. egy webshop "order/shipped/tracking" tárgyú levele az `Orders` mappába. A tárgy CSAK lokálisan matchel, semmi nem megy ki.

Indulj a mintából: másold a `scripts/email-digest/email-rules.example.json`-t `store/email-rules.json`-ba és írd át.

### A három ütemezett feladat

| Feladat | Típus | Ütemezés | Mit csinál |
|---|---|---|---|
| `email-watch` | command | `* * * * *` | Archivál/route-ol, pingeli az új fontosakat, triggereli az AI-review-t |
| `email-daily-digest` | command | `0 8 * * *` | Napi számszerű archív-összesítő domainenként |
| `email-ai-review` | task (LLM) | trigger-only | Elolvassa + összefoglalja az `ai_analysis` leveleket, archivál |

A `watch` és a `daily` **command**-típusú (LLM nélküli) feladat -- olcsó, percenként futhat. Az `ai-review` egy LLM-task, amit a watch a **run-now** endpointon triggerel, amikor új `ai_analysis` levél jön (Message-ID dedup, 30 perc utáni újrapróba). Nincs órás időzítése (a febr-30 cron sosem fut).

> Ez a feature a `command` task-típusra és a run-now endpointra épül -- mindkettő külön is dokumentált (lásd [Command-feladatok](command-tasks.md)).

### Adatvédelmi határ

A `--mode ai-dump` szkript-mód **kódból** a config `ai_analysis` listájára van korlátozva: csak ezektől a feladóktól olvas tartalmat. Minden más levélnél csak a fejléc (From/Subject/Date) kerül feldolgozásra, lokálisan.

### Beüzemelés

1. Tedd a postafiók IMAP-jelszavát a vaultba a `vault_key` alatt (alapból az email-cím).
2. Másold a példa-configot `store/email-rules.json`-ba, töltsd fel a listáidat.
3. A `.env`-ben legyen `TELEGRAM_BOT_TOKEN` és `ALLOWED_CHAT_ID` (ide mennek a pingek).
4. Engedélyezd mind a három `email-*` ütemezett feladatot (alapból `enabled: false`).

> A `command` parancsok a repo gyökeréből futnak (`python3 scripts/email-digest/digest.py ...`). Ha a dashboard nem onnan indul, írj abszolút útvonalat a `command` mezőbe.
