# Takarítógéppartner - PPC akcióterv v4

Verzió: v4 (a v3 helyébe lép). Készült: 2026-07-22.
Változás a v3-hoz: (A) 10x blended ROAS cél a 4,5-5,5x helyett, volumen-fojtás nélkül. (B) Kidolgozott nagy értékű láb. (C) A GA4 csatorna-diagnózis beépítve.
Fiók: Google Ads 5385457642 (MCC 5257587986), Meta act 314287332, GA4 properties/374081626.
Státusz: JAVASLAT. Egyetlen pénzt költő beállítás sem lett módosítva, mindenhez Zsolt jóváhagyása kell.

---

## 0. Amit a GA4 megváltoztatott a tervben

1. **Nem forgalmi probléma van, hanem kosárérték-probléma.** Rendelésszám +1% YoY, konverziós ráta +21%, AOV -26%. Tehát nem több klikk kell, hanem drágább kosár.
2. **Az organic "esés" nagyobb része PMax-átcímkézés**, nem SEO-összeomlás (az organic AOV változatlan). Ezért ez NEM SEO-projekt, hanem attribúció- és struktúra-kérdés. Két konkrét kivétel, ami valódi SEO/feed feladat: az Organic Shopping (ingyenes listázás) 2026 februártól nulla, és az AI Overview miatti organikus session-vesztés.
3. **A gépek dedikált keresési lába ki van kapcsolva.** A PMax-ra állással minden gép-Search és gép-Shopping kampány PAUSED lett. Ezt kell visszaépíteni, ez a terv súlypontja.
4. **A Google Ads ROAS felül van súlyozva** (30 nap alatt 11,48M konverziós érték, miközben a teljes webshop-bevétel ~10,8M). **Ezért a 10x célt Unas-bevétel / teljes médiaköltés alapon mérjük, nem a Google Ads felületén.**

---

## 1. A 10x cél helyes olvasata: nem költés-vágás, hanem növekmény-szabály

Mai állapot (30 nap): Google Ads költés **1 276 013 Ft**, Unas bevétel ~16,6M (június) illetve ~8,5M (júliusi ütem).

- 20M Ft/hó bevétel 10x blended ROAS mellett = **2,0M Ft/hó teljes médiaköltés kerete.**
- Ma 1,28M-ot költünk. Tehát **van kb. 620-720 ezer Ft/hó növekmény-keret**, feltéve hogy a növekmény 10x felett dolgozik.

**A 10x tehát nem azt jelenti, hogy le kell fojtani a meglévő kampányokat. Azt jelenti, hogy a plusz pénz kizárólag a nagy értékű lábra mehet.** A meglévő volumen-kampányok tROAS célja szándékosan a MAI ROAS-uk alá van állítva, hogy a darabszám ne essen.

---

## 2. Kétsebességes struktúra

### 2.1 VOLUMEN-motor (marad a volumen, javul az érték)

Cél: ugyanannyi kattintás és rendelés, de a rendszer a drágább SKU-t preferálja a kosárban. A ROAS-emelés a MIX-ből jön, nem a fojtásból.

| Kampány | Napi büdzsé ma | v4 büdzsé | Licit ma | v4 licit | Mai ROAS | tROAS cél |
|---|---:|---:|---|---|---:|---:|
| PMax 2025 - Porszívók és kiegészítők | 13 000 | **13 000** | Max Conversions | Max Conv Value -> tROAS | 4,64x | **450%** |
| PMax 2025 - Porzsákok | 10 000 | **10 000** | Max Conversions | Max Conv Value -> tROAS | 6,47x | **550%** |
| PMax 2025 - Kiemelt termékek | 8 000 | **8 000** | Max Conversions | Max Conv Value -> tROAS | 6,40x | **550%** |
| DSA | 7 000 | **7 000** | Max Conversions | Max Conv Value -> tROAS | 8,28x | **700%** |

**Minden tROAS cél a mai ROAS ALATT van** (4,50 < 4,64; 5,50 < 6,47; 5,50 < 6,40; 7,00 < 8,28). Ez garantálja, hogy a volumen nem esik. Sorrend: először 2 hét tiszta Max Conversion Value tROAS nélkül (betanulás), UTÁNA rá a tROAS. Ha tROAS-t azonnal ráteszünk, a PMax lefagy.

Listing group / feed korlát (kannibalizáció-gát): ezekből a kampányokból **kizárjuk** a `gep_premium` és `gep_volumen` custom label-t. A gépeket a nagy értékű láb viszi.

### 2.2 NAGY ÉRTÉKŰ LÁB ("Gép-motor") - az új rész

**A termék-adat három osztályt ad:**

| Osztály | Mi tartozik ide | 2026 H1 bevétel | Db | Ft/db | Stratégia |
|---|---|---:|---:|---:|---|
| **G1 - Skálázható gép** | Szállodai/irodai porszívók (Nilfisk VP300 HEPA Basic 60 960 Ft, VP930 PRO 193 798 Ft), Napelem tisztító (60 464 Ft) | 7,16M | ~105 | 50-200e | **Fő cél. Van kereslet ÉS volumen, skálázható.** |
| **G2 - Nagy tételes gép** | Gyalogkíséretű padlótisztítók (Eureka E61 4,29M, E46B 2,10M, E36B 1,20M), Nilfisk SB Station 1,75M | 10,11M | 5 | 1,2-4,3M | Nem volumen-játék. Cél: +1-2 db/hó. Ajánlatkérés-vezérelt. |
| **G3 - Ismétlődő magas-értékű fogyó** | Gépi tisztítószerek (Kleen Purgatis BLUE KLEEN 25 900 Ft), kategória összesen | 2,81M | 121 | 15-30e | LTV-motor: a gépvásárlók utánrendelése. |

**Feed-szegmentáció (ez az egész alapja) - Merchant Center `custom_label_0`:**

| Címke | Szabály | Hova megy |
|---|---|---|
| `gep_premium` | bruttó ár >= 300 000 Ft | G2 kampányok |
| `gep_volumen` | bruttó ár 50 000 - 299 999 Ft, `Takarítógépek/*` kategória | G1 kampányok |
| `szer_profi` | `Tisztítószer/*` kategória, >= 15 000 Ft | G3 kampány |
| `kiegeszito` | minden más < 50 000 Ft | volumen-motor (2.1) |

**Kampány-struktúra a nagy értékű lábhoz:**

| Kampány | Státusz ma | v4 napi büdzsé | Licit | Feed / célzás | Miért |
|---|---|---:|---|---|---|
| PMax 2025 - Ipari porszívók és padlóápoló gépek | ENABLED, de csak 1 450 Ft/nap költ | **10 000 -> 15 000** | tROAS **1800% -> 900% -> 700%** | csak `gep_premium` + `gep_volumen` | A fiók konverziós értékének 43%-át adja a költés 3,4%-ából. Nem büdzsé-korlátos, hanem tROAS-fojtott. **Ez a leggyorsabb nyereség, 0 Ft új pénzből.** |
| S - Szállodai porszívók | PAUSED (1 000/nap) | **3 000** | Max Conv Value tROAS **600%** | exact + phrase: "nilfisk vp300", "szállodai porszívó", "irodai porszívó", "profi porszívó" | G1 magja. A Search exact match mindig veri a PMax-ot ugyanarra a keresésre. |
| S - Márkák - Viper, Nilfisk, Eureka | PAUSED (10 000/nap) | **6 000** | Max Conv Value tROAS **600%** | márka + géptípus kombinációk | Márkás géptípus-keresés, magas szándék. |
| S - Padlósúroló gépek | PAUSED (5 000/nap) | **4 000** | Max Conv Value tROAS **800%** | "padlósúroló gép", "padlótisztító gép", "eureka e46", "eureka e61" | G2 belépő. Ritka de 1,2-4,3M/db. |
| **Brand Search (ÚJ)** | - | **2 000** | Target Impression Share 90% (abszolút top) | "takarítógéppartner" + variánsok | Ne a PMax fizesse a saját márkás keresést, és mérhetővé teszi az organic-kannibalizációt. |
| **PMax `szer_profi` (ÚJ)** | - | **2 000** | tROAS **800%** | csak `szer_profi` | G3, LTV. A halott Kiehl kampány ide olvad be. |

**Kannibalizáció-kezelés (fontos, hogy ne egymást vegyék):**
1. A volumen-PMax-okból kizárjuk a `gep_*` címkéket -> a gépet nem viheti a volumen-kampány.
2. A gép-Search kampányok exact és phrase match-en futnak. A Search exact match a Google licit-hierarchiában elsőbbséget élvez a PMax-szal szemben azonos keresésre, tehát a gépes kereséseket a Search viszi, a PMax marad a Shopping / Display / YouTube felületeken.
3. Fiók-szintű negatív kulcsszó lista a márkanévre, ráhúzva a volumen-PMax-okra -> a Brand Search viszi a márkát.
4. A gép-Search kampányokba negatívként bekerül: "porzsák", "szűrő", "alkatrész", "fej", "tartozék", "cső".

### 2.3 Gép-landing és a mérési vakfolt megszüntetése

A Direct AOV -22%-a (44 715 -> 34 905 Ft) valódi üzleti jel, és részben azért nem látjuk, mert a gépeladás egy része offline/telefonon zárul.

Két dedikált B2B landing: `/szallodai-irodai-porszivok` és `/padlosurolo-gepek`. Tartalom: ártartomány, lízing/finanszírozás, szerviz és garancia, referenciák, **"Kérjen ajánlatot" űrlap**.

Mérés: az űrlap-beküldés külön `generate_lead` key event, **becsült értékkel**: átlagos gép-AOV x zárási arány. Kiindulásnak 76 000 x 0,3 = **22 800 Ft**. Ezzel a nagy értékű láb akkor is kap licit-jelet, ha a vásárlás offline zárul. Ez oldja fel azt, hogy ma a smart bidding csak a porzsákot látja konverziónak.

---

## 3. Veszteség-stop - ez fedezi a növekményt

| Akció | Megtakarítás / hó | Indok |
|---|---:|---|
| **Demand Gen LEÁLLÍTÁS** | **59 285** | 11 195 kattintás 5,3 Ft-os CPC-vel, **0 konverzió** 30 nap alatt. A GA4 7 hónap alatt csak 3 389 sessiont lát ehhez a kampányhoz, tehát a kattintások túlnyomó része érvénytelen. Nemcsak pénz, hanem adatszennyezés is. |
| PMax Szőnyeg: 5 000 -> 2 500/nap, tROAS 400% | 73 500 | 3,30x ROAS, 304 Ft-os CPC (a fiók legdrágább kattintása). |
| PMax Autómosó: 1 500 -> 800/nap | 21 000 | 2,74x ROAS, 3 konverzió 30 nap alatt. |
| PMax Kiehl beolvasztása a `szer_profi` kampányba | 0 (átcsoportosítás) | 3 944 Ft költés, 0 konverzió, a tROAS 1280% megfojtja. |
| **Összesen** | **~154 000** | |

---

## 4. Büdzsé-terv összesítve

| Kampány | Ma (napi) | v4 (napi) | Δ |
|---|---:|---:|---:|
| PMax Porszívók és kiegészítők | 13 000 | 13 000 | 0 |
| PMax Porzsákok | 10 000 | 10 000 | 0 |
| PMax Kiemelt termékek | 8 000 | 8 000 | 0 |
| DSA | 7 000 | 7 000 | 0 |
| **PMax Ipari gépek** | 7 000 (valósan 1 450) | **15 000** | **+8 000 keret, +~4 000 valós** |
| **S - Márkák (Nilfisk/Viper/Eureka)** | 0 (paused) | **6 000** | +6 000 |
| **S - Padlósúroló gépek** | 0 (paused) | **4 000** | +4 000 |
| **S - Szállodai porszívók** | 0 (paused) | **3 000** | +3 000 |
| **Brand Search (új)** | 0 | **2 000** | +2 000 |
| **PMax szer_profi (új)** | 0 | **2 000** | +2 000 |
| PMax Szőnyeg | 5 000 | 2 500 | -2 500 |
| PMax Autómosó | 1 500 | 800 | -700 |
| PMax Kiehl | 2 000 | 0 (beolvad) | -2 000 |
| **Demand Gen** | 2 000 | **0 (STOP)** | -2 000 |
| **Összesen keret** | 55 500 | **63 300** | +7 800 |
| **Összesen valós költés** | ~42 500 | ~63 000 | **+20 500/nap** |

Havi valós költés: 1 276 000 -> kb. **1 890 000 Ft**. Ez pontosan belefér a 20M / 10x = 2,0M-os keretbe.

**A növekmény (+614 000 Ft/hó) megoszlása: 100%-ban a nagy értékű lábon.**

**Várható hatás.** A nagy értékű láb mai mért ROAS-a 113x (Ipari PMax), de ez erősen felülsúlyozott. Konzervatívan 12-15x valós ROAS-szal számolva: +614 000 x 13 = **+8,0M Ft/hó bevétel**. Nagyon óvatosan, 10x-en: +6,1M/hó. Júniusi 16,6M-ról indulva ez **22-25M Ft/hó**, tehát a 20M-os cél elérhető, és a blended ROAS 10x körül marad.

---

## 5. Végrehajtási sorrend

| Hét | Lépés | Kockázat |
|---|---|---|
| **0. hét (azonnal)** | 1. **Demand Gen STOP.** 2. Merchant Center `custom_label_0` feltöltés (gep_premium / gep_volumen / szer_profi / kiegeszito). 3. Volumen-PMax-okban a `gep_*` címkék kizárása. | Alacsony. A Demand Gen 0 konverziót termel, nincs mit elveszteni. |
| **1. hét** | 4. **PMax Ipari: tROAS 1800% -> 900%, büdzsé 10 000/nap.** 5. Gép-Search 3 kampány újraindítása (Szállodai, Márkák, Padlósúroló) tROAS 600/600/800%. 6. Szőnyeg és Autómosó vágás. | Közepes. Az Ipari kampány újratanul, 7-10 nap ingadozás. |
| **2. hét** | 7. Volumen-PMax-ok átállítása Max Conversion Value-ra, **tROAS NÉLKÜL** (betanulás). 8. Brand Search indítás + fiók-szintű márka-negatív a volumen-PMax-okra. 9. Gép-landingek élesítése. | Közepes. A licitváltás 2 hét tanulási időszakkal jár, ez alatt ingadozik a teljesítmény. |
| **3. hét** | 10. `generate_lead` key event értékkel a gép-landingeken (GTM + GA4 + Google Ads import). 11. `szer_profi` PMax indítás, Kiehl beolvasztás. 12. Customer Match lista: gépvásárlók -> tisztítószer/alkatrész retargeting. | Alacsony. |
| **4. hét** | 13. **Első kiértékelés** Unas-bevétel alapon. 14. Volumen-PMax-okra tROAS ráhúzás (450/550/550/700%). | Közepes. |
| **6. hét** | 15. PMax Ipari tROAS 900% -> 700%, büdzsé 15 000/nap, ha tartja a ROAS-t. 16. Volumen tROAS +50 bázispont, ha a darabszám nem esett. | Alacsony. |
| **Határidő** | **Augusztus 15.** Minden élesítve, hogy a szeptember-október (szezonális csúcs, 2025-ben 14,2M és 16,9M) betanult rendszerrel fusson. | |

---

## 6. Mérési feladatok (a GA4-elemzésből következően)

| # | Feladat | Miért | Sürgősség |
|---|---|---|---|
| M1 | **Merchant Center free listings ellenőrzés** | Az Organic Shopping 2026 februártól NULLA (előtte 0,6M/félév). Ingyen forgalom veszett el. | 48 óra |
| M2 | **2026-07-21 anomália ellenőrzése az Unasban** | Aznap 5 151 976 Ft bevétel 21 rendelésből, a 20 napos átlag 290 000 Ft/nap, és a sessionök 84%-a "(not set)". Vagy feldolgozási késés, vagy valódi nagy B2B rendelés. | 48 óra |
| M3 | **Google Ads konverziós műveletek auditja** | 30 nap alatt az Ads 11,48M értéket állít, a teljes webshop-bevétel ~10,8M. Duplikált konverzió? View-through ablak túl hosszú? | 1 hét |
| M4 | **Riport-alap átállítása Unas-bevételre** | A 10x cél csak számla-szinten értelmes. Heti riport: Unas bevétel / (Google Ads + Meta költés). | 1 hét |
| M5 | **`generate_lead` key event értékkel** | A gépeladás egy része offline zárul, ma nincs licit-jel rá. | 3. hét |
| M6 | **Search Console linkelés a GA4-hez** | Ma nem lehet kulcsszó-szinten igazolni az organikus visszaesés okát. | 2 hét |
| M7 | AI Assistant / Perplexity csatorna figyelése | 2026 júniusban jelent meg (43 session). Még kicsi, de a trend elindult. | Csak megfigyelés |

---

## 7. Meta (rövid)

A Meta ugyanabban a betegségben szenved: AOV 22 832 -> 11 700 Ft (-49%), bevétel -57%, rendelésszám csak -17%.

1. Katalógusban külön product set a `gep_volumen` és `gep_premium` címkékre, dedikált Advantage+ kampány **value-optimalizálással**, nem darabszámra.
2. A jelenlegi fő kampány (6571814639194: 10 091 session, 104 rendelés, 1,25M Ft, 12k AOV) a kiegészítő-motor, marad változatlanul.
3. Új: gép-fókuszú retargeting a gép-landing látogatóira és a Customer Match gépvásárló-listára.
4. CAPI ellenőrzés a `generate_lead` eseményre, hogy a Meta is kapjon jelet a nagy értékű szándékról.

---

## 8. KPI-k

| Mutató | Ma | 4 hét | 12 hét |
|---|---:|---:|---:|
| Havi bevétel (Unas) | 16,6M (jún) / ~8,5M (júl ütem) | 18M | **20M+** |
| **Blended ROAS (Unas / teljes médiaköltés)** | ~12x (jún), ~6x (júl) | 10x | **10x** |
| Blended AOV | 24 202 Ft (jún), 14 329 Ft (júl) | 22 000 Ft | **25 000 Ft** |
| Gép-darabszám (`Takarítógépek/*`) | ~17 db/hó | 22 db/hó | **30 db/hó** |
| Nagy értékű láb részesedése a médiaköltésből | 3,4% | 25% | 30% |
| Cross-network rendelés-részesedés | 60% | 55% | 50% |
| Demand Gen költés | 59 285 Ft/hó | **0** | **0** |
| Ajánlatkérés (`generate_lead`) | nincs mérve | mérve | 15+/hó |

---

## 9. Amihez Zsolt jóváhagyása kell (pénzt költő beavatkozás)

1. Demand Gen leállítása (-59 285 Ft/hó).
2. PMax Ipari tROAS 1800% -> 900% és büdzsé 7 000 -> 10 000/nap.
3. Három PAUSED gép-Search kampány újraindítása (+13 000 Ft/nap).
4. Brand Search és `szer_profi` PMax indítás (+4 000 Ft/nap).
5. Szőnyeg és Autómosó büdzsé-vágás.
6. A négy nagy kampány licitváltása Max Conversions -> Max Conversion Value -> tROAS.
7. Összesített napi költés-emelés: ~42 500 -> ~63 000 Ft/nap.
