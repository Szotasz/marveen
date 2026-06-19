# Ágens feladatállapot (Agent Task State)

> Kontextus-tömörítés közbeni amnézia-megelőzés: strukturált feladatállapot mentése és újra-injektálása, hogy az ügynök ott folytassa ahol abbahagyta.

---

## 🎯 Mit tud / miért érdekes

Hosszú futású feladatok közben a Claude Code automatikusan **tömöríti a kontextust** (PreCompact hook). Ilyenkor elveszhet a "pontosan hol tartok, mit csináltam már, mit NEM kell megismételni" információ -- az ügynök "amnéziásan" folytatja, és a legrosszabb esetben **újra delegál már kiadott feladatokat** vagy újra elvégez már kész lépéseket.

Az Agent Task State rendszer ezt oldja meg:

1. **PreCompact hook** (tömörítés előtt): az ügynök strukturált rekordot ír -- kész lépések, már delegált feladatok, következő akció, nyitott döntések
2. **SessionStart hook** (újrainduláskor): ha a forrás `compact` vagy `resume`, a rekord visszainjektálódik az ügynök kontextusába
3. Az ügynök pontosan tudja: "ezt már csináltam, ezt NE ismételjem, innen folytassam"

**Fail-safe tervezés**: ha a PreCompact kivonás meghiúsul, nem íródik rekord -- a re-injekció no-op, Claude saját összefoglalója marad érvényes. A rendszer csak segíthet, soha nem ront.

---

## 🗂 Rekord struktúra

```json
{
  "agent": "zack",
  "doneSteps": [
    "PR branch létrehozva és pusholt",
    "Cross-fork compare ellenőrizve"
  ],
  "alreadyDelegated": [
    "Compare link átadva Jarvisnak"
  ],
  "nextAction": "Megvárni Jarvis megerősítését a PR megnyitásáról",
  "pendingDecision": "",
  "summary": "docs/scheduled-tasks PR előkészítése és push cett forkra",
  "ts": 1748956800000,
  "consumed": false
}
```

| Mező | Leírás |
|------|--------|
| `agent` | Az ügynök azonosítója (fájlnévvé alakul) |
| `doneSteps` | Kész lépések -- **NE ismételd meg** |
| `alreadyDelegated` | Már kiadott delegálások -- **NE küldd újra** |
| `nextAction` | Ahol folytatni kell |
| `pendingDecision` | Nyitott döntés/blokkolo, ha van |
| `summary` | Egy sor: mi folyik éppen |
| `ts` | Írási időpont (epoch ms) |
| `consumed` | `true` = már visszainjektálva, nem játszik újra |

---

## 🔄 Életciklus

```
Feladat futás
    │
    ▼
[kontextus telítődik]
    │
    ▼
PreCompact hook
    └─ ügynök struktúrált rekordot ír
       store/agent-taskstate/<agent>.json
    │
    ▼
Claude Code tömörít
    │
    ▼
SessionStart hook (source=compact)
    └─ rekord létezik + nem consumed + TTL ok?
       ├─ igen: additionalContext-be injektálja, consumed=true
       └─ nem: no-op
    │
    ▼
Ügynök folytatja a feladatot
(pontosan tudja mi kész, mi nem)
```

---

## 📍 Rekord helye

```
store/agent-taskstate/
  jarvis.json
  zack.json
  ...
```

Minden ügynöknek saját fájl. Az ügynök neve sanitizálódik (csak `a-z`, `A-Z`, `0-9`, `_`, `-` engedett fájlnévként).

---

## ⏱ TTL (érvényességi idő)

A rekord **12 óra** után automatikusan `orphan sweep`-pel törlődik, hogy elavult állapot ne injektálódjon vissza. Valóban futó hosszú feladatoknál ez elegendő -- a PreCompact hook minden tömörítéskor frissíti a rekordot.

---

## 🔧 Re-injekció feltételei

Egy rekord **csak akkor** injektálódik vissza, ha:

| Feltétel | Magyarázat |
|----------|------------|
| Rekord létezik | `store/agent-taskstate/<agent>.json` megvan |
| `consumed == false` | Nem játszódott még le |
| `source` = `compact` vagy `resume` | Hideg indulásra (`startup`) NEM játszik -- csak folytatásnál |
| TTL-en belül | Legfeljebb 12 óra régi |
| Nem üres rekord | Van legalább egy kész lépés, delegálás, következő akció vagy nyitott döntés |

---

## 📝 Injektált szöveg formátuma

Az ügynök kontextusába az alábbi struktúra kerül (magyarul, szándékosan feltűnő):

```
=== TASK-FOLYTATAS (NEM uj feladat) ===

A kontextusod tömörítődött egy FOLYAMATBAN LÉVŐ feladat közben.
Ez NEM új feladat -- FOLYTASD onnan ahol abbahagyta.
NE INDÍTSD újra a már kész lépéseket, és NE delegáld újra amit már átadtál.

FELADAT: docs/scheduled-tasks PR előkészítése

MÁR KÉSZ (NE ismételd meg):
  - PR branch létrehozva és pusholt
  - Cross-fork compare ellenőrizve

MÁR DELEGÁLVA (NE küldd újra):
  - Compare link átadva Jarvisnak

KÖVETKEZŐ AKCIÓ (innen folytasd): Megvárni Jarvis megerősítését
```

---

## 🛠 API

A task-state kezelése elsősorban hook-ok és az ügynök-kód szintjén történik. Dashboard-on megtekinthető (dev/debug célra):

```
GET /api/agents/<name>/taskstate
```

Visszaadja az aktuális rekordot, ha van.

---

## Kapcsolódó dokumentumok

- [Ügynök-flotta](agent-fleet.md) -- ügynök életciklus, hooks
- [Skill-factory](skill-factory.md) -- PreCompact hook és skill-reflexió
- [Háttérfeladatok](background-tasks.md) -- hosszú futású munkafolyamatok
