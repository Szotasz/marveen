# Dream-engine

> Amíg alszol, az asszisztens "álmodik": átrendezi a napi tudást és felkészül a reggelre.

---

## 🎯 Mit tud / miért érdekes

Minden éjjel lefut egy csendes analízis-loop — a **dream-engine**. Nem zavar senkit (nem küld üzenetet), hanem átkonszolidálja az aznapi tudást, és felkészíti a reggelt: rendberakja a memóriát, kalibrálja a holnapi prioritásokat, és egy priorizált javaslat-csomagot rak össze, amit a reggeli napindító visz eléd.

Olyan, mintha az asszisztens éjszaka "átgondolná a napot": mit tanultunk, mit kell a memóriában rendberakni, mi a holnap három legfontosabb feladata, és van-e a flottának olyan visszatérő mintája, amiből új skill születhetne — reggelre mindez feldolgozva vár.

**Kuriózum:** a reggeli napindítód nem nulláról készül — az éjszakai dream-engine a kanban-kártyák és az aznapi tanulságok alapján már elvégezte a nehezét. Te nem "tájékozódsz" reggel: folytatod, ahol tegnap abbahagytad. A 7:30-as összefoglaló ezért sokkal sűrűbb, mint amit egy fresh-start asszisztens össze tudna rakni.

---

## 🛠 Hogyan működik

Éjszaka (kb. 02:00) lefut és egy `DREAM.md` fájlt generál 5 "bucket" alapján:

1. **💡 Skill-javaslatok** — végignézi az aznapi (24h) memóriákat és naplót: van-e 3+ visszatérő manuális művelet, vagy új, nem lefedett minta, amiből skill lehetne.
2. **🧹 Memória-egészség** — vektorizáltság-ellenőrzés, elavult `hot` tételek `cold`-ba mozgatása, duplikátumok kezelése (sosem törlés).
3. **🎯 Top-3 holnapi javaslat** — a nyitott kanban-kártyák + a heti aktivitás alapján prioritizálva.
4. **🌐 External opportunity** — heti 1-2x friss külső eszköz/skill-keresés (egyébként skip, hogy ne legyen zajos).
5. **🛠 Skill-flotta health** — elavult (nem-pinned, régóta nem használt) skill-ek jelzése.

Reggel a napindító a `DREAM.md` 5 bucketjét teszi a jelentés élére, az email/naptár/AI-hírek szekciók elé. Minden művelet helyi (SQL + opcionális helyi embedding), nincs külső API-hívás. Akadály esetén a `DREAM.md` végére hiba-szekció kerül, amit reggel látsz.

### External opportunity + fokozatos autonómia

A külső opportunity-k kezelése az `external_skill_adoption` autonómia-kategóriát követi. Az alapérték `level: 1`, ezért egy friss vagy frissített telepítés nem kezd el magától capability-t módosítani.

- **Level 1:** a Dream Engine csak jelzi az opportunity-t a `DREAM.md`-ben.
- **Level 2:** konkrét helyi skill-adaptációt javasol, de a skill-fájlt nem módosítja; a döntés a tulajdonosé.
- **Level 3:** kizárólag alacsony kockázatú, visszafordítható, helyi `SKILL.md` create/patch hajtható végre automatikusan, a meglévő `skill-factory` / `skill-management` eljárásokkal.

A level 3 nem supply-chain bypass. A külső README/repo-leírás nem megbízható adatforrásként kezelendő, nem végrehajtandó utasításként. A Dream Engine nem tölthet le, telepíthet vagy futtathat külső repo-kódot, nem adhat hozzá dependency-t, plugint, MCP/connectort vagy új secretet, nem változtathat permissiont/system-service konfigurációt, és nem végezhet publikálást, külső üzenetküldést, fizetést vagy adattörlést. Az automatikusan létrehozott vagy patchelt skill sem kerülheti meg ezeket a határokat. Ha az opportunity ezek közül bármelyiket igényli, a folyamat level 2 viselkedésre esik vissza és tulajdonosi döntést kér.

Autonóm adaptációnál a forrás URL és az adaptáció indoka provenance-ként megmarad, a módosított skillt a rendszer visszaolvassa, a skill indexet újragenerálja, és csak sikeres ellenőrzés után jelenti az adaptációt lezártnak.
