# Kanban audit: buktatók (references)

- **A saját kommentelésed elrejti a kártyát a kor-alapú metrikák elől.** Egy
  komment (és minden kártya-írás) frissíti az `updated_at`-et, tehát a
  `waiting > 48h` lista ÜRESRE válthat attól, hogy az előző körben te magad
  írtál a kártyára. 2026-08-11, saját mérés: egy kártya 307 órája várt, 12:00-kor
  kommenteltem rá, és a 16:00-s auditon már 0 volt a `waiting > 48h` -- nem
  azért, mert megoldódott, hanem mert én nyúltam hozzá. A hiba iránya
  megnyugtató, és ettől veszélyes: néma nulla, ami sikernek látszik.
  Ha "0 blokkolót" mérsz, nézd meg, mozgott-e a kártya az előző audit óta ÉS ki
  mozgatta:
  ```bash
  python3 -c "
  import sqlite3
  c=sqlite3.connect('store/claudeclaw.db')
  r=c.execute(\"select author from kanban_comments where card_id=? order by created_at desc limit 1\", ('<id>',)).fetchone()
  print(r[0] if r else '(nincs komment)')"
  ```
  Az `updated_at` az utolsó ÍRÁS ideje, nem a munka utolsó valódi mozgásáé.
  **A VALÓS kort a `created_at`-tel vesd össze, ha az `updated_at` a te írásod.**
  2026-08-25: egy kártya 162,5 órásnak mérődött, de az `updated_at` egy héttel
  korábbi saját kommentem volt; a kártya 14 napja készült. A kétszeres eltérés
  eldönti, halasztható-e még egy napot, ezért a jelentésben a valós kort mondd,
  a mérttel együtt.
  Ebből következik egy tartózkodás is: **ne kommentelj a kártyára pusztán azért,
  hogy rögzítsd, hogy megnézted.** Ha csak ellenőriztél, a csatornán jelezd, ne a
  táblán. Kommentet akkor írj, ha MÉRTÉL valamit, ami a kártyán maradandó.
- **NE `sqlite3` CLI-t és NE `jq`-t használj.** Egyik sincs telepítve egy átlagos Linux
  gépen (a telepítő függőségei: ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip), és a
  hívás ott `exit 127`-tel elhal -- ez a lépés némán kimarad, miközben az audit sikeresnek
  látszik. Élő gépen mérve 2026-08-04: két külön Linux telepítésen `sqlite3` és `jq`
  egyaránt hiányzott, `python3` mindkettőn ott volt. A macOS gépeken azért nem tűnt fel,
  mert ott a `sqlite3` gyárilag van.
- **A 300 KARAKTERES CIM-KAPUT NE UTKOZD MEG, ES HA MEGIS, NE TOROLD A NYOMAT (2026-08-26, sajat meres a Dream Engine-ben).**
  A `kanban_cards_title_gate_*` trigger 300 felett levagja a cimet, es a teljes szoveget egy
  `cim-kapu (trigger)` kommentbe teszi. **Egyetlen esti munkamenetben HETSZER futottam bele** (MIOAGENTSZO825,
  INSTPWURES825 ketszer, INSTROOTDESKTOP825, MACHW825, DIGESTSTALE825, MIOPIN825), es mindannyiszor ugyanaz
  volt a javitas: ujrairni rovidebbre.
  **AZ ELSODLEGES FIX A SZERKESZTESI SZOKAS, NEM A JAVITAS:** a CIM egy sor legyen (lelet + gazda + hatarido),
  a hosszu leirast pedig ELEVE kommentbe ird, sajat kezuleg. Igy a trigger el sem sul.
  **ES A MERESI CSAPDA, AMI EBBOL A LEGERTEKESEBB:** a hetbol MA MAR CSAK KETTO merheto, mert a cim rendbe
  tetele utan minden alkalommal kitoroltem a trigger sajat kommentjet. A takaritas elmosta azt a jelet,
  amibol egy kesobbi kor kimerhetne, hogy ez visszatero problema -- a `length(title)=300` ujjlenyomat is
  eltunik, amint a cimet javitod. **Ha a trigger elsult, a kommentjet ne torold szo nelkul:** vagy hagyd
  ott, vagy cserelj a helyere EGY sort arrol, hogy mikor es melyik kartyan sult el.
  **AZ ALTALANOS SZABALY: ha egy automatizmus NYOMOT hagy a sajat mukodeserol, azt a nyomot ne toroljuk
  ugyanabban a korben, amiben a hibat javitjuk** -- kulonben minden egyedi javitas utan ugy nez ki, mintha
  a problema nem letezne. Ugyanaz a csalad, mint amikor a bizonyitek az indexbe kerul es elvakitja a
  detektort.

- **EGY `waiting` KÁRTYA NEM BIZONYÍTÉK ARRA HOGY A BUG MÉG FENNÁLL -- élő kód, ne kártya-szöveg (2026-07-25, 5F996CBC, saját hiba)**: a "Dashboard vault-save UI nem nézi a res.ok-ot -> csendes hamis siker" kártya `waiting`-en ült, én ezt ténynek vettem, blokkolónak eszkaláltam (prioritás high) és MEGKÉRTEM A TULAJDONOST hogy várjon a credential-beírással. A fix valójában **egy hónappal korábban** bement (af48837 / PR #430, 06-21) és rajta volt a developen; a `web/app.js` vault-add ágában ott a `res.ok`-check + hibatoast. A kártyát senki nem zárta le, ezért "élt". ELJÁRÁS mielőtt egy kártyát blokkolóként eszkalálsz vagy a gazdát fékezed vele: (1) `git log --oneline --all -S"<a hibás minta>"` vagy `grep` az ÉLŐ fájlban, (2) `git branch --contains <fix-sha>` hogy a deployolt ágon van-e, (3) csak ezután eszkalálj. Ha kiderül hogy stale: zárd a kártyát ÉS korrigálj a gazdánál kimondva hogy rossz infón fékezted. Ugyanez a családba tartozik mint a PR-kártyák premissza-avasodása (lásd `pr-auto-process` Buktatók).
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a tulajdonos még látni akarja). **KIVÉTEL: explicit "nézd át és tisztítsd" / "tisztítsd a kanbant" tulajdonosi kérésnél archiváld az ÖSSZES done-t (a <7-nap standing default-ot az explicit kérés felülírja, 2026-06-17).**
- **DEEP-CLEAN ("tisztítsd") extra lépések a sima archive-on túl (2026-06-17)**: (1) waiting/planned PR-kártyáknál verifikáld a PR tényleges állapotát (`gh pr view <n> --json state,mergedAt`) -- a MERGED/CLOSED PR-ek kártyái done+archiválandók (pl. #368 merged, #351 closed maradt waiting/planned-en). (2) DEDUP TÉMA-alapon, NEM csak PR-szám-alapon: ugyanarra a munkára gyakran van EGY task-kártya ÉS egy PR-kártya (pl. frontend-tax-validáció task vs aiam #73 PR), vagy két ágens kártyázza ugyanazt (pl. a 015-hardening B6E4CB76 [én] vs 876ec002 [Samu PR] -- a pr-auto-process PR-szám-dedup ezt NEM fogja el). A duplikátumot archiváld, a kanonikus trackert tartsd. (3) NE zárj legit nyitott backlogot (Samu tech-debt/repro queue, roadmap, decision-backlog) -- a deep-clean a done+obsolete+duplikátum, nem a backlog-pruning; azt KÜLÖN, tulajdonos-egyeztetéssel.
- **HARMADIK DUPLIKÁTUM-FORMA: két ágens reagál UGYANARRA A FRISS megfigyelésre, perceken belül (2026-07-29, saját hiba)**: az eddigi dedup-szabály a „téma vs PR-szám" és a „két ágens kártyázza ugyanazt a RÉGI munkát" esetet fedte. A harmadik gyorsabb és alattomosabb: küldtem egy megfigyelést a fejlesztőnek azzal, hogy „vedd fel low-prio kártyára", és KÖZBEN én is felvettem egyet -- két kártya, ugyanaz a munka, percek alatt. A dedup-check itt nem segít, mert a másik kártya a lekérdezés pillanatában még nem létezett. **A megelőzés nyelvi, nem lekérdezéses: ha ÉN veszem fel, azt KIMONDOM („felvettem X néven, nincs teendőd") és NEM kérem meg a másikat ugyanarra; ha ő vegye fel, én NEM veszem fel.** Ha mégis megtörtént: a VÉGREHAJTÓ kártyája legyen a kanonikus (abból fog dolgozni), a másikat archiváld, az indoklást emeld át kommentként, és mondd ki, kié volt a hiba.
  **UGYANEZ MEGISMÉTLŐDÖTT EGY ÓRÁN BELÜL (2026-07-29, BRIDGENET1) -- tehát nem figyelmetlenség, hanem hiányzó lépés a folyamatban.** A második eset pontosan úgy nézett ki, mint az első: a levél végén megkértem a fejlesztőt hogy „vedd fel kártyára", majd ugyanabban a körben magam vettem fel. **A MECHANIZMUS, ami megfogja: a kártya-gazdát MIELŐTT az üzenetet megírod döntsd el, ne a végén -- és egyetlen üzenetben SOHA ne szerepeljen egyszerre a „felvettem" és a „vedd fel".** Ha egy megfigyelésből kártya lesz, a mondat vagy az egyik, vagy a másik; harmadik lehetőség nincs. Írás után, küldés előtt: grep a saját szövegedre mindkét fordulatra.

  **HARMADSZOR IS MEGTÖRTÉNT (2026-08-04, két párban egyszerre: MIGGATE804/UPDMAINTGATE804 és UPDSTASH804/UPDCONFL804) -- és ekkor derült ki, hogy a rés KÉTOLDALÚ.** Az előző két eset után a szabály és mellé az ellenőrzés is le volt írva; a hiba mégis megismétlődött, mert a leírt grep-et nem futtattam le. Ugyanabban az üzenetben szerepelt a „nyiss külön kártyát" és -- pár perccel később, ugyanabban a körben -- a saját felvételem.
  **AMI ÚJ, ÉS AMIÉRT NEM ELÉG A SAJÁT OLDALADAT JAVÍTANI:** a végrehajtó is nyit kártyát a saját leletére, és ő sem keres rá a meglévőkre. Aznap három kártyát nyitott, egyszer sem futtatott előtte címkeresést. Vagyis a duplikátum akkor is megszületik, ha az ÉN üzenetem tiszta -- a két oldal egymástól függetlenül ugyanarra a leletre kártyáz.
  **A KÉTOLDALÚ MECHANIZMUS, amiben megegyeztünk:** (1) nálam a küldés előtti grep a saját szövegre, ténylegesen lefuttatva, nem csak leírva; (2) a végrehajtónál kártyanyitás előtt egy grep a nem-archivált kártyák CÍMÉRE a lelet kulcsszavaival (nem a saját megfogalmazására -- lásd `feedback_search_the_concept_not_the_sentence`), és találat esetén komment a meglévőre, nem új kártya.
  **RENDEZÉS, ha mégis megtörtént:** a VÉGREHAJTÓ kártyája a kanonikus (abból dolgozik), az enyém archiválandó a tartalom átvezetésével -- és a rendezésben mondd ki, melyik oldalon keletkezett a hiba. Itt mindkettőn.

- **A DEDUP-CHECK NEM CSAK KÁRTYÁZÁS ELŐTT KELL, HANEM DELEGÁLÁS ELŐTT IS (2026-07-29, saját hiba, drága)**: a szabály eddig a kártya-létrehozásra vonatkozott. Aznap egy ügyfél-bejelentésből fél napos nyomozást indítottam két ágensnek -- és a végén derült ki, hogy **három hete állt egy `planned` kártya ugyanerről a bugról**, ami a fő mechanizmust már leírta, sőt egy kommentjében a másodikat is. A munka nagy része újrafelfedezés volt. A kártya-keresést a munka UTÁN futtattam le, nem előtte. **ELJÁRÁS: mielőtt bármilyen felderítést vagy javítást KIADSZ, keress rá a témára a táblán** -- ne csak ID-re, hanem tárgyszóra és rendszernévre (`title LIKE '%<rendszer>%' OR title LIKE '%<tunet>%'`), és nézd meg a `planned` állapotúakat is, ne csak az aktívakat. Ha van találat, az legyen a kanonikus kártya, és a briefben MONDD MEG az ágensnek, hogy onnan induljon.
  **AMI ILYENKOR MÉGSEM VESZETT KÁRBA, és ezt mondd is ki:** a régi kártya tipikusan HIPOTÉZIST rögzít; az új mérés BIZONYÍTÉKKÁ teszi, és gyakran hoz olyan ágat, ami a régiben nincs. A kettő együtt több, mint külön -- de a sorrend fordítva olcsóbb lett volna.

- **Kártya-létrehozás ELŐTT dedup-check (a duplikátum-megelőzés)**: mielőtt task-kártyát hozol létre delegált munkára, nézd meg van-e már kártya ugyanarra (téma + PR-szám), különben dupla keletkezik (mint a 015-hardening fent).
- NE pingelj saját magadat (skip ha assignee a fő-ágens ({{MAIN_AGENT_ID}})). **DE A SKIP NEM AZT JELENTI HOGY ÁTUGROD -- ez strukturális vakfolt (2026-07-28, saját eset).** A ping-mechanizmus minden ágenst figyel, EGYETLEN kivétellel: engem. Ha a saját kártyám ragad be, nincs aki szóljon, tehát csendben ül tovább, akár hetekig. Konkrét: a `connectors.hu MVP` kártyám 28 órája állt `in_progress`-en, holott aznap végig másokon dolgoztunk -- a tábla azt állította, hogy valaki épp csinálja. **ELJÁRÁS: a fő-ágens-assignee beakadt kártyáknál a ping helyett MAGAM döntök még ugyanabban a körben** -- vagy folytatom (és kommentelem, hogy hol tart), vagy `waiting`-re állítom az indokkal. A ping kihagyása a helyes; a döntés kihagyása nem. Ugyanaz az elv, mint a delegált-figyelő 5. pontjában: az `in_progress` azt állítja, hogy valaki EPP dolgozik rajta -- ha nem dolgozik, a tábla hazudik.
- **A NULLA-MÉRÉS A LEGGYORSABBAN AVULÓ ÁLLÍTÁS EGY KÁRTYÁN -- és semmi nem szól, amikor elavul (2026-08-04, GOOGLEVERIF1 + A475A648)**: két kártyánk azt rögzítette, hogy a Google-konnektoron **nulla külső bekötés** van, illetve hogy a konnektor **dormant** és a gazda döntésére vár. Mindkettő IGAZ volt a 07-27-i méréskor. A napi connectors-kör kötelező nyitó mérése viszont megmutatta, hogy 08-02 óta egy külső ember aktívan hívja, ma is, Gmail-küldéssel együtt, nulla hibával. Senki nem tévedett; az állítás **magától romlott el**, mert egyetlen új felhasználó megfordítja, és arról semmilyen jelzés nem érkezik.
  **MIÉRT KÜLÖN OSZTÁLY:** egy "sok van belőle" állítás lassan mozdul, egy **"nulla van belőle" állítás egy darabbal megdől**. És pont a nulla-állításokra épülnek a legerősebb következtetések ("nincs rá kereslet", "nem kell vele foglalkozni", "a gazdára vár"), tehát a legdrágább, ha csendben elavul.
  **ELJÁRÁS:** ha egy kártya nulla-mérést rögzít, a szövegbe kerüljön bele a MÉRÉS DÁTUMA és az, hogy MI dönti el újra (melyik lekérdezés, melyik táblán). Amikor egy ilyen kártyához hozzáérsz, a mérést futtasd le újra, ne a szöveget olvasd -- ez pár másodperc, és pont azt a következtetést védi, amire a legtöbbet építjük. Ugyanaz a család, mint a "kártya premisszája megavasodik", csak itt a bukás iránya rögzített: a nulla mindig FELFELÉ tud elmozdulni, és sosem jelez.

- **A 30+ napos waiting-lista nem csak adósság, hanem TUDÁS-FORRÁS (2026-07-28)**: az aznapi audit valódi haszna egy mellékhozam volt. A `3BB2E738` (WSL2-telepítés, „Windows-claude-WSL csapda") 53 napja ült érintetlenül -- és aznap este vált relevánssá, mert a tulajdonos épp a Windows/WSL-ágat kérte. Átadva a fejlesztőnek, megspórolt egy újra-felderítést. **Ezért a listát ne csak számként nézd: fusd át a CÍMEKET az aznapi aktív témák szemüvegén, és ha valamelyik egy most futó munkához input, add át annak, aki dolgozik rajta.** Az öreg kártya nem feltétlenül halott -- lehet, hogy csak korán érkezett.
  **DE: A TÉMA-KÖZELSÉG NEM INPUT (2026-07-31, ugyanennek a szabálynak a másik éle).** A `AFBDE2AD` (#470 delivery-intent gate, security) 33 napja ült, és aznap a fejlesztő ÉPP kapu-biztonságon dolgozott (#770 Bash auto-approve + egy friss bypass-kártya). Kézenfekvő lett volna „kontextusként" átadni. Nem tettem: az egy **másik kapu**, rokon család, de nem input a futó körhöz -- és aznap a P0 egy 10:00-s ügyfél-telepítés megfigyelése volt. Adjacens anyagot P0-napon átadni nem szolgáltatás, hanem költség.
  **A KÜLÖNBSÉGTÉTEL:** input az, amiből a futó munka MOST merít (ugyanaz a fájl, ugyanaz a kapu, ugyanaz a hibajelenség, egy már megmért adat). Adjacens az, ami ugyanabba a TÉMÁBA esik. Ha bizonytalan vagy: input-e annyira, hogy a másik ember MOST abbahagyná miatta amit csinál? Ha nem, akkor nem input.
  **AMIT ADJACENCIÁNÁL CSINÁLJ HELYETTE:** ne a személynek add át, hanem a KÁRTYÁRA írd fel a mintázatot. Aznap ez lett belőle: három nyitott kapu-biztonsági szál egyszerre (33 napos conflicting draft, futó review, friss bypass-lelet), és mindhárom ugyanarról szól -- hogy egy automatikus kapu mit enged át. **Ez nem sürgősség-emelés: attól lesz hasznos, hogy a következő prioritás-mérlegelésnél már mintázat áll ott, nem három külön tétel.** (Rokon: az „erősítsd a bizonyítékot eszkaláció nélkül" pont lentebb.)
  **ÉS ELŐTTE MÉRD LE AZ ÉLŐ ÁLLAPOTOT:** a 33 napos kártyaszöveg helyett `gh pr view` -- kiderült, hogy a PR időközben CONFLICTING lett. A kártya nem elavult, a helyzet romlott; enélkül „változatlan"-t írtam volna.

  **A `gh pr view` VISZONT NEM MONDJA MEG, HOGY KIMENT-E -- külön mérés kell rá (2026-08-01, 20d70901)**: a kártya azt állította, hogy három fix „a developen vár, hátra van a release develop->main". A `gh pr view` mindháromra `MERGED`-et adott, ami csak annyit jelent, hogy a *developre* bement -- a kártya állítását ez sem nem igazolja, sem nem cáfolja. A kimenetel-kérdésre EGY parancs válaszol: `gh api "repos/<o>/<r>/compare/main...<merge-sha>" -q .status` -> **`behind` = a main MÁR tartalmazza (kiment), `ahead`/`diverged` = még nem**. Mindhárom fix `behind` volt, 2026-06-29 óta élesben; a kártya release-része tehát hetek óta halott premissza volt, miközben a HOST-VERIFY része valóban nyitva maradt. **ELJÁRÁS: ha egy régi kártya „kiadásra vár"-t állít, a merge-állapot NEM elég bizonyíték -- a `compare/main...<sha>` a mérés.** És ha a kártya részben avult el, a címet is javítsd, ne csak a törzset (lásd `feedback_merged_is_not_live_for_security_fix`).

- **EGY RÉGI KOCKÁZAT-KÁRTYÁT MEG LEHET ERŐSÍTENI ANÉLKÜL, HOGY ESZKALÁLNÁD (2026-07-29)**: a `56dd56bf` (fleet-wide Supabase prod-write zárás) 36 napja waiting, és tegnap már helyesen NEM eszkaláltam, mert az élő állapot szerint a technikai zár kész, csak a vault-PAT áthelyezése maradt. A csábítás ilyenkor az, hogy a következő auditban ugyanazt írod le újra ("változatlan"), és a kártya lassan háttérzajjá válik. **Amit helyette csinálj: keresd meg, hogy AZNAP történt-e olyan, ami a kártya kockázatát KONKRÉTABBÁ teszi.** Aznap három külön feladatban használtam ugyanazt a megosztott `MARVEEN-CONNECTORS-PAT`-ot, két olyan Supabase-projekten is, aminek semmi köze a napi munkához -- vagyis a "megosztott helyen ül egy teljes DDL/DML jogú Management API kulcs" nem elméleti, hanem NAPI HASZNÁLATÚ kitettség. Ez nem sürgősség-emelés és nem eszkaláció: egy komment, ami a következő prioritás-mérlegelésnél tény lesz, nem érzés. **Elv: a `waiting` státusz megtartása mellett a BIZONYÍTÉK erősödhet -- és épp ez különbözteti meg az élő kockázat-nyilvántartást a temetőtől.**
  **DE A BIZONYÍTÉK-ERŐSÍTÉSNEK IS VAN TELÍTÉSI PONTJA (2026-08-04, 5E0A32B0, a 20:00-s audit)**: a fenti szabály arra bátorít, hogy mérj és kommentelj a régi kártyán. Aznap ezt a 63 napos naptár-auth kártyát a 08:00-s, a 12:00-s ÉS a 16:00-s audit is átmérte, mindhárom kommentelt is rá, és a 20:00-s körben ott volt a késztetés a negyedikre -- ugyanazzal a tartalommal ("a heartbeat naptár-szekciója ma is hibás"). Az ilyen negyedik komment már nem erősíti a bizonyítékot, csak hosszabbá teszi a kártyát, és pont azt a hatást éri el, ami ellen a szabály született: a kártya háttérzajjá válik, csak most a saját kommentjeimtől.
  **ELJÁRÁS: mielőtt bizonyítékot írsz egy régi kártyára, nézd meg a MAI kommentjeit** (`SELECT date(created_at,'unixepoch','localtime'), substr(content,1,120) FROM kanban_comments WHERE card_id='<id>' ORDER BY created_at DESC LIMIT 3`). Ha ma már szerepel ugyanaz a mérés, a helyes lépés a hallgatás. Új komment csak akkor, ha a mérés EREDMÉNYE változott (a tünet eltűnt, súlyosbodott, vagy más okra vezethető vissza), nem akkor, ha csak megint lefuttattad.
- Ne re-pingelj 4 órán belül ugyanazt: a state-fájlban tárolt `last_audit_at` automatikusan kezeli ezt (l. 1. lépés az első futásra is).
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.
- **A beakadás-mérést NE írd újra saját SQL-lel** (a régi, csak `in_progress`-es lekérdezés strukturálisan üres volt): az aktivitás (felelős kommentje, esemény, szerkesztés) a `/api/kanban/stuck`-ban él, a 3. lépés azt hívja.

- **`changes()` KÜLÖN sqlite3-hívásban MINDIG 0 (2026-06-15)**: ha az UPDATE után `sqlite3 ... "SELECT changes()"` külön invokációban fut, az egy ÚJ kapcsolat -> 0-t ad akkor is ha az UPDATE sikeres volt (false-negative, "0 sor módosult" látszat). NE erre alapozz. Verifikáld a hatást előtte/utána count-tal (pl. unassigned darabszám 11->5), vagy tedd a `SELECT changes();`-t UGYANABBA a sqlite3 hívásba az UPDATE után (`sqlite3 db "UPDATE ...; SELECT changes();"`).
- **Batch-UPDATE `{ ... } | sqlite3` szubshell-pipe + loop-épített `$SQL` string CSENDBEN visszagördülhet (2026-07-20)**: sok kártya egyszerre zárásakor a `for id in ...; do SQL="$SQL UPDATE...;INSERT..."; done; sqlite3 db "$SQL ..."` minta némán 0 sort módosított (a záró SELECT lefutott és normál számot adott, de SEMMI nem íródott -- valószínű egy statement a loop-épített stringben elrontotta a parse-t, hibaüzenet nélkül a capture-ben). MEGBÍZHATÓ MINTA: (1) NE `{ } | sqlite3` szubshell-pipe; (2) az összes statement EGYETLEN `sqlite3 db "..."` argumentumban, explicit egymás után (ne shell-loopból konkatenálva), pontosvesszővel; (3) UTÁNA verifikáld a hatást count-tal (waiting-darabszám előtte/utána), ne a 0-exitre hagyatkozz. Kis (2-3 statementes) hívások megbízhatóan mennek; a nagy loop-string a rizikós.
- **ES A TAGABB SZABALY, AMIT KET KULON ESET EGY ORAN BELUL TANITOTT (2026-08-16): EGY IRAST, AMIT
  KIADTAL, NEM SZABAD ELVEGZETTNEK TEKINTENI VISSZAOLVASAS NELKUL -- FUGGETLENUL A CSATORNATOL.**
  A fenti pont a batch-sqlite mintarol szol. Aznap ket TOVABBI, egymastol fuggetlen alakban jott elo,
  es egyik sem batch volt:
  1. **KANBAN-STATUSZ:** kiadtam egy `UPDATE ... SET status='done'`-t a PR973-ra; a cim atirodott, az
     assignee atirodott, a STATUSZ nem. A kartya 45 percig ugy allt, hogy a cime MERGELVE-t mondott,
     a statusza `waiting`-et. A sopres fogta meg, nem en.
  2. **MEMORIA-API:** a `curl -X POST /api/memories` URES kimenetet adott, en tovabbmentem, es a sor
     NEM keletkezett meg. A DB-bol visszaolvasva derult ki; ujrakuldve HTTP=200, id megvan.
  **A KOZOS MAG:** mindket esetben a parancs LEFUTOTT, hibauzenet nem volt, es a kovetkezo lepesem a
  sikert feltetelezte. A kulonbseg csak annyi, hogy az egyiket egy kesobbi kor talalta meg, a masikat
  en, mert VELETLENUL ranezetem.
  **ELJARAS, ket olcso szokas:** (a) allapot-valtoztato hivasnal (`UPDATE`, memoria-POST, uzenet-POST,
  fajl-iras) MINDIG kerd el a bizonyitekot ugyanabban a korben -- `curl -w "HTTP=%{http_code}"`, a
  beszuras utan egy `SELECT`, vagy a fajl visszaolvasasa; (b) ha a kimenet URES ott, ahol valaszt
  vartal, az NEM siker, hanem MERETLEN allapot. Az ures kimenet a leggyakoribb csendes hiba-alak,
  mert semmi nem hivja fel ra a figyelmet.
  **ES A JELENTESBEN IS:** ne ird le, hogy "elmentve" vagy "atallitva", ha nem olvastad vissza --
  a transzkriptben allo hamis kesz-jelentes tobbet art, mint a hianyzo iras, mert megszunteti a
  gyanut is. Rokon: [[feedback_save_confirmation_must_reread_server_state]].

- **ÚJ KÁRTYA ELŐTT KERESD MEG A MEGLÉVŐT -- a saját leletedre is áll (2026-08-01, HBWARNSTALE801, saját hiba)**: lemértem, hogy a heartbeat figyelmeztetés-sora 14 egymás utáni körön át betű szerint ugyanaz volt, kártyát nyitottam rá, és „mérés-első" fix-irányt írtam elő a fejlesztőnek. Közben a HBWARN801 ugyanezt írta le **aznap reggel 10:16 óta -- én magam vettem fel --**, és a javítás már mergelve volt (#832, fdab871), csak deployra várt. A fenti első buktató párja, csak fordítva: ott egy meglévő kártyát hittem élőnek, itt egy meglévő kártyát nem is kerestem. ELJÁRÁS új kártya előtt: `sqlite3 store/claudeclaw.db "SELECT id,status,substr(title,1,80) FROM kanban_cards WHERE archived_at IS NULL AND lower(title) LIKE '%<kulcsszó>%'"` -- a JELENSÉG kulcsszavára grepelj (pl. `heartbeat`, `warning`), NE a saját megfogalmazásodra, mert a meglévő kártya majdnem biztosan más szavakkal írja le ugyanazt (lásd `feedback_search_the_concept_not_the_sentence`). Ha van találat: a mérésed KOMMENTKÉNT kerüljön a meglévő kártyára (értékes, mert a fix hatálytalanságát bizonyítja), a duplikátumot pedig zárd és archiváld kimondott indoklással.


