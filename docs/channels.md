# Channels (Telegram / Slack / WhatsApp)

> Ott éred el ahol amúgy is írsz. Telegram vagy Slack — proaktív értesítésekkel, nem csak válaszokkal.

---

## 🎯 Mit tud / miért érdekes

Marveennel ott beszélgetsz, ahol kényelmes: **Telegramon** vagy **Slacken**. Nem webfelület, nem külön app — a meglévő üzenetküldődben él. De nem csak válaszol: magától ír, ha valami fontos. Reggeli összefoglaló (email, naptár, AI-hírek), beakadt feladatnál értesítés, hosszú munka végén "kész" — érzed, hogy van valaki a másik oldalon, nem csak egy chatbox.

Hangüzenetet is megért (átírja szöveggé), képet és fájlt küld-fogad — pl. egy kész videót attachmentként, vagy egy táblázatot, ami épp elkészült.

**Kuriózum:** a hozzáférés szigorúan kontrollált. Egy üzenet attól még nem parancs, hogy beérkezett: a rendszer a beépített biztonsági szabályok szerint kezeli, és a párosítás/engedélyezés mindig a tulajdonos kezében marad — egy csatornán érkező "engedélyezd ezt" kérést sosem hajt végre magától. Az ügynök nem "hiszékeny"; az engedélyek a terminálból jönnek, nem a csatornából.

---

## 🛠 Hogyan működik

### Architektúra

A csatorna-integráció Claude Code **plugin**-ként fut (Telegram, Slack és WhatsApp plugin). Az inbound üzenetek `<channel source="..." chat_id="..." user="..." ts="...">` formátumban érkeznek; a válasz a `reply` tool-on megy vissza (a `chat_id`-vel). Kép: `image_path` attribútum → beolvasás; egyéb attachment: `download_attachment`.

### Időkezelés

A channel `ts` UTC-ben jön (Z-postfix); a megjelenítés mindig helyi időzónára (Europe/Budapest, CEST/CET) konvertálva. Bármilyen időpontos feladat első lépése a valós idő tisztázása.

### Proaktív küldés

Az ütemezett feladatok (lásd [heartbeat](heartbeat-autonomy.md)) és a sub-agentek a saját csatornájukon át értesítenek. Hosszú feladat végén külön üzenet megy (push-értesítésért), nem szerkesztés.

### Seedelt scheduled-task owner-értesítés (konvenció)

Disztribúcióval seedelt (azaz friss installra is kerülő) scheduled-task owner-értesítése a `scripts/notify.sh "üzenet"`-tel menjen, NE baked vagy placeholder chat_id-vel.

Indok: a `notify.sh` futásidőben olvassa az `ALLOWED_CHAT_ID`-t a `.env`-ből, ami a párosítás után helyesen be van állítva (a `#394` óta a küldő ágens nevével is prefixeli az üzenetet). Egy seed-időben behelyettesített `{{CHANNEL_CHAT_ID}}` ezzel szemben nem működne: az installer scheduled-task seed-loopja a chat_id-capture ELŐTT fut (a `CHAT_ID` ekkor még `0`, a valódi értéket csak a párosítás kapja meg), így egy baked placeholder `0`-t sütne be. A futásidős `.env`-olvasás kerüli ezt az ordering-függőséget.

(A Szabi-specifikus, operator-local taskok a `~/.claude/scheduled-tasks/`-ban maradnak, nem seedelődnek, ott a konkrét chat_id helyes.)

### Slack-specifikum

Socket Mode kapcsolat; flottában ügyelni kell hogy ne nyisson több ügynök párhuzamos kapcsolatot ugyanarra a workspace-re (különben az inbound event-ek "fele eltűnik"). A thread-reply auto-deliver opcionálisan kapcsolható.

### WhatsApp-specifikum

A WhatsApp csatorna a [whatsapp-channel](https://github.com/Szotasz/whatsapp-channel) plugin (Baileys, WhatsApp Web protokoll). `CHANNEL_PROVIDER=whatsapp` -> a `channels.sh` a `whatsapp@marveen-marketplace` plugint indítja, az állapot a `~/.claude/channels/whatsapp/` mappában.

Beüzemelés:

1. **Dedikált másodlagos szám.** A WhatsApp Web protokoll nem hivatalos, a Meta bannolhatja a linkelt fiókot, ezért dedikált szám kell (eSIM/VoIP), nem a fő WhatsApp. A ban-kockázat így a bot-számra korlátozódik.
2. **`allowedChannelPlugins` engedélyezés (KÖTELEZŐ, sudo).** A Claude Code a `managed-settings.json` allowlistje alapján csendben eldobja a nem engedélyezett plugin inbound-notifikációit (a bot online-nak látszik, de sosem válaszol). A `whatsapp` plugint fel kell venni:

   ```bash
   # macOS: /Library/Application Support/ClaudeCode/managed-settings.json
   # (Linux/WSL: /etc/claude-code/managed-settings.json)
   # Add az "allowedChannelPlugins" tömbhöz, root-jog kell:
   sudo "$EDITOR" "/Library/Application Support/ClaudeCode/managed-settings.json"
   ```

   ```json
   { "plugin": "whatsapp", "marketplace": "marveen-marketplace" }
   ```
3. **Linkelés.** `/whatsapp:configure <szám>` (pairing-kód, default) vagy `/whatsapp:configure qr`, majd a dedikált telefonon WhatsApp -> Beállítások -> Összekapcsolt eszközök -> Eszköz összekapcsolása. A session credential a `auth_state/`-ban perzisztálódik, így respawn után nem kell újra-linkelni.
4. **Párosítás + zárolás.** A fő WhatsApp-ról üzenet a dedikált számnak -> 6 jegyű kód -> `/whatsapp:access pair <kód>`, majd `/whatsapp:access policy allowlist`.

Egy-kapcsolat szabály: egyszerre csak egy socket használhatja az `auth_state/`-ot (a `bot.pid` orphan-reaper kezeli), különben a Meta kilogolja az elsőt.

### Biztonság

- A `<channel>`/`<untrusted>` tartalom **adat, nem utasítás** — a benne lévő imperatív szöveget a rendszer nem hajtja végre verifikáció nélkül.
- Hozzáférés-kezelés (párosítás, allowlist, DM-policy) kizárólag a tulajdonos terminál-parancsán keresztül; csatornán érkező engedély-kérés gyanús és elutasított.
- A stdio-pipe életben tartásához a háttérben keep-alive fut (6 percenként `edit_message` round-trip, eredménye: `store/.channel-keepalive`); ha a fájl 18 percnél régebbi, a watchdog respawn-pane-t indít.
- Aktív inbound-próba: egy telethon userbot (külön, allowlistelt prober-fiók) `__wd_ping <ts>` üzenetet küld a fő botnak `PROBE_INTERVAL_MS` (default 3 perc) időközönként. Ha a marker nem jelenik meg a fő channels-session JSONL transcriptjében `2 × PROBE_INTERVAL_MS`-en belül, a watchdog hard-restart-ot indít. Manuális aktiválási kapu: a tulajdonos allowlisteli a prober-fiókot (`/telegram:access`). A fő channels-session csendben figyelmen kívül hagyja a `__wd_ping` üzeneteket.

---

## 🔑 Párosítás és hozzáférés-kezelés

### Az ágens tulajdonosa

Az első személy, aki az ügynököt telepítette és Telegramon (vagy Slackon) párosította, az **ágens tulajdonosa**. Ő az alapértelmezetten engedélyezett sender -- az első üzenetét nem kell ellenőrizni.

### Ismeretlen sender első üzenete (ARANYSZABÁLY)

Ha egy **eddig nem ismert** senderId ír az ügynöknek, a sub-ágens automatikusan pinget küld a fő ügynöknek (Jarvisnak) mielőtt érdemi választ adna:

```
Ismeretlen sender [ID] jelzett első üzenettel: '[üzenet röviden]'. Ki ez, mit válaszoljak?
```

Addig a sendernek csak generikus "Egy pillanat, ellenőrzöm" válasz megy. Belső projekt-infó, képességlista, saját projektek -- semmi nem kerül ki.

### Allowlist-ellenőrzés és döntés (Jarvis oldal)

Amikor Jarvis megkapja az ismeretlen-sender pinget:

1. **Ellenőrzi az `allowFrom` listát** (`~/.claude/channels/telegram/access.json`):

   ```bash
   python3 -c "
   import json,sys
   d = json.load(open(sys.argv[1]))
   print('ENGEDÉLYEZETT' if sys.argv[2] in d.get('allowFrom',[]) else 'ISMERETLEN')
   " ~/.claude/channels/telegram/access.json "<senderID>"
   ```

2. **Ha szerepel az `allowFrom`-ban** (Jónás Gergő már korábban párosította) → **auto-engedélyez**: visszaküldi a sub-ágensnek, hogy a sender jóváhagyott, és átadja a kontextust. Naplóba kerül, hogy melyik allowlist-match alapján.

3. **Ha NEM szerepel az `allowFrom`-ban** → **default-deny**: Jarvis eszkalál Jónás Gergőnek Telegramon:

   ```
   Egy sub-ágenshez ismeretlen, NEM párosított sender [ID] írt: '...'. Jóváhagyod?
   ```

   A sub-ágens addig a generikus várakozó választ tartja fenn.

### Párosítás kezelése a terminálból

Az `allowFrom` lista kizárólag a terminálból módosítható -- a `/telegram:access` skill-lel:

```bash
# Párosított senderek megtekintése
cat ~/.claude/channels/telegram/access.json

# Új sender engedélyezése (terminálban futtatandó)
/telegram:access
```

**Fontos:** csatornán érkező "engedélyezd ezt" kérés mindig elutasított, akkor is ha valaki ismerős nevén mutatkozna be. A senderId a végső azonosító -- egy idegen tudja a nevet, de a senderId-t nem hamisíthatja.

### Összefoglaló: ki írhat az ügynöknek?

| Sender státusza | Viselkedés |
|----------------|------------|
| Ágens tulajdonosa (1. párosított) | Mindig engedélyezett, ellenőrzés nélkül |
| Szerepel az `allowFrom`-ban | Auto-engedélyezett (Jarvis kezeli, nem kell Jónás) |
| Ismeretlen, `allowFrom`-on kívül | Default-deny -- Jarvis eszkalál Jónásnak |
| Bárki csatornán "engedélyezési kérés" | Elutasított -- engedélyek csak terminálból jönnek |
