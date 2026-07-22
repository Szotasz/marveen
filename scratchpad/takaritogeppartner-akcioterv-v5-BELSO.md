# Takarítógéppartner - akcióterv v5

Verzió: v5 (a v4 helyébe lép). Készült: 2026-07-22.
Változás a v4-hez: a Search Console adat alapján bekerült egy harmadik, **ORGANIKUS LÁB**, és a diagnózis pontosodott. A PPC-rész lényegében változatlan, mert az SC megerősítette.
Fiók: Google Ads 5385457642 (MCC 5257587986), Meta act 314287332, GA4 properties/374081626.
Státusz: JAVASLAT. Egyetlen pénzt költő beállítás sem lett módosítva, mindenhez Zsolt jóváhagyása kell.

---

## 0. Amit a Search Console megváltoztatott

A v4 egy hiányos képre épült: akkor még nem tudtam megkülönböztetni a valódi forgalomvesztést az attribúciós átcímkézéstől. Most már tudom, és **három külön mechanizmus** van, három külön beavatkozással:

| # | Mechanizmus | Mérete | Bizonyíték | Melyik láb kezeli |
|---|---|---:|---|---|
| 1 | **Mix-torzulás**: a PMax darabszám-liciten az olcsó kiegészítő felé sodor | AOV -26%, ez a bevételkiesés zöme | PMax AOV 12 770 Ft, a rendelések 60%-a (tavaly 24%) | Volumen-motor + nagy értékű láb |
| 2 | **Attribúciós átcímkézés**: a PMax elszívja az organic last-click kreditet | ~14,5M Ft/félév | Organic AOV VÁLTOZATLAN (22 551 -> 23 058 Ft); ha csak a forgalommal esett volna (-27%), 22,5M lenne 8,00M helyett | Brand Search + márka-kizárás |
| 3 | **Valódi organikus forgalomvesztés** | ~940 klikk/hó, kb. 0,5-1,1M Ft/hó | SC klikk -27%, CTR 3,11% -> 2,42% | **ÚJ: organikus láb** |

**Az arányokat fontos kimondani, hogy a figyelem oda menjen ahol a pénz van:**
- PPC-láb (1+2): **+6-8M Ft/hó** potenciál
- Organikus láb (3): **+0,5-1,1M Ft/hó** potenciál

Az organikus láb valós és megéri, de **másodlagos**. Nem szabad hagyni, hogy elvigye a PPC-átállás kapacitását, mert a szeptember-októberi szezonra a PPC-nek kell betanulnia.

**A második fontos SC-tanulság:** a két legnagyobb organikus NYERTES pontosan a v4 nagy értékű lábának két magja (napelem-tisztító tartalom 3 -> 446 klikk, Nilfisk VP300 termékoldal 19 -> 69 klikk, pozíció 9,0 -> 6,5). Az organikus oldal tehát már most húzza azt a szegmenst, amire a PPC-tervet építettem. Ez nem véletlen egybeesés, hanem megerősítés: **ott van kereslet, ahová a pénzt tenni akarjuk.**

---

## 1. A 10x cél olvasata (változatlan a v4-hez képest)

Mai állapot (30 nap): Google Ads költés **1 276 013 Ft**, bevétel ~16,6M (június) illetve ~8,5M (júliusi ütem).

- 20M Ft/hó bevétel 10x blended ROAS mellett = **2,0M Ft/hó teljes médiaköltés kerete.**
- Ma 1,28M-ot költünk. Van kb. **620-720 ezer Ft/hó növekmény-keret.**

**A 10x nem költés-vágás, hanem növekmény-szabály: a plusz pénz kizárólag a nagy értékű lábra mehet.** A volumen-kampányok tROAS célja szándékosan a mai ROAS alatt van, hogy a darabszám ne essen.

**A ROAS-t Unas-bevétel / teljes médiaköltés alapon mérjük**, nem a Google Ads felületén: 30 nap alatt az Ads 11 475 641 Ft konverziós értéket állít, miközben a teljes webshop-bevétel ugyanerre kb. 10,8M. Az Ads a teljes bevétel több mint 100%-át tulajdonítja magának.

---

## 2. Első láb: VOLUMEN-MOTOR (változatlan)

Cél: ugyanannyi kattintás és rendelés, de a rendszer a drágább SKU-t preferálja a kosárban.

| Kampány | Napi büdzsé ma | v5 büdzsé | Licit ma | v5 licit | Mai ROAS | tROAS cél |
|---|---:|---:|---|---|---:|---:|
| PMax 2025 - Porszívók és kiegészítők | 13 000 | **13 000** | Max Conversions | Max Conv Value -> tROAS | 4,64x | **450%** |
| PMax 2025 - Porzsákok | 10 000 | **10 000** | Max Conversions | Max Conv Value -> tROAS | 6,47x | **550%** |
| PMax 2025 - Kiemelt termékek | 8 000 | **8 000** | Max Conversions | Max Conv Value -> tROAS | 6,40x | **550%** |
| DSA | 7 000 | **7 000** | Max Conversions | Max Conv Value -> tROAS | 8,28x | **700%** |

**Minden tROAS cél a mai ROAS ALATT van** (4,50 < 4,64; 5,50 < 6,47; 5,50 < 6,40; 7,00 < 8,28). Ez garantálja, hogy a volumen nem esik. Sorrend: először 2 hét tiszta Max Conversion Value tROAS nélkül (betanulás), UTÁNA rá a tROAS. Ha a tROAS azonnal rákerül, a PMax lefagy.

Feed-korlát: ezekből a kampányokból **kizárjuk** a `gep_premium` és `gep_volumen` custom label-t.

---

## 3. Második láb: NAGY ÉRTÉKŰ LÁB (változatlan, de az SC megerősítette)

**Termék-osztályok (2026 H1 GA4 item-adat):**

| Osztály | Mi tartozik ide | Bevétel | Db | Ft/db | Stratégia |
|---|---|---:|---:|---:|---|
| **G1 - Skálázható gép** | Szállodai/irodai porszívók (Nilfisk VP300 HEPA Basic 60 960 Ft, VP930 PRO 193 798 Ft), Napelem tisztító (60 464 Ft) | 7,16M | ~105 | 50-200e | **Fő cél.** Az SC szerint mindkét mag organikusan is NŐ. |
| **G2 - Nagy tételes gép** | Gyalogkíséretű padlótisztítók (Eureka E61 4,29M, E46B 2,10M, E36B 1,20M), Nilfisk SB Station 1,75M | 10,11M | 5 | 1,2-4,3M | Cél +1-2 db/hó, ajánlatkérés-vezérelt. |
| **G3 - Ismétlődő fogyó** | Gépi tisztítószerek (Kleen Purgatis BLUE KLEEN 25 900 Ft) | 2,81M | 121 | 15-30e | LTV-motor. |

**Feed-szegmentáció - Merchant Center `custom_label_0`:**
`gep_premium` (>= 300 000 Ft) | `gep_volumen` (50 000-299 999 Ft, `Takarítógépek/*`) | `szer_profi` (`Tisztítószer/*`, >= 15 000 Ft) | `kiegeszito` (minden más < 50 000 Ft)

**Kampányok:**

| Kampány | Státusz ma | v5 napi büdzsé | Licit | Feed / célzás |
|---|---|---:|---|---|
| PMax Ipari porszívók és padlóápoló gépek | ENABLED, de csak 1 450 Ft/nap költ | **10 000 -> 15 000** | tROAS **1800% -> 900% -> 700%** | csak `gep_premium` + `gep_volumen` |
| S - Szállodai porszívók | PAUSED | **3 000** | Max Conv Value tROAS **600%** | exact + phrase: nilfisk vp300, szállodai porszívó, irodai porszívó, profi porszívó |
| S - Márkák - Viper, Nilfisk, Eureka | PAUSED | **6 000** | Max Conv Value tROAS **600%** | márka + géptípus |
| S - Padlósúroló gépek | PAUSED | **4 000** | Max Conv Value tROAS **800%** | padlósúroló gép, padlótisztító gép, eureka e46, eureka e61 |
| **Brand Search (ÚJ)** | - | **2 000** | Target Impression Share 90% | takarítógéppartner + variánsok |
| **PMax `szer_profi` (ÚJ)** | - | **2 000** | tROAS **800%** | csak `szer_profi` |

**Kannibalizáció-gát:** 1) a volumen-PMax-okból kizárjuk a `gep_*` címkéket; 2) a gép-Search exact és phrase match-en fut, ami a licit-hierarchiában veri a PMax-ot azonos keresésre; 3) fiók-szintű márka-negatív lista a volumen-PMax-okra; 4) a gép-Search kampányokba negatívként: porzsák, szűrő, alkatrész, fej, tartozék, cső.

**Gép-landing és a mérési vakfolt:** két B2B landing (`/szallodai-irodai-porszivok`, `/padlosurolo-gepek`) "Kérjen ajánlatot" űrlappal, külön `generate_lead` key event becsült értékkel (76 000 x 0,3 zárási arány = **22 800 Ft**). Ezzel a nagy értékű láb akkor is kap licit-jelet, ha a vásárlás offline zárul.

**FONTOS v5-változás:** ezt a két landinget **SEO-first kell megépíteni**, nem PPC-only landingként (lásd 4.5). Ugyanaz az eszköz szolgálja ki a PPC-t és az organikus lefedettség-visszaszerzést. Egyszer épül, kétszer fizet.

---

## 4. HARMADIK LÁB: ORGANIKUS (ÚJ v5-ben)

### A diagnózis egy mondatban
**Nem rangsort vesztettünk, hanem kattintást.** A pozíció 2,5 helyet JAVULT (10,0 -> 7,5), az impresszió gyakorlatilag változatlan (-6%), de a CTR 3,11%-ról 2,42%-ra esett, a törés 2026 W18-ban (kb. április 27 - május 3). Ez AI Overview / SGE-hatás. **Ezért rangsor-javító SEO-projektnek nincs értelme.** Emellett van néhány oldal, ahol valódi lefedettség- vagy rangsorvesztés is történt - azok külön kezelendők.

### S1. CTR-visszaszerzés az AI Overview által érintett oldalakon

Érintett: azok az oldalak, ahol az impresszió és a pozíció tartja magát vagy javult, de a klikk esett.

| Oldal | Klikk 2025 -> 2026 | Impresszió | Pozíció | Akció |
|---|---:|---:|---:|---|
| `/spg/.../5-fontos-tudnivalo-a-HEPA-szuros-porszivorol` | 1 079 -> 483 (**-55%**) | 15 813 -> 14 372 (-9%) | 5,8 -> 5,2 | Title és meta újraírás kattintás-kikényszerítésre; a cikk elejére olyan elem, amit az AI Overview nem ad: **aktuális HEPA-porszívó ártáblázat + készlet + összehasonlító táblázat**; FAQ strukturált adat |
| `/spg/.../Nedves-porszivo-vs-karpittisztito` | 322 -> 196 | 7 239 -> 9 684 (**+34%**) | 11,1 -> 7,9 | Ugyanez: az impresszió nőtt, a klikk esett. Döntési táblázat + termékajánló blokk |
| `/spg/.../Szonyegtisztito-gep-otthonra` | 251 -> 163 | 11 915 -> 14 347 (+20%) | 23,1 -> 11,1 | Ugyanez |
| `/spg/.../5-1-legfontosabb-szempont-szaraz-nedves-porszivo` | 193 -> 56 | 4 740 -> 2 640 | 25,5 -> 11,3 | Ugyanez |

Konkrét recept mind a négyre, ebben a sorrendben:
1. **Title átírás** számmal és konkrétummal (ár, év, darabszám), mert az AI Overview alatt csak a kattintásra ingerlő cím működik.
2. **Meta description** olyan információígérettel, amit az AI Overview nem tud teljesíteni: aktuális ár, készlet, szerviz, garancia.
3. **FAQPage és HowTo strukturált adat** a cikkekre.
4. **Interaktív vagy adat-blokk a cikk tetejére**: összehasonlító táblázat, ártáblázat, "melyiket válaszd" döntési fa. Ez a fő fegyver: az AI Overview a szöveges választ elviszi, a strukturált döntéstámogatást nem.

Mérés: 4 hét után ugyanezen oldalak CTR-je az SC-ből (`landingPagePlusQueryString` + `organicGoogleSearchClickThroughRate`).

### S2. Lefedettség-visszaszerzés (ez a valódi SEO-feladat)

Itt NEM CTR a baj, hanem eltűnt az impresszió. Ez valódi láthatóság-vesztés.

| Oldal | Klikk | Impresszió | Pozíció | Diagnózis és akció |
|---|---:|---:|---:|---|
| **`/ipari-takaritogepek`** | 627 -> 238 (**-62%**) | 32 173 -> 17 708 (**-45%**) | 7,7 -> 7,2 | **PRIORITÁS 1.** A gépkategória organikus belépője, közvetlenül összefügg a gépbevétel-eséssel. A pozíció jó, csak kevesebb lekérdezésre jelenik meg. Akció: kategóriaoldal tartalmi bővítése (géptípusonkénti alkategória-szövegek, gyakori kérdések, szűrők indexelhetővé tétele), belső linkelés a blogból és a termékoldalakról, alkategória-landingek (`/szallodai-irodai-porszivok`, `/padlosurolo-gepek`) létrehozása. |
| `/Parkside_porszivo_tartozek_alkatresz` | 951 -> 768 (-19%) | 31 271 -> 14 292 (**-54%**) | 8,4 -> 6,8 | Impresszió felezés jobb pozíció mellett. Modell-lista és kompatibilitási táblázat bővítése, hogy több long-tail lekérdezésre jelenjen meg. |
| `/ipari-porszivo-alkatresz-tartozek` | 138 -> 26 | 5 252 -> 1 330 | 12,7 -> **17,1** | **Valódi rangsorvesztés** (az egyetlen ilyen a top oldalak közt). Tartalom-frissítés, belső link, kompatibilitási adatok. |
| `/Papir-porzsak-Karcher-WD-2` | 104 -> 14 | 8 500 -> 2 936 | 8,0 -> 9,2 | Lefedettség-vesztés. Ellenőrizni, hogy nem kannibalizálja-e a WD-3-as oldal. |

### S3. Technikai SEO (gyors, olcsó, egyszeri)

1. **URL-migrációs vérzés.** `/Magasnyomasu-tomlo-10m-Karcher-K2-K3-K4-K5-K6-K7-H` 122 -> 14 klikk, miközben a `-H` nélküli változat 9 -> 69. Hasonlóan `/Karcher_K2-K3-K4-K5-K6-K7_tartozek_alkatresz` 0 -> 69. Az új URL-ek nem vették át a régiek teljes erejét, nettó kb. **-48 klikk**. Akció: 301 redirect és kanonikus tag ellenőrzése minden érintett párra, plusz a régi URL-ekre mutató belső linkek frissítése.
2. **Delistelt vagy készlethiányos termékoldalak.** `/Soteco-Lava-Szonyegtisztito-Karpittisztito-gep`: impresszió -64% (7 938 -> 2 891) MIKÖZBEN a pozíció 12,9-ről 6,9-re javult. Ez a mintázat termék-kivezetésre vagy tartós készlethiányra utal. Ugyanez `/Habosito-szar-Parkside-mosohoz` (208 -> 32 klikk). Akció: ha a termék kifutott, 301 az utódra vagy a kategóriára; ha csak készlethiány, maradjon indexelve elérhetőségi dátummal.

### S4. Organic Shopping / ingyenes Merchant Center listázás visszaállítása

**2026 februártól NULLA.** Előtte 0,6M Ft/félév bevétel, teljesen ingyen. 2026 januárban még 7 session, azóta semmi.

Akció, sorrendben:
1. Merchant Center -> Growth -> Manage programs: a **Free listings** program státusza (aktív? felfüggesztve? nem elfogadott?).
2. Fiók-szintű felfüggesztés vagy policy-figyelmeztetés ellenőrzése.
3. Feed diagnosztika: hány termék jóváhagyott a free listings programban vs a Shopping ads programban. Gyakori ok, hogy a shipping vagy a return policy hiánya csak a free listings programot blokkolja.
4. Ha strukturált adat hiányzik a termékoldalakon (`Product` schema `price`, `availability`), pótolni.

**Ez a legjobb megtérülésű SEO-feladat: egyszeri, néhány órás, és ingyenes forgalmat hoz vissza.**

### S5. Tartalmi klaszter skálázása a nagy értékű szegmensre

Ami MŰKÖDIK, azt kell megismételni:
- `/spg/.../Napelem-tisztito-szett-ha-nem-eleg-az-eso`: **3 -> 446 klikk**, impresszió 56 -> 11 037. És a napelem-tisztító termék 60 464 Ft/db, 20 db/félév.
- `/spg/.../5-1-tevhit-magasnyomasu-moso`: 9 -> 104 klikk.
- `/spg/.../Legnagyobb-szivoteljesitmeny-porszivo`: 41 -> 109 klikk.
- **`/Nilfisk-VP300-HEPA-Basic-EU-szallodai-irodai-porszivo`: 19 -> 69 klikk, pozíció 9,0 -> 6,5.**

Akció: ugyanezt a mintát (problémavezérelt, döntéstámogató cikk + erős belső link a termékre) ráhúzni a **G1 és G2 szegmensre**. Konkrét cikk-témák:
1. "Szállodai porszívó választás: mit bír egy profi gép, amit a háztartási nem" -> `/Nilfisk-VP300...`
2. "Irodai porszívó zajszint: mennyi a még elfogadható dB nyitvatartási időben" -> VP300 / VP930
3. "Padlósúroló gép vagy felmosás: mikor térül meg a gép" -> `/padlosurolo-gepek`
4. "Akkus vagy hálózati padlótisztító gép" -> Eureka E46B / E36B
5. "Önkiszolgáló porszívó autómosóba: megtérülési számítás" -> Nilfisk SB Station

Ez a láb közvetlenül a nagy értékű PPC-lábat táplálja: ugyanaz a szegmens, ugyanaz a landing, csak a másik csatornán.

**Kapacitás-megjegyzés:** a tartalomgyártás nem PPC-feladat. Ha Zsolt jóváhagyja, a cikkeket érdemes a **copy** ágensnek delegálni, a briefet és a kulcsszó-célt én adom.

### S6. Amit NEM csinálunk

- **Nincs klasszikus rangsor-javító SEO-projekt.** A pozíció már 2,5 helyet javult, nincs mit javítani rajta.
- **Nincs linképítés.** A probléma nem tekintély-hiány.
- **Nincs teljes körű technikai SEO-audit.** A technikai rész két konkrét pontra szűkül (S3).

---

## 5. Veszteség-stop (változatlan)

| Akció | Megtakarítás / hó | Indok |
|---|---:|---|
| **Demand Gen LEÁLLÍTÁS** | **59 285** | 11 195 kattintás 5,3 Ft-os CPC-vel, **0 konverzió** 30 nap alatt. A GA4 7 hónap alatt csak 3 389 sessiont lát ehhez a kampányhoz. |
| PMax Szőnyeg: 5 000 -> 2 500/nap, tROAS 400% | 73 500 | 3,30x ROAS, 304 Ft-os CPC (a fiók legdrágább kattintása). |
| PMax Autómosó: 1 500 -> 800/nap | 21 000 | 2,74x ROAS, 3 konverzió 30 nap alatt. |
| PMax Kiehl beolvasztása a `szer_profi` kampányba | 0 (átcsoportosítás) | 3 944 Ft költés, 0 konverzió, a tROAS 1280% megfojtja. |
| **Összesen** | **~154 000** | |

---

## 6. Büdzsé (változatlan)

| Kampány | Ma (napi) | v5 (napi) |
|---|---:|---:|
| PMax Porszívók és kiegészítők | 13 000 | 13 000 |
| PMax Porzsákok | 10 000 | 10 000 |
| PMax Kiemelt termékek | 8 000 | 8 000 |
| DSA | 7 000 | 7 000 |
| **PMax Ipari gépek** | 7 000 (valósan 1 450) | **15 000** |
| **S - Márkák** | 0 (paused) | **6 000** |
| **S - Padlósúroló gépek** | 0 (paused) | **4 000** |
| **S - Szállodai porszívók** | 0 (paused) | **3 000** |
| **Brand Search (új)** | 0 | **2 000** |
| **PMax szer_profi (új)** | 0 | **2 000** |
| PMax Szőnyeg | 5 000 | 2 500 |
| PMax Autómosó | 1 500 | 800 |
| PMax Kiehl | 2 000 | 0 (beolvad) |
| **Demand Gen** | 2 000 | **0 (STOP)** |
| **Valós költés** | ~42 500 | **~63 000** |

Havi: 1 276 000 -> kb. **1 890 000 Ft**, belefér a 2,0M-os 10x-keretbe. A növekmény (+614 000 Ft/hó) 100%-ban a nagy értékű lábon.

**Az organikus lábnak nincs médiaköltése**, csak munkaidő-igénye (becslés: S4 néhány óra, S3 fél nap, S1+S2 kb. 3-4 nap, S5 folyamatos 1-2 cikk/hét).

---

## 7. Végrehajtási sorrend

| Hét | PPC-láb | Organikus láb |
|---|---|---|
| **0. hét** | Demand Gen STOP; Merchant Center `custom_label_0`; `gep_*` kizárás a volumen-PMax-okból | **S4: free listings diagnózis és javítás** (ugyanaz a Merchant Center munkamenet, egyszerre elvégezhető) |
| **1. hét** | PMax Ipari tROAS 900% + 10 000/nap; 3 gép-Search újraindítás; Szőnyeg és Autómosó vágás | **S3: redirect és kanonikus javítás, delistelt oldalak rendezése** |
| **2. hét** | Volumen-PMax-ok Max Conv Value-ra (tROAS nélkül); Brand Search + márka-negatívok; gép-landingek élesítése **SEO-first** | **S2 indul: `/ipari-takaritogepek` bővítés + a két alkategória-landing** (közös munka a PPC gép-landinggel) |
| **3. hét** | `generate_lead` key event értékkel; `szer_profi` PMax; Customer Match | **S1: title/meta/strukturált adat a 4 érintett cikken** |
| **4. hét** | Első kiértékelés Unas-bevétel alapon; volumen tROAS ráhúzás (450/550/550/700%) | S1 CTR-mérés az SC-ből; **S5 első 2 cikk** (brief tőlem, írás a copy ágenstől) |
| **6. hét** | PMax Ipari tROAS 700% + 15 000/nap, ha tartja | S2 hatásmérés (impresszió az `/ipari-takaritogepek`-en); S5 folytatás |
| **Határidő** | **Augusztus 15.** Minden PPC-elem él, hogy a szeptember-október (2025-ben 14,2M és 16,9M) betanult rendszerrel fusson. | S4 és S3 szintén augusztus 15-ig, S1/S2/S5 folyamatos |

---

## 8. Mérési feladatok

| # | Feladat | Miért | Sürgősség |
|---|---|---|---|
| M1 | **Merchant Center free listings** (= S4) | Organic Shopping 2026 februártól NULLA | 48 óra |
| M2 | **2026-07-21 anomália ellenőrzése az Unasban** | 5 151 976 Ft bevétel 21 rendelésből, a 20 napos átlag 290 000 Ft/nap, a sessionök 84%-a "(not set)" | 48 óra |
| M3 | **Google Ads konverziós műveletek auditja** | 30 nap alatt az Ads 11,48M értéket állít, a teljes bevétel ~10,8M | 1 hét |
| M4 | **Riport-alap átállítása Unas-bevételre** | A 10x cél csak számla-szinten értelmes | 1 hét |
| M5 | **`generate_lead` key event értékkel** | Az offline gépeladásra ma nincs licit-jel | 3. hét |
| M6 | **SC CTR-monitor** a 4 érintett cikkre és az `/ipari-takaritogepek`-re | Az S1 és S2 hatásának mérése, GA4-ből lekérdezhető | 4. hét, majd havonta |
| M7 | AI Assistant / Perplexity csatorna figyelése | 2026 júniusban jelent meg (43 session) | Megfigyelés |

**M6 megjegyzés:** a Search Console kulcsszó-szintű adata NEM jön le a GA4 Data API-ból (a query-dimenzió nincs a sémában). Oldal-szinten viszont minden mérhető, ami az S1-S2 kiértékeléséhez elég. Ha később mégis kell kulcsszó-szint, a Search Console API bekötése kell - a recept a GA4-elemzés 8.6 szekciójában van, és credential-kezelést érint, ezért Nova koordinálja Zsolttal.

---

## 9. Meta (változatlan)

AOV 22 832 -> 11 700 Ft (-49%), bevétel -57%, rendelésszám -17%. Ugyanaz a mix-betegség.

1. Katalógusban külön product set a `gep_volumen` és `gep_premium` címkékre, dedikált Advantage+ kampány **value-optimalizálással**.
2. A jelenlegi fő kampány (10 091 session, 104 rendelés, 1,25M Ft, 12k AOV) a kiegészítő-motor, marad.
3. Gép-fókuszú retargeting a gép-landing látogatóira és a Customer Match gépvásárló-listára.
4. CAPI ellenőrzés a `generate_lead` eseményre.

---

## 10. KPI-k

| Mutató | Ma | 4 hét | 12 hét |
|---|---:|---:|---:|
| Havi bevétel (Unas) | 16,6M (jún) / ~8,5M (júl ütem) | 18M | **20M+** |
| **Blended ROAS (Unas / teljes médiaköltés)** | ~12x (jún), ~6x (júl) | 10x | **10x** |
| Blended AOV | 24 202 Ft (jún), 14 329 Ft (júl) | 22 000 Ft | **25 000 Ft** |
| Gép-darabszám (`Takarítógépek/*`) | ~17 db/hó | 22 db/hó | **30 db/hó** |
| Nagy értékű láb részesedése a médiaköltésből | 3,4% | 25% | 30% |
| Demand Gen költés | 59 285 Ft/hó | **0** | **0** |
| Ajánlatkérés (`generate_lead`) | nincs mérve | mérve | 15+/hó |
| **Organic klikk / hó** | 2 215 (jún) | 2 400 | **2 800** |
| **Organic CTR** | 2,14% (jún) | 2,3% | **2,6%** |
| **`/ipari-takaritogepek` impresszió** | ~3 800/hó | 4 500/hó | **6 500/hó** |
| **Organic Shopping session** | 0 | >0 | 20+/hó |

---

## 11. Amihez Zsolt jóváhagyása kell

**Pénzt költő (PPC):**
1. Demand Gen leállítása (-59 285 Ft/hó).
2. PMax Ipari tROAS 1800% -> 900%, büdzsé 7 000 -> 10 000/nap.
3. Három PAUSED gép-Search kampány újraindítása (+13 000 Ft/nap).
4. Brand Search és `szer_profi` PMax indítás (+4 000 Ft/nap).
5. Szőnyeg és Autómosó büdzsé-vágás.
6. A négy nagy kampány licitváltása Max Conversions -> Max Conversion Value -> tROAS.
7. Összesített napi költés: ~42 500 -> ~63 000 Ft.

**Nem pénzt költő, de erőforrás-igényes (organikus):**
8. S4 free listings javítás (néhány óra, Merchant Center hozzáférés kell).
9. S3 redirect és kanonikus javítás (fél nap, webshop-fejlesztői hozzáférés kell).
10. S1 és S2 tartalmi munka (3-4 nap).
11. S5 tartalmi klaszter, 1-2 cikk/hét - **javaslom a copy ágensnek delegálni**, a briefet és a kulcsszó-célt én adom.
12. Gép-landingek fejlesztése (`/szallodai-irodai-porszivok`, `/padlosurolo-gepek`) - webshop-fejlesztői feladat, SEO-first felépítéssel.
