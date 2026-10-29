# Hook-metaadatok és env-kapcsolók (HOOKDRIFT926)

> A `.claude/settings.json` hookjai mellé egy oldalfájl kerül, ami megfogja a csendes hook-átírást, a rossz sorrendet és a nem létező szkriptre mutató parancsot, mielőtt élesbe jutna.

English version: [en/hook-metadata.md](en/hook-metadata.md)

---

## 🎯 Mit tud / miért érdekes

A hookok (kapuk, naplózók, csatorna-segédek) a `settings.json` egyetlen nagy JSON-blokkjában élnek. Egy rosszul feloldott merge, egy elírt matcher vagy egy átnevezett szkript nem dob hibát: a hook egyszerűen nem fut, és ezt senki nem veszi észre, amíg egy kapu át nem enged valamit, amit meg kellett volna fognia.

Az oldalfájl minden hookhoz megjegyzi, mi volt a parancs és a matcher, amikor utoljára valaki tudatosan jóváhagyta. A CI ellenőrzi, hogy a settings és az oldalfájl egyezik-e. Ha nem, megmondja, melyik hook, melyik helyen, és mi változott.

A másik fele egy kis segédkönyvtár (`scripts/hooks/hook_switches.py`): egy env-változóval kikapcsolható egy naplózó hook (például a nagy forgalmú `tool-log-capture`), a kapukat viszont semmilyen env-érték nem kapcsolja ki.

---

## 🛠 Hogyan működik

### Az oldalfájl

`.claude/hooks.metadata.json`, a settings-fájl mellett. Minden matcher-csoportnak (esemény + index) van benne egy stabil `id`, egy egysoros `purpose`, a `hook` név (a szkript fájlneve kiterjesztés nélkül), egy `gate` jelző és egy `fingerprint` (sha256 az eseményre, a matcherre és a parancs-szövegre; a timeout NEM része). Azért oldalfájl, mert a Claude Code settings-sémája nem enged saját kulcsot a hook-objektumokban.

### Hook szerkesztése után

Ha hookot adsz hozzá, törölsz, átírod a parancsát vagy a matcherét, vagy átrendezed őket, ugyanabban a commitban frissítsd az oldalfájlt:

```bash
python3 scripts/hook-metadata.py --update     # újraírja az oldalfájlt és kiírja a diffet
python3 scripts/hook-metadata.py              # ellenőrzés, 0 = rendben, 1 = eltérés, 2 = olvashatatlan bemenet
```

A diffet nézd át: az átrendezett hook az `id`-jét és a `purpose`-át viszi magával, az új hook `purpose`-a a szkript első dokumentációs mondatából jön (ha `TODO`, írd át kézzel). Bármelyik settings-fájl ellenőrizhető, például egy lokálisan módosított példány: `python3 scripts/hook-metadata.py --settings /út/.claude/settings.json` (az oldalfájl alapból a settings-fájl mellett van, a `--metadata` és a `--project-dir` felülírja).

Hibakódok:

| Kód | Jelentés |
|-----|----------|
| `MISSING_METADATA` | a hooknak nincs bejegyzése |
| `ORPHAN_METADATA` | a bejegyzés hookja eltűnt a settingsből |
| `DRIFT` | parancs vagy matcher átírva az oldalfájl frissítése nélkül |
| `REORDERED` | ismert hook más helyen (csendes átrendezés) |
| `MISSING_SCRIPT` | a parancs nem létező fájlra mutat |
| `FORBIDDEN_KEY` | sémán kívüli kulcs a settingsben (például `id` vagy `description`) |
| `SCHEMA` | szerkezetileg hibás hooks-blokk |
| `BAD_METADATA` | hibás oldalfájl (a felső szint nem objektum, rossz index, ismételt id, a `hook` mező nem a csoport által futtatott szkript, hibás `non_disableable` lista) |
| `GATE_NOT_LOCKED` / `GATE_UNFLAGGED` | a `gate` jelző és a zárolási lista eltér, vagy egy `-gate` / `-guard` nevű hook nincs zárolva |

A CI (`.github/workflows/test.yml`) a validátor tesztjeit és magát a validátort is futtatja a repó settings-fájlján.

### Env-kapcsolók

`MARVEEN_DISABLED_HOOKS=tool-log-capture` kikapcsolja a felsorolt hookokat, ha azok a `hook_switches` segédet használják (jelenleg: `tool-log-capture`). A felsorolt hook a bemenete beolvasása előtt 0-val kilép.

A **zárolt** hookok NEM kapcsolhatók ki env-ből: a nevük figyelmen kívül marad, bármit mond a változó. Egy env-változót pont az tud beállítani, aki nem kellene: egy prompt-injekció vagy egy figyelmetlen `export`.

A zárolási lista két részből áll:

1. **Beépített alap:** `hook_switches.DEFAULT_NON_DISABLEABLE`, a repóval szállított összes kapu és őr (`outgoing-copy-gate`, `email-approval-gate`, `email-send-gate`, `egress-gate`, `credential-gate`, `destructive-gate`, `fleet-freeze-gate`, `telegram-reply-guard` és a többi), továbbá a beszélgetés-napló (audit ledger) hookjai (`ledger-capture`, `ledger-outbound`, `ledger-turn-failure`, `ledger-live-drain`, `ledger-live-drain-precheck`). Egy teszt bukik, ha egy szállított `-gate` / `-guard` hook kimarad belőle.
2. **A telepítés saját kiegészítése:** az oldalfájl felső szintű `non_disableable` listája. Ide kerülnek a telepítés saját kapui és audit-naplói, a `hook_switches.py` szerkesztése nélkül:

```json
{
  "version": 1,
  "non_disableable": ["my-post-gate", "outgoing-mail-ledger"],
  "hooks": { "...": [] }
}
```

A lista csak HOZZÁAD: a beépített alapból semmit nem lehet adattal kivenni. Ha az oldalfájl létezik, de a zárolási lista nem olvasható, akkor amíg meg nem javítod, minden hook zároltnak számít (biztonságos irány): egyik sem kapcsolható ki env-ből, és a túl nagy bemenet mindegyiknél blokkol. A validátor a kétféle hibát másképp jelzi, lásd a lenti táblázatot.

#### Mit ír és mit nem ír a `--update`

Egyetlen szabály, egyetlen függvény (`preflight()`) őrzi, ez az írás előtti egyetlen kapu: a `--update` csak akkor írja az oldalfájlt, ha MINDKÉT bemenetet (a settings-fájlt, amiből újragenerál, és a meglévő oldalfájlt) beolvasta és ellenőrizte, a settingsben nulla `SCHEMA` / `FORBIDDEN_KEY` találattal, és nincs semmi, amit ne tudna átvinni, és az új szöveget már felépítette és kódolta. Minden más esetben 2-es kóddal kilép, és az oldalfájl bájtra azonos marad. Minden ellenőrzés az ideiglenes fájl létrehozása előtt fut; az írás közbeni hiba (bármilyen kivétel) szintén 2-es kód, az ideiglenes fájl törlődik.

Átviteli szabály: pontosan azt írja vissza, amit beolvasott, kivéve az általa újragenerált mezőket (`version`, `_comment` és a `hooks` bejegyzései; az id és a purpose a hookjával megy). A meglévő `non_disableable` értéket változatlanul visszaírja, a `null`-t is. Az ismeretlen felső szintű kulcsokat megtagadás helyett változatlanul átviszi (a kíméletesebb választás: semmi nem vész el). A `gate` jelzők a tényleges zárolási listából jönnek (beépített alap és az oldalfájl `non_disableable` nevei); amíg ez a lista hibás, a bejegyzés megtartja a régi jelzőjét.

Melyik régi bejegyzést örökli egy csoport (az `id`-jét és a `purpose`-át), úgy, hogy egy címke soha ne kerüljön másik csoporthoz: először minden pontos ujjlenyomat-egyezés ugyanazon a helyen, az összes csoporton át; utána minden maradék pontos ujjlenyomat-egyezés bárhol az eseményen belül (áthelyezett hook); csak ezután, a maradékokra (átírt parancs vagy matcher), egy szkript maradék csoportjai sorrendben öröklik ugyanannak a szkriptnek a maradék bejegyzéseit, és csak akkor, ha a két szám egyenlő. Ha eltér (átírás és ugyanannak a szkriptnek a beszúrása vagy törlése egyszerre), a párosítás találgatás lenne, ezért ezek a csoportok friss id-t és generált purpose-t kapnak; az a régi id, amit egy csoport sem örököl, abban a futásban nem kerül újra kiosztásra. Ha tehát egy többször bekötött szkript (például `outgoing-copy-gate`) új csoportját szúrod be, minden testvér id-je és purpose-a a helyén marad.

| A bemenet állapota | Validátor | `--update` |
|---|---|---|
| settings: hiányzik, nem nyitható meg, nem érvényes JSON, vagy túl mélyen egymásba ágyazott | 2-es kód (olvashatatlan bemenet) | 2-es kód, megtagadja |
| settings: nincs `hooks` kulcs, miközben az oldalfájlban vannak bejegyzések (valószínűbb a csonka vagy rossz fájl, mint hogy minden hook megszűnt) | 1-es kód, minden bejegyzésre `ORPHAN_METADATA` | 2-es kód, megtagadja; ha tényleg minden hook megszűnt, a bejegyzéseket kézzel töröld |
| settings: a felső szint vagy a `hooks` nem objektum, egy esemény nem tömb, egy csoport / handler nem objektum, egy csoportnak nincs nem üres `hooks` tömbje, egy command handlernek nincs `command`-ja, nem érvényes UTF-8 szöveg | 1-es kód, `SCHEMA` | 2-es kód, megtagadja |
| settings: hook-sémán kívüli kulcs (`id`, `description` ...) | 1-es kód, `FORBIDDEN_KEY` | 2-es kód, megtagadja |
| settings: a parancs nem létező szkriptre mutat | 1-es kód, `MISSING_SCRIPT` | ír (semmi nem vész el), utána 1-es kód, `MISSING_SCRIPT` |
| oldalfájl: nem nyitható meg, nem érvényes JSON (például merge-konfliktus jelölők), vagy túl mélyen egymásba ágyazott | 2-es kód, `cannot read metadata` | 2-es kód, megtagadja |
| oldalfájl: a felső szint vagy a `hooks` nem objektum (vagy a `hooks` hiányzik), egy esemény nem tömb, egy bejegyzés nem objektum | 1-es kód, `BAD_METADATA` | 2-es kód, megtagadja |
| oldalfájl-bejegyzés: ismeretlen vagy hiányzó kulcs, rossz típus (`index` egész, `id` nem üres szöveg, `hook` szöveg vagy null, `gate` logikai, `purpose` szöveg, `fingerprint` szöveg), vagy ismételt `id` | 1-es kód, `BAD_METADATA` az `index`, `id`, `fingerprint`, `gate`, `hook` mezőre; a `purpose` típusát nem nézi (a hiányzóra figyelmeztet) | 2-es kód, megtagadja |
| oldalfájl: a `version` megvan, de nem pontosan az 1-es egész (`true`, `"1"`, `1.0`, `2`) | nem ellenőrzi | 2-es kód, megtagadja |
| oldalfájl: olyan szöveg, amit az új fájl nem tud UTF-8-ként kódolni (magányos surrogate escape) | nem ellenőrzi | 2-es kód, megtagadja |
| oldalfájl: a `non_disableable` megvan, de nem nevek tömbje (a `null` is ilyen) | 1-es kód, `BAD_METADATA` | az értéket változatlanul visszaírja, a régi `gate` jelzőket megtartja, utána 1-es kód, `BAD_METADATA` |
| oldalfájl: ismeretlen felső szintű kulcsok | figyelmen kívül hagyja | változatlanul átviszi |
| az új fájl írása nem sikerül (ideiglenes fájl, chmod, csere) | - | 2-es kód, az oldalfájl érintetlen, az ideiglenes fájl törlődik |

Előbb oldd fel a konfliktust, vagy állítsd vissza a fájlt. Ha az oldalfájl nincs meg, csak a beépített alap érvényes. Az oldalfájl helye a `hook_switches.py` helyéből jön (a repó gyökere alatti `.claude/hooks.metadata.json`), env-ből szándékosan nem írható felül.

#### Bemeneti korlát és öröklés

`MARVEEN_HOOK_INPUT_MAX_BYTES` (alap 8 MiB) a hook bemenetének felső korlátja. Fölötte a naplózó hook csendben kihagyja a hívást (fail-open), a zárolt hook 2-es kóddal blokkol (fail-closed).

A változót a hook a Claude Code folyamattól örökli, ezért a session indítása előtt kell beállítani (vagy a settings.json `env` blokkjába tenni). Egy futó session Bash-eszközében kiadott `export` a Bash alfolyamatban marad, a hookig nem jut el. (Ez a folyamat-öröklésből következik; élő sessionen nem mértük, ahogy az `env` blokk hook-hatását sem.)

### Új hook bekötése a kapcsolóra

A segédet használó hook az importját `try`-ba teszi, és import-hiba esetén a korábbi viselkedésére esik vissza, hogy a kapcsoló soha ne legyen új hibaforrás:

```python
try:
    import hook_switches
except Exception:
    payload = json.load(sys.stdin)
else:
    if hook_switches.is_disabled("my-logger"):
        sys.exit(0)
    raw = hook_switches.read_hook_stdin("my-logger")
    if raw is None:          # túl nagy bemenet, naplózó hook: fail-open
        sys.exit(0)
    payload = json.loads(raw)
```

Az ötlet az affaan-m/ECC (MIT) `hooks.metadata.json`-jából jön; kódot nem vettünk át belőle.
