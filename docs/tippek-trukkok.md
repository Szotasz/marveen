# Tippek, Trükkök

> Bevált fogások, amelyekkel gyorsabban és hatékonyabban dolgozhatsz a Marveen flottával.

---

## 1. Ügynök-leírók önfelülvizsgálata és skill-be szervezése

Az ügynökök CLAUDE.md leírói időszakosan felülvizsgálhatják önmagukat: ami procedurális és ismétlődő (API-receptek, lépéssorok), az kerüljön skillbe (recall-on-demand formában). A viselkedési és biztonsági mag maradjon a leíróban. A folyamat maga is delegálható -- kérd meg az ügynököt, hogy tekintse át saját leíróját, és amit skillbe tud szervezni, azt tegye meg.

Példa prompt: "Vizsgáld meg az ügynökök CLAUDE.md leíróit: mi emelhető át belőlük (a viselkedési és biztonsági magot meghagyva) közös skillbe, hogy csökkenjen a leíró mérete és a tokenhasználat?"

**Elért hatás:** 6 sub-ügynök CLAUDE.md-je 103-ról 54 sorra csökkent; a fő CLAUDE.md 292-ről 194 sorra; a duplikált API-receptek egyetlen közös skillbe kerültek. Minden session indításakor kevesebb token töltődik be -- kisebb kontextus, gyorsabb válasz.

---

## 2. Cimke-vezérelt kész-állapot email-értesítő workflow

Ha egy ügynöknek van levelküldési lehetősége (pl. Google Workspace MCP), egy cimke segítségével kialakítható olyan workflow, amely egy kártya DONE állapotba kerülésekor automatikusan emailt küld az érintettnek. A cimke jelöli ki, melyik kártyák tartoznak a workflow-ba; egy ütemezett (heartbeat) feladat figyeli a done+cimkés, még nem értesített kártyákat, kiküldi az emailt (ékezetes tárggyal), majd megjelöli a kártyát, hogy ne ismétlődjön. PII-érzékeny esetekben beépíthető humán jóváhagyási lépés.

Élő példa: az Eszter-cimke + eszter-done-ertesito ütemezett feladat -- a done Eszter-cimkés kártyákról email megy egy megadott címre.

**Elért hatás:** automatikus, megbízható értesítés a kész feladatokról kézi lépés nélkül; a cimke bármely projektre újrahasználható.

---

## 3. Nagyobb feladat kanbanra és AI-bontással

Ha nagyobb feladatot adsz az ügynöknek, tedd kanbanra, majd használd a "Kanbanra (AI)" bontást: az ügynök maga osztja értelmes részfeladatokra, prioritásokkal és felelős ügynökkel. Nem kell előre megtervezned az egész struktúrát.

**Elért hatás:** gyorsabb delegálás, átláthatóbb haladás, kevesebb kézi tervezés.

---

## 4. Ötletláda mint puffer és priorizáló

A még nem érett ötleteket vedd fel az Ötletládába impact/effort pontozással, és csak a jóváhagyottakat promotáld a kanban táblára. Az Ötletláda nem feladatlista -- szűrő, ahol az ötletek érnek és priorizálódnak.

**Elért hatás:** semmi ötlet nem veszik el, de a kanban tábla sem zsúfolódik; a pontozás segít eldönteni, mi a legjobb következő lépés.

---

## 5. Cimkézz témára vagy projektre

Lásd el a kártyákat cimkékkel téma vagy projekt szerint. Így a táblán gyorsan szűrhetsz, és értesítő- vagy automatizált workflow-kat is építhetsz rá (lásd 2. tipp). A swimlane nézet cimkék szerint is csoportosítható.

**Elért hatás:** gyors áttekintés és szűrés; a cimke workflow-kapcsolóként is működik.

---

## 6. Használj saját aliasokat

Definiálj rövid saját kulcsszavakat az ismétlődő kérésekhez, amelyek egyetlen szóra egy egész összetett workflow-t indítanak el. Nem kell minden lépést külön kérned -- az alias elvégzi helyetted.

Példa: a "napindító" kulcsszó a teljes reggeli láncot futtatja (Dream Engine -> Peter edzés-összefoglaló -> email -> naptár) egyetlen szóra.

**Elért hatás:** gyorsabb, konzisztens napi vezérlés; az ismétlődő rutinok egy kulcsszóra indulnak, és nem térnek el a szokásos sorrendtől.

---

## 7. Időszakos modell-elemzés minden specializált ügynökhöz

Rendszeresen vizsgáld felül, melyik Claude-modellt használja minden specializált ügynök (az `agent-config.json` "model" mezőjét), és igazítsd a szerepköréhez és az aktuális modell-kínálathoz.

Egy nehéz, magas szellemi igényű szerepkör -- architektúra-tervezés, komplex kódgenerálás, több forrást egyesítő elemzés -- erősebb modellt indokolhat, ahol a minőség az elsődleges szempont. Egy egyszerűbb, rutinszerűbb szerep -- naptár-összefoglaló, email-értesítő, adatformázás -- könnyebb, gyorsabb és olcsóbb modellel is ugyanolyan jól működik. Új modellek megjelenésekor érdemes az egész flottát újraértékelni.

A rendszeres felülvizsgálat hozadékai:

- Jobb minőség ott, ahol számít: a nehéz feladatokhoz a legerősebb elérhető modell dolgozik
- Alacsonyabb költség és kisebb késleltetés ott, ahol elegendő: a rutin szerepköröknél a könnyebb modell is teljesít
- A flotta naprakészen marad a modell-fejlődéssel -- egy ma gyengébb modell fél év múlva már elég lehet egy szerepkörhöz
- Tudatos erőforrás-gazdálkodás: nem minden ügynök igényli a legsúlyosabb modellt
- Dokumentált döntés: minden modellváltást jegyezz fel (commitüzenet, napi napló) -- miért váltottál és mikor; néhány hónap múlva elvész a kontextus, ha csak az agent-config.json-ban van nyoma
- Kockázatkezelés: kritikus szerepkörű ügynöknél (architektúra-tervezés, összetett elemzés) legyen tesztelési periódus az új modellel, mielőtt véglegesen átállsz; egy gyorsabb-olcsóbb modell tűnhet elégnek, amíg éles terhelés alatt nem derül ki a minőségromlás

**Elért hatás:** optimális minőség/költség/sebesség-arány az egész flottában; kisebb számlák a rutin szerepköröknél, nagyobb teljesítmény ott, ahol szükséges.

---

## 8. Heartbeat-ek időszakos felülvizsgálata és ütemezésük ritkítása

Az ütemezett heartbeat-feladatok könnyen szaporodnak, és az eredetileg indokolt futási sűrűség idővel feleslegessé válhat. Rendszeresen nézd át, melyek azok, amelyek tipikusan semmit sem találnak (no-op futások), és ritkítsd az ütemezésüket. A legtöbb értesítő-típusú feladatnál az óránkénti futás éppoly időben szállítja az eredményt, mint a 10 percenkénti -- de 6-szor kevesebb LLM-hívással jár.

Konkrét példa: az eszter-done-ertesito feladat 10 percenkéntiről (`*/10 * * * *`) óránkéntire (`0 * * * *`) állítva -- napi 144 helyett 24 futás, az értesítés továbbra is perceken belül megérkezik.

Az ütemezés a dashboard Ütemezés oldalán vagy az API-n keresztül módosítható; a futási előzmények alapján ítélhető meg, hogy melyik feladat érdemes a ritkításra.

Ritkítás előtt mérd fel az időkritikusságot: ha egy feladat eredménye perceken belül hatással van valamire (pl. azonnali riasztás, SLA-küszöb, üzleti folyamat blocker), ne ritkítsd -- ott a futási sűrűség indokolt. A ritkítás csak ott előnyös, ahol az eredmény késleltetése semmit sem ront az értéken.

A felülvizsgálatot tedd rendszeressé (pl. havi egyszer): egy feladat fontossága változhat, és ami ma még szükséges volt, két hónap múlva már no-op-nak számít.

**Elért hatás:** token- és erőforrás-megtakarítás a felesleges no-op LLM-futások kiszűrésével; kisebb zajszint a naplókban -- anélkül, hogy az időkritikus figyelések sérülnének.
