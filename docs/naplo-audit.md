# Napló - Audit Idővonal

A dashboard "Napló" oldala egységes, csak-olvasható nézetben jeleníti meg a rendszer auditálható eseményeit: beállítás-változások, ötletláda státuszváltások és store-könyvtár fájlesemények.

---

## Adatforrások

### Config change-log (`config_change_log`)

Minden sikeres `POST /api/settings` kérés audit-sort ír ebbe a táblába. Titkos beállítás (`secret: true`) esetén az `old_value` és `new_value` mező `null` -- a tény rögzítve van, de az érték soha nem.

Mezők: `key`, `old_value`, `new_value`, `actor`, `created_at`

### Ötletláda-audit (`idea_status_log`)

Minden ötlet-státuszváltáskor (pl. `new` -> `kanban`, `kanban` -> `new` visszavonáskor) a rendszer beírja a változást. A `promote-breakdown` ágon is keletkezik bejegyzés.

Mezők: `idea_id`, `from_status`, `to_status`, `actor`, `note`, `created_at`

### Store-fájl audit (`store_file_audit`)

Induláskor a szerver `fs.watch()` figyelőt indít a `store/` könyvtárra. Minden `change` és `rename` esemény (fájl írás, átnevezés, törlés) rögzítődik. Tartalom soha nem kerül a táblába -- csak az útvonal, az esemény típusa és a fájlméret (ha meghatározható).

Érzékeny fájlok (`.dashboard-token`, `vault.json`, `.vault-key`) az `is_sensitive=1` jelzőt kapják; a UI "sensitív" felirattal jelzi őket.

Automatikusan kizárt fájlok: atomi írás temp-fájljai (`.tmp.<hex>`), `.migrated` és `.bak` utótagú fájlok.

Mezők: `rel_path`, `event_type`, `is_sensitive`, `file_size`, `created_at`

---

## API

### `GET /api/audit-log`

Bearer tokennel védett.

| Paraméter | Típus | Leírás |
|-----------|-------|--------|
| `source` | string | Vesszővel elválasztott forrásszűrő: `config`, `idea`, `store`. Üres = mind. |
| `from` | int | Unix timestamp, ettől (inclusive). |
| `to` | int | Unix timestamp, eddig (inclusive). |
| `q` | string | Szabadszavas keresés (kulcs, útvonal, note stb.). |
| `limit` | int | Maximum bejegyzésszám (alapérték: 200, max: `AUDIT_LOG_MAX_ENTRIES`). |

Válasz:
```json
{
  "entries": [
    {
      "id": 1,
      "source": "config",
      "created_at": 1718000000,
      "key": "KANBAN_WIP_IN_PROGRESS",
      "old_value": "5",
      "new_value": "8",
      "actor": "dashboard"
    },
    {
      "id": 2,
      "source": "idea",
      "created_at": 1718000100,
      "idea_id": "abc123",
      "from_status": "new",
      "to_status": "kanban",
      "actor": "jarvis",
      "note": "promote:planning"
    },
    {
      "id": 3,
      "source": "store",
      "created_at": 1718000200,
      "rel_path": "config-overrides.json",
      "event_type": "change",
      "is_sensitive": 0,
      "file_size": 512
    }
  ],
  "total": 3
}
```

Az eredmények `created_at DESC` sorrendben érkeznek; a mergelt sorrend forrás-független.

---

## Konfiguráció

Az alábbi kulcsok a Settings oldalon (Audit modul) szabályozzák a napló viselkedését:

| Kulcs | Alapérték | Leírás |
|-------|-----------|--------|
| `AUDIT_LOG_RETENTION_DAYS` | 90 | Ennyi napnál régebbi bejegyzések törlődnek a napi sweep során. |
| `AUDIT_LOG_MAX_ENTRIES` | 10 000 | Az API legfeljebb ennyi bejegyzést ad vissza egy kérésenként. |

A törlés a `runDecaySweep()` függvényből hívott `pruneAuditLogs()` függvényen keresztül történik, amely naponta egyszer fut (24 órás ciklus).

---

## Dashboard UI

A bal oldali navigációban a "Napló" menüpont nyitja meg az oldalt.

**Forrás-fülek**: Összes / Config / Ötletláda / Store-fájlok -- a kiválasztott fülre kattintva azonnal szűr.

**Dátumszűrő**: "Ettől" -- "Eddig" dátummező; mindkettő opcionális. Ha mindkettő üres, az összes bejegyzés megjelenik (a `limit` értékéig).

**Keresőmező**: a `q` paraméternek megfelelő szabad szöveges szűrés (key, rel_path, note, actor stb.).

**Frissítés gomb**: manuálisan újratölti az aktuális szűrési feltételekkel.

Az oldal csak-olvasható: szerkeszteni nem lehet, törölni csak az automatikus sweep által.

---

## Kapcsolódó dokumentumok

- [Beállítások rendszer](config-reference.md#beallitasok-rendszer-settings)
- [Ötletláda](ideabox.md)
