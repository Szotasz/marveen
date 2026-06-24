# Channel provider architektúra

> A Marveen több csatorna-típust támogat (Telegram, Slack). Minden provider más kapcsolati modellt használ, és ez meghatározza, melyik ágens melyik csatornán hallgat.

---

## Alapelv: egy főágens, egy natív plugin

A csatorna-kommunikáció a Claude Code natív channel plugin-rendszerén keresztül történik. A főágens (marveen/Jarvis) egy egyetlen `CHANNEL_PROVIDER` típust futtat -- ezt a `~/.claude/settings.json` `enabledPlugins` mezője határozza meg.

**Sub-ágensek nem futtatnak saját channel plugin-t.** Ők az inter-agent üzenetsoron keresztül kommunikálnak, és a főágens csatornáján értesítenek.

---

## Providerek összehasonlítása

| Tulajdonság | Telegram | Slack |
|-------------|----------|-------|
| Kapcsolati modell | HTTP long-polling | Socket Mode (WebSocket) |
| Token típus | Bot token (`TELEGRAM_BOT_TOKEN`) | Bot + App token (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`) |
| Chat azonosítás | `ALLOWED_CHAT_ID` (numerikus) | `SLACK_CHANNEL_ID` |
| Bevezető preamble | Ugyanaz a prompt-safety réteg | Ugyanaz |
| Multi-agent csatorna-duplikáció kockázata | Alacsony (polling, egy folyamat) | **Magas** (Socket Mode, lásd lent) |

---

## Telegram provider -- polling mód

A Telegram integration HTTP long-polling-on alapul: a `telegram-client.ts` folyamatosan hívja a `getUpdates` API-t, feldolgozza a beérkező üzeneteket, és a `channel-coordinator`-on keresztül juttatja el az ágenshez.

### Folyamat

```
Telegram API
    ↓ getUpdates (long-poll)
channel-coordinator (külön process)
    ↓ store/claudeclaw.db incoming_events tábla
message-router (60s tick)
    ↓ tmux send-keys
Marveen/Jarvis session
```

### Liveness monitoring

A `channel-monitor.ts` figyeli, hogy a natív plugin aktív-e. A `store/.channel-keepalive` fájlt a plugin ~6 percenként frissíti -- ha 18 percen túl nem frissül és a process él, a monitor wedged állapotot jelez és újraindítja.

### Backfill (channel-coordinator)

Ha a natív plugin átmenetileg nem elérhető (pl. dashboard újraindítás), a `channel-coordinator` önállóan gyűjti az üzeneteket és visszatölti (`backfill`) a főágenshez. Az így érkező üzenetek `<channel>` tagbe kerülnek -- az ágens ugyanúgy válaszol rájuk mint a natív beérkezésre.

---

## Slack provider -- Socket Mode

A Slack integration WebSocket alapú (Socket Mode). A kapcsolat tartós és kétirányú -- nem poll-alapú.

### Csatorna-duplikáció veszélye

**Ez az egyik leggyakoribb beállítási hiba fleet környezetben.**

Az `enabledPlugins` mező a **user-szintű** `~/.claude/settings.json`-ban van. Ez azt jelenti, hogy ha több ágens fut ugyanazon a felhasználón (ami az összes Marveen sub-ágens esetén így van), **mindegyikük betölti** a Slack Socket Mode plugint -- és mindegyikük önállóan nyit WebSocket kapcsolatot a Slack workspace-en.

Következmény: az inbound event-ek elosztódnak a kapcsolatok között, az üzenetek "fele eltűnik" (különböző ágensek kapják meg, de csak az egyik ágens válaszol).

### Megoldás: scope-olt enabledPlugins

A Slack plugint csak a főágens `agents/<name>/.claude/settings.json`-jában engedélyezd, a user-szintű settings-ből távolítsd el. Így csak egy process nyit Socket Mode kapcsolatot.

```json
// agents/marveen/.claude/settings.json -- HELYES
{
  "enabledPlugins": ["slack-channel"]
}

// ~/.claude/settings.json -- NEM ide való Slack esetén
// (ha ide kerül, MINDEN ágens csatlakozik)
```

**Telegram esetén ez kevésbé kritikus** (polling: több process is pollingolhat, az API dedupeálja), de a Slack Socket Mode esetén ez tranzakcióbeli kizárólagosságot igényel.

---

## enabledPlugins -- hol él, mit tartalmaz

```json
// ~/.claude/settings.json (user-szintű, minden ágensre hat)
{
  "enabledPlugins": ["telegram"]
}

// agents/<name>/.claude/settings.json (ágens-szintű, csak erre az ágensre)
{
  "enabledPlugins": ["slack-channel"]
}
```

A plugin neve egyezik a `~/.claude/plugins/` alatti mappa nevével (pl. `telegram`, `slack-channel`, `discord`).

---

## Melyik ágens melyik csatornán válaszol?

A fleet alapkonfigurációjában:
- **Marveen/Jarvis** (főágens): fogadja a Telegram/Slack üzeneteket, válaszol a channel plugin-en keresztül
- **Sub-ágensek** (Rick, Dave, Zoe, Peter, Zack): saját Telegram bot tokennel és saját channel plugin-nel futnak -- minden ágensnek külön bot van, külön csatornán

Sub-ágens csatorna-konfiguráció: `agents/<name>/agent-config.json` + a megfelelő bot token a launchd plist-ben vagy `.env`-ben.

---

## Diagnosztika

### A csatorna nem reagál

```bash
# Ellenőrizd a keepalive fájl frissességét
ls -la ~/Documents/marveen/store/.channel-keepalive

# Dashboard channel-monitor állapot
curl -s -H "Authorization: Bearer $(cat ~/Documents/marveen/store/.dashboard-token)" \
  http://localhost:3420/api/status
```

### Slack: üzenetek fele elveszik

Ellenőrizd, hány process fut Socket Mode kapcsolattal:

```bash
ps aux | grep "slack\|claude" | grep -v grep
```

Ha több `claude` process is fut és mindnek van Slack plugin engedélyezve: töröld az `enabledPlugins`-t a user-szintű `~/.claude/settings.json`-ból, és csak a főágens settings-jébe tedd.

---

## Kapcsolódó dokumentumok

- [Csatornák (Telegram/Slack) -- használat](channels.md)
- [Biztonsági modell](security.md)
- [Ügynök-flotta](agent-fleet.md)
