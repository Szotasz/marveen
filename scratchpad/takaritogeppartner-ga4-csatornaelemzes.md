# Takarítógéppartner - GA4 csatorna-elemzés

Forrás: GA4 properties/374081626 (TakarítógépPartner.hu - GA4, HUF, Europe/Budapest)
Időszak: 2025-01-01 - 2026-07-21, havi bontás, `sessionDefaultChannelGroup` (last-click)
Kiegészítés: Google Ads 5385457642 kampány-szintű adat (utolsó 30 nap: 2026-06-22 - 2026-07-21)
Készült: 2026-07-22. Read-only, semmit nem módosítottam.

---

## 1. A LÉNYEG egy mondatban

**Nem forgalmi és nem konverziós probléma van, hanem kosárérték-probléma.** A rendelésszám 2026 H1-ben gyakorlatilag azonos a tavalyival (+1%), a konverziós ráta JAVULT (+21%), de az átlagos kosárérték 26%-kal esett, ezért a bevétel -25%. A kosárérték-esés fő oka egy strukturális döntés: 2025-ben a fiókot Search + Shopping struktúráról Performance Max-ra állították át, darabszám-alapú (Max Conversions) liciten, ami a mixet az olcsó kiegészítők felé tolta és közben kikapcsolta a nagy értékű gépek dedikált keresési lábát.

---

## 2. Össz-számok, 2025 H1 vs 2026 H1 (jan-jún)

| Mutató | 2025 H1 | 2026 H1 | Változás |
|---|---:|---:|---:|
| Session | 96 285 | 80 497 | **-16%** |
| Rendelés | 4 474 | 4 517 | **+1%** |
| Konverziós ráta | 4,65% | 5,61% | **+21%** |
| Bevétel | 112,69M Ft | 84,34M Ft | **-25%** |
| Átlagos kosárérték (AOV) | 25 188 Ft | 18 671 Ft | **-26%** |

A forgalom csökkent, a konverzió javult, a rendelésszám tartja magát. A teljes bevételkiesés az AOV-ból jön.

---

## 3. MELYIK csatorna esett - bevétel szerint

| Csatorna | 2025 H1 | 2026 H1 | Δ Ft | Δ % | Rend. 2025 | Rend. 2026 | AOV 2025 | AOV 2026 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Organic Search** | 30,85M | 8,00M | **-22,85M** | **-74%** | 1 368 | 347 | 22 551 | 23 058 |
| **Paid Search (DSA)** | 19,91M | 9,17M | **-10,74M** | **-54%** | 846 | 369 | 23 534 | 24 850 |
| **Direct** | 32,64M | 26,11M | **-6,53M** | **-20%** | 730 | 748 | 44 715 | **34 905** |
| Unassigned | 3,12M | 1,22M | -1,90M | -61% | | | | |
| **Paid Social (Meta)** | 4,00M | 1,71M | -2,29M | -57% | 175 | 146 | 22 832 | **11 700** |
| Organic Social | 1,20M | 0,34M | -0,86M | -71% | | | | |
| Email | 1,79M | 1,12M | -0,67M | -38% | 35 | 22 | | |
| Organic Shopping | 0,60M | **0,00M** | -0,60M | **-100%** | | | | |
| Referral | 1,40M | 1,72M | +0,32M | +23% | | | | |
| **Cross-network (PMax)** | 17,18M | **34,88M** | **+17,70M** | **+103%** | 1 084 | 2 731 | 15 849 | **12 770** |
| **Összesen** | **112,69M** | **84,34M** | **-28,35M** | **-25%** | 4 474 | 4 517 | 25 188 | 18 671 |

Session-oldalon: Organic Search -36% (25 585 -> 16 458), Paid Search **-74%** (26 649 -> 6 871), Cross-network **+116%** (16 423 -> 35 498), Direct -16%, Paid Social -8%.

---

## 4. MIKOR - az idővonal

| Időpont | Esemény |
|---|---|
| **2025 aug** | Organic Search rendelésszám szakadás: 175 -> 70 db/hó, és soha nem tért vissza. Session csak -3% ugyanekkor. Havi bevétel mélypont: 9,66M. |
| **2025 okt-nov** | Cross-network (PMax) berobbanás: 2 908 -> 7 157 -> 7 395 session/hó. Ezzel párhuzamosan Paid Search 2 701 -> 1 294 -> 1 291 session. A Search->PMax átállás itt fejeződik be. |
| **2026 feb-től** | Organic Shopping (ingyenes Merchant Center listázás) NULLA. Előtte havi 14-30 session, 0,6M Ft/félév. |
| **2026 ápr** | Bevétel-mélypont: 9,67M (Direct 2,45M, a legalacsonyabb 19 hónapban). |
| **2026 jún** | Legjobb 2026-os hónap: 16,60M. Ebből Direct 8,28M / 121 rendelés = 68 445 Ft AOV. Nagy gépes hónap. |
| **2026 jún** | Megjelenik az **AI Assistant** csatorna (43 session) + Perplexity referral. Új, még kicsi trend. |
| **2026 júl 1-20** | Forgalom stabil (409 session/nap vs júniusi 398), rendelés -11%, de **AOV -41%** (14 329 vs 24 202 Ft). Direct 1,07M / 62 rendelés = 17 188 Ft AOV. **A gépeladás állt le, nem a forgalom.** Napi bevétel 290k -> 31 napra vetítve ~9,0M, ami egybevág a 8,3M-os Unas-számmal. |

---

## 5. MIÉRT - hipotézisek, bizonyítottsággal

### H1. Az organic BEVÉTEL-esése döntően átcímkézés, a SESSION-esése viszont valódi. Valószínűség: BIZONYÍTOTT (Search Console adattal, lásd 8. szekció)

**FIGYELEM: ezt a hipotézist a Search Console adat 2026-07-22-én pontosította. Az eredeti verzió a session-esés 55-65%-át tulajdonította PMax-interceptálásnak - ez TÚLBECSLÉS volt. A helyes kép két külön mechanizmus:**

**(a) A session-esés (-36%) VALÓDI Google-klikkvesztés.** A Search Console szerint az organikus klikk -27% (2025 vs 2026 márc-júl). Ez lefedi a session-esés kb. háromnegyedét, tehát a forgalomvesztés nem attribúciós illúzió. DE az ok nem az, amire számítani lehetne: az **impresszió gyakorlatilag változatlan** (-6%) és az **átlagos pozíció JAVULT** (10,0 -> 7,5). Kizárólag a **CTR esett**: 3,11% -> 2,42%, heti bontásban 2,9% -> 2,0%. Ez AI Overview / SERP-feature hatás, nem rangsorvesztés.

**(b) A bevétel-esés (-74%) döntően ÁTCÍMKÉZÉS.** Bizonyíték:
- Az organic **AOV változatlan** (22 551 -> 23 058 Ft). Ha valódi keresletvesztés lenne, a kosárérték is mozogna.
- Ha a bevétel csak a forgalommal esett volna (-27%), 22,5M Ft-nak kellene lennie. Ténylegesen 8,00M. Vagyis a 22,85M Ft-os veszteségből **kb. 14,5M (63%) NEM magyarázható forgalomvesztéssel.**
- A Cross-network rendelésszám **+1 647**-tel nőtt, ami majdnem pontosan fedezi az Organic (-1 021) + Paid Search (-477) + Paid Social (-29) veszteséget = -1 527. Az össz-rendelésszám +1%.
- A PMax last-click alapon elszívja a márkás és a generikus keresést, mert Shopping + Search felületen is licitál, brand-kizárás nélkül.

**Következmény a beavatkozásra:** két külön feladat, nem egy. A forgalomvesztés SEO/tartalom-feladat (CTR-visszaszerzés, lásd 8.4), a bevétel-átcímkézés PPC-struktúra-feladat (brand-kizárás, Brand Search, lásd v4 terv).

### H2. A Paid Search -54% SZÁNDÉKOS strukturális váltás következménye. Valószínűség: BIZONYÍTOTT
- Paid Search session -19 778, Cross-network +19 075. Ez 1:1 csere.
- A Google Ads fiókban ma **egyetlen** aktív Search kampány van: a DSA. Minden más Search és Shopping kampány PAUSED, köztük olyanok, amik pont a nagy értékű gépeket vitték:
  - `S - Padlósúroló gépek`, `S - Márkák - Viper, Nilfisk, Eureka`, `S - Szállodai porszívók`, `S - Padló seprő gépek`, `Autómosó - SEARCH`
  - `Shopping - Takarítógépek` (tROAS 4100%!), `Shopping - Drágább ipari porszívók` (tROAS 500%), `Shopping - Magasnyomású mosók`
- **Az átállással kikapcsolták a gépek dedikált keresési lábát.** Ez a bevétel-esés egyik legfontosabb közvetlen oka.

### H3. A PMax darabszám-alapú liciten fut, ezért olcsó kiegészítőre optimalizál. Valószínűség: BIZONYÍTOTT
Google Ads, utolsó 30 nap, ENABLED kampányok:

| Kampány | Típus | Licit | Költés | Konv | Érték | ROAS | CPC |
|---|---|---|---:|---:|---:|---:|---:|
| PMax 2025 - Porszívók és kiegészítők | PMAX | **MAX_CONVERSIONS** | 386 918 | 154,1 | 1 797 311 | 4,64x | 147 Ft |
| PMax 2025 - Kiemelt termékek | PMAX | **MAX_CONVERSIONS** | 235 608 | 151,8 | 1 509 081 | 6,40x | 208 Ft |
| DSA | SEARCH | **MAX_CONVERSIONS** | 183 488 | 82,2 | 1 519 134 | 8,28x | 152 Ft |
| PMax 2025 - Porzsákok | PMAX | **MAX_CONVERSIONS** | 170 310 | 109,9 | 1 101 360 | 6,47x | 164 Ft |
| PMax 2025 - Szőnyeg/kárpit | PMAX | MaxConvValue (nincs tROAS) | 147 169 | 17,3 | 484 939 | **3,30x** | **304 Ft** |
| Demand Gen | DEMAND_GEN | Target CPC | 59 285 | **0** | **0** | **0x** | **5,3 Ft** |
| PMax 2025 - Autómosó | PMAX | MaxConvValue | 45 804 | 3,0 | 125 319 | **2,74x** | 187 Ft |
| PMax 2025 - Ipari gépek | PMAX | MaxConvValue **tROAS 1800%** | 43 487 | 6,0 | 4 938 497 | 113,6x | 177 Ft |
| PMax 2025 - Kiehl | PMAX | MaxConvValue **tROAS 1280%** | 3 944 | 0 | 0 | 0x | 208 Ft |
| **Összesen** | | | **1 276 013** | | **11 475 641** | **9,0x** | |

A három legnagyobb költő PMax **Max Conversions** liciten van, tROAS nélkül. Ez matematikailag a legolcsóbb konverziót keresi, azaz a 3-9 ezer forintos porzsákot és porszívófejet. A Cross-network AOV 12 770 Ft, a legalacsonyabb az összes csatorna közül, és a rendelések **60%-át** adja (2025 H1-ben még csak 24%-át). **Ez a blended AOV -26%-ának fő motorja.**

### H4. A nagy értékű láb LÉTEZIK, de meg van fojtva. Valószínűség: BIZONYÍTOTT
- `PMax 2025 - Ipari porszívók és padlóápoló gépek`: tROAS cél **1800%**, napi büdzsé 7 000 Ft, de csak **~1 450 Ft/nap** költ (a keret 21%-a). Nem büdzsé-korlátos, hanem tROAS-korlátos. Mégis ez adja a fiók konverziós értékének **43%-át** a költés **3,4%-ából**.
- `PMax 2025 - Kiemelt Kiehl termékek`: tROAS 1280%, 30 nap alatt 3 944 Ft költés, 0 konverzió. Gyakorlatilag halott.

### H5. A Demand Gen pénzt éget és rontja az adatot. Valószínűség: BIZONYÍTOTT
59 285 Ft / 30 nap, **11 195 kattintás 5,3 Ft-os CPC-vel, 0 konverzió**. A GA4 ugyanehhez a kampányhoz 7 hónap alatt összesen 3 389 sessiont lát. A kattintások túlnyomó része el sem jut a webshopig, ez érvénytelen / bot forgalom. Nemcsak 59k/hó veszteség, hanem szennyezi a smart bidding tanulási jelét is.

### H6. A Meta ugyanabban a betegségben szenved. Valószínűség: MAGAS
Paid Social AOV 22 832 -> **11 700 Ft** (-49%), bevétel -57%, rendelés csak -17%. A katalógus/DPA az olcsó kiegészítőkre optimalizál, ugyanaz a mix-torzulás mint a PMax-nál.

### H7. A Direct AOV-esése VALÓDI üzleti jel, nem attribúció. Valószínűség: MAGAS
Direct: rendelésszám 730 -> 748 (+2%), AOV 44 715 -> 34 905 Ft (**-22%**). A Direct a gépcsatorna (visszatérő B2B, ajánlatkérés utáni vásárlás). Ugyanannyi rendelésből kevesebb vagy olcsóbb gépet adnak el. Ezt nem magyarázza sem a PMax, sem az attribúció.

### H8. A Google Ads konverziós érték felül van súlyozva. Valószínűség: MAGAS - MÉRÉSI KÖVETKEZMÉNYE VAN
30 nap alatt a Google Ads **11 475 641 Ft** konverziós értéket állít, miközben a GA4 szerint a **teljes webshop** bevétele ugyanerre az időszakra kb. 10,8M Ft. A Google Ads egyedül a teljes bevétel több mint 100%-át tulajdonítja magának. Ennek zöme a PMax view-through + data-driven attribúció. Az Ipari kampány 113x ROAS-a szinte biztosan nagyrészt olyan gépes rendelés, amit a GA4 Directnek vagy organiknak lát.

**Következmény: a 10x ROAS célt CSAK számla-szinten (Unas bevétel / teljes médiaköltés) szabad mérni. A Google Ads felületén mért ROAS önámítás.**

### H9. Az Organic Shopping eltűnése konkrét, javítható hiba. Valószínűség: KÖZEPES-MAGAS
2026 februártól nulla ingyenes Merchant Center listázás. Ez ingyen forgalom volt (0,6M Ft/félév). Merchant Center feed / free listings beállítás ellenőrzést igényel.

### H10. A 2026-07-21-i adat anomália. Valószínűség: MÉRÉSI ARTEFAKT
Aznap 449 sessionből **378 "Unassigned / (not set)"**, és **5 151 976 Ft bevétel 21 rendelésből**, miközben a július 1-20 napi átlag 290 000 Ft. Két magyarázat: (a) GA4 feldolgozási késés az utolsó napon, forrás még nincs hozzárendelve, vagy (b) valódi nagy B2B rendelés. A júliusi Unas-szám (8,3M) és a GA4 július 1-20 adata (290k/nap -> 9,0M/hó) egybevág, tehát a 7/21-i tétel valószínűleg torzítás. **48 óra múlva újra kell nézni és az Unasban ellenőrizni.**

---

## 6. Termék-oldali kép (2026 H1, GA4 item-adat)

Ez adja a "nagy értékű láb" alapját.

**Top kategóriák bevétel szerint:**

| Kategória | Bevétel | Db | Ft/db |
|---|---:|---:|---:|
| Takarítógépek / Padló súroló / Gyalogkíséretű padlótisztító | 8 355 890 | **4** | **2 088 973** |
| Alkatrész / Kärcher / WD 3 porszívó | 8 291 821 | 1 653 | 5 016 |
| **Takarítógépek / Porszívók / Szállodai irodai porszívók** | **5 954 948** | **78** | **76 345** |
| Alkatrész / Nilfisk / VP 300 HEPA | 4 443 981 | 515 | 8 629 |
| Alkatrész / Kombinált padlófejek | 3 825 295 | 610 | 6 271 |
| Tisztítószer / gépi padló- és felülettisztító | 2 811 780 | 121 | 23 238 |
| Alkatrész / Kärcher WD 2 | 2 539 876 | 782 | 3 248 |
| Takarítógépek / Önkiszolgáló porszívók | 1 750 000 | 1 | 1 750 000 |
| Takarítógépek / Napelem tisztító | 1 209 285 | 20 | 60 464 |

**Top SKU-k:**

| SKU | Bevétel | Db | Ft/db |
|---|---:|---:|---:|
| Eureka E61 önjáró gyalogkíséretű padlótisztító | 4 290 000 | 1 | 4 290 000 |
| **Nilfisk VP300 HEPA Basic szállodai irodai porszívó** | **4 023 360** | **66** | **60 960** |
| Papír porzsák (10db) Kärcher WD 3 | 3 197 040 | 616 | 5 190 |
| Szintetikus porzsák (10db) Nilfisk VP300 / Saltix | 2 599 220 | 338 | 7 690 |
| Eureka E46B akkumulátoros padlótisztító | 2 095 500 | 1 | 2 095 500 |
| Nilfisk SB Station önkiszolgáló porszívó | 1 750 000 | 1 | 1 750 000 |
| Kleen Purgatis BLUE KLEEN gépi padlótisztítószer 10L | 1 579 900 | 61 | 25 900 |
| Nilfisk VP930 PRO HEPA S2 prémium szállodai porszívó | 1 356 588 | 7 | 193 798 |
| Eureka E36 B ipari padlótisztító | 1 199 000 | 1 | 1 199 000 |
| Teleszkópos napelem tisztító kefe 10m | 1 119 300 | 7 | 159 900 |

**Ebből a legfontosabb következtetés:** a `Takarítógépek/*` kategóriák a bevétel kb. **20%-át** adják kb. **103 darabból**, míg a maradék 80% több ezer, 3-9 ezer forintos alkatrészből jön. A **Szállodai/irodai porszívók** a kulcs-szegmens, mert ott van EGYSZERRE magas darabár (76 345 Ft) ÉS skálázható volumen (78 db/félév, 13 db/hó). A többi gép nagy értékű, de egyedi tétel.

---

## 7. Mit NEM tudtam kihozni

- **Kulcsszó-szintű organic adat: NEM elérhető a GA4 Data API-ból.** A Search Console link él és az oldal-szintű adat lejön (lásd 8. szekció), de a query-dimenzió nincs a Data API sémájában. Tesztelve és elutasítva: `googleSearchQuery`, `searchConsoleQuery`, `organicGoogleSearchQuery`. A GA4 Search Console adatkészlete csak `landingPagePlusQueryString`, `countryId`, `deviceCategory` + dátum bontásban kérdezhető. Query-szinthez külön Search Console API hozzáférés kell, lásd 8.6.
- Az offline / telefonos gépeladás nincs mérve, ezért a Direct-en látszó AOV-esés csak részben értelmezhető. Erre a v4 terv `generate_lead` értékkel ellátott ajánlatkérő eseményt javasol.
- Meta költés-adat nincs ebben az elemzésben, csak a GA4-oldali Meta bevétel.

---

## 8. Search Console - organikus diagnózis (kiegészítés, 2026-07-22)

Forrás: GA4 Data API `organicGoogleSearch*` metrikák (a linkelt Search Console adatkészlet). Lefedettség: **2025-03-tól 2026-07-21-ig**, 17 hónap. 2025 január-február nincs benne, ezért az összevetés március-július alapon készült.

### 8.1 A fő megállapítás: nem rangsort vesztettünk, hanem kattintást

| Időszak (márc 1 - júl 21) | Klikk | Impresszió | CTR | Átlag pozíció |
|---|---:|---:|---:|---:|
| 2025 | ~16 314 | ~524 281 | 3,11% | ~10,0 |
| 2026 | 11 897 | 492 277 | **2,42%** | **~7,5** |
| Változás | **-27%** | **-6%** | **-22%** | **+2,5 hely, JAVULT** |

Az oldal **jobban rangsorol, mint valaha** (átlag pozíció 10,0-ról 7,5-re javult), az impresszió lényegében változatlan, mégis 27%-kal kevesebb kattintás jön. Ez kizárja a klasszikus SEO-magyarázatokat (algoritmus-büntetés, technikai hiba, tartalom-elavulás), mert azok mind rangsor- vagy impresszió-vesztéssel járnának.

### 8.2 Havi trend

| Hónap | Klikk | Impresszió | CTR | Pozíció |
|---|---:|---:|---:|---:|
| 2025-03 | 3 462 | 100 342 | 3,45% | 8,82 |
| 2025-04 | 3 818 | 116 420 | 3,28% | 9,79 |
| 2025-05 | 3 799 | 125 183 | 3,03% | 10,37 |
| 2025-06 | 3 116 | 110 123 | 2,83% | 10,84 |
| 2025-07 | 3 128 | 106 600 | 2,93% | 10,83 |
| 2025-08 | 3 413 | 117 900 | 2,89% | 10,31 |
| 2025-09 | 3 147 | 103 857 | 3,03% | 9,14 |
| 2025-10 | 2 794 | 101 215 | 2,76% | 8,54 |
| 2025-11 | 3 117 | 109 078 | 2,86% | 8,11 |
| 2025-12 | 2 497 | 94 401 | 2,65% | 8,83 |
| 2026-01 | 3 092 | 107 145 | 2,89% | 8,47 |
| 2026-02 | 2 991 | 102 339 | 2,92% | 7,92 |
| 2026-03 | 3 046 | 105 284 | 2,89% | 7,37 |
| 2026-04 | 2 688 | 103 854 | 2,59% | 7,46 |
| **2026-05** | **2 552** | **125 264** | **2,04%** | 7,39 |
| 2026-06 | 2 215 | 103 587 | 2,14% | 7,54 |
| 2026-07 (1-21) | 1 396 | 54 288 | 2,57% | 8,29 |

2026 májusban volt a **legmagasabb impresszió az egész idősorban (125 264)** és ezzel egyidejűleg a **legalacsonyabb CTR (2,04%)**. Több megjelenés, kevesebb kattintás.

### 8.3 A törés pontos időpontja: 2026 W18 (kb. április 27 - május 3)

Heti CTR: W6-W17 stabilan 2,58-3,10%. Aztán:
- **W18: 2,23%** (a törés)
- W19: 2,39% | W20: 2,08% | **W21: 1,77% (mélypont)** | W22: 1,93% | W23: 2,06% | W24: 2,18% | W25: 2,02% | W26: 2,21% | W27: 2,37% | W28: 2,31% | W29: 2,96%

Az átlagos pozíció a teljes időszakban 7,1-7,8 között maradt, tehát nem mozdult. Az impresszió W17-W23 között a legmagasabb volt (27-30 ezer/hét), miközben a klikk esett.

**Ez az AI Overview / SGE-kiterjesztés tankönyvi ujjlenyomata: több megjelenés, változatlan rangsor, összeomló átkattintás.** A W29-es 2,96%-os visszapattanás mellett az impresszió 20 000-re esett, tehát ez inkább összetétel-változás, mint gyógyulás.

### 8.4 Oldal-szintű diagnózis (top 120 landing page, márc 1 - júl 21)

**Legnagyobb klikkvesztők:**

| Landing page | Klikk 25->26 | Impresszió 25->26 | Pozíció 25->26 | Mi történt |
|---|---:|---:|---:|---|
| `/spg/.../5-fontos-tudnivalo-a-HEPA-szuros-porszivorol` | 1 079 -> 483 (**-55%**) | 15 813 -> 14 372 (-9%) | 5,8 -> **5,2** | **Tiszta AI Overview eset:** impresszió és pozíció jobb, a klikk fele elveszett. |
| `/ipari-takaritogepek` | 627 -> 238 (**-62%**) | 32 173 -> 17 708 (**-45%**) | 7,7 -> 7,2 | **NEM CTR-ügy: valódi lekérdezés-lefedettség vesztés.** Ez a gépkategória belépő oldala. |
| `/Parkside_porszivo_tartozek_alkatresz` | 951 -> 768 (-19%) | 31 271 -> 14 292 (**-54%**) | 8,4 -> 6,8 | Impresszió felezés jobb pozíció mellett. Lefedettség-vesztés. |
| `/Habosito-szar-Parkside-mosohoz-1L` | 208 -> 32 | 5 426 -> 1 642 | 4,7 -> 5,1 | Termékoldal kiesés (készlet? delistelés?). |
| `/Papir-porzsak-Karcher-WD-3` | 273 -> 99 | 11 136 -> 9 408 | 7,3 -> 8,2 | Enyhe pozícióromlás + CTR. |
| `/ipari-porszivo-alkatresz-tartozek` | 138 -> 26 | 5 252 -> 1 330 | 12,7 -> **17,1** | **Valódi rangsorvesztés.** |
| `/Papir-porzsak-Karcher-WD-2` | 104 -> 14 | 8 500 -> 2 936 | 8,0 -> 9,2 | Erős lefedettség-vesztés. |
| `/Soteco-Lava-Szonyegtisztito-Karpittisztito-gep` | 152 -> 59 | 7 938 -> 2 891 | 12,9 -> **6,9** | Pozíció sokat javult, impresszió mégis -64%. Gyanú: termék delistelve / készlethiány. |

**URL-migrációs veszteség (nem valódi SEO-vesztés, de nettó mínusz):**
`/Magasnyomasu-tomlo-10m-Karcher-K2-K3-K4-K5-K6-K7-H` 122 -> 14 klikk, miközben a `-H` nélküli változat 9 -> 69 klikk. Hasonlóan a `/Karcher_K2-K3-K4-K5-K6-K7_tartozek_alkatresz` 0 -> 69. Az új URL-ek nem vették át a régi teljes erejét, nettó kb. -48 klikk. **Redirect és kanonikus ellenőrzés kell.**

**Nyertesek - és ez megerősíti a v4 termékválasztást:**

| Landing page | Klikk 25->26 | Impresszió 25->26 | Pozíció |
|---|---:|---:|---:|
| `/spg/.../Napelem-tisztito-szett-ha-nem-eleg-az-eso` | 3 -> **446** | 56 -> 11 037 | 36,3 -> 7,5 |
| `/spg/.../5-1-tevhit-magasnyomasu-moso` | 9 -> 104 | 68 -> 2 627 | 8,2 -> 6,7 |
| `/spg/.../Legnagyobb-szivoteljesitmeny-porszivo` | 41 -> 109 | 1 129 -> 5 587 | 8,6 -> 6,5 |
| **`/Nilfisk-VP300-HEPA-Basic-EU-szallodai-irodai-porszivo`** | **19 -> 69** | 1 078 -> 3 978 | 9,0 -> **6,5** |
| `/spg/.../Porzsakos-vagy-porzsak-nelkuli-porszivo` | 137 -> 204 | 3 157 -> 4 170 | 22,4 -> 14,4 |

**A két legnagyobb organikus nyertes pontosan a v4 nagy értékű lábának két magja: a napelem-tisztító és a Nilfisk VP300 szállodai porszívó.** Az organikus oldal tehát már most támogatja azt a szegmenst, amire a PPC-tervet építettem. Ez erősíti a v4 termékválasztást.

**Blog vs kereskedelmi oldalak:**

| Oldaltípus | Klikk 2025 -> 2026 | Impresszió 2025 -> 2026 |
|---|---:|---:|
| Blog (`/spg/`) | 2 669 -> 2 178 (-18%) | 59 898 -> 84 563 (**+41%**) |
| Kategória / termék | 9 075 -> 6 197 (**-32%**) | 344 496 -> 307 895 (-11%) |

A blog impressziója 41%-kal nőtt, de a klikkje esett - ez az AI Overview a tartalmi lekérdezéseken. A **kereskedelmi oldalak veszítenek jobban** (-32% klikk), és ott a probléma nagyobb részben lefedettség-vesztés, nem CTR.

### 8.5 Mit jelent ez a beavatkozásra

1. **Rangsor-javítási SEO-projektnek nincs értelme** - a pozíció már javult 2,5 helyet. A cél a CTR visszaszerzése: title és meta description átírás kattintás-kikényszerítésre, FAQ és HowTo strukturált adat, valamint olyan tartalmi elem, amit az AI Overview nem tud helyettesíteni (aktuális ár, készlet, összehasonlító táblázat, konfigurátor, videó, szerviz-információ).
2. **Súlypont-áthelyezés információsról tranzakciósra.** A blogot elviszi az AI Overview, a kereskedelmi oldalak viszont lefedettséget vesztettek. Az `/ipari-takaritogepek` kategóriaoldal (-45% impresszió) a legfontosabb egyetlen SEO-feladat, mert ez a gépkategória organikus belépője, és közvetlenül összefügg a gépbevétel-eséssel.
3. **Technikai ellenőrzés:** URL-migrációk redirect és kanonikus státusza; a delistelt/készlethiányos termékoldalak (Soteco Lava, Habosító szár) sorsa.
4. **Amit skálázni kell:** a napelem-tisztító és a magasnyomású mosó tartalmi klaszter működik. Ugyanezt a mintát kell ráhúzni a szállodai/irodai porszívó és a padlósúroló gép szegmensre - ez pontosan a v4 nagy értékű lábának két osztálya.
5. **A PPC-terv nem változik.** A bevétel-átcímkézés (H1/b) továbbra is fennáll, tehát a Brand Search és a PMax márka-kizárás indokolt marad.

### 8.6 Ha kulcsszó-szintű adat is kell

A GA4 Data API nem adja a query-dimenziót (7. szekció). Query-szinthez a Search Console API kell közvetlenül:

1. **API engedélyezése:** `searchconsole.googleapis.com` a GA4 MCP-vel azonos GCP projektben.
2. **Scope hozzáadása a meglévő ADC-hez:**
   `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`
   **FIGYELEM:** az `analytics.readonly` scope-ot MINDENKÉPP bent kell hagyni. Ha az új login csak a `webmasters.readonly`-t kapja meg, a GA4 MCP azonnal eltörik, és az egész mostani elemzési útvonal megszűnik.
3. **Jogosultság:** a bejelentkező Google-fióknak legalább korlátozott felhasználói hozzáférés kell a Search Console propertyn.
4. **Lekérdezés:** nem kell új MCP, elég a REST végpont
   `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`
   `gcloud auth application-default print-access-token` tokennel.
5. **Kell hozzá:** a property pontos azonosítója (`sc-domain:takaritogeppartner.hu` vagy `https://www.takaritogeppartner.hu/`).
6. **Korlát:** a Search Console API maximum 16 hónap történelmet ad, ami a 12-16 hónapos kérésnek pont megfelel.

Ez credential-kezelést és gcloud-logint érint, ezért a Flotta-szabályok 7. pontja szerint nem indítom el magamtól - Nova koordinálja Zsolttal.

---

## 9. Volumen-dimenzió (kiegészítés, 2026-07-22)

Új célkitűzés került be: a bevétel és a kosárérték mellett a **havi rendelésszám** is önálló cél (~1000 db/hó).

### 9.1 Baseline és történelmi csúcs

Havi rendelésszám:

| 2025 | db | 2026 | db |
|---|---:|---|---:|
| január | **1 017** | január | 816 |
| február | 756 | február | 791 |
| március | 730 | március | **831** |
| április | 586 | április | 684 |
| május | 743 | május | 709 |
| június | 642 | június | 686 |
| július | 602 | július (1-21) | 426 |
| augusztus | 427 | | |
| szeptember | 565 | | |
| október | 792 | | |
| november | 859 | | |
| december | 647 | | |

- **2026 H1 átlag: 753 rendelés/hó** (4 517 / 6). Ez a baseline.
- **Az 1 000-es cél NEM példa nélküli: 2025 januárjában 1 017 rendelés volt.** (Nova üzenetében az szerepelt, hogy ilyen még nem volt - az adat szerint volt, egyszer.) Érdemes tudni, mi hozta: 2025 januárjában a Paid Search 423 rendelést adott, szemben a mai 62/hó-val. Vagyis a rekordhónap volumene a keresési kampányokból jött, ami tovább erősíti a gép-Search visszaállítás melletti érvet.
- 2026 legjobb hónapja március, 831 rendelés. A célhoz ehhez képest +20% kell.
- 2025 H1 átlag 746, 2026 H1 átlag 753. **A rendelésszám YoY stabil (+1%)**, tehát nem visszaesésből kell visszakapaszkodni, hanem eddig nem látott szintre kell emelni (a havi rekord kivételével).

### 9.2 Miért reális a +33%

1. **A konverziós ráta már javult**: 4,65% -> 5,61% (+21%). Ugyanaz a látogatószám ma több rendelést eredményez. A webshop oldali korlát tehát nem szűk keresztmetszet.
2. **Forgalmi igény**: 1 000 rendelés az 5,61%-os rátán 17 825 látogatás/hó (ma 13 416). Ez +33% forgalom, VAGY kevesebb forgalom magasabb konverziós rátával és több visszatérő vásárlóval.
3. **A volumen-kampányok költségkeret-korlátosak.** A rendszer jelzi, hogy a keret elfogyása miatt marad ki nyereséges megjelenésekből. A jelenlegi 1 960 Ft-os konverziós költség mellett a keretbővítés közvetlenül rendelésre váltható.

### 9.3 A legnagyobb kihasználatlan tartalék: az ismétlődő vásárlás

- **Visszatérő felhasználók aránya 2026 H1: 13,9%** (60 539 felhasználóból 8 405). 2025 H1-ben 15,0% volt, tehát enyhén romlott.
- Ez alacsony egy olyan termékkör mellett, ahol a forgalom természeténél fogva ismétlődő. A **12 legtöbb darabban eladott termékből 11 fogyóeszköz** (porzsák, szűrő, porszívófej), és ezek együtt **3 389 darabot** tesznek ki, azaz a teljes féléves darabszám (8 547) **40%-át**.
- Legnagyobb darabszámú termékek 2026 H1: Kärcher WD 3 papír porzsák 10 db (616), Kärcher WD 2 papír porzsák 5 db (385), Nilfisk VP300 szintetikus porzsák (338), Miele mikroszálas porzsák (321), parketta porszívófej (309), kombinált porszívófej (272), Parkside papír porzsák (247), Kärcher WD 3 papír porzsák 5 db (213), Kärcher szűrőpatron (185).
- Egy porzsákcsomag 3-6 hónap alatt elfogy. **Utánrendelési program és vásárlói lista alapú újracélzás nélkül ez a bázis ma nagyrészt egyszeri vásárlóként viselkedik.**

### 9.4 A második legnagyobb tartalék: a Meta konverziós rátája

- Meta 2026 H1: 12 929 látogatás, 146 rendelés = **1,13% konverziós ráta**, szemben a webshop 5,61%-os átlagával és a Performance Max 7,69%-ával.
- Ugyanekkora forgalom mellett 2,5%-os rátával a rendelésszám 146-ról kb. 323-ra nőne, azaz **+30 rendelés/hó**.
- A javítás iránya: hideg elérésről meleg közönségre (újracélzás, vásárlói lista, hasonmás), és katalógus-alapú fogyóeszköz-hirdetés a korábbi vásárlóknak.

### 9.5 Az ingyenes Shopping megjelenések volumen-hatása (reális méret)

Az Organic Shopping 2025 H1-ben **20 rendelést** hozott hat hónap alatt (3-4/hó), 0,6M Ft értékben. Ma nulla. A visszaállítása tehát **fontos, mert ingyenes, de volumenben kicsi**: kb. +3-5 rendelés/hó. Ezt a tervben nem szabad túlértékelni.

### 9.6 A rendelésszám-híd összefoglalva

| Forrás | Várható hatás |
|---|---:|
| Volumen-kampányok keretbővítése (költségkeret-korlát feloldása) | +90-120 |
| Ismétlődő vásárlás és visszatérő vevők | +55-60 |
| Meta konverziós ráta javítása | +25-30 |
| Gépszegmens felépítése (plusz kapcsolódó tartozék-rendelés) | +15-20 |
| Organikus visszaszerzés és ingyenes megjelenések | +25-35 |
| **Összesen** | **+210-265** |
| **Baseline 753 ->** | **kb. 1 000** |

Kockázat: a híd öt elemből áll, és mindegyikre szükség van. Ha az ismétlődő vásárlási program vagy a Meta-átépítés kimarad, a cél nem érhető el pusztán hirdetési keretbővítéssel, mert az önmagában csak a 850-880-as sávig visz.

---

## 10. A 2026. áprilisi webshop-redesign hatása (kiegészítés, 2026-07-22)

Új információ: 2026 április közepén (15-e után) arculatváltás történt. Megvizsgáltam, van-e mérhető törés a dátum körül.

### 10.1 Konverziós ráta: NEM romlott

| Időszak | Session | Rendelés | CVR | Engagement rate | Aktív idő / session |
|---|---:|---:|---:|---:|---:|
| Redesign előtt (feb 1 - ápr 11, W06-W15) | 32 874 | 1 875 | **5,70%** | 66,5% | **71,8 mp** |
| Redesign után (ápr 19 - júl 18, W17-W29) | 36 779 | 2 036 | **5,54%** | 62,6% | **62,1 mp** |

- **CVR -2,8%**, a heti ingadozás sávján belül, és mindkét érték jóval a 2025 H1-es 4,65% felett. **A redesign nem okozott konverziós visszaesést.**
- Bevétel és AOV heti idősorában sincs törés; az áprilisi visszaesés szezonális (2025: márc 730 -> ápr 586 rendelés; 2026: márc 831 -> ápr 684, ugyanaz a mintázat).
- **Engagement viszont romlott:** aktív idő/session 71,8 -> 62,1 mp (**-13,5%**), lépcsősen, nem trendszerűen. Engagement rate 66,5% -> 62,6%.

### 10.2 A checkout-esemény törése: MÉRÉSI HIBA, dátumhoz köthető

Heti checkout / add_to_cart arány:

| Hét | add_to_cart | checkout | arány |
|---|---:|---:|---:|
| W10-W16 (átlag) | 372/hét | 224/hét | **60,5%** |
| **W17 (ápr 19-25)** | 395 | 206 | **52,2%** |
| **W18 (ápr 26 - máj 2)** | 327 | 146 | **44,6%** |
| W19-W26 (átlag) | 369/hét | 165/hét | **44,8%** |

- add_to_cart gyakorlatilag változatlan (-3%), **checkout -25%**, vásárlás -9,4%.
- **A vásárlás/checkout arány 79%-ról 96%-ra ugrott.** Valós tölcsérben ez lehetetlen -> a `begin_checkout` esemény nem tüzel megbízhatóan a redesign óta (vagy kimaradt a méréskód az új sablonból, vagy az új folyamat átugorja azt a lépést, amihez kötve volt).
- Eszközbontás (márc 1 - ápr 14 vs ápr 15 - máj 31): **mobil add_to_cart +6,6% (1 307 -> 1 393), mobil checkout -26% (800 -> 592)**. Desktop: add_to_cart -7%, checkout -14%. A mobil az érintett.
- **Üzleti jelentőség:** a smart bidding és a retargeting tölcsérjelet használ. Hiányzó `begin_checkout` mellett a kosárelhagyó-újracélzás pontatlan és a rendszerek kevesebb jelből tanulnak.

### 10.3 URL-váltás: IGEN, egybevág a redesignnal

Havi session az érintett oldalakon:

| Oldal | jan | feb | márc | **ápr** | máj | jún | júl (1-21) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/ipari-takaritogepek` | 199 | 188 | 147 | **57** | 81 | 89 | 42 |
| `/Karcher_K2-K3-K4-K5-K6-K7_tartozek_alkatresz` (új) | 1 | 1 | 3 | **14** | 53 | 124 | 68 |
| `/Magasnyomasu-tomlo-...-K7-H` (régi) | 8 | 5 | 2 | 3 | 2 | 3 | 1 |
| `/Parkside_porszivo_tartozek_alkatresz` | 241 | 237 | 223 | 209 | 267 | 200 | 155 |

- **Az `/ipari-takaritogepek` forgalma áprilisban 61%-kal zuhant (147 -> 57)** és azóta sem tért vissza. **Ez megadja a 8.4-ben leírt -45%-os impresszió-vesztés OKÁT: a redesign, nem általános SEO-erózió.** Ez jó hír, mert technikai és javítható.
- Az új URL lassan, hónapok alatt vette át a forgalmat (1 -> 3 -> 14 -> 53 -> 124), a régi elhalt. Az átmenet volt a veszteség forrása.
- **Nem minden oldal érintett:** a Parkside-oldal végig stabil. A probléma szűk körű.

### 10.4 Redesign vs AI Overview: KÉT KÜLÖN ESEMÉNY

| | Redesign | AI Overview |
|---|---|---|
| Időpont | ápr 15-19 | W18 (ápr 26 - máj 3) |
| Hol mérhető | a webshopon belül | a Google találati oldalán |
| Tünet | checkout-esemény -25%, aktív idő -13,5%, `/ipari-takaritogepek` forgalom -61% | CTR 2,58% -> 1,77%, VÁLTOZATLAN impresszió, JAVULÓ pozíció |
| Mi bizonyítja a szétválasztást | oldalspecifikus, és a webshopon belüli eseményekben látszik | a webshoptól függetlenül, a találati oldalon keletkezik |

**Diagnosztikai ökölszabály, amit ebből leszűrtem:** ha az IMPRESSZIÓ esik -> redesign / technikai / URL-ügy. Ha az impresszió tartja magát vagy nő, és csak a CTR esik -> AI Overview. Ez alapján az `/ipari-takaritogepek` (impresszió -45%) redesign-ügy, a HEPA-blogposzt (impresszió -9%, CTR-összeomlás) AI Overview-ügy.

### 10.5 Következtetés és korrekció a korábbi elemzéshez

**A redesign nem rontotta el a konverziót és a bevételt.** Két konkrét, javítható károkozás van: a checkout-esemény mérése és néhány kategóriaoldal URL-vesztesége.

**Korrekció a 8.4 szekcióhoz:** az `/ipari-takaritogepek` lefedettség-vesztését ott "valódi lekérdezés-lefedettség vesztésként" írtam le, ok nélkül. Most megvan az ok: az áprilisi redesign URL- és struktúraváltása. A teendő ennek megfelelően nem tartalmi SEO, hanem elsősorban technikai helyreállítás (301, kanonikus, belső linkelés), és csak utána tartalmi bővítés.

### 10.6 404-validáció: NINCS tömeges 404 (kiegészítés, 2026-07-22)

Zsolt jogos kérése: ne "ellenőrizd az átirányításokat" szerepeljen, hanem adattal validált állítás. Megnéztem. **Az eredmény: a tömeges 404 hipotézist az adat NEM támasztja alá.**

**a) Van 404-mérés, de nincs dedikált esemény.** A propertyben 56 eseménynév van, egyik sem 404-jellegű. A 404-oldal viszont azonosítható a `pageTitle` alapján: **"404 - Az oldal nem található"**.

**Fontos módszertani buktató:** a `pageTitle CONTAINS "404"` szűrő HAMIS találatokat ad, mert a `Numatic TTB 4045` terméknevek is tartalmazzák a "404" karakterláncot. Pontos egyezésre kell szűrni.

**b) A 404-forgalom nagyságrendje (pontos egyezéssel):**

| Hónap | 404-oldalletöltés | Session |
|---|---:|---:|
| 2025-10 | 6 | 6 |
| 2025-11 | 4 | 3 |
| 2025-12 | 1 | 1 |
| 2026-01 | 5 | 3 |
| 2026-02 | 8 | 7 |
| 2026-03 | 5 | 4 |
| 2026-04 | 9 | 8 |
| **2026-05** | **16** | 7 |
| **2026-06** | **22** | 8 |
| **2026-07 (1-21)** | **21** | 3 |

Van emelkedés: a redesign előtti hónapokban átlag 6,75 oldalletöltés/hó, utána kb. 20/hó, azaz **háromszorosára nőtt.** DE az abszolút szint elhanyagolható: **havi ~20 oldalletöltés a havi ~35 000-ből, azaz 0,06%.** Május 1 óta összesen 59 db 404-oldalletöltés. **Ez nem tömeges 404.**

**c) A meglévő 404-ek NEM átirányítás-hiányból származnak.** A konkrét URL-ek jellege:

| 404 URL | Letöltés | Mi ez valójában |
|---|---:|---|
| `/<br>https://www.takaritogeppartner.hu/spg/561853/Elallas-a-szerzodestol` | 14 | **Hibás link a webshop tartalmában**: egy HTML `<br>` címke beleragadt az URL-be. A legnagyobb egyedi 404. |
| `/<br>https://.../spg/561853/<br>https://.../Elallas-a-szerzodestol` | 4 | Ugyanaz a hiba, dupla példány |
| `/spd/107405169/` | 4 | Kifutott termék azonosítója |
| `/Eureka-E36Cipari- padlotisztito-gep-kefeszivogumi` és 3 további változata | 5 | **Elgépelt URL** (hiányzó kötőjel, szóköz az URL-ben) |
| `/about`, `/about-us`, `/about/team`, `/blog` | 5 | Általános angol útvonalak: robot- és sebezhetőség-kereső próbálkozások, nem valós felhasználók |
| `/Nilfisk-VP300-...ennek a garanciája számlával együtt él` | 1 | Hibás link, amibe szövegtörzs ragadt bele |

Vagyis a 404-ek **hibás linkekből, elgépelt címekből, robotforgalomból és egy kifutott termékből** állnak, nem a redesign átirányítás-hiányából.

**d) Keresési oldalról sincs tömeges kiesés.** A top 400 landing oldal, 2026. jan 1 - ápr 14 vs ápr 22 - júl 21:

| | Előtte | Utána | Változás |
|---|---:|---:|---:|
| Kattintás | 8 921 | 6 115 | -31% |
| Megjelenés | 361 457 | 314 854 | -13% |
| CTR | 2,47% | 1,94% | -21% |

- **Egyetlen oldal sem tűnt el teljesen** (0 db olyan, aminek előtte volt 100+ megjelenése és utána egy sem).
- Csak **2 oldal** vesztett 90%-nál többet a megjelenéseiből:
  - `/Eureka-E36C-ipari-padlotisztito-gep-kefeszivogumi`: 2 920 -> 189 megjelenés (-94%), 23 -> 6 kattintás. **Ez ugyanaz az oldal, aminek három elgépelt változata a 404-listán szerepel** - ez az egyetlen megerősített törött URL.
  - `/spl/232111/Markafuggetlen-automoso-szerviz`: 402 -> 26 megjelenés.

**e) Amit viszont TALÁLTAM: nem 404, hanem megjelenés-átrendeződés az URL-minták között.** A legalább 1 000 megjelenéssel induló 75 oldalból **27 vesztett 40%-nál többet** (együtt -58 497 megjelenés), miközben néhány oldal nagyot nyert:

| Oldal | Megjelenés | Változás |
|---|---:|---:|
| `/karcher-wd-2-porszivo-tartozek-alkatresz` | 7 594 -> 35 648 | **+369%** |
| `/sct/558702/Karcher-tartozek` | 3 400 -> 9 682 | +185% |
| `/spg/.../Napelem-tisztito-szett...` | 3 902 -> 7 747 | +99% |
| `/porszivo-gegecso` | 3 068 -> 5 116 | +67% |

Legnagyobb vesztesek: `/ipari-porszivok` (-81%), `/Padlo-surolo-gepek` (-75%), `/Napelem-tisztito` termékoldal (-73%), `/Soteco-Lava-Szonyegtisztito` (-71%), `/sct/708469/Porszivofejek` (-63%), `/sct/771703/Hako-tartozek` (-62%).

**Ez nem 404, hanem kannibalizáció:** a redesign új kategória-URL-mintát vezetett be, az új minta elszívja a megjelenéseket a régi termék- és kategóriaoldalaktól. A régi oldalak továbbra is indexeltek (van megjelenésük), csak kevesebb lekérdezésre. Nettó egyenleg -46 603 megjelenés, mert a nyertesek nem fedezik a veszteséget.

**f) Következtetés és a teendő pontosítása.** Az eredeti "ellenőrizd az összes átirányítást" javaslat így pontosítható:

1. **Egyetlen megerősített törött URL-család** van: az Eureka E36C oldal. Erre kell 301-es átirányítás. Ez konkrét, nem feltételezés.
2. **A `<br>` hibás link a webshop tartalmában** javítandó - ez a legnagyobb egyedi 404-forrás (18 letöltés), és tartalmi hiba, nem szerverbeállítás.
3. **A valódi probléma nem 404, hanem kanonikus- és belsőlink-konszolidáció** a régi és az új URL-minta között. Ez érinti a 27 oldalt, köztük az `/ipari-takaritogepek`-et.
4. Tömeges 301-akció nem indokolt, mert nincs tömeges 404.

### 10.7 Mit NEM lehet a jelenlegi hozzáféréssel kihozni, és mi kellene helyette

A hivatalos, teljes "Nem található (404)" lista a Search Console **Indexelés / Oldalak** jelentésében van.

**Fontos pontosítás: ezt a Search Console API SEM adja meg.** Konkrétan:
- A **Search Analytics API** (amit a `webmasters.readonly` scope nyit meg) ugyanazt a kattintás/megjelenés/CTR/pozíció adatot adja, amit a GA4-en keresztül már lekérdeztem. **404-lista szempontjából nulla többletet nyújt.**
- A **URL Inspection API** URL-enként ad indexelési státuszt, napi 2 000-es kvótával. Egy meglévő gyanús lista ellenőrzésére jó, tömeges felderítésre nem.
- A teljes "Nem található (404)" lista **kizárólag a Search Console felületén érhető el** (Indexelés -> Oldalak jelentés), onnan manuálisan exportálható. Erre nincs publikus API.

**Ezért NEM javaslom a Search Console API bekötését ehhez a feladathoz** - nem oldaná meg, és a GA4-hez kötött hitelesítés kockáztatása sem indokolt.

**Amit helyette kérni érdemes** (mindkettő egyszerű kérés a gazda vagy az ügyfél felé):
1. **Search Console felületi export**: Indexelés -> Oldalak -> "Nem található (404)" lista CSV-ben. Ez a hivatalos lista.
2. **Webszerver hozzáférési napló 404-kivonata** a 2026. április 1 utáni időszakra, hivatkozó oldallal (referrer) együtt. Ez az igazán teljes forrás, mert a robotforgalmat és a keresőmotor-kéréseket is tartalmazza, nemcsak azt, amit a böngészőoldali mérés lát.

A jelenlegi adat alapján viszont már most kimondható: **a tömeges 404 hipotézis nem áll, a redirect-teendő szűk és konkrét.**

---

## 11. ÖNKORREKCIÓ: nem volt URL-változás (2026-07-22)

A 10.3 és 10.5 szekcióban azt állítottam, hogy a redesign URL-változásokkal járt, és ez okozta az `/ipari-takaritogepek` visszaesését. **Ezt az állítást vissza kell vonnom, mert utánamérve nem áll.**

Ami az állítást megdöntötte:

**a) Élő ellenőrzés.** Az `/ipari-takaritogepek`, `/ipari-porszivok`, `/Padlo-surolo-gepek` és `/karcher-wd-2-porszivo-tartozek-alkatresz` mind 200-at ad, átirányítás egyiken sincs. Vagyis ezeknek a címe **nem változott meg.**

**b) A régi címek ma is kapnak forgalmat.** Ha egy cím megváltozott volna, a régire nulla session érkezne. Havi session az `/ipari-takaritogepek`-en 2026-ban: jan 199, feb 188, márc 147, ápr 57, máj 81, jún 89, júl (21 nap) 42. Él és forgalmat kap.

**c) Nincs egyetlen új oldal sem.** A top 400 keresési belépő oldalt megvizsgálva **nulla** olyan cím van, amely ápr 22 után 500+ megjelenést kapott, miközben előtte gyakorlatilag nem létezett. Nem jelent meg új URL-minta.

**d) Amit tévesen URL-váltásnak néztem:**
- `/Karcher_K2-K3-K4-K5-K6-K7_tartozek_alkatresz` (havi session: 2025-ben végig 1-8, 2026 jan-márc 1-3, ápr 14, máj 53, jún 124, júl 68). **Ez az oldal 2025 januárja óta létezik**, tehát nem új cím. Ráadásul Kärcher-tartozék, nem ipari gép -> nem vehette át az `/ipari-takaritogepek` lekérdezéseit. A két oldal különböző témában van.
- `/Magasnyomasu-tomlo-...-K7-H` vs a `-H` nélküli változat. Havi session 2025-ben: a `-H` 18/20/27/25/24/26/16/25/18/12/7/5, a `-H` nélküli 47/12/7/8/9/14/8/20/25/9/16/3. **A kettő a teljes 2025-ös évben EGYSZERRE létezett**, és a `-H` már 2025 októberétől fogyatkozik, fél évvel a redesign előtt. Létezik egy harmadik változat is (`/spd/5904422420024/Magasnyomasu-tomlo-...-H`). Ez tehát **duplikált termékoldal**, nem redesign-kori átnevezés.

**e) A megjelenés-átrendeződés sem site-oldali.** A legnagyobb "nyertes", a `/karcher-wd-2-porszivo-tartozek-alkatresz`: megjelenés 7 594 -> 35 648 (+369%), DE **kattintás 47 -> 34 (csökkent)**, és a havi session végig 35-54 között stabil. Vagyis a Google több lekérdezésre mutatja az oldalt, olyanokra is, amikre nem kattintanak. Ez a keresőmotor oldalán történt, nem a webshopban.

**f) Az `/ipari-takaritogepek` képe is árnyaltabb.** YoY: 2025 jan 241 -> júl 103 (-57%) ugyanez a szezonális fogyás. 2026: jan 199 -> ápr 57 -> jún 89. Az éves lemaradás **szűkül**: ápr -69%, máj -43%, jún -23%. Vagyis az áprilisi mélypont egyhónapos anomália volt, ami nagyrészt helyreállt.

**Helyes összefoglaló:** a 2026 áprilisi redesign nem okozott kimutatható kárt. Nem változtatott URL-t, nem rontotta a konverziós rátát, nem termelt tömeges 404-et. Egyetlen mérhető nyoma a session-enkénti aktív idő -13,5%-os csökkenése. A keresési forgalom csökkenése időben egybeesett vele, de a mechanizmusa a Google találati oldalán van (AI Overview CTR-esés + megjelenés-átrendezés), nem a webshopban.

**Tanulság magamnak:** időbeli egybeesésből nem következik ok-okozat. Az URL-váltás hipotézist azonnal ellenőrizni kellett volna azzal, hogy a régi cím kap-e még forgalmat, és hogy létezik-e egyáltalán új cím. Mindkettő egy lekérdezés lett volna.
