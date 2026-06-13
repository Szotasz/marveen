# Determinisztikus beszélgetés-folytonosság (gördülő átirat főkönyv)

**Probléma.** A channel-watchdog friss `claude`-ként indítja újra a channels session-t (`channels.sh`, nincs `--continue` -- mert a `--continue` törné a `--channels` aktiválást). Egy friss session-nek **nulla emlékezete** van az élő beszélgetésről, így ha egy felhasználó félúton van egy kérdésnél az újraindításkor, mind az utolsó megválaszolatlan kérdése, **mind az arra utaló kontextus** elvész. Ezt lehetetlenné kell tenni -- **determinisztikus hámozó** (hook-ok + tartós főkönyv) garantálja, soha nem az ágens viselkedése (ami meghibásodhat vagy újraindulhat).

**Mechanizmus (nulla ágensi mérlegelés).**

1. **Tartós gördülő átirat** -- `store/claudeclaw.db` → `conversation_log` tábla
   (`id, agent_id, chat_id, direction('in'|'out'), message_id, text, ts, created_at`,
   `UNIQUE(agent_id, chat_id, direction, message_id)`). Minden csatorna-forduló -- mind a bejövő felhasználói üzenetek, mind a kimenő válaszok -- ide kerül. A `db.ts` `initDatabase()` migrációja hozza létre; a `scripts/hooks/ledger_lib.py` is védelmi céllal újra létrehozza (egy hook lefuthat a dashboard-migráció előtt friss indításnál).
2. **Bejövő rögzítés** -- a `UserPromptSubmit` hook `scripts/hooks/ledger-capture.py` elemzi az összes bejövő `<channel source="plugin:telegram:telegram" …>` blokkot a promptból és `INSERT OR IGNORE`-ral `direction='in'`-ként menti el, **mielőtt** az ágens cselekszik. A `UNIQUE` megszorítás idempotensé teszi az újrarögzítést.
3. **Kimenő rögzítés** -- a `PostToolUse` hook `scripts/hooks/ledger-outbound.py` a Telegram reply eszközre feliratkozva a válasz szövegét `direction='out'`-ként rögzíti (a `chat_id=0` gyorsírást a tulajdonos chat-jára oldja fel). A kimenő sorok `message_id=NULL`-t kapnak, így soha nem kerülnek deduplikálásra egymással szemben.
4. **Indításkori visszajátszás** -- a `SessionStart` hook `scripts/hooks/ledger-replay.py` rejtett `additionalContext`-et injektál a friss session kontextusának tetejére:
   - az átirat **utolsó N fordulója** időrendben, mindegyik `Felhasználó:` (bejövő) / `Te:` (kimenő) előtaggal, hogy a friss session tudja *miről szólt a beszélgetés*;
   - egy kiemelten jelzett **NYITOTT KÉRDÉS** -- a legutóbbi bejövő, amelynek nincs utána kimenő ("NYITOTT KÉRDÉS … válaszolj rá MOST") -- a `chat_id`-jával, hogy a válasz a megfelelő chatbe kerüljön.

   Az ágensnek nem kell *emlékeznie*, hogy utánanézzen -- a kontextus és a nyitott kérdés már előtte van.
5. **Élő session ürítés** -- a `SessionStart` visszajátszás csak *újraindításnál* fut, de egy üzenet egy **már-futó** session-ben is elveszhet (a session közepén keletkező süketség): a rögzítés felveszi, de az élő session sosem látja az újraindításig. A `scripts/hooks/ledger-live-drain.py` (kb. 2 percenként futtatja a `ledger-live-drain` ütemezett feladat az élő session-ben) újra felszínre hozza a még megválaszolatlan bejövőt -- `OPEN_QUESTION chat_id=… message_id=…\n<szöveg>` formában a stdout-ra -- így a futó ágens újraindítás nélkül válaszol. Két biztonsági korlát: **türelmi ablak** (`GRACE_SECONDS = 60` -- nem versenyez egy folyamatban lévő válasszal) és **deduplikációs állapotfájl** (`store/.ledger-drain-<agent_id>` -- egy kihagyott kérdés egyszer jelenik meg, nem minden ticknél). Soha nem blokkol (bármilyen hiba → exit 0, csendes). NEM settings.json hook -- ez egy szívverés ütemezett feladat, amelynek promptja csak akkor válaszol a Telegram reply eszközzel, ha blokk kerül a kimenetre.

**Több-ágenses hatókör.** A hook-ok **generikusak az összes channel ágens számára**
(marveen / dia / erno-ba): az `agent_id` a session cwd-jéből következik
(`<install>/agents/<id>` → `<id>`; `<install>` → `MAIN_AGENT_ID`). Minden olvasás és írás `agent_id` szerint van szűrve, így egy session csak a **saját** chatjét játssza vissza, és az ágensek soha nem szennyezik egymást.

**Hangolás (env).**

- `LEDGER_CONTEXT_WINDOW` -- a visszajátszott utolsó fordulók száma (alapértelmezett `20`). Ha a renderelt ablak meghaladja a ~4000 tokent (`CONTEXT_CHAR_BUDGET = 16000` karakter a `ledger-replay.py`-ban), a **legrégebbi** fordulók kikerülnek, hogy az injektált kontextus korlátozott maradjon.
- `LEDGER_OWNER_CHAT` / `ALLOWED_CHAT_ID` -- a reply eszköz `chat_id=0` gyorsírását a tulajdonos chatjára oldja fel a `ledger-outbound.py`-ban.
- `LEDGER_DB_PATH` -- csak teszteléshez, DB útvonal felülbírálása.

## settings.json blokk hozzáadása

A hook-okat a **projekt** settings.json-ban kell bekötni (NEM felhasználói scope-ban). A fő channels session cwd-je a projekt gyökere, tehát ezeket veszi fel. A hook-ok cwd alapján scopeolják magukat, így öröklésnél is biztonságosak.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-capture.py\"", "timeout": 15 } ] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__plugin.telegram.telegram__reply", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-outbound.py\"", "timeout": 15 } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume|clear", "hooks": [ { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/scripts/hooks/ledger-replay.py\"", "timeout": 15 } ] }
    ]
  }
}
```

- `UserPromptSubmit` nem kap matchert (minden promptnál lefut).
- `PostToolUse` matcher `mcp__plugin.telegram.telegram__reply`: a `.` karakterek regex wildcardok, amelyek illeszkednek a szanitizált eszköznévre `mcp__plugin_telegram_telegram__reply` (a hook ezenkívül ellenőrzi, hogy a `tool_name` tartalmazza a `telegram`+`reply` szót).
- `SessionStart` matcher `startup|resume|clear`: a matcher a **`source` mező felett alkalmazott regex** -- az egyetlen lehetséges értékek: `startup` / `resume` / `clear` / `compact`. Nincs `auto` forrás -- egy `"auto"` matcher csendesen semmire nem illeszkedik, így a visszajátszás soha nem fut le (ez volt a 2026-06-02-es siketség-visszajátszás hiba). A `compact` szándékosan ki van zárva: a tömörítési összefoglaló már megőrzi az élő kontextust. A visszajátszás no-op, ha az átirat üres.

**Nincs szükség systemd-re** -- ezek eseményvezérelt Claude Code hook-ok, nem időzítők. A hook-ok a `store/claudeclaw.db`-t olvassák a `python3` stdlib `sqlite3`-on keresztül (nincs node indítás, nincs `jq`). A beállítás módosítása után a következő session indításnál lépnek életbe.

## Tesztek

- `bash scripts/__tests__/conversation-ledger.test.sh` -- 34 eset (bejövő/kimenő rögzítés / visszajátszási kontextus ablak / N-korlát / időrend + előtagok / nyitott kérdés / megválaszolt-nincs-blokk / idempotencia / több-ágenses scope / élő-ürítés türelem + dedup + megválaszolt / szélső esetek) a valódi hook-ok ellen, `LEDGER_DB_PATH` + `LEDGER_OWNER_CHAT` általi izolációban.
- `npx vitest run src/__tests__/conversation-ledger-schema.test.ts` -- séma-drift guard (db.ts migráció == ledger_lib.py).
