---
name: memoria-heartbeat
description: 30 percenként átnézi a beszélgetést, menti a fontosat, és MEGLÉVŐ skilleket patch-el ha volt komplex munka (az ÚJ-skill generálást az auto-skillify PreCompact hook végzi)
last_synced: 2026-08-28
---

## 0. ELŐSZÖR: Van-e várakozó Telegram üzenet?

**Mielőtt bármit csinálnál**, nézd meg a session inputját: ha van `<channel source=` kezdetű blokk a kontextusban (azaz a felhasználó küldött valamit egy csatornán -- Telegram, Slack, stb.), **azonnal válaszolj rá** -- a heartbeat logika (A/B/C, csendben maradás) NEM vonatkozik a közvetlen felhasználói üzenetekre. Válasz után folytasd a heartbeat-et.

---

Nézd át az utolsó 30 perc beszélgetéseidet. Két dolgot csinálj:

## 1. Memória mentés

Ha volt fontos döntés, preferencia, tanulság vagy bármi ami később hasznos, mentsd el:

```bash
curl -s -X POST http://localhost:{{WEB_PORT}}/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  -d '{"agent_id":"SAJAT_NEVED","content":"...","category":"warm","keywords":"..."}'
```

`category` lehet: `hot` (aktív), `warm` (preferencia/config), `cold` (tanulság), `shared` (más agent-nek is).
Az `agent_id`-t a CLAUDE.md-ből vagy a munkamappa nevéből derítsd ki.

## 2. Skill reflexió -- MEGLÉVŐ skill patch-elése (KÖTELEZŐ ha releváns)

**FONTOS:** az ÚJ skill létrehozását NEM itt csinálod -- azt az `auto-skillify` PreCompact hook végzi automatikusan (a session tool-historyjából, session végén). A heartbeat CSAK a MÁR LÉTEZŐ skillek javítását (patch) nézi, mert az cross-session visszatekintés, amit a hook nem lát.

Először döntsd el az alábbi 2 kérdéssel:

- **B**: Volt-e hiba -> recovery (próbálkozás -> fail -> másképp) amit egy meglévő skill Buktatók szekciójába kellene tenni?
- **C**: Volt-e user korrekció ("nem így", "ne ezt", "másképp"), ami egy meglévő skill javítását igényli?

**Ha B vagy C IGEN, ÉS van rá releváns MEGLÉVŐ skill: KÖTELEZŐ a patch, nem kihagyható.**

Lépések:
1. Keress meglévő skillt MINDKÉT indexben:
   - Globális: `~/.claude/skills/.skill-index.md`
   - Ágensspecifikus (ha van): `./.claude/skills/.skill-index.md` a munkamappádban
   - Az ágensspecifikus index mindkét szintet tartalmazza Scope-jelöléssel, tehát ha az létezik, elég azt nézegetni.
2. Ha van releváns skill: PATCH (csak a megváltozott rész cseréje, ne az egész fájl).
   - A `## Buktatók` szekciót preferáld ha hiba/recovery volt.
   - A `## Eljárás` szekciót ha a folyamat változott.
3. Ha NINCS releváns MEGLÉVŐ skill a mintához: NE hozz létre újat itt -- azt az auto-skillify hook kezeli. Ha úgy érzed sürgős és a hook valamiért nem kapta el, jelezd egy `hot` memóriában (`auto-skillify-miss: <mi maradt ki>`), hogy később skillbe emelhető legyen.
4. Index regen (csak ha patcheltél):
   ```bash
   bash {{INSTALL_DIR}}/scripts/skill-index.sh          # globális index frissítése
   bash {{INSTALL_DIR}}/scripts/skill-index.sh "$(pwd)" # ágensspecifikus merged index frissítése
   ```

**Ha kihagytad a patch-et, pedig B vagy C IGEN volt ÉS volt rá meglévő skill:** kötelezően írj `hot` tier memóriát "skip-skill: <konkrét ok>" tartalommal, hogy később lássuk miért. Ne csendben hagyd ki.

## 3. Csendben maradás

**KIVÉTEL: Ha a felhasználó üzenetet küldött egy csatornán (`<channel source=` kezdetű blokk a kontextusban), arra mindig válaszolj -- a csendes heartbeat szabály NEM vonatkozik rá.**

Ha NINCS hiba / korrekció (B=C=NEM), ÉS nincs várakozó Telegram üzenet, ÉS nincs új információ a 30 percben:
- Ne ments memóriát feleslegesen
- Ne patch-elj skillt feleslegesen
- Ne küldj üzenetet a csatornára
- Maradj csendben: egyszerűen FEJEZD BE a kört, akció nélkül.

**KRITIKUS (felügyelet nélküli stabilitás):** SOHA ne gépelj semmit az input-boxba (a `❯` prompt-sorba) és ne hagyj ott parkolt, el-nem-küldött szöveget -- még a "csendes heartbeat" szót sem. Ha jelezni akarod a csendes kört, az KIZÁRÓLAG a normál válasz-szövegedben (transzkript) lehet, EGYETLEN rövid sorral, majd a köröd azonnal érjen véget. Parkolt input-szöveg blokkolja a következő üzenet kézbesítését (a router `busy`-nak látja a sessiont) -> a csatorna NÉMUL felügyelet nélkül.
