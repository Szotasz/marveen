# Háttér-feladatok (background tasks)

> "Dolgozz ezen, amíg én mással foglalkozom." Az asszisztens a háttérben futtat egy feladatot, és szól ha kész.

---

## 🎯 Mit tud / miért érdekes

Néha egy feladat hosszú — kutatás, build, batch-feldolgozás — és nem akarsz mellette ülni. A háttér-feladat funkcióval az asszisztens **leválasztva** elindít egy munkát, te közben mással foglalkozol, és amikor kész, Telegramra jelez. A beszélgetés nem blokkolódik, a munkamenet nem foglalt.

**Kuriózum:** a prompt nem kerül közvetlenül parancsba — XML-taggel körülvéve, "untrusted data" kezeléssel fut. Ha egy feladat-leírásban véletlenül futtatható utasítás lenne, nem hajtódik végre. Ez nem mellékszempont: háttér-feladatnál, ahol nincs élő felügyelet, ez az egyik legfontosabb biztonsági határ.

---

## 🛠 Hogyan működik

### Indítás

Egy `/background` jellegű prefixszel vagy a dashboardról indítható feladat külön folyamatban fut. A rendszer követi az állapotát (fut / kész / hibázott), és a befejezésről értesít.

### Biztonság

A háttér-feladat promptja **nem épül közvetlenül parancsba** — XML-taggel körülvéve, "untrusted data" kezeléssel, hogy a feladat-leírásban lévő esetleges injektálás ne hajtódjon végre. A parancs-argumentumok env-változón át mennek (nem shell-interpolációval), így nincs shell-injection.

### Életciklus-API

```
POST /api/background-tasks      # új háttér-feladat (prompt env-változóból)
GET  /api/background-tasks      # állapot
```

A feladatok a dashboardon is láthatók, és a befejezés a megszokott csatornán (Telegram/Slack) jelez.

### Mikor érdemes

Hosszú, jól körülírt, felügyelet nélkül futtatható munkára (kutatás, batch-feldolgozás, build). Interaktív, gyakori döntést igénylő feladatra inkább a normál, beszélgetős mód való.
