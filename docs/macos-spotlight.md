# macOS: a Spotlight-index és a „System Data”

## 🎯 Mit jelent, miért érdekes

Ha a Marveen egy Macen fut, az ügynökök egész nap írnak: naplókat, jsonl-átiratokat (`~/.claude/projects`) és sqlite-adatbázist (`store/`). A macOS Spotlight ezeket is indexeli. Folyamatos írás mellett az index a Data köteten több tíz GiB-ra nőhet. Minden index-összefésüléskor (merge) a macOS ideiglenesen egy teljes új példányt is ír.

A Rendszerbeállításokban ez **„System Data” (Rendszeradatok)** növekedésként látszik, ami újraindításkor részben eltűnik.

Egy mért eset (macOS 26.6, Mac mini):
- az index 64+ GiB volt;
- egy merge közben további +74 GiB ideiglenes fájl keletkezett;
- a szabad hely 28 GiB-ra fogyott.

## Ellenőrzés

```bash
mdutil -s /System/Volumes/Data              # "Indexing enabled." = az index fut
bash scripts/doctor.sh                       # a "Spotlight (macOS)" szakasz ugyanezt jelzi
```

Az index valódi mérete és a merge-fájlok csak rootként láthatók (jelszót kér):

```bash
sudo du -sh /System/Volumes/Data/.Spotlight-V100
sudo lsof -c mds_stores | grep -iE 'merge|indexPositions'
```

## Javítás (ajánlott)

**Rendszerbeállítások > Spotlight > Keresési adatvédelem** (Search Privacy): add hozzá a listához
1. a Marveen telepítési mappáját (azt, amelyikben a `scripts/doctor.sh` van; a doctor kiírja a pontos útját);
2. a `~/.claude` mappát.

**Ára:** ez a két mappa nem jelenik meg a Cmd+Szóköz keresésben. A naplókat, a jsonl-t és az adatbázist úgyis a dashboardon és a memória-keresőn át éred el. Minden más (alkalmazások, dokumentumok, levelek) kereshető marad.

**Amit a mért esetben NEM hatott** (macOS 26.6):
- `mdutil` egy mappára;
- `.metadata_never_index` fájl a mappában.

Csak a Keresési adatvédelem lista hatott.

## Végső eset

Ha a fenti nem elég, a teljes Data kötet indexelése kikapcsolható:

```bash
sudo mdutil -i off /System/Volumes/Data
```

Ez az **egész gépen** kikapcsolja a Spotlight-keresést (Cmd+Szóköz, Finder-keresés). Visszakapcsolás: `sudo mdutil -i on /System/Volumes/Data`. Az index ilyenkor újraépül, ami eltart egy ideig.

## 🛠 Hogyan működik

- A `scripts/doctor.sh` macOS-en a `scripts/lib/spotlight-check.sh`-t futtatja. Ha a Data kötet indexelése be van kapcsolva, figyelmeztet. Megmutatja az `mds_stores` CPU-idejét és a fenti root-parancsokat.
- **Csak jelez:** a futás eredményét nem rontja el, és semmit nem állít át.
- A Keresési adatvédelem listát root nélkül nem tudja kiolvasni. Ha a két mappa már a listán van, a figyelmeztetés teendő nélkül figyelmen kívül hagyható.
