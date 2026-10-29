# Nehéz-feladat kapu (egyszerre egy nehéz feladat, memória-padló, cgroup-keret)

> Egy gépen több ügynök ugyanabban a pillanatban indíthat videórendert, teljes
> tesztsort vagy TypeScript-buildet. Egyenként mindegyik belefér a memóriába, együtt
> nem, és ilyenkor a kernel OOM-killere választ áldozatot: egy ügynök paneljét, a
> dashboardot, a csatornát. A nehéz-feladat kapu ezeket egyenként engedi indulni,
> csak ha van hely, és saját memóriakeretben.

Angol változat: [en/heavy-job-gate.md](en/heavy-job-gate.md).

---

## 🎯 Mit tud / miért érdekes

- **Egyszerre egy nehéz feladat**, az egész gépen, érkezési sorrendben (FIFO-sor egy
  globális zár előtt). Aki később jött, nem előzhet.
- **Memória-padló:** a feladat csak akkor indul, ha a `MemAvailable` legalább
  `max(--min-mb, keret + tartalék)`, így a legrosszabb esete (a teljes kerete) mellett
  is megmarad a tartalék a gép többi részének. Erre legfeljebb `--wait-sec`-ig vár.
- **Saját memóriakeret:** a feladat átmeneti `systemd-run --user --scope` alatt fut,
  `MemoryMax` / `MemorySwapMax` kerettel. Az elszabadult feladatot a saját cgroupjában
  öli meg az OOM-killer (137-es kilépési kód); a gép és a többi ügynök érintetlen marad.
- **Semmi nem éli túl a feladatot:** amikor a fő folyamat véget ér, a kapu a teljes
  scope-ot leállítja, így egy háttérben hagyott gyerekfolyamat sem foglal tovább
  memóriát, miután a következő feladat már elindult.
- **Zárva hibázik:** ha nem tudja mérni a memóriát, nem tudja használni a zárat vagy a
  sort, vagy nem tud olyan scope-ot létrehozni, amelynek a memóriakerete
  bizonyítottan érvényes, akkor nem futtatja a feladatot, és saját kilépési kóddal
  megmondja, miért.

**Opt-in:** a Marveen magától sehol nem hívja. Egy ügynök (a `CLAUDE.md`-jében lévő
szabály alapján) vagy egy szkript csomagolja bele a nehéz parancsot. **Csak Linuxon**
működik (a `/proc/meminfo`-t olvassa, és systemd user scope-ot használ).

### Mikor használd

Akkor tedd a kapu mögé a parancsot, ha a gép memóriájának nagy részét viheti el, vagy
percekig futhat:

- videórender, ffmpeg-kódolás, Remotion
- teljes tesztsor (`npx vitest run`, `npm test`)
- TypeScript-build (`npm run build`, `npx tsc`)
- böngészős teszt (Playwright)
- helyi LLM-batch

Nem kell hozzá: egyetlen kép gyors ffmpeg-művelete (előnézet, crop, scale), `ffprobe`,
egyetlen tesztfájl futtatása.

```bash
scripts/heavy-job-gate.sh --label vitest -- npx vitest run
scripts/heavy-job-gate.sh --max-mem 3G --wait-sec 600 --label render -- node render.mjs
scripts/heavy-job-gate.sh --max-sec 240 --agent backend-dev --label tsc -- npx tsc --noEmit
```

A várakozás és a feladat együtt hosszabb lehet, mint egy Bash-eszközhívás időkorlátja:
adj az eszközhívásnak hosszú időkorlátot, vagy futtasd háttérben, különben az eszköz
félúton leöli a feladatot.

### Kilépési kódok és teendők

A kapu a parancs saját kilépési kódját adja tovább. A saját kódjai:

| Kód | Jelentés | Teendő |
|-----|----------|--------|
| 64 | hibás hívás (érvénytelen környezeti alapérték is) | javítsd a hívást |
| 73 | egy másik nehéz feladat (vagy régebbi várakozók) a teljes `--wait-sec` alatt fogták a zárat | próbáld később; ne futtasd a kapu nélkül |
| 74 | a zárfájl vagy a sor nem használható | rendszerhiba: jelezd |
| 75 | a `MemAvailable` a teljes `--wait-sec` alatt a padló alatt maradt, vagy nem volt olvasható | próbáld később, vagy szabadíts fel memóriát; ne kerüld meg a kaput |
| 76 | a feladat elindult, de túllépte a `--max-sec`-et, ezért a kapu leállította | a feladat hosszabb a bejelentettnél: emeld a `--max-sec`-et, vagy bontsd fel |
| 77 | nincs ellenőrzött memóriakeretes scope: nincs `systemd-run`, nincs user manager, vagy a systemd elfogadja a `MemoryMax`-ot, de nem érvényesíti (a memory controller nincs delegálva, a naplóban `cap_probe=cap_not_in_effect`) | rendszerhiba: jelezd (a `cap_not_in_effect` esetén lásd a Követelményeket); a `--allow-uncapped` keret nélkül futtat, naplózva, csak tudatos döntésként |
| 128+n | a hívás a sorban vagy a memóriára várva n-es jelzést kapott (SIGTERM 143, SIGINT 130, SIGHUP 129); a feladat el sem indult | a naplósorban `reason=signal` áll (a memóriavárásnál `phase=memory`) |

Ha egy keretes feladat 137-tel (vagy 143-mal) hal meg, és a jelzés nem a kapun át
ment, akkor a memóriakerete vagy valaki a kapun kívülről ölte meg;
a `journalctl --user -u <unit>.scope` megmondja, melyik (`Failed with result 'oom-kill'`).

### Szabály egy ügynök CLAUDE.md-jébe

```markdown
## Nehéz feladat csak a kapun át
Videórender, ffmpeg-kódolás, teljes tesztsor, TypeScript-build, böngészős teszt és
helyi LLM-batch csak így indul:
`scripts/heavy-job-gate.sh [--max-mem 2G] [--wait-sec 300] --label NEV -- <parancs...>`.
73 vagy 75 esetén ne futtasd kapu nélkül: próbáld később, vagy jelezd. A 74 és a 77
rendszerhiba: jelezd a fő ügynöknek.
```

---

## 🛠 Hogyan működik

A `scripts/heavy-job-gate.sh` egy vékony burok a `scripts/heavy-job-gate.py` körül
(csak Python 3 standard könyvtár). A teljes szerződés a szkript docstringjében van; a
működés, a kapcsolók és a konfiguráció részletes leírása az
[angol változatban](en/heavy-job-gate.md) található. Röviden:

- **Sor és zár:** `store/.heavy-job-queue/` (jegyek), `store/.heavy-job.lock` (zár).
  A halott folyamatok jegyeit bárki eltávolítja, aki látja őket, így egy összeomlott
  várakozó nem akasztja meg a sort.
- **Napló:** `store/heavy-job-log.jsonl`, eseményenként egy JSON-sor (`wait`, `start`,
  `finish`, `refuse` egy `reason` mezővel, `uncapped`, `ollama_unload`, `nested`,
  `nested_unverified`). A `cmd` mező csak a program neve és az argumentumok első
  32 karaktere, a teljes argv soha (argv-ben token is lehet). 5 MiB-nál a napló
  egyszer `heavy-job-log.jsonl.1`-re fordul.
- **Fájljogok:** a zár, a jegyek és a napló `0600`-as, a sor könyvtára `0700`-as,
  az umasktól függetlenül. A zárat és a naplót a kapu szimbolikus linken át soha nem
  nyitja meg, és csak a hívó saját, közönséges fájlját fogadja el (különben a zár 74,
  a naplósor elmarad).
- **Ellenőrzött keret:** minden hívás előtt egy próba-scope `MemoryMax=64M`-et kap, és
  a benne futó gyerekfolyamatnak a saját cgroupja `memory.max` értékét pontosan
  64 MiB-nak kell visszaolvasnia. Ha ott `max` áll, vagy nincs is ilyen fájl, a keret
  nem érvényes, és a kapu 77-tel elutasít, ahelyett hogy keret nélkül futtatná a
  feladatot, miközben keretesnek naplózza. A start-sor `capped: true` értéke azt
  jelenti, hogy ez az ellenőrzés sikerült.
- **Konfiguráció környezeti változókkal** (a kapcsoló erősebb): `HEAVY_JOB_MIN_MB`
  (2500), `HEAVY_JOB_MAX_MEM` (2G), `HEAVY_JOB_SWAP_MAX` (256M), `HEAVY_JOB_WAIT_SEC`
  (300), `HEAVY_JOB_RESERVE_MB` (500), `HEAVY_JOB_AGENT`, `HEAVY_JOB_STORE`
  (alapból `<telepítés gyökere>/store`), `HEAVY_JOB_OLLAMA_UNLOAD=1` (memóriahiánynál
  egyszer kiüríti a betöltött ollama-modelleket; alapból ki van kapcsolva, és maradjon
  is, ha egy ügynök helyi ollama-modellen fut).
- **Sorrend a FIFO felett:** `--agent` (méltányosság: ugyanaz az ügynök nem veheti el
  kétszer egymás után a zárat, amíg más vár) és `--max-sec N`, N <= 300 (rövid sáv: a
  rövid feladat előzhet, de legfeljebb három egymás után egy várakozó hosszút).
- **Beágyazott hívás:** egy kapu alatt futó feladat, amely maga is a kaput hívja,
  második zár nélkül fut, de csak ha ez ellenőrizhető (a zár tényleg foglalt, a rekord
  a feladat tokenjét hordozza, és a hívó cgroupja a rögzített scope-on belül van).

### Követelmények

- Linux, cgroup v2, és systemd user manager az ügynököket futtató felhasználónak
  (fej nélküli gépen: `loginctl enable-linger <felhasználó>`). A `MemoryMax`-hoz a
  memory controllernek delegálva kell lennie a user managerhez:
  `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers`
  kimenetében legyen ott a `memory`. A kapu ezt minden hívásnál maga is ellenőrzi
  (lásd fent): delegálás nélkül 77-tel elutasít, `cap_probe=cap_not_in_effect`.
- macOS-en nem működik: nincs `systemd-run` (77), és nincs `/proc/meminfo` (75, a
  `--allow-uncapped` mellett is).

### Ismert korlátok

- Ha magát a kaput SIGKILL éri, nem tud takarítani: a kernel elengedi a zárat,
  miközben a feladat scope-ja tovább fut, így a következő nehéz feladat mellé
  indulhat; ekkor csak a memória-padló védi a gépet.
- A további korlátok az [angol változatban](en/heavy-job-gate.md#known-limits).
