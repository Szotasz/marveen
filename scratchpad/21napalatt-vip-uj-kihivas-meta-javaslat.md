# 21napalatt VIP - új ingyenes kihívás, Meta kampány-terv

Készült: 2026-07-22. Kanban c3b14cb1, PM #345753.
Fiók: 21napalatt VIP (365735307576260), HUF.
Landing: https://vip.21napalatt.hu/ingyenes-kihivas/ (kész, nem nyúlunk hozzá)
Napi keret: 2 500 Ft. Futás: augusztus 2-ig.
Státusz: **TERV. Semmit nem indítottam el, semmilyen beállítást nem módosítottam.**
Sorrend: kreatívok + szövegek -> Zsolt jóváhagyása -> utána setup.

---

## 1. A bevált recept: mit csináltak a korábbi kihívások

Három korábbi kihívás-kampányt vizsgáltam meg a fiókban. **Mindhárom pontosan ugyanazt a felállást használta**, és a beállításaik betűre azonosak.

### 1.1 Eredmények

| Kampány | Futás | Napok | Költés | Lead | Ft/lead | CPM | CTR |
|---|---|---:|---:|---:|---:|---:|---:|
| **Mediterrán saláta** | jún 22 - júl 3 | 11 | 34 382 | **784** | **44** | **480** | 4,97% |
| Tavaszi energiaboost turmix | ápr 22 - ápr 30 | 8 | 37 704 | 220 | 171 | 1 893 | 5,76% |
| Biohacking | máj 20 - máj 31 | 11 | 52 296 | 218 | 240 | 1 432 | 3,65% |

Összesen 1 222 lead 124 382 Ft-ból, átlag 102 Ft/lead.

**A mediterrán saláta 4-5x olcsóbb volt a másik kettőnél**, és a különbség szinte teljesen a CPM-ből jön (480 Ft vs 1 432-1 893 Ft). Az étel-témájú, vizuálisan konkrét kihívás lényegesen olcsóbban ér el embereket, mint az absztrakt (biohacking). A zöldturmix ugyanebbe a kategóriába esik, tehát a saláta-kampány a helyes viszonyítási alap.

### 1.2 Struktúra - mindhárom kampány azonos

- **1 kampány -> 1 hirdetéssorozat** (mindháromnál a neve: `Landingre`)
- Kampánycél: **Leadek**
- Hirdetéssorozat optimalizálás: **OFFSITE_CONVERSIONS**, az eredmény típusa **"Website leads"**, azaz a **weboldali Lead esemény**
- Licit: legalacsonyabb költség, nincs cél-CPA és nincs cél-ROAS
- Attribúció: **1 napos megtekintés / 7 napos kattintás**
- Futásidő: 8-11 nap, a kihívás indulása ELŐTT indulva (a saláta-kihívás július 1-jén indult, a hirdetés június 22-től ment)

### 1.3 Célzás - szintén mindhárom kampányban azonos

| Beállítás | Érték |
|---|---|
| Ország | Magyarország, otthoni és nemrég ott járt |
| Kor | 18-65 (a rendszer 28-50 közé súlyoz) |
| Nem | **csak nők** |
| Érdeklődés-célzás | **nincs, egyáltalán** |
| Advantage+ közönség | **bekapcsolva**, kor és nem esetén is engedve a tágítást |
| Elhelyezések | Advantage+ (Facebook, Instagram, Messenger; hírfolyam, story, reels, felfedezés, marketplace, keresés), mobil és asztali |
| Kizárt közönség | nincs |

**Ez a legfontosabb tanulság: nincs érdeklődés-alapú célzás.** Tiszta széles célzás nőkre, a többit a rendszerre bízva. Ez magyarázza a saláta-kampány alacsony megjelenési költségét, és ez az, amit meg kell tartani.

---

## 2. Javasolt struktúra az új kihíváshoz

### 2.1 A keret és ami belefér

- Napi keret: **2 500 Ft**
- Futás: jóváhagyás után, **augusztus 2-ig**
- Ha július 23-án indul: **11 nap, kb. 27 500 Ft**. Minden csúszó nap kb. 2 500 Ft elérést visz el.

**És itt egy fontos, megnyugtató adat.** Lekérdeztem a korábbi kampányok beállított napi keretét, és kiderült, hogy a legjobb eredményt a legkisebb kerettel érték el:

| Kampány | Beállított napi keret | Eredmény |
|---|---:|---:|
| **Mediterrán saláta** | **3 000 Ft** | **44 Ft/lead** |
| Tavaszi turmix | 8 000 Ft | 171 Ft/lead |
| Biohacking | 10 000 Ft | 240 Ft/lead |

A mostani **2 500 Ft/nap tehát nem egy lecsökkentett változata a nyertesnek, hanem gyakorlatilag ugyanakkora keret** (a saláta-kampányhoz képest 17%-kal kisebb). A szűk keret ebben a fiókban nem hátrány volt, hanem együtt járt a legjobb eredménnyel.

### 2.2 Hány hirdetéssorozat: EGY

**Nem hármat javaslok, hanem egyet.** Három okból:

1. **Ez a bevált felállás.** Mindhárom korábbi kihívás egyetlen hirdetéssorozattal futott, és az 44-240 Ft/lead között teljesített. Nincs okunk eltérni tőle.
2. **A tanulási szakasz matematikája.** A rendszer akkor lép ki a tanulási szakaszból, ha egy hirdetéssorozat heti nagyságrendben 50 konverziót összegyűjt. Egy sorozattal, 2 500 Ft/napon és 60-100 Ft-os lead-áron ez heti 175-290 lead, tehát bőven megvan. **Két sorozatra osztva viszont napi 1 250 Ft jutna mindegyikre**, és mindkettő a tanulási szakasz alsó peremén billegne.
3. **Nincs idő korrigálni.** 11 napból az első 3-5 tanulás. Ha a keretet szétosztjuk, a ténylegesen optimalizált időszak 6-8 napra rövidül, és egy rosszul induló sorozatot már nem tudunk kijavítani.

**A négy kreatív-verzió a helyes tesztelési szint, de a hirdetés szintjén**, egyetlen sorozaton belül. Így a keret együtt marad, és a rendszer maga súlyozza a jobban teljesítő kreatívot.

### 2.3 A javasolt felállás

```
Kampány: 21napalatt VIP - Zöldturmix kihívás - 2026.08
  Cél: Leadek | Konverziós hely: weboldal
  NAPI KERET: 2 500 Ft (kampány szinten, mint a precedensben)
  Licit: legmagasabb volumen | Futás: júl 23 - aug 2
  |
  +-- Hirdetéssorozat: "Landingre"
        Optimalizálás: weboldali Lead esemény
        Saját keret: nincs (a kampányé érvényes)
        Attribúció: 1 napos megtekintés / 7 napos kattintás
        Célzás: Magyarország, nők, 18-65, érdeklődés nélkül,
                Advantage+ közönség és elhelyezések
        |
        +-- V1 - Nyari frissesseg
        +-- V2 - Reggeli rohanas
        +-- V3 - Tobb zoldseg
        +-- V4 - Kozos kihivas
```

Minden hirdetés ugyanarra a landingre mutat: `https://vip.21napalatt.hu/ingyenes-kihivas/`

### 2.4 Amit szándékosan NEM csinálunk

- **Nem osztjuk szét a keretet** több sorozatra.
- **Nem teszünk érdeklődés-célzást** a sorozatra: a korábbi kampányok érdeklődés nélkül futottak, és úgy voltak olcsók.
- **Nem adunk kizárt közönséget.** A korábbiak sem használtak, és ekkora keretnél minden szűkítés drágítja az elérést.
- **Nem állítunk cél-CPA-t.** Ilyen rövid futásnál a licitkorlát csak fékezne.

---

## 3. Várható eredmény

| Forgatókönyv | Ft/lead | Lead 27 500 Ft-ból |
|---|---:|---:|
| A saláta-kampány szintjén | 44 | 625 |
| Reális tervszám (nyári, ételtémájú kihívás) | 60-100 | **275 - 460** |
| A három kampány átlagán | 102 | 270 |
| A leggyengébb (biohacking) szintjén | 240 | 115 |

**Tervszámnak 275-460 leadet javaslok**, mert a zöldturmix ugyanabba a vizuálisan konkrét, ételalapú kategóriába esik, mint a saláta, és a szezon is hasonló. A 44 Ft/lead viszont kivételesen jó eredmény volt, nem szabad alapértelmezésként kezelni.

**Sikerküszöb:** 100 Ft/lead alatt maradni. E fölött a kreatívot kell cserélni, nem a célzást.

---

## 4. Ellenőrzési pontok futás közben

**Fontos előre tisztázni: az első napok gyengébbek lesznek.** A kampányt a korábbi nyertes másolataként építjük fel, de **a másolás a beállításokat örökli, nem a teljesítményt.** A rendszer szempontjából ez egy új kampány, amelynek 3-5 nap tanulási időszakra van szüksége, mielőtt beáll a kiszámítható eredményre. Az első két nap lead-ára ezért jellemzően magasabb, és ez normális, nem hibajel.

| Mikor | Mit nézünk | Mit teszünk |
|---|---|---|
| 2. nap | Fut-e mind a négy hirdetés, van-e mérési jel | Ha nincs konverzió-jelzés, azonnali ellenőrzés |
| 3-4. nap | Lead-ár és a négy kreatív megoszlása | A gyengén teljesítőket kikapcsoljuk |
| 6. nap | Megjelenési gyakoriság | 2,5 felett kreatív-frissítés kell |
| 9. nap | Összesített lead-ár | Döntés a hajrá-napokról |

A korábbi kampányok gyakorisága 1,60 és 2,50 között maradt, tehát 11 nap alatt ez nem szokott gond lenni.

---

## 5. Nyitott kérdés

**Mikor indul maga a kihívás?** A korábbi mintában a hirdetés a kihívás indulása előtt 8-10 nappal indult, és néhány nappal az indulás után állt le (a saláta-kihívás július 1-jén indult, a hirdetés június 22 - július 3 között futott). Ha az új kihívás augusztus elején indul, az augusztus 2-i véghatár pontosan illeszkedik a bevált mintába. Ha később, érdemes a futást is arrébb tolni, mert a regisztráció akkor a legerősebb, amikor az indulás közel van.

---

## 6. Kapcsolódó feladatok más szerepkörben

- **Kreatívok:** 4 verzió, mindegyik zöldturmixos, 1080x1080 PNG. Jóváhagyva.
- **Hirdetésszövegek:** a korábbi, bizonyítottan működő szöveget átadtam, hogy az legyen a kiindulási minta.
- **Jóváhagyás:** a kreatívok és a szövegek elkészülte után, a kampány beállítása előtt.

---

## 7. Végleges hirdetésszövegek (beillesztésre kész)

Elkészültek és átnézve. Formai ellenőrzés: mindhárom horog a hírfolyam-levágás (kb. 125 karakter) előtt végződik, a címek 40 karakter alattiak, a szerkezet a korábbi nyertes szöveg váza, és a három szög érdemben különböző - ez fontos, mert egy hirdetéssorozaton belül versenyeznek egymással.

**Közös beállítás mindhárom hirdetéshez:** cselekvésre ösztönző gomb **"Regisztráció"**, cél-URL `https://vip.21napalatt.hu/ingyenes-kihivas/`.

**Két adat, amit Zsolt erősítsen meg** (mindhárom szövegben egy-egy helyen szerepel, gyorsan cserélhető): az indulás dátuma (`2026. augusztus 1.`, a landing szerint) és a kihívás hivatalos neve (`7 napos nyári zöldturmix-kihívás`, a landing szerint).

### Verzió 1 - Nyári frissesség

**Elsődleges szöveg:**
```
🥤 Nyár van, meleg van, és reggelente valami hűsítőre vágysz, ami mégis feltölt?

Indul a 7 napos INGYENES zöldturmix-kihívás. 💚

7 napon át minden reggel kapsz egy konkrét, krémes, hűsítő zöldturmix-receptet, amit 5 perc alatt összeturmixolsz és viszel is magaddal.

A regisztráció teljesen ingyenes. Ezt kapod:
🥤 7 finom, krémes zöldturmix-recept
🛒 heti bevásárlólista
📱 iOS és Android appos hozzáférés
🌿 egyszerű, bárhol beszerezhető alapanyagok
💚 egy kis lendület egy frissebb nyári rutinhoz

Lemondások nélkül, diéta nélkül, csak napi 1 pohár finom, hűsítő turmix. Imádni fogod!

Indulás: 2026. augusztus 1.

Csatlakozz ingyenesen itt, és hozd a barátnőidet, kolléganőidet is 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
```
**Rövid változat:** Meleg van? Kezdd a napot egy hűsítő zöldturmixszal. Csatlakozz a 7 napos, ingyenes zöldturmix-kihíváshoz 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
**Cím:** 7 napos ingyenes zöldturmix-kihívás
**Leírás:** Hűsítő, krémes, napi 1 pohár.
**Javasolt kép:** nyári, hűsítő hangulat

### Verzió 2 - Reggeli rohanás

**Elsődleges szöveg:**
```
⏰ Reggelente nincs időd egy rendes reggelire, és kapkodva, éhesen indulsz?

Van megoldás, ami 5 percbe telik. Indul a 7 napos INGYENES zöldturmix-kihívás. 💚

7 napon át minden reggel kapsz egy konkrét, gyors zöldturmix-receptet. Bedobod a turmixgépbe, 5 perc, és viszed is magaddal a munkába.

A regisztráció teljesen ingyenes. Ezt kapod:
🥤 7 finom, gyorsan elkészíthető zöldturmix-recept
🛒 heti bevásárlólista, hogy minden otthon legyen
📱 iOS és Android appos hozzáférés
🌿 egyszerű, hétköznapi alapanyagok
💚 egy reggeli rutin, ami tényleg belefér a napodba

Diéta nélkül, bonyolult főzés nélkül, csak napi 1 pohár, 5 perc alatt.

Indulás: 2026. augusztus 1.

Csatlakozz ingyenesen itt 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
```
**Rövid változat:** 5 perc reggel, és kész a reggelid. Csatlakozz a 7 napos, ingyenes zöldturmix-kihíváshoz 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
**Cím:** Reggeli 5 perc alatt, ingyen
**Leírás:** Gyors, krémes, napi 1 pohár.
**Javasolt kép:** gyors, útra kész (pohár, kézben vihető)

### Verzió 3 - Több zöldség, könnyen

**Elsődleges szöveg:**
```
🥬 Tudod, hogy több zöldség kéne, de valljuk be: nyersen nem sok csúszik le, igaz?

Van egy trükk: turmixban észre sem veszed. Indul a 7 napos INGYENES zöldturmix-kihívás. 💚

7 napon át minden reggel kapsz egy konkrét zöldturmix-receptet, amiben a zöldség olyan krémes, gyümölcsös ízt kap, hogy a gyerekek is megisszák.

A regisztráció teljesen ingyenes. Ezt kapod:
🥤 7 finom zöldturmix-recept, amivel tényleg több zöldséget viszel be
🛒 heti bevásárlólista
📱 iOS és Android appos hozzáférés
🌿 egyszerű, bárhol beszerezhető alapanyagok
💚 egy könnyű mód, hogy több energiával induljon a napod

Nincs diéta, nincs lemondás, csak napi 1 pohár finom turmix.

Indulás: 2026. augusztus 1.

Csatlakozz ingyenesen itt, és hozd a barátnőidet is 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
```
**Rövid változat:** A zöldséget turmixban észre sem veszed. Csatlakozz a 7 napos, ingyenes zöldturmix-kihíváshoz 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
**Cím:** Több zöldség, ahogy tényleg megy
**Leírás:** Ingyenes 7 napos kihívás.
**Javasolt kép:** zöldség-alapanyagok, "elrejtve" a turmixban

**Megjegyzés a 3. verzióhoz:** az utolsó listaelem tudatosan kerüli a testképre utaló megfogalmazást. Az egészség- és táplálkozási témájú hirdetéseknél ez visszautasítást válthat ki, és egy 11 napos futásnál nincs idő fellebbezésre.

### Verzió 4 - Közös kihívás

**Elsődleges szöveg:**
```
👯 Egyedül mindig nehéz belekezdeni valami újba, igaz? Ketten viszont már megy.

Ezért csináljuk együtt. Indul a 7 napos INGYENES zöldturmix-kihívás. 💚

7 napon át minden reggel kapsz egy konkrét, krémes zöldturmix-receptet, és nem egyedül csinálod: veled tart a barátnőd, a kolléganőd, és mindenki, aki ugyanakkor vág bele.

A regisztráció teljesen ingyenes. Ezt kapod:
🥤 7 finom, krémes zöldturmix-recept
🛒 heti bevásárlólista
📱 iOS és Android appos hozzáférés
🌿 egyszerű, bárhol beszerezhető alapanyagok
💚 zárt Facebook-csoport, ahol együtt csináljátok végig

Lemondások nélkül, diéta nélkül, csak napi 1 pohár finom turmix. Együtt könnyebb!

Indulás: 2026. augusztus 1.

Hívd a barátnődet, és csatlakozzatok ingyenesen 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
```
**Rövid változat:** Egyedül nehéz, együtt megy. Hívd a barátnődet a 7 napos, ingyenes zöldturmix-kihívásra 👉 https://vip.21napalatt.hu/ingyenes-kihivas/
**Cím:** Vágjatok bele együtt, ingyen
**Leírás:** Barátnőddel még könnyebb.
**Javasolt kép:** a maradék negyedik hero

**Megjegyzés a 4. verzióhoz:** a szöveg tudatosan **nem állít konkrét résztvevőszámot** (például "több száz nő"), mert az erre a futásra még nem igaz. A közösség-érzetet a kohorsz-jelleg hordozza, ami a kihívás természetéből adódóan igaz.

**A közösség-ígéret fedezett, megerősítve.** A kihívás ingyenes résztvevője **zárt Facebook-csoportot** kap, ezért a felsorolásban a közösségi elem nem fedezetlen állítás. A szöveg ennek megfelelően konkrétan megnevezi, hogy zárt csoportról van szó - ez erősebb, mint az elvont "közösség", és összhangban van a fiók saját tanulságával, hogy a konkrét megfogalmazás lényegesen olcsóbban teljesít az absztraktnál.

**Egy határ, amit tartani kell:** a teljes VIP klub felület **kizárólag előfizetőknek** jár, ezért az ingyenes kihívás hirdetésében nem ígérhető. A négy szöveg egyike sem hivatkozik rá, és ez így is marad.

---

## 8. Döntés: oldal-bejegyzés vagy különálló hirdetés-kreatív

**Döntés: oldal-bejegyzésként fut, mint a nyertes kampány.**

**Az indoklás egy mondatban:** a korábbi nyertes hirdetés igazoltan oldal-bejegyzés volt, a társadalmi bizonyíték ennél az ajánlatnál konverziót hoz, és a komment-moderálási teher a másik megoldással sem lenne kisebb - csak nehezebben látható.

Ez az utolsó pont a döntő, és érdemes tisztán kimondani, mert könnyű félreérteni: **a Meta hírfolyam-hirdetéseit akkor is lehet kommentelni, ha nem meglévő bejegyzésből készültek.** A rendszer minden hirdetéshez létrehoz egy nem publikált bejegyzést a háttérben, és a felhasználók ott is hozzászólnak. A "különálló hirdetés-kreatív" tehát **nem szünteti meg a moderálási igényt**, csak elrejti: azok a hozzászólások nem jelennek meg az oldal postaládájában és az értesítések között, hanem hirdetésenként külön kell rájuk keresni a hirdetéskezelőben. Vagyis a látszólag biztonságosabb megoldás valójában a kockázatosabb, mert amit nem látunk, azt nem is moderáljuk.

### 8.1 Automatikus védelem, hogy ne kelljen folyamatos jelenlét

> **KÜLÖN JÓVÁHAGYÁS SZÜKSÉGES, MIELŐTT BÁRMELYIK BEÁLLÍTÁS ÉLESEDIK.**
> Az alábbiak nem a hirdetési fiókot, hanem **magát a Facebook-oldalt és az Instagram-fiókot** módosítják, tartósan, és minden jövőbeli hozzászólásra hatnak - nem csak erre a kampányra. Ezért ezek a kampányindítástól függetlenül külön döntést igényelnek, és **a jóváhagyásig egyik sem kerül beállításra.**
>
> A döntés könnyítése végett: **minden felsorolt beállítás visszavonható**, és a kampány lezárása (augusztus 2.) után egy lépésben visszaállítható az eredeti állapot, ha csak a kampány idejére kellenek.

Ezeket a kampányindítás előtt érdemes beállítani, és utána napi 1-2 perces ránézés elegendő.

**Facebook oldal beállításai, moderálás:**
1. **Trágárságszűrő bekapcsolása** (közepes vagy erős fokozat).
2. **Kulcsszavas automatikus elrejtés.** Javasolt szólista, három csoportban:
   - *Linkes hozzászólások* (az üzleti ajánlgatás jellemzően így érkezik): `http`, `https`, `www`, `bit.ly`, `wa.me`, `t.me`, `whatsapp`, `telegram`
   - *Üzleti ajánlgatás és hálózatépítés*: `üzleti lehetőség`, `munkalehetőség`, `otthonról`, `extra jövedelem`, `passzív jövedelem`, `csatlakozz a csapatomhoz`, `írj privátban`, `írj rám`, `keress meg privátban`, `regisztrálj alám`, `forgalmazó`
   - *Csodaszer és pénzügyi átverés*: `csodaszer`, `zsírégető`, `garantált fogyás`, `nyertél`, `nyeremény`, `befektetés`, `kripto`, `bitcoin`
3. **Instagram külön beállítás.** Az elhelyezések között az Instagram is szerepel, és annak a hozzászólás-szűrője független a Facebookétól: az Instagram fiók beállításai között a rejtett szavak listáját ugyanezekkel a kifejezésekkel kell feltölteni.

**Fontos korlát, amit tudni kell:** ezek a beállítások az **egész oldalra** érvényesek, nem csak erre a kampányra, és visszamenőlegesen is hatnak az új hozzászólásokra. Bármikor visszavonhatók, de érdemes tudni, hogy nem kampány-szintű kapcsolók.

### 8.2 Napi ellenőrzés, ami tényleg elég

A Facebook oldal postaládájában és az értesítések között, naponta egyszer, néhány perc: a nem elrejtett hozzászólások átfutása, a valódi kérdésekre válasz, a maradék spam kézi elrejtése. **Erre pont azért van mód, mert oldal-bejegyzésként fut** - a hirdetés-szintű bejegyzések hozzászólásaihoz ez a felület nem is mutatna semmit.

### 8.3 A társadalmi bizonyíték koncentrálása

Mind a négy bejegyzés elindul. A 3-4. napi ellenőrzéskor a gyengébben teljesítők kikapcsolnak, és a maradék hét-nyolc napban a túlélő bejegyzés gyűjti egy helyre a reakciókat és a hozzászólásokat. Így a tesztelési információt nem veszítjük el, a hajrá-szakaszra viszont koncentrált társadalmi bizonyíték áll rendelkezésre.

---

## 9. Setup-lap: minden mező beírható értékkel

Ez a fejezet önmagában elegendő a kampány felépítéséhez. Minden mezőnél konkrét érték áll, nincs benne eldöntendő kérdés.

### 9.1 Kampány szint

**A keret a kampányon áll, nem a hirdetéssorozaton.** Ez az ellenőrzött precedens: mindhárom korábbi kihívás kampányszintű napi kerettel futott (saláta 3 000 Ft, turmix 8 000 Ft, biohacking 10 000 Ft), a hirdetéssorozaton nem volt külön keret.

| Mező | Érték |
|---|---|
| Kampány neve | `21napalatt VIP - Zöldturmix kihívás - 2026.08` |
| Célkitűzés | **Leadek** |
| Konverziós hely | **Weboldal** |
| **Kampányszintű költségkeret (Advantage kampányköltségkeret)** | **BE** - a precedens így futott, a keret a kampányon áll, nem a hirdetéssorozaton |
| **Napi költségkeret (kampány szinten)** | **2 500 Ft** |
| **Licitstratégia** | **Legmagasabb volumen** (a felületen így hívják a legalacsonyabb költség stratégiát; nincs licitkorlát, nincs cél-eredményár) |
| **Kampány kezdése** | legkorábban **2026. július 23.** |
| **Kampány befejezése** | **2026. augusztus 2., 23:59** |
| A/B teszt | nem |
| Speciális hirdetési kategória | **nincs** (nem hitel, nem álláshirdetés, nem lakhatás, nem politika) |

### 9.2 Hirdetéssorozat szint

| Mező | Érték |
|---|---|
| Hirdetéssorozat neve | `Landingre` |
| Konverziós esemény helye | Weboldal |
| Adatkészlet (pixel) | **21napalatt VIP Klub**, azonosító `1996766707097683` |
| Konverziós esemény | **Lead** |
| Költségkeret | **nincs a hirdetéssorozaton** - a kampány szintjén áll (lásd 9.1) |
| Ütemezés | a kampány ütemezését követi |
| Országok | **Magyarország** |
| Helymeghatározás típusa | ott lakó és nemrég ott járt emberek |
| Kor | **18-65** |
| Nem | **nők** |
| Részletes célzás (érdeklődés, viselkedés) | **nincs, egy sem** |
| Advantage+ közönség | **bekapcsolva**, a kor és a nem tágítása engedve |
| Kizárt közönség | **nincs** |
| Elhelyezések | **Advantage+ (automatikus)** |
| Attribúciós beállítás | **1 napos megtekintés, 7 napos kattintás** |

### 9.3 Hirdetés szint - négy hirdetés

Mind a négy **meglévő oldal-bejegyzés** felhasználásával készül (nem újonnan feltöltött hirdetés-kreatívval).

Közös értékek mind a négyre:

| Mező | Érték |
|---|---|
| Cél-URL | `https://vip.21napalatt.hu/ingyenes-kihivas/` |
| Cselekvésre ösztönző gomb | **Regisztráció** |
| Formátum | egyetlen kép |
| Képméret | 1080 x 1080 (1:1) |
| Nyomon követés | a fenti adatkészlet (`1996766707097683`) |

Az egyes hirdetések neve és párosítása:

**A képek megérkeztek és ellenőrizve lettek.** Mind a négy 1080x1080 PNG, a fejléc és a "Start: augusztus 1." dátum mindegyiken helyes.

| Hirdetés neve | Képfájl | A kép tartalma | Szöveg |
|---|---|---|---|
| `V1 - Nyari frissesseg` | `V1-nyari-frissesseg.png` | kiöntés, termék-közeli | 7. fejezet, Verzió 1 |
| `V2 - Reggeli rohanas` | `V2-reggeli-rohanas.png` | egy nő a konyhában | 7. fejezet, Verzió 2 |
| `V3 - Tobb zoldseg` | `V3-tobb-zoldseg.png` | spenót kerül a turmixgépbe, alatta alma és sárgarépa | 7. fejezet, Verzió 3 |
| `V4 - Kozos kihivas` | `V4-kozos-kihivas.png` | négy nő együtt, mindegyik kezében zöldturmix, nevetnek | 7. fejezet, Verzió 4 |

A képfájlokat a szövegverziók szerint neveztük át, ezért a párosítás magától adódik, nincs mit eltéveszteni. Az eredeti export a tervezőprogram oldal-sorrendjét követte, amelyben a harmadik és a negyedik kép fordítva állt a szövegekhez képest - ezt az átnevezés véglegesen megszünteti.

**A párosítás elve:** a szöveg hordozza a szöget, a kép megerősíti. Ahol a kép tartalma egyértelműen egy szöghöz köthető (közösség, zöldség), ott a tartalmi egyezés a döntő.

### 9.4 A bejegyzések létrehozása

**Elsődleges útvonal:** a négy bejegyzést a kampányt összeállító fél hozza létre. Ha ez valamilyen jogosultsági okból ténylegesen nem sikerül, akkor - és csak akkor - kerül át a feladat az oldalt kezelő félhez, a külön átadható csomag alapján. A sorrend fontos: előbb megpróbáljuk, és csak a tényleges hibaüzenet után lépünk a tartalék útvonalra.

Minden hirdetéshez egy-egy oldal-bejegyzés kell a Facebook-oldalon (azonosító: `292200250940748`), a következő felépítéssel:

1. Bejegyzés típusa: **link megosztása** a `https://vip.21napalatt.hu/ingyenes-kihivas/` címre.
2. A bejegyzés szövege: a hozzá tartozó verzió elsődleges szövege a 7. fejezetből.
3. Cselekvésre ösztönző gomb: **Regisztráció**.
4. Kép: a hozzá tartozó 1080x1080-as kép.
5. **A bejegyzések kizárólag NEM PUBLIKÁLT formában készülhetnek.** Nem jelenhetnek meg az oldal idővonalán, tehát az oldal nevében nem kerül ki nyilvános tartalom. Ez a hirdetéseknél szokásos eljárás, és a hozzászólások, reakciók ettől függetlenül ugyanúgy gyűlnek a bejegyzésen, vagyis a társadalmi bizonyíték nem vész el. Ha valamilyen okból nem hozható létre nem publikált bejegyzés, a folyamat megáll és jelezni kell - publikált bejegyzés nem alternatíva.

### 9.5 Amit a kreatívoktól kérünk

- **Formátum:** PNG, **1080 x 1080** pixel, verziónként külön fájl.
- **Fájlnevek:** `turmix-v1.png`, `turmix-v2.png`, `turmix-v3.png`, `turmix-v4.png`.
- **Ellenőrzendő a képeken:** a "Start: augusztus 1." felirat dátuma helyes, és a kihívás neve egyezik a szövegekben használt névvel.

### 9.6 Indítás előtti utolsó ellenőrzés

1. Az adatkészlet aktív, és a **Lead** esemény érkezik a landing oldalról (a rendszer szerint az adatkészlet ma is fogadott adatot).
2. A hirdetéssorozaton be van állítva a **befejezés dátuma**, különben augusztus 2. után is költene.
3. Mind a négy hirdetés jóváhagyott állapotban van (elutasítás esetén a szöveg vagy a kép módosítandó, erre a rövid futás miatt nincs sok idő).
4. A cél-URL kattintásra a megfelelő oldalra visz, és a regisztrációs űrlap működik.

### 9.7 Megjegyzés a méréshez

Az adatkészlet jelenleg **kizárólag böngészőoldali adatot** kap, szerveroldali (Conversions API) jelzés nem érkezik. Ez nem akadálya a kampánynak, és a korábbi kihívások is így futottak. Hosszabb távon viszont a szerveroldali mérés bekötése pontosabb optimalizálást adna, mert a böngészőoldali mérés a hirdetésblokkolók és a sütikezelés miatt rendszerint alulmér. Ez külön feladat, nem ennek a kampánynak a része.
