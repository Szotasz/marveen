# Dream-engine

> Amíg alszol, az asszisztens "álmodik": átrendezi a napi tudást és felkészül a reggelre.

---

## 🎯 Mit tud / miért érdekes

Minden éjjel lefut egy csendes analízis-loop — a **dream-engine**. Nem zavar senkit (nem küld üzenetet), hanem átkonszolidálja az aznapi tudást, és felkészíti a reggelt: egy priorizált javaslat-csomagot rak össze, amit a reggeli napindító visz eléd.

Olyan, mintha az asszisztens éjszaka átgondolná a napot: mit tanultunk, mit kell rendberakni a memóriában, mi a holnap három legfontosabb feladata, és van-e a flottának olyan visszatérő mintája, amiből új skill születhetne.

**Kuriózum:** a reggeli napindítód nem nulláról készül 7:30-kor — a nehezét az éjszakai dream-engine már elvégezte, te csak a kész, priorizált összefoglalót kapod.

---

## 🛠 Hogyan működik

Éjszaka (kb. 02:00) lefut és egy `DREAM.md` fájlt generál 5 "bucket" alapján:

1. **💡 Skill-javaslatok** — végignézi az aznapi (24h) memóriákat és naplót: van-e 3+ visszatérő manuális művelet, vagy új, nem lefedett minta, amiből skill lehetne.
2. **🧹 Memória-egészség** — vektorizáltság-ellenőrzés, elavult `hot` tételek `cold`-ba mozgatása, duplikátumok kezelése (sosem törlés).
3. **🎯 Top-3 holnapi javaslat** — a nyitott kanban-kártyák + a heti aktivitás alapján prioritizálva.
4. **🌐 External opportunity** — heti 1-2x friss külső eszköz/skill-keresés (egyébként skip, hogy ne legyen zajos).
5. **🛠 Skill-flotta health** — elavult (nem-pinned, régóta nem használt) skill-ek jelzése.

Reggel a napindító a `DREAM.md` 5 bucketjét teszi a jelentés élére, az email/naptár/AI-hírek szekciók elé. Minden művelet helyi (SQL + opcionális helyi embedding), nincs külső API-hívás. Akadály esetén a `DREAM.md` végére hiba-szekció kerül, amit reggel látsz.
