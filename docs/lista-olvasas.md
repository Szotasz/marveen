# Lista-olvasás: nemleges lelet csak teljes listából

Ez a lap a minden ügynök `CLAUDE.md`-jébe generált „Lista-olvasás” szakasz
részletes változata. A szakasz maga csak a szabályt és egy parancsot hordoz;
a végpontonkénti korlátok és a mechanizmus itt vannak.

## A mechanizmus

Egy lista-végpontból (`GET /api/kanban`, `GET /api/messages?agent=`,
`GET /api/memories`) levont NEMLEGES állítás („nincs ilyen lap”, „0 függő
üzenet”, „erről nincs emlék”) csak akkor igaz, ha a lista TELJES volt: a válasz
ép, ÉS a szerver sem vágta le.

- Egy leálló vagy újrainduló dashboard alatt a kérés félbeszakad, vagy választ
  sem kap. A `curl -s` ezt nem írja ki.
- Egy félbeszakadt törzs eleje egy sor-számlálónak (`grep -c`) vagy egy tűrő
  olvasónak rövidebb, de valódinak látszó lista lehet. Ha erre épül egy
  „nincs ilyen lap” lelet, a kiesés körül duplikátum-lap nyílhat.
- A végpont a teljes listát memóriában építi fel és egy darabban küldi, tehát
  egy félbeszakadt törzs soha nem érvényes JSON, és a curl 18-cal lép ki rá.
  Az ellenőrzés ezért az OLVASÓ dolga.

## A recept

A curl kilépési kódját és a HTTP-kódot KÜLÖN mérd, a törzset futásonként saját
ideiglenes fájlba (`mktemp`) írd, és szigorú JSON-olvasóval olvasd:

```bash
f=$(mktemp); code=$(curl -sS -o "$f" -w '%{http_code}' -H "Authorization: Bearer $(cat <telepítés>/store/.dashboard-token)" <dashboard>/api/kanban); rc=$?; echo "rc=$rc http=$code"; python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$f"; rm -f "$f"
```

A VÁLASZ csak akkor ép, ha `rc=0`, `http=200`, és a `json.load` hiba nélkül
fut. `rc=18` a félbeszakadt átvitel, `rc=7` a kapcsolat hiánya, a `000` a
válasz nélküli kérés.

## Az ép válasz még NEM teljes lista

A korlátos végpont szerver-oldalon, jelzés nélkül vág. A lista csak akkor
teljes, ha az elemszám a korlát ALATT van; a korlátnál lapozz vagy szűkíts.
Végpontonként (a számokat a `src/__tests__/list-read-limits.test.ts` a valódi
kezelőkön méri, és ehhez a laphoz köti):

- `GET /api/kanban`: a teljes, nem archivált lista, korlát nélkül (archivált lap
  csak `includeArchived=1`-gyel). Az `X-Total-Count` fejléc a válasz lapjainak
  száma a szűrők után: vesd össze a tömb hosszával.
- `GET /api/kanban/archived`: a `limit` alapból a `KANBAN_ARCHIVED_MAX_ROWS`
  beállítás (alapérték 500, legfeljebb 5000); a válasz `total` és `limit` mezőt
  ad: `total < limit` a teljes, `total = limit` csonka lehet.
- `GET /api/messages?agent=`: CSAK a `status=pending` szűr, és az a teljes függő
  sort adja, korlát nélkül. Más `status` (delivered, done, failed) HATÁSTALAN: a
  válasz az ügynök beszélgetése, a legújabbal kezdve, alapból 50, legfeljebb 200
  sor (`limit=`), csonkolás-jelzés nélkül; a régebbi sorokat a
  `before=<a kapott legkisebb id>` adja. Nem függő üzenetről csak a JSON
  `status` mezőjére szűrve, a korlát alatti vagy végiglapozott listán mondj
  nemleges leletet.
- `GET /api/memories`: alapból 50, legfeljebb 200 sor (`limit=`). Listázásnál az
  `X-Memory-Search` fejléc `truncated=true`-t mond a korlátnál (lapozás:
  `offset=`); keresésnél (`q=`) a `hits` = `limit` jelenti ugyanezt, ott szűkíts.

## Ha valamelyik feltétel hiányzik

Ha nem ép a válasz, vagy a lista a korlátnál áll, nemleges lelet TILOS: se
„nincs ilyen lap”, se „0 függő”, se új lap nyitása a „nem találtam” alapján.
Várj, és olvasd újra, amíg ép választ kapsz; a korlátnál lapozz vagy szűkíts.
Darabszámot a JSON elemszámából mondj, ne `grep`-pel számolt sorokból.
