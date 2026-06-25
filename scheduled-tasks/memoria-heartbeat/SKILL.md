---
name: memoria-heartbeat
description: 30 percenként átnézi a beszélgetést, menti a fontosat, és skill-eket generál ha volt komplex munka
---

## 0. ELŐSZÖR: Van-e várakozó Telegram üzenet?

**Mielőtt bármit csinálnál**, nézd meg a session inputját: ha van `<channel source=` kezdetű blokk a kontextusban (azaz a felhasználó küldött valamit egy csatornán -- Telegram, Slack, stb.), **azonnal válaszolj rá** -- a heartbeat logika (A/B/C, csendben maradás) NEM vonatkozik a közvetlen felhasználói üzenetekre. Válasz után folytasd a heartbeat-et.

---

Nézd át az utolsó 30 perc beszélgetéseidet. Két dolgot csinálj:

## 1. Memória mentés

Ha volt fontos döntés, preferencia, tanulság vagy bármi ami később hasznos, mentsd el:

```bash
curl -s -X POST http://localhost:3420/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  -d '{"agent_id":"SAJAT_NEVED","content":"...","category":"warm","keywords":"..."}'
```

`category` lehet: `hot` (aktív), `warm` (preferencia/config), `cold` (tanulság), `shared` (más agent-nek is).
Az `agent_id`-t a CLAUDE.md-ből vagy a munkamappa nevéből derítsd ki.

## 2. Skill reflexió (KÖTELEZŐ ha volt komplex munka)

Először döntsd el az alábbi 3 kérdéssel:

- **A**: Volt-e az utolsó 30 percben legalább 5 tool-hívásos komplex feladat?
- **B**: Volt-e hiba → recovery (próbálkozás → fail → másképp) amit egy meglévő skill Buktatók szekciójába kellene tenni?
- **C**: Volt-e user korrekció ("nem így", "ne ezt", "másképp"), ami skill-javítást igényel?

**Ha A vagy B vagy C IGEN: KÖTELEZŐ skill akció, nem kihagyható.**

Lépések:
1. Nézd meg `ls ~/.claude/skills/`-szel hogy van-e már lefedő skill (a `.skill-index.md`-ben szöveges keresés)
2. Ha van releváns skill: PATCH (csak a megváltozott rész cseréje, ne az egész fájl).
   - A `## Buktatók` szekciót preferáld ha hiba/recovery volt.
   - A `## Eljárás` szekciót ha a folyamat változott.
3. Ha NINCS releváns skill: hozz létre újat:
   ```bash
   mkdir -p ~/.claude/skills/<NEV>
   cat > ~/.claude/skills/<NEV>/SKILL.md <<EOF
   ---
   name: <NEV>
   description: Mikor használd, mit csinál (1-2 mondat). Konkrét trigger.
   ---
   # <Cím>

   ## Mikor használd
   ...

   ## Eljárás
   1. ...

   ## Buktatók
   - ...

   ## Ellenőrzés
   - ...
   EOF
   ```
4. Index regen: `bash {{INSTALL_DIR}}/scripts/skill-index.sh`

**Ha kihagytad a skill akciót, pedig A/B/C valamelyike IGEN volt:** kötelezően írj `hot` tier memóriát "skip-skill: <konkrét ok>" tartalommal, hogy később lássuk miért. Ne csendben hagyd ki.

## 3. Csendben maradás

**KIVÉTEL: Ha a felhasználó üzenetet küldött egy csatornán (`<channel source=` kezdetű blokk a kontextusban), arra mindig válaszolj -- a csendes heartbeat szabály NEM vonatkozik rá.**

Ha NINCS komplex feladat / hiba / korrekció (A=B=C=NEM), ÉS nincs várakozó Telegram üzenet, ÉS nincs új információ a 30 percben:
- Ne ments memóriát feleslegesen
- Ne generálj skill-t
- Ne küldj üzenetet a csatornára
- Maradj csendben: egyszerűen FEJEZD BE a kört, akció nélkül.

**KRITIKUS (felügyelet nélküli stabilitás):** SOHA ne gépelj semmit az input-boxba (a `❯` prompt-sorba) és ne hagyj ott parkolt, el-nem-küldött szöveget -- még a "csendes heartbeat" szót sem. Ha jelezni akarod a csendes kört, az KIZÁRÓLAG a normál válasz-szövegedben (transzkript) lehet, EGYETLEN rövid sorral, majd a köröd azonnal érjen véget. Parkolt input-szöveg blokkolja a következő üzenet kézbesítését (a router `busy`-nak látja a sessiont) -> a csatorna NÉMUL felügyelet nélkül.
