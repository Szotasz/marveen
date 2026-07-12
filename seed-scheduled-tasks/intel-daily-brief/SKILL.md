---
name: intel-daily-brief
description: Proaktív hírszerző -- napi brief 07:00-kor az intel registry-ből (store/intel.db). Az intel-collector párja, azzal együtt kapcsold be.
---

# Proaktív hírszerző -- napi brief

> ⚠️ SABLON: alapból KIKAPCSOLVA érkezik (task-config.json: `"enabled": false`).
> Az intel-collector taskkal együtt kapcsold be -- a brief abból a registry-ből
> épül, amit a collector tölt fel.

## Adatok betöltése

Futtasd: `python3 {{INSTALL_DIR}}/scripts/intel_db.py --dump`
(JSON: registry utolsó 14 nap + watchlist + active_focus.)

## Priority Score (Claude végzi, nem a collector)

Minden Registry tételre: Relevancia 40% + Sürgősség 25% + Hatás a tulajdonosra
20% + Megbízhatóság (forrás-tier) 15%. Alacsony konfidenciájú tétel: max
Watchlist-említés, nem kerül a brief törzsébe.

## Brief formátum (Telegram, MarkdownV2)

```
📊 Mai állapot: Nyugodt / Figyelendő / Feszült / Kritikus
⭐ Top 3 döntési jel ma: 1. ... 2. ... 3. ...

🟦 [DOMAIN NÉV]
• Mi történt: [1 mondat, forrás + tier]
  → Miért számít: [...] → Hatás: 🔴/🟠/🟢
  → Mit tehetsz: [akció vagy "csak figyeld"]

🔍 Mi maradt ki: X ismétlés · Y gyenge forrás
👁 Watchlist: [...] 🎯 Aktív fókusz: [...]
```

Üres domain: hagyd ki teljesen, ne írj "nincs mozgás" sorokat.

## Küldés

Telegram a tulajdonosnak ({{OWNER_NAME}}) a reply tool-lal, MarkdownV2 formátumban.
Escapelni kell: . - ( ) + = ! { } [ ] | ~ > # karaktereket.

## Ha a Registry üres

Küldd: "📊 Reggeli brief: az adatgyűjtés még inicializálás alatt. Az óránkénti
ciklus ma feltölti a Registry-t." Ha 2+ napja üres, jelezd hogy az
intel-collector task valószínűleg nem fut vagy nem ír a registry-be.
