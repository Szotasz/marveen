# Eco-mode P4 — feladat-pontozás/beárazás (router R&D)

Kártya: #132, P4. Alapja: P1-P3 (router él a peci01-en, /metrics gyűjt), a #133
benchmark, és a costops költség-adat. Végrehajtás: prisma (PR-workflow, marveen
review), ez a terv a build inputja. Az ár-forrás kanonikus helye a #168 (a P3
metrika szándékosan NEM ír árat, csak a számításhoz kellő nyers mezőket).

## 0. A LEGFONTOSABB ELŐBB: P4 ma nem kalibrálható valós adaton
A router /metrics jelenleg 7 kérést lát — ez a P3 elfogadási battéria, NEM éles
forgalom. Organikus route-adat nulla, mert ma SEMMI éles fleet-munka nem
terelődik a helyi modellekre: a címke-audit 0/17 single-call feladatot talált,
a scheduler-executor parkol, a fleet-helper->router kliens (P2c) kész, de egyik
valódi lépésbe SINCS bekötve. Következmény: egy beárazási modell most csak a
#133 laborszámaira támaszkodhatna, éles visszamérés nélkül -- az pedig
feltételezés, nem mérés.

Ezért P4 két részre bomlik, és a sorrend kötött:
- P4a (most megtehető): a pontozási/beárazási KERET megtervezése + az organikus
  adat FORRÁSÁNAK bekötése (≥1 valódi lépés a fleet-helper->routeren át).
- P4b (csak P4a adat gyűlése után): a keret KALIBRÁLÁSA és a döntési küszöbök
  meghúzása valós route-metrikából.

## 1. A pontozási modell (P4a, keret)
Feladatonként (egy agens-lépés vagy schedule) három bemenet:
- **osztály** (a router task_class-a): eldönti, HELYI-KÉPES-e egyáltalán (a #133
  tábla: structured/summary/general/hungarian/code igen; long-context csak
  air903max; agent-loop soha).
- **kritikusság**: user-felé megy-e / visszafordítható-e. Magyar user-szöveg és
  jogi/pénzügyi kimenet lokálisan CSAK emberi átnézéssel (#290) -> ezeknél a
  helyi út draft-only, a végleges felhő vagy review.
- **prompt-méret**: >8k token -> StrikeX kizárva (lassú prompt-eval), air903max
  vagy felhő.

Döntés: `helyi, ha (helyi-képes ÉS nem-kritikus ÉS méret-fér) ÉS (eco-mode VAGY
a becsült felhő-megtakarítás > küszöb)`. Különben felhő. A router már ezt a
routing-táblát alkalmazza (P1); P4 a "megéri-e" réteget teszi rá.

## 2. A beárazás (P4a keret, P4b kalibrálás)
- **Helyi marginális költség ≈ 0** (áram; a vas fix költség, süllyedt). Egy helyi
  hívás pénzben ~ingyen, ára a latencia (a #133: 30-143 tok/s gép szerint) és a
  VRAM-foglaltság (ComfyUI/ollama verseny).
- **Felhő-költség**: a token_usage / cost_line_items adja osztály/feladat
  szerint (a #168 kanonikus hely). A megtakarítás = a felhőn elköltött összeg,
  amit egy helyi-képes feladat helyben kiváltott volna.
- P4b: a /metrics route-rekordjaiból (osztály, gép, modell, tokenek, latencia)
  + a costops felhő-áraiból számol egy valós "mennyit spóroltunk" számot, és
  ebből húzza a küszöböt (mikor éri meg a lassabb helyi út).

## 3. Az organikus adat forrása (P4a, a tényleges unblokk)
A címke-audit négy valódi LÉPÉS-jelöltet adott a mai loopokon belül (nem önálló
feladatok): napindító-összefoglaló (summary), intel-brief (summary),
support-besorolás (structured), heti-összefoglaló magyar szövege (hungarian).
Ezek a fleet-helper->router (P2c) kliensen keresztül köthetők be. Javaslat:
ELŐSZÖR a napindító-összefoglaló (marveen sajátja, alacsony kockázat,
visszafordítható) menjen a routeren át -> ez termel organikus summary-metrikát,
amiből P4b kalibrálható. Egy lépés bekötése elég a mérés elindításához.

> **Utólagos korrekció (2026-08-09, prisma):** a napindító bekötése megtörtént
> (`scripts/napindito-router-draft.py`), és a mérés megcáfolta a fenti utolsó
> mondatot: **egy lépés bekötése NEM elég**. Napi egy hívást termel, amiből a
> P4b hetek helyett hónapok alatt kalibrálható. A folytatás tervét a 6. szakasz
> írja le, a §3 négy jelöltjének mért felülvizsgálatával együtt.

## 4. Elfogadás
- P4a: a scoring-keret kódban (tiszta függvény, tesztelhető), ÉS legalább egy
  valódi lépés a fleet-helper->routeren át fut, valós /metrics rekordot termelve.
- P4b: a route-metrikából + costops-ból számolt megtakarítás-riport, és a
  küszöb, amely mellett a helyi út nettó nyereség -- számmal, nem tippel.

## 5. Buktató (előre)
- Ne árazz a #133 laborszámaiból "megtakarítást" éles adat nélkül -- az a
  the-instrument-must-not-work-from-memory hibaosztály. A labor a KÉPESSÉGET
  adja (mi fut helyben), az ÁR a valós forgalomból jön.
- A helyi "ingyen" félrevezető, ha a latencia egy user-interaktív úton fáj: a
  scoring a kritikusság-tengelyen ezt kezeli (draft-only vs végleges).

## 6. Részlépés-szintű route-pontok (P4a folytatás, 2026-08-09, prisma)

A #301 mérése lezárt egy utat és kinyitott egy másikat. Feladat-szinten a
local-first hozama nulla: a 30 napos ablakban futott mind a 10 ütemezett feladat
turn-jeinek 66-100%-a tool-hívás, 1-9 különböző eszközzel -- ezek agent loopok,
és az `agent-loop` osztály a routerben szándékosan `cloudOnly`. Nem az
osztályozás hiányzott, hanem a szemcsézettség: nem egy egész heartbeat megy
lokálra, hanem **egy egylöketes lépés a heartbeaten belül**.

### 6.1 A kiindulási mérés (ne emlékezetből dolgozzunk)

A router `/metrics`, 2026-08-09 10:20-kor, `since` 2026-08-08 09:31:

| mérőszám | érték |
|---|---|
| requests / served / refused | 8 / 7 / 1 |
| ebből a P3 elfogadási battéria | 7 |
| **organikus** (a napindító 07:30-as futása) | **1** |
| latencia p50 / max | 16 150 ms / 45 329 ms |
| modell-betöltés összesen 7 kérésre | 96 884 ms |
| host | air903max (mindkét gép up) |

Két következtetés, mindkettő közvetlenül a számokból:

1. **Napi 1 organikus rekord.** Egy osztályonként ~100 rekordos mintához így
   több hónap kellene. A P4b nem adatra vár, hanem forgalomra.
2. **A modell-csere dominál** (96,9 s betöltés 7 kérésre, p50 16,2 s). A
   `structured`, `summary` és `general` osztály UGYANARRA a modellre megy
   (qwen3-coder), a `hungarian` (gemma4) és a `code` (laguna) viszont cserét
   kényszerít. **Tervezési szabály: az első kör route-pontjai maradjanak a
   structured/summary/general családban**, különben a mért latenciák nem a
   munkát, hanem a csereciklust írják le.

### 6.2 A §3 négy jelöltjének felülvizsgálata (mért)

| jelölt | osztály | schedule állapota | futás/nap | verdikt |
|---|---|---|---|---|
| napindító-összefoglaló | summary | enabled, `30 7 * * *` | 1 | bekötve, marad |
| intel-brief kivonat | summary | **enabled=false** | **0** | most nem forrás |
| support-besorolás | structured | enabled, `*/15 * * * *` | 96 | lásd 6.3, feltételes |
| heti-összefoglaló magyar szöveg | hungarian | enabled, `15 8 * * 5` | 0,14 | utolsó kör (modellcsere) |

Az intel-brief kiesik: a schedule ki van kapcsolva, nulla rekordot termelne. Ezt
a §3 nem tudhatta, mert akkor a mérés nem terjedt ki a schedule enabled-jére.

### 6.3 A döntő megkülönböztetés: tick-lépés vs anyag-lépés

A support-besorolás naiv olvasatban napi 96 hívás. Valójában sokkal kevesebb: a
besorolás CSAK akkor fut, ha új külső levél érkezett, a `store/support-inbox-state.json`
tanúsága szerint pedig a körök túlnyomó része csendes ("Valtozatlan: 8 level, 0
olvasatlan"). **Egy anyag-függő részlépés az ANYAG ritkaságát örökli, nem a
schedule gyakoriságát** -- ez az a hiba, ami miatt a §3 becslése felfelé tévedne.

Amit keresünk tehát: olyan részlépés, ami MINDEN tickben lefut, anyagtól
függetlenül, és egylöketes (nincs benne eszközhasználat, csak szöveg be ->
szöveg ki).

### 6.4 A javasolt route-pontok, sorrendben

**R1 -- support-inbox állapot-diff (structured, ~96/nap).** A heartbeat minden
körben ír egy `note` mezőt a saját state-fájljába: mi változott az előző körhöz
képest. Ez ma in-session szöveg. Bemenet: az előző state + a mostani
postafiók-listázás; kimenet **NEM magyar mondat, hanem mezők** (változott-e,
darabszám-delta, van-e új külső feladó és ki, egy soros indok angolul). A magyar
`note`-ot ezekből a mezőkből a loop állítja össze, ahogy eddig is.

Ez szándékos: a magyar szöveg-minőség külön osztály (`hungarian` -> gemma4), és
egy magyar mondatot `structured` osztállyal kérni azt jelentené, hogy a
qwen3-coderrel íratunk magyart -- pont az a hiba, ami miatt a gemma4 külön
sorban van a #133 táblában. Mezőket kérve a lépés valóban strukturált kinyerés,
az osztály-választás igaz, és a magyar szöveg ott marad, ahol ma is jó.

**NEM user-felé megy** (belső állapotfájl), tehát a #290 kötelező-review terhe
NEM vonatkozik rá -- ettől jobb első jelölt, mint a napindító. Blast radius: egy
állapotfájl-sor.

**R2 -- kanban-flow-watchdog board-triázs (structured, ~34/nap).** Minden körben
átnézi a táblát: van-e beragadt in_progress, gazdátlan waiting. Ez besorolás egy
kompakt tábla-dumpon: bemenet a kártyasorok (id, státusz, kor, assignee),
kimenet strukturált lista arról, melyik gyanús és miért. A DÖNTÉS (szóljunk-e
Viktornak) marad a loopban -- a router csak a besorolást adja.

**R3 -- memória-heartbeat kivonat (summary, ~12/nap).** Feltételes: a feladat a
`LOCAL_FIRST_EXEMPT` listán van, mert a HOST session kontextusától függ. A
kivonatolás részlépése viszont nem: ha a loop maga adja át a mentendő szöveget,
az már egylöketes. Csak akkor kösd be, ha R1+R2 után még kell minta.

**R4 -- heti-összefoglaló magyar szövege (hungarian, 0,14/nap).** Utolsó, és nem
a volumene miatt: ez az egyetlen jelölt, ami modellcserét kényszerít, tehát a
gemma4 latencia-profilját külön méri. Akkor kösd be, ha az R1-R3 mintája már
áll, hogy a csere ne szennyezze az alapvonalat.

Volumen R1+R2 után: ~130 hívás/nap a mai 1 helyett. Osztályonként ~100 rekord
egy napon belül, egy hét ~900 -- ebből a P4b már küszöböt húzhat.

### 6.5 A minta, amit általánosítunk (a napindítóból)

A `scripts/napindito-router-draft.py` szerződése változtatás nélkül átvehető,
route-pontonként egy szkript:

1. **Egy hívás, nincs retry-hurok.** A mérés a hívás, nem a kézbesítés.
2. **A visszautasítás ADAT, nem hiba.** rc=3 -> a loop pontosan úgy dolgozik
   tovább, ahogy a bekötés előtt tette. Ez fail-open: a route-pont soha nem
   akadályozhatja meg a feladat valódi munkáját.
3. **A fallback döntése a HÍVÓÉ.** A `local_router.ask()` sosem hív felhőt
   magától.
4. **A prompt a szkriptben él, nem a SKILL.md-ben.** Így a route-pont
   verziózható és a változása látszik a diffben.
5. **A SKILL.md-be csak a hívás + a két kimenet kezelése kerül** (rc=0 mit
   jelent, rc=3 mit jelent), hogy a lépés a promptból ne tudjon "elfelejtődni".

Új elem az R1/R2-nél a napindítóhoz képest: mivel a kimenet NEM megy user felé,
a kötelező emberi review helyett **alak-ellenőrzés** kell (megvannak-e a kért
mezők, a típusuk stimmel-e). Ha az alak nem stimmel, a lépés úgy viselkedik,
mint egy visszautasítás -- rc=3, a loop dolgozik tovább magától. Az alak-hiba
KÜLÖN számláló a visszautasítás mellett: a kettő más okot jelent (a modell rossz
alakot adott vs a router nem adott semmit), és összemosva egyik sem javítható.

### 6.6 Elfogadás (ennek a körnek)

- R1 és R2 bekötve, mindkettő fail-open, alak-ellenőrzéssel.
- A router `/metrics` `byClass.structured` értéke **≥100** organikus rekord, és
  a mintában legalább **7 egymást követő nap** szerepel -- a napszakos VRAM-
  verseny (ComfyUI) nélkül a latencia-eloszlás nem reprezentatív.
- A **visszautasítási arány** külön szám, nem hibaszázalék: egy `all-busy`
  visszautasítás felhő-hívást jelent, tehát a beárazás bemenete.
- Csak ezután indul a P4b küszöb-húzás.

### 6.7 Buktatók, amiket ez a kör hoz be

- **A gyakoriság nem volumen.** Anyag-függő részlépés az anyag ritkaságát
  örökli (6.3). Bekötés előtt minden jelöltnél mérni kell, hányszor futna
  ténylegesen -- ne a cron-ból becsüljük.
- **A ki nem kapcsolt schedule sem biztos, hogy fut.** Az intel-brief a §3-ban
  jelölt volt, közben `enabled=false`. A jelölt-listát a schedule ÁLLAPOTÁVAL
  együtt kell nézni.
- **A modellcsere elnyeli a mérést.** Vegyes osztályú első kör esetén a
  latencia a csereciklust írja le, nem a munkát (6.1).
- **GPU-verseny.** ~130 hívás/nap x ~16 s ≈ napi 35 perc GPU-foglaltság. Ez a
  ComfyUI-jal osztozik ugyanazon a VRAM-on; ha a refusal-arány elszalad, az nem
  a router hibája, hanem kapacitás-adat -- és pontosan ez a P4b egyik bemenete.
- **A fail-open csendes lehet.** Ha egy route-pont minden körben visszautasítást
  kap és a loop szó nélkül dolgozik tovább, a bekötés halott, de zöldnek
  látszik. A visszautasítás-számláló (6.6) ezért nem opcionális.
