# Heartbeat + fokozatos autonómia

> Az asszisztens nem vár arra hogy szólj neki. Ütemezetten körülnéz, és te szabod meg, mennyire engeded el a kezét.

---

## 🎯 Mit tud / miért érdekes

A legtöbb AI-asszisztens reaktív: kérdezel, válaszol. Marveen ezzel szemben **proaktív** — óránként/ütemezetten magától ellenőrzi a környezetét (kanban-tábla, naptár, memória, rendszer-állapot), és csak akkor szól, ha tényleg van mit jelenteni.

Ennek a viselkedésnek a kulcsa a **fokozatos autonómia**: egy bizalmi-létra, amin kategóriánként beállítod, mennyit cselekedhet az asszisztens egyedül:

- **1. szint — Csak jelez:** észreveszi a dolgot, és megkérdezi mielőtt bármit tenne.
- **2. szint — Javasol + jóváhagyás:** előkészíti a konkrét lépést, és egy kattintásra jóváhagyod.
- **3. szint — Autonóm + jelent:** alacsony kockázatú, előre engedélyezett feladatoknál magától megcsinálja, és utólag jelzi.

Egy dashboard-felületen, kategóriánként húzod feljebb-lejjebb a szintet — projekt-fázistól függően lazíthatsz vagy szigoríthatsz. Például a "régi, lezárt feladatok archiválása" mehet teljes autonómiára, miközben a "publikálás" vagy "pénzmozgás" mindig jóváhagyás-köteles marad.

**A biztonsági korlát beépített:** a visszafordíthatatlan, kifelé menő műveletek (email-küldés, publikálás, vásárlás, törlés, jogosultság-változtatás) **zárolva** vannak — akármit állítasz, ezek sosem válhatnak teljesen autonómmá. Ez nem opció, hanem kódba égetett határ.

**Kuriózum:** ez a minta lényegében az, amit az Anthropic 2025-ben hivatalosan "Routines" névvel mutatott be — proaktív, ütemezett ügynökök, kategóriánként állítható autonómiával. Marveen ezt a mintát már korábban élesben futtatta, saját ütemezett-feladat + heartbeat infrastruktúrán. Nem konceptként, hanem valódi termelési rendszerként, amely naponta fut.

---

## 🛠 Hogyan működik

### Komponensek

1. **Ütemezett feladatok (heartbeat-ek):** cron-szerű ütemezésű promptok (pl. memória-mentés, kanban-audit, déli/reggeli összefoglaló). Minden futás egy rövid, fókuszált ellenőrzés.
2. **Autonómia-config:** egy `store/autonomy-config.json` tárolja kategóriánként a szintet (`level: 1|2|3`), a zárolt (`locked`) flag-et és a `maxLevel`-t.
3. **Dashboard UI + API:** `GET/POST /api/autonomy` olvassa/írja a configot; a felület kategória-soronként szint-választót ad, a zárolt sorok szürkén, lakattal. A backend server-side tiltja a zárolt kategóriák szint-emelését.
4. **Heartbeat-bekötés:** minden ütemezett feladat a futás elején beolvassa a rá vonatkozó kategória szintjét, és aszerint viselkedik.

### Szint-logika (példa: kanban-audit)

```
level 3  → a 7+ napos lezárt kártyákat magától archiválja;
           beakadt feladatnál magától szól a felelősnek, és csak
           2 eredménytelen kör után eszkalál a felhasználóhoz
level 2  → nem cselekszik magától; üzenetben javasolja, és vár a jóváhagyásra
level 1  → csak listázza/jelzi, semmit nem tesz
```

Hiányzó config vagy kulcs esetén a default a 3. szint (a korábbi viselkedés).

### Config-séma

```json
{
  "version": 1,
  "categories": [
    { "key": "kanban_archive_done", "label": "...", "level": 3, "locked": false, "maxLevel": 3 },
    { "key": "email_send",          "label": "...", "level": 1, "locked": false, "maxLevel": 2 },
    { "key": "payment",             "label": "...", "level": 1, "locked": true,  "maxLevel": 1 }
  ]
}
```

- `locked: true` + `maxLevel: 1` → hard-safety kategória, nem emelhető (publikálás, pénz, törlés, jogosultság, külső üzenet).
- `email_send` speciális: állítható, de `maxLevel: 2` (vázlat + jóváhagyás, sosem teljesen autonóm küldés).

### Telepítés / frissítés

A default config a `seed-config/` mappában van; az install kimásolja `store/`-ba, ha még nincs. Frissítéskor a meglévő configot **nem írja felül** — csak a hiányzó (újonnan bevezetett) kategóriákat fűzi hozzá, a felhasználó által beállított szinteket érintetlenül hagyva.

### Bővítés

Új autonómia-kategória: vedd fel a `seed-config/autonomy-config.json`-ba (`key`, `label`, `level`, `locked`, `maxLevel`), és a releváns heartbeat-prompt olvassa be a szintet a cselekvés előtt. A hard-safety határt mindig tartsd: kifelé menő / visszafordíthatatlan művelet sosem kap `maxLevel > 1`-et (az email a kivétel, `maxLevel: 2`).
