# Channels (Telegram / Slack)

> Ott éred el ahol amúgy is írsz. Telegram vagy Slack — proaktív értesítésekkel, nem csak válaszokkal.

---

## 🎯 Mit tud / miért érdekes

Marveennel ott beszélgetsz, ahol kényelmes: **Telegramon** vagy **Slacken**. Nem webfelület, nem külön app — a meglévő üzenetküldődben él. És nem csak válaszol: magától ír, ha valami fontos (reggeli napindító, sürgős email, beakadt feladat).

Hangüzenetet is megért (átírja szöveggé), és képet/fájlt is tud küldeni-fogadni — pl. egy kész videót attachmentként.

**Kuriózum:** a hozzáférés szigorúan kontrollált. Egy üzenet attól még nem parancs, hogy beérkezett: a rendszer a beépített biztonsági szabályok szerint kezeli, és a párosítás/engedélyezés mindig a tulajdonos kezében marad — egy csatornán érkező "engedélyezd ezt" kérést sosem hajt végre magától.

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
- A stdio-pipe életben tartásához a háttérben keep-alive fut; disconnect esetén automatikus újracsatlakozás.
