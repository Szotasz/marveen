# Meta Graph olvasó (`scripts/graph-read.py`)

> Csak olvasó ajtó a Facebook / Instagram Graph API-hoz: kizárólag GET, rögzített host, a token a store-ból jön, a parancssorba soha nem kerül.

---

## 🎯 Mit tud / miért érdekes

Egy Facebook-oldalt vagy Instagram üzleti fiókot kezelő ügynök sokat *olvas*: az oldal hírfolyamát, egy videó
forrását, a fiók médialistáját, statisztikákat. Inline `curl`-lel minden ilyen olvasás a parancssorba (és az
átiratba) teszi a hozzáférési tokent, és a shell elé tett hook nem tudja megkülönböztetni egy közzétételtől,
ha az ige el van rejtve (`-XPOST`, `method=post`, `batch=` törzs, százalék-kódolt útvonal).

A `graph-read.py` az egyetlen parancs, ami egy olvasáshoz kell, és felépítéséből adódóan olvasás:

- minden kérés törzs nélküli `GET` a `graph.facebook.com`-ra (a végső URL-en újraellenőrizve);
- az útvonal egyszerű (`[A-Za-z0-9_/-]` egy opcionális `vNN.N/` után): se host, se pont, se `?`, se `..`;
- lekérdezési paraméter csak `kulcs=érték` argumentumként, és csak engedélyezett kulcs (`fields`, `limit`,
  `after`, `before`, `since`, `until`, `metadata`, `summary`, `date_preset`, `period`, `metric`, `breakdowns`);
  az író jelzőket (`message=`, `method=`, `batch=`, `published=` ...) hálózati hívás előtt elutasítja;
- a token a `store/.meta-token` fájlból jön (`--page <id>` esetén az oldal-tokent abból származtatja a
  `me/accounts` hívással); soha nem íródik ki, és a válasz minden `access_token` kulcsa maszkolva van.

```bash
python3 scripts/graph-read.py me/accounts fields=id,name
python3 scripts/graph-read.py <OLDAL_ID>/feed fields=id,message,created_time limit=5 --page <OLDAL_ID>
python3 scripts/graph-read.py <IG_FIOK_ID>/media fields=id,caption,permalink limit=10
```

Kilépési kódok: `0` rendben (JSON a stdout-on), `2` elutasítva vagy hibás hívás (semmi nem ment ki), `1` token-,
hálózati vagy API-hiba.

---

## 🛠 Hogyan működik

**Hívásszám-korlát.** A korlát-kódos Graph-hibát (17, 80004, 613, 80000, 80003, 80014) újrapróbálja, összesen
legfeljebb 6 hívásig. A várakozás a használati fejlécekből jön, ha azok megadják (`X-Business-Use-Case-Usage`
`estimated_time_to_regain_access`, `X-Ad-Account-Usage` `reset_time_duration`), különben 60 mp, duplázva 600 mp-ig.
Egy futás teljes alvását a `GRAPH_READ_MAX_WAIT_SEC` korlátozza (alapból 300 mp, hogy beférjen egy Bash
eszközhívásba; a hívásnak adj legalább 400000 ms időkorlátot). Ami nem fér bele, az azonnal 1-gyel kilép, nem alszik.

**Közös szünet-fájl.** Egy felhasználói token minden hívója ugyanazon a korláton osztozik, ezért a korlát-hiba
`{"blocked_until": <epoch>, "ok": <ok>, "irta_pid": <pid>}` sort ír egy szünet-fájlba (flock a `<fájl>.lock`-on,
atomi átnevezés, csak növelni lehet, az egy óránál távolabbi érték elavultnak számít), és minden próbálkozás előbb
kivárja a más által írt szünetet. A 95 % feletti használatot jelző sikeres válasz is szünetet ír a következő hívónak.

| Beállítás | Honnan | Alapértelmezés |
|---|---|---|
| `META_GRAPH_PAUSE_FILE` | környezeti változó, aztán a telepítés `.env`-je; relatív út a telepítés gyökeréhez képest | `store/meta-graph-pause.json` |
| `GRAPH_READ_MAX_WAIT_SEC` | környezeti változó | `300` |

A `META_GRAPH_PAUSE_FILE`-t arra a fájlra állítsd, amit ugyanennek a tokennek egy másik Graph-kliense már használ,
így egymást is visszafogják.

**Tesztek.** `python3 scripts/__tests__/graph-read.test.py` (hermetikus: hamis opener, ideiglenes token- és
szünet-fájl, hamisított óra; hálózat nincs).
