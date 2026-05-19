---
name: channel-plugin-duplicate-socket
description: ClaudeClaw flottában új channel plugin (slack-channel, telegram, stb.) telepítésekor a user-szintű ~/.claude/settings.json enabledPlugins minden agent-nek loadolja a plugin server-t, és ha az egy Socket Mode connection-t nyit (Slack), akkor TÖBB agent egyszerre nyit ugyanazon a workspace-en kapcsolatot. Akkor használd, ha egy agent Socket Mode-os channel plugin-t használ és inbound event-ek "fele eltűnik".
---
# Channel plugin duplicate Socket Mode connection

## Mikor használd
- Új channel plugin (slack-channel, vagy bármi Socket-Mode-os) telepítve a Marveen flottába
- Egy agent (pl. slacker) használja a Slack-et, és Szabi azt jelzi hogy DM-eket küld, de "semmi nem történik"
- A Slack auth.test OK, manifest OK, tokenek OK, bot scope-ok rendben — de events nem érkeznek a server.ts-hez
- Egyszerre több claude process fut `--channels` flaggel a flottában

## Eljárás
1. `ps aux | grep server.ts | grep -v grep` -- count how many slack-channel server.ts processes are running
2. Ha >1 instance: `ps -o pid,ppid,command -p <pid>` minden parent process-re. A ppid chain végén legyen `claude --continue ... --channels plugin:...`. Ha az `--channels` flag NEM ugyanaz mint a plugin, akkor a plugin másodlagosan loadolódott az `enabledPlugins`-ből.
3. Megnézed a user-szintű engedélyezést: `grep -A5 enabledPlugins ~/.claude/settings.json`. Ha a problémás plugin `true` itt, akkor minden agent betölti.
4. Project-szinten override-old: `<projekt>/.claude/settings.json` -> `{"enabledPlugins": {"<plugin>@<marketplace>": false}}`. Project > user precedencia.
5. Az adott agent saját project-szintű settings.json-jában HAGYD true-n -- ott explicit engedélyezve marad.
6. A felesleges channel-process-eket killeld (kill <pid>), vagy restart-old a tmux session-t, amelyikben fut.
7. Verify: `ps aux | grep server.ts | grep -v grep` -- csak az agent-szintű session-ben fusson a plugin.

## Buktatók
- A Socket Mode bug NÉMA: a Slack két aktív Socket Mode connection-t load-balance-ol round-robin-szerűen, így az event-ek FELE a "nem-figyelő" server.ts-hez megy, és ott eldobódik. NEM warning, NEM error -- csak "üzenetek tűnnek el".
- A user-szintű `~/.claude/settings.json.allowedChannelPlugins` és `enabledPlugins` *KÜLÖNBÖZŐ* dolgok. Az `allowedChannelPlugins` csak whitelistezi a `--channels plugin:X` flag-et, de az `enabledPlugins.X: true` az ami minden agent-ben loadolja az MCP-t.
- A flotta-architektúra MIATT (minden agent claude-code-instance) ez nem egyetlen-host probléma -- minden agent függetlenül nyit Socket-et, a Slack-side meg nem tudja megkülönböztetni őket egy workspace-en.
- Telegram-nál NEM "event eltűnés" módon jelentkezik, hanem **lockfight**-ként: a Telegram Bot API long-poll alapú, és Telegram lockolja a session-t (409 Conflict) ha két instance poll-ol -- a két agent felváltva kicsapja egymást. Tünet: amikor az agent-X tmux session restart-ol, az agent-Y telegram MCP "disconnected" jelez, és viszont. **Megoldás**: bármely agent project-szintű `.claude/settings.json`-ben, amelyik NEM telegram-en kommunikál, `enabledPlugins.telegram@claude-plugins-official: false`-re kell tenni. A globális `unset TELEGRAM_BOT_TOKEN` az agent-process.ts indítóscriptben NEM elég, mert a telegram plugin a state-dir `.env`-ből is olvas (a SLACK_STATE_DIR env van set-elve, de TELEGRAM_STATE_DIR nem -- így a telegram plugin a globális `~/.claude/channels/telegram/.env`-be esik vissza, ami a Marveen tokenét tartalmazza).
- **Csatorna-policy külön a DM-policy-tól**: a slack-channel plugin gate-jén a DM-policy (`access.dmPolicy` + `allowFrom`) és a csatorna-policy (`access.channels[channelId]`) TELJESEN különálló. Egy üres `channels: {}` minden csatorna-message-et (még @-mention-t is) dropp-ol. Per-csatorna opt-in: `channels[C...]: {allowFrom: [U...], requireMention: true}`. UX-bug forrás: setup után a user @-tageli a botot csatornában és néma marad, fél órás debug. Felhasználóbarát megoldás: SLACK_AUDIT_LOG env-be írott journal-t a dashboard polling-ozzon, gate.inbound.drop entry-kből pending_channel_requests tábla, Jóváhagy/Elutasít gomb a dashboard-on.
- **MANAGED allowlist trap (Claude Code 2.1.143)**: az `allowedChannelPlugins` MANAGED setting (system-level admin policy). macOS-en `/Library/Application Support/ClaudeCode/managed-settings.json`. User-szintű `~/.claude/settings.json` és project-szintű `.claude/settings.json` egyik sem elég -- a tmux pane "plugin:X · not on the approved channels allowlist" warning-ot mutat. Az MCP plugin tools ettől még connected-ek (8 tools), DE a Claude Code disable-li a `notifications/claude/channel` inbound notification path-et a chat-be. A server.ts megkapja az event-eket (sessions/-be ír, smoke-test megerősíti), a Claude Code mégis lenyeli őket -- a pane idle marad, semmilyen `<channel source="slack" ...>` tag nem jelenik meg. Megoldás: sudo szükséges `mkdir -p "/Library/Application Support/ClaudeCode"` + managed-settings.json létrehozása az allowedChannelPlugins-szal.

## Ellenőrzés
- 1 darab slack-channel server.ts process fut (`pgrep -af 'slack-channel.*server.ts' | wc -l` == 1)
- Annak a parent process-e az AGENT-é (`ps -o command -p <ppid>` tartalmazza az agent neveét vagy a `--channels plugin:slack-channel` flaget)
- Szabi DM-je a slacker tmux pane-jén megjelenik `<channel source="slack" ...>` tag-ben
