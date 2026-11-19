---
name: bumblebee-hygiene-scan
description: Heti ellátási lánc higiéniai szkennelés (Perplexity Bumblebee). Hétfő 09:00. Leltárba veszi a telepített csomagokat, MCP-konfigokat és bővítményeket, majd ismert ellátási lánc fenyegetés-katalógusokhoz méri őket. Telegram-riasztás CSAK ha a találat > 0.
---

# Bumblebee heti ellátási lánc szkennelés

## Mikor / cél
Hétfő 09:00. A flotta sok külső MCP-szervert, automatikusan telepített CLI-t, csomagot és skillt használ, ez ellátási lánc kockázatot jelent. Ez csak olvasó leltár + ismert fenyegetésekhez illesztés.

## Bináris
- Útvonal: `~/.local/bin/bumblebee` (Go build, PIN v0.1.1)
- Forrás: `github.com/perplexityai/bumblebee` (Apache 2.0)
- Build: `git clone https://github.com/perplexityai/bumblebee && cd bumblebee && go build -o ~/.local/bin/bumblebee ./cmd/bumblebee` (Go >= 1.25 kell hozzá)

## Eljárás

1. **Nézd meg, megvan-e a bináris**:
```bash
if [ ! -x "$HOME/.local/bin/bumblebee" ]; then
  echo "bumblebee binary not found, skipping scan (install Go>=1.25 and build from github.com/perplexityai/bumblebee)"
  exit 0
fi
```
Ha a bináris hiányzik (friss gép Go nélkül), lépj tovább csendben egy info-szintű naplósorral. NE állj meg hibával, és ne küldj riasztást.

2. **Keresd meg a fenyegetés-katalógusokat**:
```bash
BB_CATALOG="$HOME/.claude/tools/bumblebee-threat-intel"
if [ ! -d "$BB_CATALOG" ] || [ -z "$(ls -A "$BB_CATALOG" 2>/dev/null)" ]; then
  # Try seeded catalogs from install dir
  SEED_CATALOG="{{INSTALL_DIR}}/seed-scheduled-tasks/bumblebee-hygiene-scan/threat-intel"
  if [ -d "$SEED_CATALOG" ] && [ -n "$(ls -A "$SEED_CATALOG" 2>/dev/null)" ]; then
    mkdir -p "$BB_CATALOG"
    cp "$SEED_CATALOG"/*.json "$BB_CATALOG/"
  else
    echo "No threat-intel catalogs found, skipping scan"
    exit 0
  fi
fi
```

3. **Futtasd a szkennelést** (csak olvas, ~3 mp):
```bash
~/.local/bin/bumblebee scan --profile baseline --exposure-catalog "$BB_CATALOG" > /tmp/bb-weekly.ndjson 2>/tmp/bb-weekly.err
```

4. **Értékeld a találatokat**:
```bash
FINDING_COUNT=$(grep -c '"record_type":"finding"' /tmp/bb-weekly.ndjson 2>/dev/null || echo 0)
```

5. **A nulla csak pozitív kontroll után bizonyíték.** A szkennelés kimenete
rekordtípusra ugyanaz betöltött katalógussal és anélkül, és az NDJSON-ban
semmi nem mondja meg, hogy a katalógus betöltődött-e: egy elírt út vagy egy üres
katalógus-mappa ugyanazt a megnyugtató nullát adja, mint egy tiszta gép (mérve 2026-08-24).
Mielőtt egy 0-t tisztának könyvelsz el, bizonyítsd, hogy az illesztési út él:
```bash
# a) pick one certainly-installed package from today's scan
#    (the SCAN record's field is package_name)
grep '"record_type":"package"' /tmp/bb-weekly.ndjson | head -1 | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ecosystem'], d['package_name'], d['version'])"
# b) write a one-entry synthetic catalog into a TEMP dir. CAREFUL: the CATALOG
#    entry's field is `package`, NOT `package_name` -- the two schemas differ,
#    and the wrong key makes the control itself fail silently (it then looks
#    exactly like a broken catalog load). Copy schema_version from a real
#    catalog file.
mkdir -p /tmp/bb-synth && cat > /tmp/bb-synth/synthetic.json << 'JSON'
{"schema_version": "<copy from a real catalog file>", "entries": [
  {"id": "SYNTH-1", "name": "synthetic control", "ecosystem": "<from a>",
   "package": "<from a>", "versions": ["<from a>"], "severity": "low", "source": "synthetic"}
]}
JSON
~/.local/bin/bumblebee scan --profile baseline --exposure-catalog /tmp/bb-synth | \
  grep -c '"record_type":"finding"'   # must be > 0
rm -rf /tmp/bb-synth
```
Ha a kontroll ad találatot, a mai valódi 0 valódi nulla. Ha a kontroll is 0-t ad,
NE jelents tisztát, hanem MŰSZERHIBÁT (és előbb a szintetikus fájl mezőneveit nézd
meg: ez az olcsóbb a két ok közül).
A szintetikus fájlt soha ne tedd a valódi katalógus-mappába.

6. **Telegram CSAK ha a találat > 0**: küldj riasztást a találat részleteivel (ökoszisztéma, csomag, verzió, melyik fenyegetés-katalógus illeszkedett). Ha 0 a találat ÉS a pozitív kontroll átment: maradj csendben (heartbeat-stílus, csak egy átiratsor). A kontroll nélküli nulla ELLENŐRIZETLEN, és annak is kell jelenteni, nem tisztának.

7. **Havi fenyegetés-katalógus frissítés** (kb. 30 naponta egyszer). A 30 napos
szabályt egy frissítés-ellenőrzési jelölőfájlhoz kösd, NE a katalógusfájlok mtime-jához:
a katalógusfájl mtime-ja nem változik, amíg az upstream nem változik, így egy mtime-szabály
minden heti futáskor újraklónoz, amint a fájlok 30 napnál idősebbek (mérve 2026-09-07:
35 napos fájlok, az upstream bájtra azonos, a klónozás tiszta pazarlás volt). Tartalmat
hasonlíts, csak változásnál másolj, és a jelölőt mindkét esetben frissítsd:
```bash
MARKER="$BB_CATALOG/.last-refresh-check"
if [ -z "$(find "$MARKER" -mtime -30 2>/dev/null)" ]; then
  cd /tmp && rm -rf bb-ti-update
  git clone -q --depth 1 https://github.com/perplexityai/bumblebee.git bb-ti-update 2>/dev/null
  if [ -d bb-ti-update/threat_intel ]; then
    LOCAL_SUM=$(cat "$BB_CATALOG"/*.json 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
    UPSTREAM_SUM=$(cat bb-ti-update/threat_intel/*.json | shasum -a 256 | cut -d' ' -f1)
    if [ "$LOCAL_SUM" != "$UPSTREAM_SUM" ]; then
      cp bb-ti-update/threat_intel/*.json "$BB_CATALOG/"
    fi
  fi
  rm -rf bb-ti-update
  touch "$MARKER"
fi
```

## Buktatók
- Találat CSAK a `--exposure-catalog` kapcsolóval jelenik meg (nélküle mindig 0). A katalógusok helye: `~/.claude/tools/bumblebee-threat-intel/`.
- **A szkennelés a katalógusra nézve fail-open**: elírt katalógus-úttal vagy üres katalógus-mappával a kimenet rekordtípusra azonos egy egészséges futáséval, és semmi nem jelzi benne, hogy a katalógus nem töltődött be. Az 5. lépés pozitív kontrollja nélküli nulla egy szám, amit senki nem ellenőrzött.
- Ha nincs Go (< 1.25 vagy nincs telepítve), a bináris nem építhető. A feladatnak ilyenkor CSENDBEN TOVÁBB KELL LÉPNIE, nem összeomlania.
- A 0 találat NEM abszolút biztonságot jelent, csak azt, hogy a most betöltött katalógusokban szereplő fenyegetések nincsenek jelen. Ne idézz fix fenyegetés-számot emlékezetből, mert elavul (egy "6 fenyegetés" szám élte túl itt, miközben a valódi katalógusokban 12 fájl / 1099 bejegyzés volt); ha kell a szám, a betöltött katalógusfájlok `entries` tömbjeiből számold meg.
- NE spamelj: 0 találat = nincs Telegram-üzenet.
- A seed-scheduled-tasks alatt tárolt katalógusok indító tartalék. A havi frissítés tartja őket naprakészen.
- CSENDES KIHAGYÁS VAKFOLTJA (mérve 2026-08-10): ha a bináris hiányzik (nincs Go eszközlánc a gépen, `go: command not found`, vagy egyszerűen sosem épült meg), az 1. lépés minden egyes hétfőn 0-val lép ki, miközben a katalógusok egészségesnek látszanak. A "csendes kihagyás + nincs Telegram" ekkor azt jelenti, hogy a lefedettségi rés tartósan láthatatlan: nincs riasztás, nincs átirat, amit bárki elolvasna, hétről hétre. SZABÁLY: kihagyáskor, az `exit 0` előtt nézd meg, létezik-e már `hot` emlék a résről (`GET /api/memories?q=bumblebee&strict=1`), és ha nincs, írj egyet. **A `&strict=1` maga az ellenőrzés** (MEMKERESVAK917): nélküle a keresés engedékeny, így ha egyetlen emlék sem illeszkedik, a maradék töltelékszavakra hozott sorokkal válaszol, és a hiány-teszt ezt úgy olvassa, hogy "már létezik", és sosem ír. A gazda tárán mérve, pontosan ilyen alakú, természetesen megfogalmazott kérdéssel (`q=bumblebee binary hianyzik Go toolchain nincs`) a végpont ezt adta: `X-Memory-Search: strict=false; relaxed=true; hits=50`. Ötven sor, egyik sem a keresett emlék. A `strict=1`-gyel az üres válasz pontosan azt jelenti, aminek látszik. Ez hozza felszínre a Dream Engine / napindító Top-3-ban ahelyett, hogy eltűnne. A Telegram-tilalom a spamet tiltja, NEM a nyilvántartást.
- NE futtasd a 7. lépést (katalógus-frissítés), ha a bináris hiányzik. Egy futni nem tudó szkenner fenyegetés-katalógusát frissíteni tiszta üresjárat, és egy `git clone` + `cp` a katalógus-mappán haszon nélküli módosítás. Előbb a binárist javítsd, utána frissíts.
- A bináris építése egy teljes Go eszközlánc telepítését jelenti (`brew install go`) a felhasználó gépén. Ez a felhasználó döntése, nem autonóm lépés: eszkaláld és várj, ne telepítsd magadtól.


## Ellenőrzés
- A szkennelés 0-val lép ki, a scan_summary rekordban status=complete.
- Egy 0 találatos eredményt átment pozitív kontroll kísért (5. lépés), vagy a jelentés kimondja, hogy a nulla ELLENŐRIZETLEN.
- A > 0 találat Telegram-riasztást indít; az ellenőrzött 0 találat = csend.
