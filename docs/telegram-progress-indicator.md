# Telegram "dolgozom rajta…" haladásjelző

Egy könnyűsúlyú, plugin-független "az ágens dolgozik…" jelző a Telegram csatornához, plusz egy watchdog (felügyelő), amely egy elakadt fordulót egyértelmű hibaüzenetté alakít. Teljes egészében Claude Code hook-okkal és egy önálló watchdog-gal van megvalósítva, tehát **nem igényel változtatást az hivatalos Telegram plugin-ban** és túléli a plugin frissítéseket.

## Miért

Amikor üzenetet küldesz egy Telegram-kötött ágensnek, nincs megbízható jelzés arról, mi történik: megkapta-e a bot az üzenetet, gondolkodik-e, vagy elakadt/offline? A plugin egyszer küld `sendChatAction('typing')` eseményt, de a Telegram ~5s után törli, és a modell általában tovább gondolkodik, így a jelző eltűnik és a felhasználó találgatni kénytelen.

A `typing…` akció szándékosan el lett utasítva: tisztességtelen (a modell gondolkodik, nem gépel) és lejár. Ez az egyértelmű, becsületes státuszjelzés:

1. Üzenet érkezett -> megjelenik egy látható `✍️ Dolgozom rajta…` helyfenntartó.
2. Válasz elküldve -> a helyfenntartó eltűnik, és a valódi válasz friss, értesítő üzenetként jelenik meg.
3. A forduló soha nem fejeződik be (ágens összeomlott / elakadt / elérhetetlen) -> a helyfenntartó egyértelmű hibaüzenetté íródik át, így a felhasználó mindig kap **vagy választ, vagy explicit hibajelzést**.

## Hogyan működik

Négy kis stdlib-Python komponens. A token és az állapot könyvtár pontosan úgy van feloldva, mint a plugin-ban (figyelembe veszi a `TELEGRAM_STATE_DIR`-t, egyébként `~/.claude/channels/telegram`), így minden komponens per-ágens szinten helyes marad különböző bot-okkal is.

| Komponens | Kiváltó esemény | Feladata |
|-----------|-----------------|----------|
| `telegram_progress.py` | `UserPromptSubmit` hook | Ha a prompt tartalmaz Telegram `<channel … chat_id … message_id>` blokkot, elküldi a helyfenntartót és feljegyzi annak üzenetazonosítóját egy per-session állapotfájlban. |
| `telegram_progress_reply_clear.py` | `PostToolUse` hook (matcher `telegram.*reply`) | Törli a megválaszolt chat helyfenntartóját abban a pillanatban, amikor elküldik a választ. **Elsődleges törlési út.** |
| `telegram_progress_clear.py` | `Stop` hook | Töröl minden helyfenntartót, ami a forduló végén még fenn van, **és kikényszeríti a kézbesítést** (lásd lent). |
| `telegram_progress_watchdog.py` | launchd / systemd, ~60s | Megvizsgálja minden ágens per-ágens állapot könyvtárát; egy árva helyfenntartó esetén (az ágens `agent-<name>` tmux session-je eltűnt + régebbi mint egy rövid türelmi idő, VAGY régebbi mint egy nagylelkű "elakadt" küszöb) `editMessageText`-tel hibaüzenetre írja át. Ez az egyetlen réteg, ami tud szólni, ha maga az ágens is leállt. |

### Miért kell egyszerre PostToolUse és Stop

Eredetileg a helyfenntartó csak `Stop`-nál törlődött. Ez hibás egy hosszú, több-válaszos fordulón: ha az ágens több választ ad ki a forduló vége előtt, az eredeti `Dolgozom rajta…` az egész (esetleg nagyon hosszú) forduló alatt fennmarad, holott a felhasználónak már van válasza -- *úgy néz ki, mintha elakadt volna*. A `reply` eszköznél való törlés (PostToolUse) pontosan akkor tünteti el a helyfenntartót, amikor megjelenik a válasz; a `Stop` tartalékként megmarad, és a watchdog mint összeomlás-biztonsági háló.

### Válasz-kikényszerítés (a "csak CLI-ben válaszolt" hiba)

A 3. cél -- *a felhasználó mindig kap vagy választ, vagy explicit hibajelzést* -- van még egy hibaforma, amit a watchdog nem foghat el: az ágens normálisan befejezi a fordulót (tehát `Stop` lefut), de soha nem hívta meg a `reply` eszközt, így a válasza csak a CLI/átiratban él, és a Telegram felhasználó semmit sem lát. A `Stop` hook ezt zárja le: ha a forduló végén még fenn van egy helyfenntartó (= Telegram fordulat, amelybe nem küldtek választ az adott chatra), akkor:

1. **egyszer blokkol** és utasítja az ágenst, hogy küldje el a válaszát a `reply` eszközzel (az ágens visszalép és szabályosan válaszol, a saját formázásával), és
2. ha ez után *még mindig* nem válaszolt, **kézbesíti az ágens utolsó válaszát** (az utolsó asszisztens üzenet az átiratból) a chatbe garantált tartalékként.

Ciklus-biztos: egy per-session `enforce-<sid>.marker` legfeljebb egy blokkolást garantál, és a `stop_hook_active` be van tartva. Azok a fordulók, amelyekhez nem volt Telegram helyfenntartó (sima CLI session-ök, csendes szívverések), érintetlenek maradnak.

### Megerősítés

- **Duplikáció-védelem**: egy atomikus `O_EXCL` marker a bejövő üzenet azonosítójával kulcsolva, így még ha a hook két scope-on is regisztrálva van (globális + projekt, amelyeket a Claude Code additívan összesít), soha nem küld dupla helyfenntartót.
- **Fleet-szintű**: a hook-ok a globális `~/.claude/settings.json`-ban élnek, így minden meglévő és jövőbeli ágens automatikusan megkapja; a watchdog az összes ágensedet megvizsgálja `$MARVEEN_ROOT` alatt (alapértelmezett `~/marveen`).

## Telepítés

```bash
bash ~/ClaudeClaw/scripts/install-telegram-progress-hook.sh
```

Idempotens, és automatikusan lefut a `scripts/sync-hooks.sh` minden frissítésnél. A következőket csinálja:

1. Átmásolja a négy hook scriptet a `~/.claude/hooks/`-ba.
2. Frissíti a `~/.claude/settings.json`-t (UserPromptSubmit / PostToolUse / Stop).
3. Telepíti a watchdog-ot **launchd** ágensként (macOS) vagy **systemd** felhasználói service+timer formájában (Linux), ~60 másodpercenként fut.

## Hangolás

- `telegram_progress_watchdog.py`: `DOWN_GRACE_SEC` (alapértelmezett 120s -- ágens leállt + helyfenntartó ennél régebbi -> hiba) és `WEDGED_SEC` (alapértelmezett 15 perc -- ágens fut, de a helyfenntartó ennyire régi -> hiba).
- `MARVEEN_ROOT` env változó felülbírálja a fleet gyökerét, amelyet a watchdog megvizsgál.

## Eltávolítás

Töröld a négy `~/.claude/hooks/telegram_progress*.py` fájlt és a belőlük eredő bejegyzéseket a `~/.claude/settings.json`-ból, majd töröld a watchdog-ot
(`launchctl unload ~/Library/LaunchAgents/com.marveen.telegram-progress-watchdog.plist`
macOS-en, vagy `systemctl --user disable --now marveen-telegram-progress-watchdog.timer`
Linuxon).
