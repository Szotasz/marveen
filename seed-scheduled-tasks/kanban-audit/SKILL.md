---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek).
---

# Kanban 4 órás audit

## Mikor fut
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Eljárás

1. **State-fájl beolvasás**: `store/kanban-audit-state.json` tartalmazza `last_audit_at` Unix timestampet. Első futáskor null -> ne pingelj senkit, csak állítsd be a state-et.

2. **Tisztítás**: 7+ napos done kártyák archiválása:
   ```bash
   sqlite3 {{INSTALL_DIR}}/store/claudeclaw.db "UPDATE kanban_cards SET archived_at=unixepoch() WHERE status='done' AND archived_at IS NULL AND updated_at < strftime('%s','now','-7 days')"
   ```

3. **Beakadt task detection** (előző audit óta nem mozdult): in_progress kártyák amik `updated_at < last_audit_at`:
   ```bash
   LAST=$(jq -r .last_audit_at store/kanban-audit-state.json 2>/dev/null || echo 0)
   sqlite3 store/claudeclaw.db "SELECT id, title, assignee, ROUND((strftime('%s','now')-updated_at)/3600.0,1) as hours_stale FROM kanban_cards WHERE status='in_progress' AND archived_at IS NULL AND updated_at < $LAST ORDER BY hours_stale DESC"
   ```

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve {{MAIN_AGENT_ID}}-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```

5. **State-fájl frissítés** (a futás VÉGÉN): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Delegálatlan kártyák**: in_progress/waiting/planned amiknek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.

7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Egyébként csendben (heartbeat-stílus)

## Buktatók
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a felhasználó még látni akarja).
- NE pingelj saját magadat (skip ha assignee='{{MAIN_AGENT_ID}}').
- Ne re-pingelj 4 órán belül ugyanazt: a state-fájlban tárolt `last_audit_at` automatikusan kezeli ezt.
- Első futáskor (state-fájl üres) -> ne pingelj, csak inicializáld a state-et.
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.

## Ellenőrzés
- A state-fájl frissült a futás végén.
- Inter-agent message-ek sikeresek (200 response).
