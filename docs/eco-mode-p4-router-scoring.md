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
