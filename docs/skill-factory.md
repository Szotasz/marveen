# Skill-factory (öntanulás)

> Az asszisztens minden komplex feladat után megtanulja a leckét, és legközelebb már tudja.

---

## 🎯 Mit tud / miért érdekes

A legtöbb AI újra és újra elköveti ugyanazt a hibát. Marveen ehelyett **öntanuló**: amikor egy nem-triviális munkafolyamatot végigvisz (vagy beleszalad egy hibába és kijavítja), abból egy **újrahasznosítható skill**-t (recept) ír magának. Legközelebb ugyanaz a helyzet már nem próbálgatás, hanem rutin.

Ha menet közben jobb megoldást talál egy meglévő recepthez, nem írja újra az egészet — csak a megváltozott részt javítja (patch), és feljegyzi a "Buktatók" közé hogy miért.

**Kuriózum:** a skill-ek progresszív betöltéssel működnek — alapból csak a nevük + rövid leírásuk van a memóriában (pár szó), a teljes recept csak akkor töltődik be, amikor tényleg releváns. Így több tucat skill is elfér token-pazarlás nélkül.

---

## 🛠 Hogyan működik

### Skill-struktúra

Minden skill egy `SKILL.md` (frontmatter: `name`, `description` a triggereléshez) + opcionális `references/`, `scripts/`. A `description` dönti el mikor aktiválódik, ezért konkrét trigger-leírás kell.

```
~/.claude/skills/<skill-nev>/SKILL.md
```

### Mikor készül skill

| Helyzet | Akció |
|---------|-------|
| 5+ tool-hívásos sikeres komplex feladat | skill generálás |
| Hiba → recovery → siker | skill + "Buktatók" szekció |
| Felhasználói korrekció | meglévő skill patch-elése |
| Egyszerű egylépéses feladat | semmi |

### Patch vs. újraírás

Meglévő skillnél célzott csere (régi szöveg → új), nem teljes újraírás. A változás oka a "Buktatók" szekcióba kerül, hogy a tanulság megmaradjon.

### Progresszív betöltés (3 szint)

- **0. szint:** név + leírás (~100 szó) — mindig elérhető
- **1. szint:** teljes `SKILL.md` — csak ha releváns
- **2. szint:** segédfájlok (`scripts/`, `references/`) — csak ha specifikusan kell

A `SKILL.md` 500 sor alatt; nagyobb anyag a `references/`-be.

### Reflexió + szinkronizálás

A rendszer rendszeresen (heartbeat / kontextus-tömörítés előtt) megvizsgálja: van-e a session-ben újrahasznosítható minta? A flotta-szintű skill-ek a `seed-skills/` mappából install/update-kor terjednek minden telepítésre — **sanitálva** (nincs személyes adat, nincs konkrét ügynök-név, mert máshol más néven futhatnak az ügynökök).
