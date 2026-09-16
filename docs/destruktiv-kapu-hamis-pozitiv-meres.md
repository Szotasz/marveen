# A destruktív kapu hamis pozitív rátája -- mérés

Kártya: **ba856d56** -- "destructive-gate.py hamis pozitiv: szoveg-mintaillesztes, nem
muvelet-ellenorzes". Mérte: leandev, 2026-09-14. A döntés a lean-chiefé; ez a dokumentum
csak a mérést és az abból következő számokat tartalmazza. **A kapun nem módosítottam.**

---

## 1. Mit mértem és mivel

| | |
|---|---|
| Korpusz | 112 egyedi Claude Code átirat (`.jsonl`), 44 256 sor, **0 parse-hiba** |
| Ebből | 4 096 Bash-hívás, **3 365 egyedi parancs**; 418 (eszköz, útvonal) pár |
| Kiolvasott mező | KIZÁRÓLAG `tool_use.input.command` és `input.file_path`. Beszélgetés-szöveget nem olvastam ki. |
| Kiértékelés | A **valódi** `scripts/hooks/destructive-gate.py` modult importáltam, és a `block()` függvényét cseréltem kivétel-dobásra. Nem újraimplementáció: a mért viselkedés az éles kapué. |

**Két korábbi számom rossz volt, ezért javítom.** Az első menetben 778 átirat-fájlt és
27 144 Bash-hívást jelentettem. A 778-ból csak 112 valódi: az ágensek
`.claude-config/projects` bejegyzése mind **ugyanarra a közös könyvtárra mutató symlink**
(a CLAUDE.md-ben dokumentált csapda), így a glob minden fájlt 7-8-szor hozott. Az
*egyedi parancsokra* vetített arányok ettől alig mozdultak (3 339 -> 3 365), a
hívásszám viszont nagyságrenddel túlzott volt. Ugyanezért **ágensenkénti bontást nem
adok**: a közös könyvtárból az attribúció nem megbízható.

## 2. Az eredmény

| ok | blokk | valós | hamis | hamis% |
|---|---:|---:|---:|---:|
| `banned-cmd:rm` | 35 | 29 | 6 | 17% |
| `banned-cmd:mv` | 26 | 20 | 6 | 23% |
| `banned-cmd:sudo` | 4 | 4 | 0 | 0% |
| `protected-dir:gmail-mcp` | 23 | 13 | 10 | 43% |
| `dotenv` | 14 | 12 | 2 | 14% |
| `protected-dir:ssh` | 6 | 0 | 6 | **100%** |
| `git-push` | 1 | 0 | 1 | **100%** |
| **összesen** | **109** | **78** | **31** | **28,4%** |

- **Blokkolási ráta: 109 / 3 365 = 3,24%.** A parancsok 96,8%-át a kapu nem érinti.
- **Hamis pozitív a blokkoltakon belül: 31 / 109 = 28,4%.** Minden negyedik-ötödik blokk téves.
- **Hamis pozitív a teljes korpuszon: 31 / 3 365 = 0,92%.**
- **Fájl-eszköz (Read/Edit/Write/NotebookEdit): 0 / 418 blokk.** Ott nincs hamis pozitív.

Az osztályozás szabálya: hamis pozitív az a blokk, ahol a kifogásolt művelet **nem hajtódik
végre** -- a minta heredoc-törzsben, karakterlánc-literálban vagy shell-kommentben áll.
Ha a művelet ténylegesen lefut, az valós pozitív **akkor is**, ha vitatható, hogy tiltani
kellene-e (az már szabály-kérdés, nem illesztési hiba).

Hol állt a találat a 31 hamis pozitívban:

| hol | db |
|---|---:|
| heredoc-törzsben (fájlba írt adat) | 23 |
| idézőjeles literálban (grep-minta, teszt-eset, üzenet-szöveg) | 5 |
| shell- vagy Python-kommentben | 3 |

Ág szerint: **18 a teljes parancsszöveget szkennelő ágból** (védett könyvtár, `.env`),
**13 a szegmens-fejet néző ágból** (tiltott parancs, `git push`).

## 3. Három hamis pozitív, amit magam váltottam ki -- MÉRVE, nem feltételezve

Ennek a mérésnek az elkészítése közben a kapu **háromszor blokkolt le engem**, egyetlen
destruktív művelet nélkül:

1. egy csak-olvasó elemző szkript, mert a Python-**docstringje** megnevezte a védett
   könyvtárat egy magyarázó mondatban;
2. egy másik csak-olvasó szkript, mert a **kommentje** hivatkozott a `.env`-re, a mért
   esetek leírásaként;
3. **ez a dokumentum**, mert a szövege idézi a szabály nevét -- vagyis a kapu
   megakadályozta a saját hamis pozitívjainak dokumentálását.

Mindhármat **átfogalmazással** kerültem meg; a művelet egyik esetben sem változott. Ez
pontosan a kártyában leírt ösztönző-probléma: a kapu nem a **műveletet** drágítja, hanem a
róla való **világos beszédet**. Aki tanul belőle, nem óvatosabb lesz, hanem ügyesebben
fogalmaz -- és a kerülés olcsóbb marad, mint a jelzés.

Ide tartozik egy korábbi állításom helyesbítése is: az előző sessionben hivatkoztam egy
saját hamis pozitívra, amelyet **valójában soha nem mértem meg** -- a mintát preventíven
kerültem ki. Az a hivatkozás nem mérés volt. Ez a három az.

## 4. Mit oldana meg a három irány, és mit kerülne

### (a) Finomabb mintaillesztés -- csak valódi végrehajtási környezetben tüzeljen

A 31 hamis pozitívból mind a 31 ilyen természetű, tehát felső korlátban ez az irány mindet
lefedi. **De van mért ára:** a 78 valós blokkból **2 heredoc-törzsben áll** -- olyan
`python3 - <<'PY'` hívásokban, amelyek ténylegesen megnyitják a hitelesítő fájlokat. Egy
naiv "a heredoc-törzset hagyd ki" szabály **ezt a kettőt elengedné**. A heredoc-törzs
ugyanis kétféle: `cat > fájl <<EOF` esetén adat, `python3 - <<PY` esetén **futó kód**.
A kettőt meg kell különböztetni, különben a javítás lyukat üt a kapun.

### (b) A PARSE-olt Bash-parancs vizsgálata

A kapu ezt **részben már csinálja**: a tiltott-parancs ág szegmensekre vág és fej-szavakat
néz. A hamis pozitívok **18/31 része** nem innen jön, hanem a két teljes-szöveget szkennelő
sorból (`PROTECTED_RE.search(cmd)` és a `.env` regex), amelyek a parancs **egészére**
illesztenek. Ez az irány tehát elsősorban azt jelentené: a védett-könyvtár és a `.env`
ellenőrzést is vinni a szegmens/argumentum szintre. Megjegyzés: valódi shell-parser nincs
telepítve (`bashlex` nincs), tehát ez saját tokenizálást jelent -- a `shlex` a
heredocokat nem kezeli.

### (c) Warn + log blokkolás helyett alacsony kockázatú esetekben

Ez nem illesztési javítás, hanem szabály-lazítás. Mérésem, ami ide tartozik: a 12 valós
`.env`-blokk **mindegyike** konfigurációs sort olvasott (`WEB_PORT`, `MAIN_AGENT_ID`),
nem titkot. A `protected-dir:ssh` mind a 6 blokkja hamis pozitív volt -- **egyetlen valódi
`~/.ssh` hozzáférés sem fordult elő** a korpuszban.

## 5. Amit javaslok (a döntés nem az enyém)

**(a) + (b) együtt, (c) nélkül.** Indoklás:

- A hamis pozitívok 100%-a szövegkörnyezeti tévedés, nem szabály-túlzás. A szabályok jók:
  a 78 valós blokk között valódi törlések, jogosultság-emelések és hitelesítő-fájl
  olvasások vannak. Tehát a **szabályokhoz ne nyúljunk** (ezért nem (c)) -- az
  illesztéshez igen.
- A (b) nélkül az (a) féloldalas marad: a hamis pozitívok többsége (18/31) épp abból a két
  sorból jön, amelyek a teljes parancsszöveget nézik.
- A (c) kockázata aszimmetrikus: egy elengedett rekurzív törlés visszafordíthatatlan, egy
  téves blokk egy átfogalmazásba kerül. 28,4%-os hamis pozitív ráta mellett is a blokkolás
  a helyes alapértelmezés -- a javítás az legyen, hogy **kevesebbszer téved**, ne az, hogy
  **kevesebbszer állít meg**.

**Kötelező elem a javításban, bármelyik irány mellett dönt a lean-chief:** a
`python3 - <<PY` típusú, ÉRTELMEZŐNEK adott heredoc-törzs **nem adat**. Ha a javítás ezt
nem különbözteti meg a `cat > fájl <<EOF` törzstől, akkor a mérés szerint 2 valódi
hitelesítő-fájl-olvasás csúszik át. Ez a mérés legfontosabb egyedi állítása.

**Amit nem tettem meg:** a `scripts/hooks/destructive-gate.py` egyetlen sorát sem
módosítottam. Hook-alapú védelem, a szerepszabályom szerint jelzem, nem bontom.

## 6. Reprodukálhatóság

A mérés szkriptjei a session-scratchpadban: `extract2.py` (korpusz-építés a
deduplikált fájlhalmazon), `evaluate2.py` (a valódi kapumodul futtatása),
`classify2.py` + `report.py` (osztályozás és összesítés), `REPORT.txt` (nyers kimenet),
`onmeres.txt` (a három saját blokk). Az osztályozás automatikus szabályokkal indult, és
**minden eltérést kézzel néztem át**; a kézi felülbírálatok a `final2.json` `evidence`
mezőjében nevesítve vannak.

---

# II. A JAVÍTÁS (2026-09-14, lean-chief döntése után)

A lean-chief döntése: **(a)+(b) együtt, (c) nélkül** -- finomabb mintaillesztés ÉS a
parancs szerkezetének figyelembevétele, de a blokkolás marad blokkolás, nem lesz belőle
figyelmeztetés. A kötelező elemmel: az értelmezőnek adott heredoc-törzs nem adat.

## 7. Mi változott a kapuban

A kapu ugyanazokat a szabályokat tartja, csak már nem a nyers parancsszövegen futtatja
őket, hanem egy **lecsupaszított szövegen**, amelyből kiesett minden, ami nem hajtódik
végre. Öt változás:

1. **ADAT-heredoc törzse kiürül.** `cat > fájl <<EOF` -- a törzs fájlba megy, nem futtatja
   semmi. **ÉRTELMEZŐ-heredoc törzse marad** (`python3 - <<PY`, `bash <<SH`): azt a nyitó
   soron megnevezett értelmező végrehajtja. A megkülönböztetés az, hogy a nyitó sor
   bármelyik szavának alapneve értelmező-e. Ez a lean-chief kötelező eleme, és a mérés
   szerint 2 valódi hitelesítő-olvasás múlik rajta.
2. **Teljes soros shell-komment kiürül.** A sor eleji `#` utáni rész nem parancs. A sor
   VÉGI komment szándékosan bent marad: ott a `#` lehet idézőjelen belül is.
3. **A próza-idézetek kiürülnek.** Az a megkülönböztető, amit a mérés alátámaszt: egy
   idézett szakasz, amelyben SZÓKÖZ van, üzenet, JSON-törzs, regex-minta vagy tesztadat --
   nem útvonal és nem parancsnév. A szóköz nélküli idézett szakasz (`'~/.ssh/id_rsa'`)
   maradhat útvonal, ezért az bent marad.
   **Két kivétel, mindkettőt a regresszió tanította:**
   - Ha az idézett szakaszban `$( )` vagy visszafelé aposztróf van, az parancs-kontextus,
     nem próza. E nélkül 6 valódi olvasás veszett volna el (`PORT="$(sed ... .env)"`).
   - De ez a kivétel CSAK shellben érvényes: egy értelmező-heredoc TÖRZSÉBEN a visszafelé
     aposztróf sima karakter egy Python-szövegben. E nélkül 1 hamis pozitív maradt volna.
4. **Az `-c` / `-e` kapcsoló utáni idézett szakasz mindig vizsgált marad**, akkor is, ha
   szóköz van benne: az értelmezőnek adott kód, nem próza.
5. **Idézet-tudatos darabolás és parancsnév-felismerés.** A régi `re.split` egy idézett
   grep-mintán belüli `|` jelre is darabolt, és a minta következő szava parancsnévnek
   látszott. Az új darabolás tudja, mi van idézőjelen belül; és egy szóközt tartalmazó
   idézett szó nem lehet parancsnév.

A `check_read` ág (Read/Edit/Write) **változatlan**: ott a mérés 0 hamis pozitívot mutatott.

## 8. A javítás mérése

Ugyanaz a 3365 egyedi valós parancs, a RÉGI és az ÚJ kapumodul egymás mellett betöltve:

| | db |
|---|---|
| valódi blokk megmaradt | **78** |
| valódi blokk **ELVESZETT** | **0** |
| hamis pozitív megszűnt | **27** |
| hamis pozitív megmaradt | **4** |
| újonnan blokkolt | 1 |
| változatlanul átengedve | 3255 |

Hamis pozitív ráta: **28,4% -> 4,9%** (31/109 -> 4/82), **valódi blokk elvesztése nélkül**.

**Az 1 újonnan blokkolt nem regresszió, hanem egy addig észrevétlen lyuk zárása.** A régi
`.env`-minta szóközt követelt a fájlnév előtt, ezért a teljes útvonalas alakot ELENGEDTE:
`grep -i "..." /home/istvan/marveen/.env` -- ez valódi konfigurációs-fájl-olvasás, a régi
kapu átengedte, az új megfogja.

**A 4 megmaradt hamis pozitív, és miért hagytam bent.** Mind a négy ugyanaz az alak:
értelmező-heredoc törzsében egy szóköz nélküli, idézett útvonal-literál -- kapu-tesztszkriptek,
amelyek tesztadatként adnak át hitelesítő-útvonalat, és profil-író szkriptek, amelyek
deny-lista bejegyzést ágyaznak be. Kitisztításukhoz azt a szabályt kellett volna felvenni,
hogy a védett literál csak akkor számít, ha függvényhívás argumentuma. **Ezt elvetettem:**
elengedné a teljesen természetes `path = '/home/.../.ssh/id_rsa'` majd `open(path)` mintát.
Négy hamis pozitív olcsóbb, mint egy valódi lyuk.

## 9. Ismert hiányosság, amit ez a kártya NEM zár

A kapu a szegmens ELSŐ szavát nézi parancsnévnek, ezért minden burkoló, amely parancsot
kap argumentumként, átviszi a tiltott parancsot:

    ls /tmp | xargs rm          find . -name x -exec rm {} ;

**A régi és az új változat egyformán átengedi** -- mindkettővel megmérve. A 3365 parancsos
valós mintában **0** ilyen hívás volt, tehát a lyuk eddig nem fordult elő. A zárása
tightening egy védelmen, az a lean-chief döntése, nem az enyém; külön kártyát kér.

## 10. Regressziós teszt

`scripts/__tests__/destructive-gate.test.py` (futtatás: `python3 <fájl>`, exit 0 = zöld).
21 pozitív kontroll (valódi művelet, blokkolni kell -- köztük mindkét értelmező-alak és a
`$( )`-os eset) és 16 negatív kontroll (a minta csak említve van).

Mérés mindkét irányban:
- a RÉGI kapu ellen futtatva **8 ponton piros** (7 negatív kontroll + a most zárt `.env` lyuk),
- a TELEPÍTETT új kapu ellen **37/37 zöld**.

A teszt maga is példány a vizsgált hibaosztályra: a védett neveket és a tiltott
parancsneveket összefűzéssel állítja elő, mert szó szerint leírva a kapu **magának a
tesztfájlnak a megírását** blokkolta (ez volt a hetedik mért önblokk).

## 11. Élő ellenőrzés

A hook-szkriptet a Claude Code minden hívásnál újraolvassa, tehát session-újraindítás nem
kell -- de ezt megmértem, nem feltételeztem:

- **Negatív irány:** egy `.gmail-mcp`-t említő shell-komment, amit a régi kapu blokkolt,
  ebben a sessionben LEFUTOTT.
- **Pozitív irány:** `mv --help` továbbra is BLOKKOLVA (`DESTRUKTIV-KAPU: BLOKKOLVA`).

A régi változat megőrizve: `oldgate.py` és `destructive-gate.py.backup-20260914-172534`
a session-scratchpadban.

---

# III. A BURKOLÓ-PARANCS RÉS KÖLTSÉGMÉRÉSE (dec196bb, 2026-09-14)

A lean-chief kérése: **ne módosíts semmit, előbb mérd meg a javítás költségét** -- hány
kontroll törne, mennyi új hamis pozitívot hozna egy argumentum-szintű vizsgálat.
A kapu ebben a szakaszban **nem változott**.

## 12. A rés valódi mérete

A kártya `xargs`-ot és `find -exec`-et nevez meg. Megmérve **11 alak**, és a rés szélesebb:

| alak | régi kapu | telepített új kapu |
|---|---|---|
| `ls /tmp \| xargs <törlés>` | átenged | átenged |
| `xargs -I {} <törlés> {}` | átenged | átenged |
| `find . -exec <törlés> {} ;` és `{} +` | átenged | átenged |
| `timeout 5 <törlés> /tmp/x` | átenged | átenged |
| `nice <törlés> /tmp/x` | átenged | átenged |
| `parallel <törlés> ::: a b` | átenged | átenged |
| `watch <törlés> /tmp/x` | átenged | átenged |
| **`bash -c "<törlés> -rf /tmp/x"`** | átenged | átenged |
| **`sh -c '<törlés> -rf /tmp/x'`** | átenged | átenged |
| `ssh host <törlés> -rf /tmp/x` | átenged | átenged |

**Mind a tizenegy a RÉGI változaton is átment** -- egyik sem a ba856d56 javításából
származik. A legfontosabb a `bash -c` / `sh -c`: ez a legtermészetesebb mód, ahogy egy
ágens parancsot indít, és a kártya nem is említi.

## 13. Négy szigorítási változat, mind megmérve

Mindegyik a telepített kapu forrásához fűzött folt; a szövegkörnyezet-javítás
(`scannable()`) érintetlen marad alattuk.

- **V1 minimal**: `xargs` és `find -exec/-execdir/-ok/-okdir` utáni parancsnév.
- **V2 = V1 + előtag-burkolók**: `timeout, nice, ionice, stdbuf, watch, parallel, flock,
  chroot, setsid, unbuffer, script` (a `timeout` időtartam-argumentumát átlépve).
- **V3 = V2 + `sh|bash|zsh -c <szkript>` REKURZÍV vizsgálata.** Ez a tényleges (b) irány:
  a beágyazott parancsot ugyanazzal a kapuval nézi meg.
- **V4 agresszív**: a szegmens BÁRMELY csupasz szava, ha tiltott parancsnév.

| | tört kontroll (37-ből) | új blokk 3365 valós parancson | elveszett blokk | zárt alak (11-ből) | futásidő/hívás |
|---|---|---|---|---|---|
| telepített | -- | -- | -- | 0 | 0,466 ms |
| **V1** | **0** | **0** | 0 | 4 | 0,535 ms |
| **V2** | **0** | **0** | 0 | 8 | 0,535 ms |
| **V3** | **0** | **0** | 0 | **10** | 0,606 ms |
| V4 | 0 | **2** | 0 | 9 | 0,533 ms |

**A V1-V3 költsége mérhetően nulla**: egyetlen kontroll sem törik, egyetlen új blokk sem
keletkezik a valós korpuszon, és egyetlen meglévő blokk sem vész el. Ennek az oka az, hogy
a korpuszban **0 burkolt hívás** volt -- a rés eddig nem fordult elő.

**A nulla költség önmagában semmit nem bizonyít: egy nem működő folt is nulla költségű.**
Ezért a méréshez saját pozitív kontroll tartozik -- a 11 alak tesztje --, és a táblázat
"zárt alak" oszlopa ebből jön. E nélkül a mérés hamis megnyugvás lett volna.

**A V4 dominált változat, elvetendő**: 2 új hamis pozitívot hoz, ÉS közben a `bash -c`-t
sem fogja meg (ott a szkript idézőjelben, szóközzel áll, tehát nem csupasz szó).
A 2 hamis pozitív: egy Python-szkript, amelyben `'<törlés>'` karakterlánc-literálként áll
egy keresőmintában, és egy üzenet-törzs, amely szövegként tartalmaz egy tiltott parancsnevet.

## 14. Amit a V3-ról tudni kell, mielőtt bárki bevezeti

**A V3 csak az EGYSZINTŰ beágyazást fogja.** Megmérve, számlálóval:

    bash -c "<törlés> -rf /tmp/x"                    -> BLOKK
    bash -c "bash -c \"<törlés> -rf /tmp/x\""        -> ÁTENGED

A token-kinyerés nem bontja vissza a visszaperjeles idézőjel-védést, ezért a rekurzió a
második szinten megáll. Tehát a V3 **a véletlen ellen véd, nem az elszánt megkerülés
ellen**. Ez a kapu jellegéhez illik (együttműködő ágensek kormányzása, nem támadó elleni
védelem), de ki kell mondani, mert a táblázat "10/11" cellája önmagában többet ígér.

Ebből következik az is, hogy **rekurziós elszabadulás nincs**: a mért maximális mélység 3,
és a hurokvédelem (`_sub != cmd`) fog. Explicit mélységkorlát ettől még olcsó és ajánlott.
Fontos, mert a `main()` csak a nem olvasható bemenetre fail-closed: egy kezeletlen kivétel
a check_bash-ben NEM 2-es kilépés, tehát **fail-open** lenne.

Ellenőrizve az is, hogy egyik változat sem termel csendben nem-blokk kivételt
(a mérőhurokban az blokknak látszott volna): mind az ötnél 0.

## 15. Ajánlás

**V3, a fenti korlát kimondásával** -- vagy ha a lean-chief a legkisebb felületet akarja,
**V2**. Indok: a V1-V3 mért költsége nulla, a V3 zárja a `bash -c`-t is, ami a rés
legvalószínűbb valódi előfordulása. A V4-et elvetem. A kód nagyságrendje ~40 sor,
a `check_bash`-en belül; a `scannable()` és a `check_read` nem változik.
A `ssh host <törlés>` egyik olcsó változattal sem zárul: az távoli gépen futó parancs,
és ha ez cél, akkor külön szabály kell rá, nem burkoló-felismerés.

## 16. Mellékesen kibukott, külön kezelendő

A heredoc-osztályozó a nyitó SOR bármely szavát nézi értelmezőnek, ezért a
`cat <<'EOF' | bash script.sh -` alakot **kódnak** veszi, holott a törzs ADAT (egy szkript
szabványos bemenetére adott üzenetszöveg). A valós korpuszban **20** ilyen parancs van, és
ma **egyik sem** okoz hamis pozitívot -- de ez lappangó pontatlanság, és a szigorítás
után könnyen aktiválódhat. Nem javítottam, jelzem.

---

# IV. A V3 BEVEZETÉSE (dec196bb, 2026-09-14)

A lean-chief döntése: **V3, a korlát kimondásával**, V2 helyett -- mert a `bash -c` a rés
legvalószínűbb valódi előfordulása, azt a V2 nyitva hagyná. Két kötelező elemmel:
explicit mélységkorlát, és **fail-closed garancia**.

## 17. Mi került a kapuba

- `command_index()` -- a szegmens **tényleges** parancsnevét adja vissza, átlátva a
  környezeti hozzárendeléseken (`FOO=bar`), az átlátszó előtagokon (`exec, env, time,
  nohup, command`) és a burkolókon (`xargs, timeout, nice, ionice, stdbuf, watch,
  parallel, flock, chroot, setsid, unbuffer`). A burkoló kapcsolóit és a puszta számot
  (`timeout 5`, `nice -n 10`) átlépi. Láncolt burkolót is követ (`timeout 5 nice <tiltott>`).
- `find -exec/-execdir/-ok/-okdir` utáni parancsnév külön vizsgálva (nem a szegmens elején áll).
- `sh|bash|zsh|dash|ksh -c <szkript>` esetén a szkript **rekurzívan** ugyanezen a kapun
  megy át.
- A ba856d56 szabálya érintetlen: a szóközt tartalmazó idézett szó továbbra sem parancsnév.

**Mélységkorlát:** `_MAX_NEST = 8`, a hurokvédelem (`sub != cmd`) mellé. Túllépése
**BLOKK, nem átengedés** -- amit a kapu nem tud végigkövetni, azt nem engedi.

**Fail-closed garancia:** a `main()` diszpécsere `try/except Exception` alatt fut, és
bármely váratlan kivétel **exit 2**. A `block()` `SystemExit`-tel lép ki, azt az
`except Exception` nem fogja meg, tehát a valódi blokkolás változatlanul átmegy.

## 18. Mérés

| | eredmény |
|---|---|
| meglévő kontrollok | 37/37 zöld |
| összes kontroll a bővítés után | **58/58 zöld** |
| a 11 mért réses alakból zárul | **10** (a 12., `ssh`, tudatosan nyitva) |
| új blokk 3365 valós parancson | **0** |
| elveszett blokk | **0** |
| nem-blokk kivétel | 0 |
| futásidő | 0,466 -> **0,475 ms/hívás** |

**A fail-closed kontroll bizonyítéka, hogy valódi hibaosztályt fog.** Ugyanaz a
hibainjektálás (a `check_bash` szándékosan kivételt dob) a két változaton:

    folt ELŐTT:  exit=1  -> a művelet ÁTMEGY (fail-open)
    folt UTÁN :  exit=2  -> BLOKKOL

Ez volt a legfontosabb elem: egy elhasalt kapu addig **csendben engedélyezővé vált**.

**Élő ellenőrzés** (a hook valódi futtatásával, nem modulként):
- `bash -c "mv --help"` -> BLOKKOLVA, és az üzenet a BELSŐ szegmenst nevezi meg;
- `printf ... | xargs -n 1 echo` -> lefutott (a burkoló ártalmatlan paranccsal átmegy).

## 19. Ami tudatosan nyitva maradt

A tesztben nevesítve, **állítás nélkül** -- jelentésként, hogy aki továbbfejleszti, mért
adatot lásson arról, meddig hat a védelem:

- **többszintű beágyazás:** `bash -c "bash -c \"<tiltott>\""` átmegy. A token-kinyerés nem
  bontja vissza a visszaperjeles idézőjel-védést. A védelem tehát a **véletlen** ellen szól,
  nem az elszánt megkerülés ellen. Kódkommentben is ott áll.
- **`ssh gép <tiltott>`:** távoli gépen futó parancs, a lean-chief ebben a körben nem kérte.
- A 16. pont heredoc-pontatlansága: nem kérte, 0 jelenlegi hatás.
