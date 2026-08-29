---
name: memoria-heartbeat
description: Minden körben átnézi az ELŐZŐ KÖR ÓTA történteket, menti a fontosat, és skill-eket generál ha volt komplex munka
---

## 0. ELŐSZÖR: Van-e várakozó Telegram üzenet?

**Mielőtt bármit csinálnál**, nézd meg a session inputját: ha van `<channel source=` kezdetű blokk a kontextusban (azaz a felhasználó küldött valamit egy csatornán -- Telegram, Slack, stb.), **azonnal válaszolj rá** -- a heartbeat logika (A/B/C, csendben maradás) NEM vonatkozik a közvetlen felhasználói üzenetekre. Válasz után folytasd a heartbeat-et.

---

Nézd át, mi történt **az előző memória-kör óta**. Két dolgot csinálj:

> **AZ ABLAK "AZ ELŐZŐ KÖR ÓTA", NEM FIX PERCSZÁM -- MÉRVE 2026-08-22.** A szöveg korábban két
> helyen is fix "30 perc"-et mondott, miközben a tényleges kadencia (a `task_runs` közökből mérve)
> 15 perc volt: a 2x-es eltérés miatt **minden kör újranézte azt az ablakot, amit az előző már
> feldolgozott** -- ez strukturálisan duplikált memória-írást és duplikált skill-patchet hív elő,
> mert a friss kontextus nem tudja, hogy az előző kör már lezárta. A fix percszám a konfigurált
> kadenciával együtt avul; "az előző kör óta" nem.
> **HA MÉGIS ÁTFEDÉST LÁTSZ:** a mérce nem az idő, hanem hogy *lezártad-e már*. Ha egy munkára már
> írtál memóriát vagy patcheltél skillt az előző körben, az KÉSZ -- ne írd meg újra más szavakkal.

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

- **A**: Volt-e AZ ELŐZŐ KÖR ÓTA legalább 5 tool-hívásos komplex feladat? (Ami már az előző körben le lett zárva, az NEM számít -- lásd fent az ablak-megjegyzést.)
- **B**: Volt-e hiba → recovery (próbálkozás → fail → másképp) amit egy meglévő skill Buktatók szekciójába kellene tenni?
- **C**: Volt-e user korrekció ("nem így", "ne ezt", "másképp"), ami skill-javítást igényel?

**Ha A vagy B vagy C IGEN: KÖTELEZŐ skill akció, nem kihagyható.**

Lépések:
1. Keress meglévő skillt a globális és az ágensspecifikus indexben egyaránt:
   - Globális: `~/.claude/skills/.skill-index.md` (szöveges keresés)
   - Ágensspecifikus (ha van): `./.claude/skills/.skill-index.md` a munkamappádban (szöveges keresés)
   - Az ágensspecifikus index mindkét szintet tartalmazza, tehát ha az létezik, elég azt nézegetni.
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
4. Index regen (mindkét szint):
   ```bash
   bash {{INSTALL_DIR}}/scripts/skill-index.sh          # globális index frissítése
   bash {{INSTALL_DIR}}/scripts/skill-index.sh "$(pwd)" # ágensspecifikus merged index frissítése
   ```

**Ha kihagytad a skill akciót, pedig A/B/C valamelyike IGEN volt:** kötelezően írj `hot` tier memóriát "skip-skill: <konkrét ok>" tartalommal, hogy később lássuk miért. Ne csendben hagyd ki.

## 3. Csendben maradás

**KIVÉTEL: Ha a felhasználó üzenetet küldött egy csatornán (`<channel source=` kezdetű blokk a kontextusban), arra mindig válaszolj -- a csendes heartbeat szabály NEM vonatkozik rá.**

Ha NINCS komplex feladat / hiba / korrekció (A=B=C=NEM), ÉS nincs várakozó Telegram üzenet, ÉS nincs új információ az előző kör óta:
- Ne ments memóriát feleslegesen
- Ne generálj skill-t
- Ne küldj üzenetet a csatornára
- Maradj csendben: egyszerűen FEJEZD BE a kört, akció nélkül.

**KRITIKUS (felügyelet nélküli stabilitás):** SOHA ne gépelj semmit az input-boxba (a `❯` prompt-sorba) és ne hagyj ott parkolt, el-nem-küldött szöveget -- még a "csendes heartbeat" szót sem. Ha jelezni akarod a csendes kört, az KIZÁRÓLAG a normál válasz-szövegedben (transzkript) lehet, EGYETLEN rövid sorral, majd a köröd azonnal érjen véget. Parkolt input-szöveg blokkolja a következő üzenet kézbesítését (a router `busy`-nak látja a sessiont) -> a csatorna NÉMUL felügyelet nélkül.

## 4. ZÁRÓ STAMP (KÖTELEZŐ, a kör UTOLSÓ lépése -- csendes körnél is)

**MÉRT HIÁNY (2026-08-23): ennek a körnek korábban NEM volt záró nyoma.** Kívülről
megkülönböztethetetlen volt, hogy a kör LEFUTOTT és csendes volt, vagy el sem jutott a végéig --
"csendes kör"-t állítani úgy, hogy bizonyítani nem lehet, pont a hamis-nulla hibaosztály.

Ezért a kör VÉGÉN, minden ágon (csendes körnél is), egyetlen sor:

```bash
python3 -c "import json,time; json.dump({'last_run_at': int(time.time()), 'outcome': 'OUTCOME'}, open('{{INSTALL_DIR}}/store/memoria-heartbeat-state.json','w'))"
```

Az `OUTCOME` értéke: `silent` (csendes kör), `memory` (memória mentve), `skill` (skill akció volt),
`both`. A stamp attól ér valamit, hogy KIVÉTEL NÉLKÜL íródik -- egy kihagyott csendes kör a
következő mérésben futás-hiánynak látszik.
