---
name: memoria-heartbeat-{{AGENT_NAME}}
description: 4 óránként átnézi {{AGENT_NAME}} munkáját, menti a szakterületi tanulságot, és skillt generál/patch-el ha volt komplex munka
---

## 0. ELŐSZÖR: Van-e várakozó üzenet?

**Mielőtt bármit csinálnál**, nézd meg a session inputját: ha van `<channel source=` kezdetű blokk a kontextusban (a felhasználó írt egy csatornán), **azonnal válaszolj rá** -- a heartbeat csendben-maradás logikája NEM vonatkozik a közvetlen felhasználói üzenetekre. Válasz után folytasd a heartbeat-et.

---

Nézd át az elmúlt 4 óra munkádat. A cél: amit megtanultál, ne vesszen el a session végén. A szakmai mélységed abból épül, amit Jónás Gergő munkájáról FELHALMOZOL, nem abból, amit a leíród állít rólad.

## 1. Memória mentés

Ha volt fontos döntés, preferencia, tanulság vagy szakmai minta, mentsd EL AZONNAL:

```bash
curl -s -X POST http://localhost:3420/api/memories \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  -d '{"agent_id":"{{AGENT_NAME}}","content":"...","category":"warm","keywords":"..."}'
```

Az `agent_id` a TIÉD: **{{AGENT_NAME}}**. Ne írj mást.

`category`: `hot` (aktív feladat), `warm` (preferencia/konfig/eljárás), `cold` (tanulság, történeti döntés), `shared` (más ágensnek is releváns).

**Amit MENTS (ez a lényeg):**
- Jónás Gergő SAJÁT eljárása, preferenciája, konvenciója a szakterületeden ("így bontja a költségeket", "ilyen formátumban kéri a riportot")
- A rendszer/projekt konkrét ténye, amit kiderítettél és később is kelleni fog
- Hiba és a javítása -- főleg, ha egy feltételezésed dőlt meg
- Jónás korrekciója ("nem így", "másképp") -- ez a legértékesebb, mert ez a te hibád javítása

**Amit NE ments:** általános szakmai tudás (azt tudod), amit a kód/repo már rögzít, ami csak erre a beszélgetésre igaz.

Mentés ELŐTT keress rá, van-e már erről emléked -- ha van, azt frissítsd, ne duplikálj:
```bash
curl -s -H "Authorization: Bearer $(cat {{INSTALL_DIR}}/store/.dashboard-token)" \
  "http://localhost:3420/api/memories?agent={{AGENT_NAME}}&q=KULCSSZO"
```

## 2. Skill reflexió (KÖTELEZŐ ha volt komplex munka)

Döntsd el:
- **A**: Volt-e az elmúlt 4 órában legalább 5 tool-hívásos komplex feladat?
- **B**: Volt-e hiba -> recovery (próbálkozás -> fail -> másképp), ami egy skill Buktatók szekciójába való?
- **C**: Volt-e Jónás-korrekció ("nem így", "ne ezt", "másképp"), ami skill-javítást igényel?

**Ha A vagy B vagy C IGEN: KÖTELEZŐ skill akció, nem kihagyható.**

1. Nézd meg, van-e már lefedő skill: `ls ~/.claude/skills/` és `ls .claude/skills/` (a `.skill-index.md`-ben szöveges keresés)
2. Ha van releváns: PATCH (csak a változott rész, ne az egész fájl). Hiba/recovery -> `## Buktatók`. Változott folyamat -> `## Eljárás`.
3. Ha NINCS: hozz létre újat. **A SAJÁT skill-mappádba** (`.claude/skills/<NEV>/SKILL.md` a munkakönyvtáradban), mert ez a te szakterületi eljárásod, nem az egész flottáé. Csak akkor tedd globálisba (`~/.claude/skills/`), ha tényleg minden ágensnek kell.

```
---
name: <nev>
description: Mikor használd, mit csinál (1-2 mondat). Konkrét trigger.
---
# <Cim>

## Mikor használd
## Eljárás
## Buktatók
## Ellenőrzés
```

**A jó skill a TE eljárásod, nem tankönyv.** "Hogyan írjunk ADR-t" felesleges -- a modell tudja. "Hogyan csináljuk MI, hova mentjük, mit néz Jónás" hasznos. Ha a skill bármelyik modellnek ugyanígy hasznos lenne, akkor túl általános.

4. Index regen: `bash {{INSTALL_DIR}}/scripts/skill-index.sh`

**Ha kihagytad a skill akciót, pedig A/B/C valamelyike IGEN volt:** kötelezően írj `hot` memóriát "skip-skill: <konkrét ok>" tartalommal. Ne csendben hagyd ki.

## 3. Csendben maradás

Ha NINCS komplex feladat / hiba / korrekció (A=B=C=NEM), ÉS nincs várakozó csatorna-üzenet, ÉS nincs új információ:
- Ne ments memóriát feleslegesen
- Ne generálj skillt
- Ne írj Jónásnak
- Maradj csendben (egy rövid "csendes heartbeat" sor a transzkriptbe elég)

Ez heartbeat: alapból NÉMA. Csak akkor szólj Jónásnak, ha valami tényleg fontos vagy sürgős.
