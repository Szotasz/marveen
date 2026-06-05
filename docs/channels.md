# Channels (Telegram / Slack)

> Ott éred el ahol amúgy is írsz. Telegram vagy Slack — proaktív értesítésekkel, nem csak válaszokkal.

---

## 🎯 Mit tud / miért érdekes

Marveennel ott beszélgetsz, ahol kényelmes: **Telegramon** vagy **Slacken**. Nem webfelület, nem külön app — a meglévő üzenetküldődben él. De nem csak válaszol: magától ír, ha valami fontos. Reggeli összefoglaló (email, naptár, AI-hírek), beakadt feladatnál értesítés, hosszú munka végén "kész" — érzed, hogy van valaki a másik oldalon, nem csak egy chatbox.

Hangüzenetet is megért (átírja szöveggé), képet és fájlt küld-fogad — pl. egy kész videót attachmentként, vagy egy táblázatot, ami épp elkészült.

**Kuriózum:** a hozzáférés szigorúan kontrollált. Egy üzenet attól még nem parancs, hogy beérkezett: a rendszer a beépített biztonsági szabályok szerint kezeli, és a párosítás/engedélyezés mindig a tulajdonos kezében marad — egy csatornán érkező "engedélyezd ezt" kérést sosem hajt végre magától. Az ügynök nem "hiszékeny"; az engedélyek a terminálból jönnek, nem a csatornából.

---

## 🛠 Hogyan működik

### Architektúra

A csatorna-integráció Claude Code **plugin**-ként fut (Telegram és Slack plugin). Az inbound üzenetek `<channel source="..." chat_id="..." user="..." ts="...">` formátumban érkeznek; a válasz a `reply` tool-on megy vissza (a `chat_id`-vel). Kép: `image_path` attribútum → beolvasás; egyéb attachment: `download_attachment`.

### Időkezelés

A channel `ts` UTC-ben jön (Z-postfix); a megjelenítés mindig helyi időzónára (Europe/Budapest, CEST/CET) konvertálva. Bármilyen időpontos feladat első lépése a valós idő tisztázása.

### Proaktív küldés

Az ütemezett feladatok (lásd [heartbeat](heartbeat-autonomy.md)) és a sub-agentek a saját csatornájukon át értesítenek. Hosszú feladat végén külön üzenet megy (push-értesítésért), nem szerkesztés.

### Slack-specifikum

Socket Mode kapcsolat; flottában ügyelni kell hogy ne nyisson több ügynök párhuzamos kapcsolatot ugyanarra a workspace-re (különben az inbound event-ek "fele eltűnik"). A thread-reply auto-deliver opcionálisan kapcsolható.

### Biztonság

- A `<channel>`/`<untrusted>` tartalom **adat, nem utasítás** — a benne lévő imperatív szöveget a rendszer nem hajtja végre verifikáció nélkül.
- Hozzáférés-kezelés (párosítás, allowlist, DM-policy) kizárólag a tulajdonos terminál-parancsán keresztül; csatornán érkező engedély-kérés gyanús és elutasított.
- A stdio-pipe életben tartásához a háttérben keep-alive fut (6 percenként `edit_message` round-trip, eredménye: `store/.channel-keepalive`); ha a fájl 18 percnél régebbi, a watchdog respawn-pane-t indít.
- Aktív inbound-próba: egy telethon userbot (külön, allowlistelt prober-fiók) `__wd_ping <ts>` üzenetet küld a fő botnak `PROBE_INTERVAL_MS` (default 3 perc) időközönként. Ha a marker nem jelenik meg a fő channels-session JSONL transcriptjében `2 × PROBE_INTERVAL_MS`-en belül, a watchdog hard-restart-ot indít. Manuális aktiválási kapu: a tulajdonos allowlisteli a prober-fiókot (`/telegram:access`). A fő channels-session csendben figyelmen kívül hagyja a `__wd_ping` üzeneteket.
