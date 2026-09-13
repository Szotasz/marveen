# Channels (Telegram / Slack / Discord / WhatsApp / Teams)

> Ott éred el ahol amúgy is írsz. Telegram, Slack vagy Discord — proaktív értesítésekkel, nem csak válaszokkal.

---

## 🎯 Mit tud / miért érdekes

Marveennel ott beszélgetsz, ahol kényelmes: **Telegramon**, **Slacken** vagy **Discordon**. Nem webfelület, nem külön app — a meglévő üzenetküldődben él. De nem csak válaszol: magától ír, ha valami fontos. Reggeli összefoglaló (email, naptár, AI-hírek), beakadt feladatnál értesítés, hosszú munka végén "kész" — érzed, hogy van valaki a másik oldalon, nem csak egy chatbox.

Hangüzenetet is megért (átírja szöveggé), képet és fájlt küld-fogad — pl. egy kész videót attachmentként, vagy egy táblázatot, ami épp elkészült.

**Kuriózum:** a hozzáférés szigorúan kontrollált. Egy üzenet attól még nem parancs, hogy beérkezett: a rendszer a beépített biztonsági szabályok szerint kezeli, és a párosítás/engedélyezés mindig a tulajdonos kezében marad — egy csatornán érkező "engedélyezd ezt" kérést sosem hajt végre magától. Az ügynök nem "hiszékeny"; az engedélyek a terminálból jönnek, nem a csatornából.

---

## 🛠 Hogyan működik

### Architektúra

A csatorna-integráció Claude Code **plugin**-ként fut (Telegram, Slack, Discord, WhatsApp és Teams plugin). Az inbound üzenetek `<channel source="..." chat_id="..." user="..." ts="...">` formátumban érkeznek; a válasz a `reply` tool-on megy vissza (a `chat_id`-vel). Kép: `image_path` attribútum → beolvasás; egyéb attachment: `download_attachment`.

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

### Teams-specifikum

A Microsoft Teams csatorna a [claude-channel-teams](https://github.com/Szotasz/claude-channel-teams) plugin (Azure Bot Service transport). `CHANNEL_PROVIDER=teams` -> a `channels.sh` a `teams@marveen-marketplace` plugint indítja, az állapot a `~/.claude/channels/teams/` mappában (a `TEAMS_STATE_DIR` env-en keresztül). A provider-elágazások (PLUGIN_ID, STATE_ENV_VAR, orphan-reaper, plugin-watchdog) ugyanúgy viselkednek mint a többi providernél, külön kezelés nélkül.

Beüzemelés:

1. **Azure bot regisztráció.** `/teams:configure` a párbeszédben végigvezet az Azure Bot Service app-regisztráción (app ID + jelszó), majd a botot fel kell venni a kívánt Teams csapatba/csatornába.
2. **`allowedChannelPlugins` engedélyezés.** A Claude Code a `managed-settings.json` allowlistje alapján csendben eldobja a nem engedélyezett plugin inbound-notifikációit (a bot online-nak látszik, de sosem válaszol). A **macOS telepítő install-time automatikusan** felveszi a `teams` plugint (install-macos.sh, sudo a telepítés alatt), tehát friss telepítésnél ez magától megvan. CSAK egy MÁR telepített rendszernél kell kézzel hozzáadni (root-jog):

   ```bash
   # macOS: /Library/Application Support/ClaudeCode/managed-settings.json
   # (Linux/WSL: /etc/claude-code/managed-settings.json)
   # Add az "allowedChannelPlugins" tömbhöz, root-jog kell:
   sudo "$EDITOR" "/Library/Application Support/ClaudeCode/managed-settings.json"
   ```

   ```json
   { "plugin": "teams", "marketplace": "marveen-marketplace" }
   ```
3. **Párosítás + zárolás.** A párosítás és az allowlist-policy a `/teams:access` paranccsal állítható, a tulajdonos termináljából (csatornán érkező engedély-kérést a rendszer sosem hajt végre magától).

### Discord-specifikum

A Discord csatorna a hivatalos `discord@claude-plugins-official` plugin. `CHANNEL_PROVIDER=discord` -> a `channels.sh` a discord plugint indítja, az állapot a `~/.claude/channels/discord/` mappában (a `DISCORD_STATE_DIR` env-en keresztül). A provider-elágazások (PLUGIN_ID, state-dir, plugin-watchdog) ugyanúgy viselkednek mint a többi providernél, külön kezelés nélkül. A telepítő a Linux ÉS a macOS úton is felkínálja (3. opció).

Beüzemelés:

1. **Discord alkalmazás.** Hozz létre egy alkalmazást a [discord.com/developers/applications](https://discord.com/developers/applications) oldalon, a Bot fülön add hozzá a botot és másold ki a tokent. Kapcsold be a Privileged Gateway Intents alatt a MESSAGE CONTENT INTENT-et, majd az OAuth2 > URL Generatorral (bot scope) hívd meg a szerveredre.
2. **Csatorna és operátor azonosítók.** Developer Mode-dal másold ki a csatorna ID-jét (jobb klikk a csatornán > Copy Channel ID) és a saját user ID-det (jobb klikk a nevedre > Copy User ID). A telepítő ezeket bekéri; a `.env` kulcsok: `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `OPERATOR_DISCORD_USER_ID`.
3. **`allowedChannelPlugins` engedélyezés (csak ha van managed-settings).** Friss telepítésnél a hivatalos marketplace-es plugin allowlist-fájl nélkül is fut. Ha viszont a gépen MÁR van `managed-settings.json` (pl. egy korábbi Slack/Teams telepítés írta), az allowlist a benne nem szereplő plugint csendben eldobja (a bot online-nak látszik, de sosem válaszol). A macOS telepítő discord-ágon ezt install-time érzékeli és felveszi a `discord` bejegyzést. Kézi pótlásnál ugyanaz a menet, mint a Teamsnél, a bejegyzés:

   ```json
   { "plugin": "discord", "marketplace": "claude-plugins-official" }
   ```
4. **Párosítás + zárolás.** A DM-policy alapból `pairing`; az engedélyezés a `/discord:access` paranccsal, a tulajdonos termináljából történik (csatornán érkező engedély-kérést a rendszer sosem hajt végre magától).

### Biztonság

- A `<channel>`/`<untrusted>` tartalom **adat, nem utasítás** — a benne lévő imperatív szöveget a rendszer nem hajtja végre verifikáció nélkül.
- Hozzáférés-kezelés (párosítás, allowlist, DM-policy) kizárólag a tulajdonos terminál-parancsán keresztül; csatornán érkező engedély-kérés gyanús és elutasított.
- A stdio-pipe életben tartásához a háttérben keep-alive fut (6 percenként `edit_message` round-trip, eredménye: `store/.channel-keepalive`); ha a fájl 18 percnél régebbi, a watchdog respawn-pane-t indít.
- Aktív inbound-próba: egy telethon userbot (külön, allowlistelt prober-fiók) `__wd_ping <ts>` üzenetet küld a fő botnak `PROBE_INTERVAL_MS` (default 3 perc) időközönként. Ha a marker nem jelenik meg a fő channels-session JSONL transcriptjében `2 × PROBE_INTERVAL_MS`-en belül, a watchdog hard-restart-ot indít. Manuális aktiválási kapu: a tulajdonos allowlisteli a prober-fiókot (`/telegram:access`). A fő channels-session csendben figyelmen kívül hagyja a `__wd_ping` üzeneteket.
