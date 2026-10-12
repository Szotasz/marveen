# Külső skill-katalógus

> Gyűjtőhely azoknak a külső agent-skilleknek, MCP-szervereknek és keretrendszereknek, amelyekről tudunk.
> Attól, hogy egy tétel itt szerepel, még NINCS telepítve. A cél az, hogy amikor legközelebb előjön
> ("ezt láttam valahol"), ne kelljen újra felkutatni, és látszódjon, hogy megnéztük-e már.

## Hogyan használd

- Új tétel: vedd fel a táblázatba és írj hozzá egy rövid blokkot a "Tételek" alá.
- A leírás **a forrás állítása**, nem mért tény. Amit mi mértünk, azt a "Mérés" sor jelöli, dátummal.
- Státuszok: `jelölt` (érdekes, nincs döntés), `mérés alatt`, `telepítve`, `elvetve` (indoklással), `fedve` (már van nálunk ugyanerre megoldás).
- Az elvetett tételeket NEM töröljük. A "miért nem" legalább annyit ér, mint a "miért igen".

### Minden mérés 0. lépése: projekt-azonosítás (flotta-előírás, 2026-08-22)

**A repo-név nem azonosítás.** Mielőtt bármit mérnél vagy telepítenél, ellenőrizd, hogy a megadott
repo README-je azt csinálja-e, amit a katalógus (vagy a forrás) állít róla. Ha nem, előbb a valódi
forrást kell megtalálni, és a katalógusban javítani a linket.

Ez nem elméleti óvatosság, és a példa mindkét irányban tanulságos. Iris 2026-08-22-én gyanút jelzett,
hogy a Defuddle-höz megadott repo mást csinál, mint amit a videó mutat. Zara elvégezte az azonosítást,
és a kép árnyaltabb lett, mint bármelyik előzetes állítás (lásd az 1. tételnél):

- A **link nem hibás**: a linkelt repo tartalmazza a `skills/defuddle/SKILL.md`-t, tehát azt kapod, amit
  a videó mutat. Ennyiben a gyanú nem igazolódott.
- A **sejtés a különálló eszközről viszont igaz**: a `kepano/defuddle` külön létezik, az a CLI, amit a
  skill hív. A videó listája tehát a TÍPUSBAN félrevezető, nem a címben.

Ezért kell a lépés: **a gyanú is állítás, amit meg kell mérni, mielőtt döntést építünk rá**, és a
mérés itt sem a forrást, sem a gyanút nem hagyta érintetlenül. A tanulság változatlan: a repo-név, a
link és a bemutatott funkció három külön dolog, amíg valaki össze nem veti őket.

### A másik 0. kérdés: mihez képest méri magát? (Marveen, 2026-08-22)

Minden külső eszköz a **saját választott viszonyítási alapjához** képest méri magát, és az szinte soha
nem a mi mai utunk. A Defuddle a nyers WebFetch-hez képest javít sokat, nálunk viszont a külső tartalom
már az elkülönített olvasón megy át. A YouTube-ágnál ugyanez történt: a "hiányt" nem a termék állítása
cáfolta meg, hanem a saját utunk.

Ezért a projekt-azonosítás mellé: **mi a mi mai állapotunk ugyanabban a dimenzióban?** Enélkül a
termék állítását mérjük, nem a nyereséget.

**És ha az arány nem mérhető, tervezz eldönthető próbát.** Feltételeztük, hogy a nyers oldalméret nálunk
senkinek nem elérhető, mert az egress-kapu a közvetítetlen lekérést tagadja meg. **Ez így nem állt:**
`curl | wc -c` esetén csak a bájtszám jön vissza, tartalom nem kerül a kontextusba, tehát a MÉRET
megmérhető anélkül, hogy a tartalom útját megkerülnénk. A kettő nem ugyanaz a kockázat, és ezt érdemes
külön tartani.

Ahol tényleg nincs hányados, ott azt kell megnézni, hogy **a clutter túléli-e a mi utunkat**: ismert
szeméttel teli oldal megy át az olvasón, és a KIMENETBEN keressük a szemetet. Ehhez **pozitív kontroll
kell**: előre tudni kell, hogy a bemenetben ott volt a szemét, különben a tiszta kimenet ugyanúgy
jelentheti azt, hogy a szűrő jó, mint azt, hogy nem is volt mit szűrni. Erre készült a
`work/defuddle-baseline/cluttered.html` sentinel-oldal.

**Egy harmadik csapda, ami itt elő is jött:** ha a mérőeszköz maga egy PROMPT (mint az olvasónk),
akkor a kimenet a KÉRDÉSTŐL is függ. Ugyanazt kell kérni minden mintán, és ki kell mondani, mit
kértünk, különben a saját kérésünket mérjük.

**A két próba két különböző hibairányt mér, és nem helyettesítik egymást:**
- **Valódi oldal** az ALULSZŰRÉST mutatja meg (bennmaradt menü, cookie-szöveg, forráskód), mert a
  szemetet felismerjük a kimenetben akkor is, ha a bemenetet nem láttuk.
- **Épített sentinel-oldal** a TÚLSZŰRÉST mutatja meg (elveszett cikk-tartalom), amit valódi oldalon
  nem lehet mérni, mert nem tudjuk, mi lett volna a teljes elvárt szöveg.

**Álló kikötés a mérés árára (Marveen, 2026-08-22):** ha egy belső méréshez a fájlt csak PUBLIKUS
közzététellel lehetne elérhetővé tenni, azt NEM tesszük meg. Egy belső mérés nem ér meg egy kifelé ható
lépést. Ilyenkor marad a gyengébb változat, és a doksiba **eredményként kell odaírni, melyik felét
mértük kontrollal és melyiket nem.**

**A sentinel-próba ebben a formában nem futtatható (Zara mérése, 2026-08-22).** Az elkülönített olvasó
nem éri el a lokális címet: pozitív kontrollal igazolva, hogy a kiszolgálás jó (`curl` HTTP 200, 3219
bájt), az olvasó viszont `status: 0`, `error: "domain not on quarantine-reader fetch allowlist"` választ
ad, tehát a lista utasítja vissza, még a hívás előtt. A listener utána leállítva.

Három út volt, és mindkét kézenfekvő kiesett:
- **Publikus repóból kiszolgálni**: a fenti álló kikötés zárja ki. Egy belső mérésért nem publikálunk.
- **Allowlist-bejegyzés a `127.0.0.1`-re**: nem kérjük. Az olvasó dolga épp az izolálás, a loopback
  megnyitása pedig egy egész osztályt nyitna meg neki (a saját belső szolgáltatásaink is ott figyelnek).
  A mérés haszna ezt nem éri meg.
- **Marad a kontrollálható valódi oldal**: olyan lap, aminek a KANONIKUS szövegét mi magunk tartjuk
  (pl. saját blogposztunk, ahol a forrás a blog-API-ban megvan). Ez az egyetlen változat, ami
  publikálás és kapu-nyitás nélkül ad pozitív kontrollt mindkét irányra.

**Zara módszertani figyelmeztetése a sentinelekhez:** ha az olvasó összefoglal, egy hiányzó sentinel két
dolgot jelenthet: kiszűrte, vagy csak nem írta ki. Operatívan hasonló, a következtetés viszont nem az:
az első szűrő-képesség, a második véletlen.

### Az átadott külső szöveg nem szó szerinti (Zara kikötése, 2026-08-22)

Amikor külső oldalt az elkülönített olvasón át hozunk le, a visszaadott szöveg **tömörített,
értelmezett változat**, nem bitre pontos, és az olvasó ezt maga is jelzi. Ez a legtöbb kérdéshez elég,
de ahol a pontos szöveg számít (idézet, licenc-szöveg, parancs-szintaxis), ott két út van: mérd meg
függetlenül a repo-metaadatból vagy a fájlokból, vagy kérd le bitre pontosan (`gh api` + base64).

Ezért a katalógusban a licenc, a verziószám és a konfigurációs értékek **mért adatok**
(repo-metaadat, `pipeline_defs/*.yaml`), nem az átadott prózából vett idézetek.

**Pontosítás a nap végén:** ez a VÁLASZRA igaz, nem a teljes útra. A fetcher az engedélyezett
domainekre egy determinisztikus, forrás-közeli markdown-törzset ír fájlba (két futás, azonos sha1),
és idézethez az a fájl a helyes forrás, nem a válasz szövege. Lásd az 1. tételnél.

### Ez a doksi és az Ötletláda viszonya (Marveen döntése, 2026-08-22)

A kettő más életciklus-szakaszra való, ezért nem párhuzamos nyilvántartás:

- **A tétel itt születik.** Ez a doksi azt hordozza, amit még NEM tudunk: forrás-állítás, kockázat,
  mire fedi a mienk. Ehhez próza kell és a "miért nem" megőrzése.
- **Az Ötletláda impact/effort pontozást vár.** Egy még nem mért tételnél az találgatás lenne.
- **Átkerülni akkor kerül át** ötletként az Ötletládába, amikor a mérés megvan és a verdikt
  "csináljuk". Ott már van mit pontozni.

Egy hely szakaszonként, nem kettő ugyanarra.

## Áttekintés

Forrás: Sharbel A., "10 Hermes Agent Skills You NEED To Install Today" (YouTube, 2026-08-16, 13:19).
A repo-linkek a videó saját leírásából valók. Felvéve: 2026-08-22 (Iris).

| # | Név | Típus | Repo | Státusz | Gazda / határidő | Elsődleges haszon nálunk |
|---|-----|-------|------|---------|------------------|--------------------------|
| 1 | Defuddle | eszköz (`kepano/defuddle`, CLI) + skill-csomag egy tétele, MIT | kepano/obsidian-skills | **`fedve`** (a szó szerinti út is megvan, fájlon át) | Iris, lezárva | token, tisztaság és forrás-közeli szöveg: mind megvan |
| 2 | Caveman | skill | juliusbrussee/caveman | **elvetve** | - | kimeneti token-költség |
| 3 | Codebase Memory | MCP | DeusData/codebase-memory-mcp | mérés alatt | Samu / 2026-08-29 | repo-feltérképezés, ütközik a gitnexusszal |
| 4 | Humanizer | skill | blader/humanizer | jelölt (alacsony prio) | - | AI-jegyek kiszedése szövegből |
| 5 | Agent Reach | Python CLI csomag | Panniantong/Agent-Reach | mérve, döntés a gazdáé | Zara mért, Szabi dönt | Reddit-rés zárása (az X poszt-szinten ma is megy) |
| 6 | Marketing Skills | skill-pack | coreyhaines31/marketingskills | mérés alatt (részhalmaz) | Zara | 49-ből a nekünk való 5-8 |
| 7 | Composio | platform | composiohq/composio | referencia | - | 1000+ eszköz-integráció, a connectors.hu versenytársa |
| 8 | OpenMontage | keretrendszer (**AGPL-3.0**) | calesthio/OpenMontage | **mérve, minta átvehető** (kód: nem) | Iris, lezárva | renderelés előtti költségbecslés + küszöbhöz kötött kapu |
| 9 | Oh My Claude Code | skill | Yeachan-Heo/oh-my-claudecode | jelölt | - | feladat-bontás + verifikáló ügynök |
| 10 | Superpowers | keretrendszer | obra/superpowers | jelölt (nagy) | - | skill-keretrendszer módszertannal |
| 11 | Mission Control | saját projektje | sharbelxyz/hermes-agent-mission-control | referencia | - | flotta-dashboard, a mienk versenytárs-nézete |
| 12 | Nova | agent | sharbelxyz/nova-youtube-agent | referencia | - | YouTube-növekedési ügynök |

## Tételek

### 1. Defuddle
Weboldalt tiszta reader-mode markdownra csupaszít, mielőtt az ügynök beolvassa: nincs menü, footer,
cookie-sáv, hírlevél-popup a kontextusban. A forrás szerint ez a legolcsóbb nyereség a listán.
**Nálunk:** minden külső fetch a quarantine-readeren megy át, tehát egy helyen becsatlakoztatható.
**PROJEKT-AZONOSÍTÁS KÉSZ (Zara, 2026-08-22). Nem egy projekt van, hanem KETTŐ, és a videó listája
a TÍPUSBAN félrevezető, nem a linkben.**

- **`kepano/defuddle`**: maga az ESZKÖZ. TypeScript könyvtár + CLI, npm-csomagnév `defuddle` (0.19.2),
  MIT, honlap defuddle.md, önleírás: "Get the main content of any page as Markdown". **Nem agent-skill.**
- **`kepano/obsidian-skills`** (ez van a videóban linkelve): agent-skill **csomag** öt skillel
  (defuddle, json-canvas, obsidian-bases, obsidian-cli, obsidian-markdown), MIT, utolsó push
  2026-06-08. A benne lévő `skills/defuddle/SKILL.md` a fenti CLI-t hívja: "Extract clean markdown
  content from web pages using Defuddle CLI ... Use instead of WebFetch".

Vagyis aki a videó alapján klónozza a linket, azt kapja, amit a videó mutat, csak további négy skill
kíséretében. Nekünk ebből egyetlen skill kell, nem az egész csomag, és a mögötte lévő eszköz külön repo.

**MÉRÉS (Zara, 2026-08-22, két valódi dokumentáció-oldal).** A nyers méret mégis megmérhető volt, mert
`curl | wc -c` esetén CSAK a bájtszám kerül vissza, tartalom nem: a külső tartalom útja változatlanul az
olvasó maradt.

| Oldal | Nyers HTML | Amit mértünk | Arány |
|-------|-----------:|--------------|------:|
| docs.claude.com/.../hooks | 2 655 187 bájt | 12 569 karakter (a korrekció után nem újramérve) | kb. 211x |
| docs.claude.com/.../settings | 604 167 bájt | 54 724 bájt = a fetcher FÁJLBA írt törzse | kb. 11x |
| docs.claude.com/.../settings | 604 167 bájt | 743 bájt = ami a KONTEXTUSBA jutott | kb. 800x |

**Fontos korrekció (Zara, 2026-08-22):** az 54 724 bájt NEM az, ami a kontextusba jut, hanem a fetcher
által fájlba írt markdown-törzs. A kontextusba az első futásnál kb. 2 KB előnézet plusz egy fájl-mutató
jutott, a másodiknál 743 bájt. A "11x" tehát valós szám, csak MÁST mér: nem a kontextus-költséget.
A tényleges kontextus-arány a normál kérdésnél kb. 800x.

**Módszertani kikötés:** az olvasó egy PROMPTOT futtat a lapra, tehát a kimenet mérete a kéréstől is
függ. Zara mindkettőnél ugyanazt kérte ("reprodukáld a fő dokumentáció-szöveget minél teljesebben").
Összefoglaló-kérés sokkal kisebb számot adott volna, és az nem a Defuddle-ról szólna.

**VERDIKT, KÉT RÉSZRE BONTVA (Iris, 2026-08-22):**
- **A token-megtakarítás nálunk `fedve`.** A nagyságrendet a mai utunk már megadja, mindkét oldalon
  teljesül a 10-20x küszöb, az egyiken két nagyságrenddel. A Defuddle ezen a tengelyen nem hoz újat.
- **A kimenet TISZTASÁGA viszont nyitva marad.** A settings-oldalnál a kimenet 614 nem-üres sorából 248
  (40 százalék) JSX/CSS forráskód volt (`export const SettingsPrecedence = () => {`, `--sp-text: #1A1918`).
  A hooks-oldalnál ez nem fordult elő. Ez nem csak elpazarolt token, hanem zaj a kontextusban.

**AMI EBBŐL NEM KÖVETKEZIK:** hogy a Defuddle megoldja. A 40 százalékos kód-arány a "reprodukáld minél
teljesebben" kérésre jött, ami maga is hívhatta a forráskódot. Ezért a következő lépés nem telepítés,
hanem **kontroll**: ugyanaz az oldal, normál kérdéssel, és megnézzük, átjön-e megint a kód. Ha igen, a
hiba a MI utunkban van, és előbb azt kell javítani, mint külső eszközt hozni rá.

**KONTROLL LEFUTOTT (Zara, 2026-08-22): a 40 százalék a MÉRÉS artefaktuma volt, nem a rendszeré.**
Ugyanaz a settings-oldal, normál kérdéssel ("milyen sorrendben érvényesülnek a settings-források"):
7 nem-üres sor, ebből **0 forráskód**, 743 karakter / 105 szó, tiszta próza.

| Ugyanaz az oldal, más kérés | Méret | Nem-üres sor | Ebből kód |
|---|---:|---:|---:|
| "reprodukáld minél teljesebben" | 54 724 bájt | 614 | 248 (40%) |
| "válaszolj erre a kérdésre" | 743 bájt | 7 | 0 (0%) |

Vagyis a kód nem azért jött át, mert az utunk átengedi, hanem mert a teljes reprodukciót kérték, és a
lap forrása ilyen. **A "a mi utunk hibája" olvasat elesik**, és ezzel Zara a saját leletét cáfolta.
Kikötés: ez egy oldal két kéréssel, tehát azt igazolja, hogy a kérés dominál, nem azt, hogy normál
kérésnél soha nem jön át zaj.

**A HŰSÉG-KÉRDÉS VÉGLEGES ÁLLÁSA, ÉS EGY VISSZAVONÁS (Iris, 2026-08-22).** Napközben kétszer is azt
állítottam, hogy **nincs szó szerinti utunk tetszőleges weboldalra**. Ez lényegében téves, és a
mérés cáfolta: a fetcher az engedélyezett domainekre egy **determinisztikus, forrás-közeli
markdown-törzset ír FÁJLBA**. Zara két futást vetett össze ugyanarra a lapra: `sha1
67ec7b325f58b8dafa5c223a84d7c2b6fac8c55b`, 54 724 bájt mindkettőnél, nulla eltérő sor.

A pontos megfogalmazás tehát: **a szó szerinti út létezik, de FÁJLON át, nem a válaszon át.** A
kontextusba értelmezett válasz jut, a fájlban viszont ott a forrás-közeli törzs, ami idézethez elég
lehet. Amit ez a mérés NEM dönt el: hogy a törzs bitre azonos-e azzal, amit a szerver küld. Ezt csak a
nyers válasz materializálásával lehetne igazolni, azt pedig a saját határunk tiltja, ezért szándékosan
nem mértük meg.

**A hat bájt nem lelet volt, hanem mértékegység-hiba** (bájt vs. karakter, hat többbájtos karakter), és
a két szám nem "forrás vs. kimenet" volt, hanem ugyanannak a lapnak két futásban perzisztált törzse.
Zara mindkét hibát maga találta meg és javította.

**UGYANAZ A FÁJL, KÉT OLVASAT:** ami képességként a szó szerinti idézet forrása, az csapdaként a
token-nyereség elvesztése, ha valaki gondolkodás nélkül beolvassa a teljes törzset. Ugyanaz az
artefaktum, ellentétes előjellel, a használattól függően.

**A mérés határai (Zara jelezte):** két oldal nem minta, és mindkettő ugyanabból a doksi-rendszerből
való, tehát az SPA-keret hatása közös.

**Három házirendi kérdés a mérés előtt (Zara jelezte, nem hajtottuk végre):**
1. A skill `npm install -g defuddle` **globális** npm-telepítést ír elő a gazda gépén.
2. Kifejezetten a **WebFetch helyett** ajánlja magát, nálunk viszont a külső tartalom útja az
   elkülönített olvasón megy. Ez nem "olcsó nyereség", hanem a tartalom-útvonal kérdése.
3. Az `obsidian-skills` README a repo tartalmát a **gazda Obsidian-vaultjának** `/.claude` mappájába
   telepíttetné, nem az ügynök saját skill-mappájába. Ez a mi álló kikötésünkkel megy szembe.

### 2. Caveman (ELVETVE, 2026-08-22, Marveen)
Ultratömör kimeneti mód. A repo állítása 65 százalék kimeneti token-megtakarítás. Az érvelés helytálló:
a kimenet drágább mint a bemenet, és minden további körben újra elmegy a kontextusban.

**Miért vetettük el.** Az egyetlen hely, ahol nálunk szóba jöhetett volna, az ügynök-ügynök forgalom.
Csakhogy az nálunk nem puszta kommunikáció: ott utaznak a **mért állítások**, szám, időbélyeg, SHA,
kártya-szöveg. Ez a hibaosztály idén többször okozott valós kárt, amikor a szöveg CSONKULT
(backtick-csonkolás a kártya-insertben, 300 karakteres leírás-vágás a feedback-triage-ben). Egy 65
százalékos tömörítő réteg pontosan ezt szaporítaná: a nyeresége token, a vesztesége helytelen döntés.

**Mikor vehető elő újra:** csak olyan üzenetre, ami NEM hordoz mért adatot.

### 3. Codebase Memory (MCP)
Egyszer gráfba indexeli a repót, utána az ügynök a térképet kérdezi fájlolvasás helyett. A repo 99
százalék token-megtakarítást ígér a felfedezésre, a videó szerzője 95-öt mért.
**Nálunk:** ezt a szerepet a **gitnexus** MCP tölti be (query, impact, route_map, tool_map, cypher).
Ezért a kérdés nem az, hogy telepítsük-e, hanem hogy a gitnexus tud-e mindent, amit ez.
**Mérés:** ugyanaz a felfedező feladat egy közepes repón (pl. connectors-api), gitnexusszal és nélküle.

### 4. Humanizer
Kiszedi az AI-írás árulkodó jeleit a szövegből, a Wikipedia vonatkozó szócikkéből építve, és a forrás
szerint automatikusan frissül, ha a szócikk frissül. 29,6 KB, tehát nagy fájl: betöltés után végig a
kontextusban ül. A szerző ajánlása: későn hívd, egyszer, hosszú session után friss ablakban.
**Nálunk:** ezt jelenleg a CLAUDE.md stílus-szabályai és a kimenő-szöveg kapu fedik (nincs em dash,
nincs AI-klisé, ékezetek). Kérdés, hogy egy 29,6 KB-os fájl hoz-e ennél többet.

### 5. Agent Reach
X, Reddit, GitHub és más közösségi felületek elérése API-díj nélkül, automatikus tartalék-útvonalakkal,
ha egy platform blokkol. A felhő-IP-ről jövő 403-akra találták ki.

**Típus:** NEM skill fájl, hanem **Python CLI csomag** (pyproject.toml, `agent_reach` modul, tesztek,
.env.example). Ez más döntési felület, mint egy markdown skill: függőség-lánc, karbantartás, és saját
kimenő hálózati forgalom, amit nekünk kell felügyelnünk.

**A mért állapot (Zara, 2026-08-22), nem becslés:**
- **Reddit:** tényleg elérhetetlen, idézhető hibaüzenettel. Ez valódi rés.
- **X / twitter.com:** ELÉRHETŐ, és poszt-szöveget ad. Ami hiányzik, az a **szál**, tehát a válaszok.
- **GitHub:** megy, a hitelesített `gh` CLI-n keresztül.

Vagyis a helyes megfogalmazás: **Reddit-rés van, nem közösségi rés.** A korábbi "ma nem lát Redditet és
X-et" mondat túlmért állítás volt, a mérés cáfolta.

**A hatókör szélesebb, mint egy közösségi kliens** (pl. YouTube-transzkript is van benne). Ebből nekünk
a transzkript-rész NEM nyereség: a YouTube-felirat kinyerése ma is megy (yt-dlp + a `watch` skill),
2026-08-22-én élesben használtuk egy 13 perces videóra (106 KB VTT, 302 cue). Két fenntartás viszont
ide tartozik: a hoston lévő yt-dlp elavult (a videó-letöltés 403-ra fut, friss verzióval megy), és
felirat nélküli videóhoz nincs beállított Whisper-kulcs. Ezek a saját házunk táján javítandók, nem
ezzel a csomaggal (kártya: VIDEOESZKOZ822).

**A helyes diagnózis viszont nem is ez volt (Marveen visszamérése, 2026-08-22).** Az eredeti állítás
egy ügynök saját pipeline-járól szólt ("nekem nincs meg"), és abból lett továbbadás közben flotta-szintű
képesség-hiány. A mért valóság: Irisnek megvan, Zarának nincs bekötve. Ez tehát **belső bekötési rés két
saját ügynök között, nem képesség-rés**, és sokkal olcsóbban javítható, mint egy harmadik féltől
származó csomag telepítése. Ettől az Agent Reach YouTube-ágú indoklása erősen gyengül.
**Lezárva (Zara válasza, 2026-08-22):** egy videó leiratára gondolt, nem rendszeres versenytárs-
figyelésre. A meglévő utunk pontosan ezt fedi, Zara le is futtatta a saját gépén (2291 cue, dedup után
6591 szó). **Ezzel az Agent Reach YouTube-ágú indoklása kiesett.** Bulk-figyelésre ma nincs sem
csatorna-listánk, sem ritmusunk, tehát azt senki nem állítja igénynek.

**A tétel ketté van vágva, és ez nem formaság (Marveen, 2026-08-22):**
- A **képesség-rés mérése** Zaráé: mit nem lát ma, és mit nyernénk vele. Megvan, lásd fent.
- A **telepítés-döntés NEM a flottáé**: az API-díj megkerülése a platform feltételein múlik, az pedig
  kifelé ható és jogi jellegű kérdés, tehát Szabi asztala. Amíg nincs gazda-döntés, senki nem telepíti.

**A gazda elé három út megy, nem kettő:**
1. **Scrape** ezzel a csomaggal (a platform-feltételek kérdése nyitva).
2. **Hivatalos Reddit API** (van ilyen), tehát a "scrape vagy semmi" hamis dilemma.
3. **Marad a rés**, ha egyik út sem éri meg a karbantartását.

### 6. Marketing Skills
49 marketing-skill egy csomagban: SEO, hirdetés, konverzió, copywriting, vásárlói pszichológia.
A README szerint Claude Code, Codex, Cursor és minden Agent Skills spec-kompatibilis ügynökkel megy.
**Nálunk:** Zara profiljába vág. Egy 49 elemű csomag viszont pont az a "40 használhatatlan alá temeted
a jókat" eset, amitől a videó óv.
**Döntés (Marveen, 2026-08-22):** részhalmazként megy. Zara válassza ki a 49-ből azt a maximum 5-8-at,
ami a mi munkánkba vág, és azokat értékelje. A teljes csomag globális átvétele nem opció.

### 7. Composio
Platform (nem skill fájl): 1000+ eszköz csatlakoztatása egy telepítéssel, OAuth-hackelés nélkül.
**Nálunk:** ez lényegében a **connectors.hu** versenytársa, tehát nem telepítési, hanem termék-kérdés.
Érdemes megnézni, mit tud a tool-scope és az írás-jog kezelésében, mert nálunk pont ez a kényes rész.

### 8. OpenMontage
Nyílt forráskódú agentic videógyártás: 12 pipeline, 100+ eszköz, a README szerint 700+ skill- és
tudásfájl. A lényegi különbség: renderelés ELŐTT koncepciókat, tervezett eszközutat, költségbecslést
és előnézetet ad, és a felhasználó hagyja jóvá.
**Nálunk:** ez az én területem. Ma hyperframes + video-use + ffmpeg-pipeline van. A jóváhagyási kapu
és a költségbecslés az, ami hiányzik, és pont ezt csinálja jól.
**A mérés fókusza (Marveen, 2026-08-22):** nem a teljes rendszer átvétele a cél, hanem a renderelés
ELŐTTI költségbecslés és jóváhagyási kapu mintája. Ha csak ezt az egy mintát tudjuk beépíteni a saját
videó-utunkba, az már megérte a mérést.

**PROJEKT-AZONOSÍTÁS KÉSZ (Zara, 2026-08-22): a repo azonos azzal, amit a katalógus állít, és a
jóváhagyási kapu NEM csak marketing-mondat.** A `pipeline_defs/talking-head.yaml`-ban mérve:
`default_checkpoint_policy: guided`, `budget_default_usd: 0.50`, `human_approval_default: true`
(nyolc lépésnél igaz, kettőnél hamis). A `pipeline_defs/` alatt 13 pipeline-definíció van. Aktív
projekt, utolsó push 2026-08-18.

**Telepítés és előfeltételek (Zara, 2026-08-22):** `git clone` + `make setup`; Python 3.10+, FFmpeg,
Node.js 18+ és egy AI coding assistant. Fizetős API **nem kötelező** a kipróbáláshoz: a README szerint
van nulla-költségű indulás (Piper TTS offline narráció, szabad stock, helyi renderelés).

**Ami nekünk külön érdekes:** a kompozíciós motorja Remotion (React) és **HyperFrames** (HTML/GSAP).
Az utóbbit már használjuk, tehát a jóváhagyási kapu mintája nem idegen rendszerből jönne át.

**A MINTA MÉRÉSE KÉSZ (Iris, 2026-08-22). Nem telepítés, hanem összevetés: mi az, ami a mi
videó-utunkból hiányzik.**

Az ő kapujuk (mért értékek, `pipeline_defs/talking-head.yaml`): `default_checkpoint_policy: guided`,
`budget_default_usd: 0.50`, `human_approval_default: true` nyolc lépésnél, kettőnél hamis. Emellett a
README szerint kötelező jóváhagyás négy ponton (proposal, script, scene plan, asset), költség-plafon,
renderelés előtti validáció, renderelés utáni önellenőrzés, auditálható döntés-nyom.

A mi utunk ma (video-use): inventory, stratégia-javaslat, jóváhagyás, végrehajtás, önértékelés,
perzisztálás. **A jóváhagyás tehát megvan, a KÖLTSÉG-OLDAL nincs.** Ma senki nem tudja megmondani egy
videó indítása előtt, hogy mennyibe fog kerülni, és nincs olyan határ, ami fölött külön kérdezni kell.

**Amit érdemes átvenni, és amit nem:**
- **Átvenni: a renderelés előtti költségbecslés és egy küszöb.** Ez az egyetlen valódi hiány.
- **NEM átvenni: a mindig kötelező, négypontos jóváhagyást.** Nálunk az a súrlódás lenne. Bizonyíték a
  saját mai munkámból: a "motorozós séta" hangulatvideónál a kérés egyértelmű volt, a jóváhagyási kört
  kihagytam, és az eredmény jó lett. Egy kötelező négyszeres kapu ezt lassította volna, haszon nélkül.
- **A helyes adaptáció ezért: a kapu a KÖLTSÉGHEZ kötődjön, ne minden lépéshez.** Becslés mindig
  készül; jóváhagyást csak akkor kérünk, ha a becslés a küszöb fölött van, vagy ha fizetős generatív
  hívás van a láncban.

**Worked example a mai valódi munkából** (motorozós séta, 1:12, 1080p): 10 forrásfájl, 2,4 GB, 4K60
HEVC. A lánc költség-tételei: 1 db ElevenLabs zene-generálás (fizetős hívás), 33 shot-render plusz két
végleges kódolás (gépidő, nem pénz), kb. 8 perc teljes gépidő. Egy becslő ezt a három tételt tudná
előre: **fizetős hívások száma és típusa, becsült gépidő, kimeneti méret.** Ennyi elég is: nem
dollárra pontos becslés kell, hanem az, hogy látszódjon, mikor lép be pénz a láncba.

**Ez a mérés eredménye, telepítés nélkül.** Az AGPL-kérdés ezt nem érinti: egy tervezési mintát
átvenni nem származékos mű. Kód-ráépülésről továbbra sincs szó.

**DÖNTÉSI TÉNYEZŐ, AMI A GAZDÁÉ: a licenc AGPL-3.0**, nem MIT, szemben a katalógus többi tételével.
Copyleft, tehát arra is kihat, amit ráépítünk. Ezért a mintát tanulmányozni és a saját utunkba
beépíteni más kérdés, mint a kódjára támaszkodni. A mérés emiatt a MINTÁRA megy, nem a kód átvételére,
és bármilyen ráépülés előtt gazda-döntés kell.

### 9. Oh My Claude Code
A "mindenben egyetértő" ügynök problémájára: feldarabolja a feladatot, specialistákat oszt ki
(planner, executor, debugger, verifier), párhuzamosan vagy szakaszosan futtat, és a végén verifikál.
**Nálunk:** részben fedve: van Workflow-eszköz (fan-out, adversarial verify) és van élő ügynök-flotta.
Kérdés, hogy a módszertana ad-e olyat, amit a mostani workflow-mintáink nem.

### 10. Superpowers
Nem egyetlen skill, hanem keretrendszer módszertannal arra, hogyan bontsa és hajtsa végre a munkát az
ügynök. A videó 260 ezer GitHub-csillagot állít. Nagy befektetés, a szerző szerint egy délután.
**Nálunk:** a skill-rendszerünk (skill-factory, öntanulás) ugyanezt a problémát célozza. Ha ránézünk,
azt keressük, mit tanulhatunk belőle, nem azt, hogy lecseréljük-e a mienket.

### 11. Mission Control (a videó szerzőjének saját projektje)
Flotta-dashboard: task-kiosztás, ügynök-állapot, élő költség-követés egy képernyőn.
**Nálunk:** a Marveen dashboard ugyanez a műfaj. Referenciaként érdekes, főleg a költség-nézet.

### 12. Nova (a videó szerzőjének saját projektje)
YouTube-növekedési ügynök: versenytárs-figyelés, csatorna-elemzés, ötletgenerálás, script, teljesítmény-
követés. A README szerint OpenClaw-hoz készült.
**Nálunk:** a YouTube-munka ma emberi (Kuzma Péter vág) és ad hoc ügynök-támogatású. Referencia.

## Mérési sorrend és gazdák (kiosztva: Marveen, 2026-08-22)

Amit mérni érdemes, az nem a "jó-e", hanem hogy **nálunk** mennyivel jobb a mostaninál:

1. **Codebase Memory vs gitnexus** -> **Samu, határidő 2026-08-29, alacsony prioritással.** Van már
   megoldásunk, ezért ez a legolcsóbb döntés: ugyanaz a felfedező feladat, ugyanaz a repo, token- és
   időmérés. Ha a gitnexus nyer, a tétel `fedve` lesz. A host-felhúzás blokkoló verify-jai előrébb
   valók, azokat ez nem tolja félre.
2. **Defuddle** -> **Iris.** Egy cikk, egy kérdés, token előtte és utána. Előtte a forrás-repo
   azonosítása (lásd a tételnél).
3. **Agent Reach** -> **a mérés MEGVAN (Zara, 2026-08-22), a döntés a gazdáé.** Nem token-kérdés,
   hanem képesség-kérdés volt. Eredmény: Reddit-rés van, az X poszt-szinten ma is megy, a szál nem.
   A gazda elé három út megy: scrape / hivatalos Reddit API / marad a rés.
4. **Marketing Skills** -> **Zara**, a 49-ből maximum 5-8 kiválasztott tétel értékelése.
5. **OpenMontage** -> **Iris**, izoláltan, egy valódi videófeladaton, a jóváhagyási kapu mintájára
   fókuszálva.

**Caveman: elvetve**, nem kerül mérésre (az indoklás a tételnél).

**Fontos:** a mérés telepítést igényel. Harmadik féltől származó skill globális telepítése
(`~/.claude/skills/`) az egész flottára hat, ezért előbb egyetlen ügynök saját skill-mappájában
kell kipróbálni, és csak utána, külön döntéssel mehet globálisra. Egy ügynök sem telepít magától.
