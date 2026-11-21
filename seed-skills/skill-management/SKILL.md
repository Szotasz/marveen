---
name: skill-management
description: Skillek listázása, megtekintése, létrehozása, patchelése vagy törlése. A sajátjaidat (a munkakönyvtárad .claude/skills mappája) közvetlenül módosítod; a globálisakat (~/.claude/skills/) itt olvasod, és csak javaslattal változtatod. Akkor használd, ha a felhasználó az elérhető skillekről kérdez, egy meglévő skillt akar módosítani, vagy ha egy retrospektív skill-változtatást javasol. A "/skills" parancsra vagy skillhez kapcsolódó retrospektív lépésekre indul.
---

# Skill-kezelés: CRUD a skill-könyvtárhoz

## Mikor használd

- A felhasználó azt kérdezi: "milyen skilljeim vannak?", vagy azt kéri: "listázd a skilleket"
- A felhasználó egy konkrét skill tartalmát akarja megnézni
- Egy `/retrospective` CREATE, PATCH vagy DELETE lépést javasol skilleken
- A felhasználó azt mondja: "frissítsd az X skillt" vagy "javítsd az Y skillt"
- Rendszeres audit: elavult vagy duplikált skillek keresése

## Argumentumok

| Argumentum | Kötelező | Leírás |
|----------|----------|-------------|
| `action` | IGEN | Ezek egyike: `list`, `show`, `create`, `patch`, `delete`, `audit` |
| `name` | show/patch/delete esetén | A skill könyvtárneve (pl. `github-pr-rebase-merge`) |
| `scope` | nem | `own` (alapértelmezés, ./.claude/skills/ a munkakönyvtáradban: ezeket közvetlenül módosítod) vagy `global` (~/.claude/skills/: itt olvasod, csak javaslatként változtatod) |

Példák:
- `/skills action=list`: az összes skill listázása leírással
- `/skills action=show name=github-pr-rebase-merge`: a teljes SKILL.md megjelenítése
- `/skills action=create name=new-skill`: interaktív skill-létrehozás
- `/skills action=patch name=existing-skill`: konkrét szakaszok módosítása
- `/skills action=delete name=old-skill`: eltávolítás megerősítéssel
- `/skills action=audit`: elavult, duplikált vagy túlméretes skillek keresése

## Eljárás

### action=list

```bash
for SKILL_DIR in "./.claude/skills" "${HOME}/.claude/skills"; do
  echo "=== Skills in $SKILL_DIR ==="
  for dir in "$SKILL_DIR"/*/; do
    skill_file="$dir/SKILL.md"
    if [ -f "$skill_file" ]; then
      name=$(basename "$dir")
      # Extract description from frontmatter
      desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$skill_file")
      printf "  %-35s %s\n" "$name" "$desc"
    fi
  done
done
```

Tömör táblázatként mutasd be, a sajátokat és a globálisakat külön. Egy azonos nevű saját skill eltakarja a globálisat.

### action=show

1. Olvasd be a `./.claude/skills/{name}/SKILL.md` (saját) vagy a `~/.claude/skills/{name}/SKILL.md` (globális) fájlt
2. Ha van `references/` alkönyvtára, azokat a fájlokat is listázd
3. Mutasd be a teljes tartalmat

### action=create

Interaktív skill-létrehozó munkafolyamat:

1. Kérdezz rá az indító kontextusra: "Mikor kapcsoljon be ez a skill?"
2. Kérdezz rá az eljárás lépéseire: "Mit csinál, lépésről lépésre?"
3. Készítsd el a SKILL.md-t megfelelő frontmatterrel:

```markdown
---
name: {name}
description: {one-line, specific about triggers}
---

# {Title}

## When to use
{Concrete triggers and contexts}

## Procedure
1. {Step}
2. {Step}
...

## Pitfalls
- {Known issues, if any}
```

4. Saját (az alapeset): írd ide a munkakönyvtáradban: `./.claude/skills/{name}/SKILL.md`.
   Minden ágensnek (globális): a `~/.claude/skills/` alá NE írj; javaslatként küldd (lásd "Globális skill módosítása").
5. Saját: frissítsd az indexedet (lásd "A skill-index újragenerálása")

Szabályok:
- A SKILL.md maradjon 500 sor alatt
- A nagy referenciaanyag a `references/` alkönyvtárba kerül
- A leírás legyen elég konkrét az L0 illesztéshez (ne "csinál dolgokat")
- Az eljárás lépései legyenek konkrétak és végrehajthatók

### action=patch

Egy meglévő skill célzott módosítása:

1. Olvasd be a jelenlegi SKILL.md-t. Egy saját skillt helyben patchelsz; egy globálisat soha nem ott szerkesztesz, ahol
   él: a TELJES javított szöveg javaslatként megy ugyanazon a néven (lásd "Globális skill módosítása")
2. A felhasználó kérése vagy a retrospektív javaslata alapján azonosítsd a módosítandó szakaszt
3. Célzott szerkesztést végezz (régi szöveg -> új szöveg), ne teljes újraírást
4. Ha futás közbeni felfedezésből adsz hozzá buktatót, fűzd a Buktatók szakasz végére
5. Ha a patch hibából való helyreállásból jött, az okát is jegyezd fel a Buktatók szakaszban

Szabályok:
- Kis változtatásért soha ne írd újra az egész skillt
- Őrizd meg a meglévő buktatókat és eljárási lépéseket, hacsak nem kifejezetten törlöd őket
- Ha a patch az indító feltételeket változtatja, a frontmatter leírását is frissítsd

### action=delete

1. Előbb mutasd meg a skill tartalmát
2. Kérj megerősítést: "Törlöd a(z) '{name}' skillt? Ez a teljes könyvtárat eltávolítja."
3. Megerősítés után, csak SAJÁT skillt:
```bash
rm -rf "./.claude/skills/${NAME}"
```
   (Néhány ágensprofil tiltja az `rm`-et: ilyenkor kérd a fő ágenst.) Globális skillt ágens nem töröl: a flottából
   való eltávolítása a tulajdonos döntése, a dashboard Skillek oldalán.
4. Frissítsd az indexedet (lásd "A skill-index újragenerálása")

Szabályok:
- Soha ne törölj úgy, hogy előbb nem mutattad meg a tartalmat
- Soha ne törölj a felhasználó kifejezett megerősítése nélkül
- Ha más skillek hivatkoznak a skillre, törlés előtt figyelmeztess

### action=audit

Átfogó állapotellenőrzés a skill-könyvtáron:

1. **Elavultság keresése**: egyik CLAUDE.md-ben sem hivatkozott skillek, amelyeken 60+ napja nem volt git-aktivitás
```bash
for dir in ~/.claude/skills/*/; do
  name=$(basename "$dir")
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    mod_date=$(stat -f '%Sm' -t '%Y-%m-%d' "$skill_file" 2>/dev/null || stat -c '%y' "$skill_file" 2>/dev/null | cut -d' ' -f1)
    echo "$mod_date  $name"
  fi
done | sort
```

2. **Duplikátumok keresése**: átfedő leírású vagy indító feltételű skillek
```bash
for dir in ~/.claude/skills/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$skill_file")
    echo "$(basename "$dir"): $desc"
  fi
done
```
Nézd át kézzel a jelentésbeli átfedéseket.

3. **Méretellenőrzés**: 500 sornál hosszabb skillek, amelyeket át kellene szervezni
```bash
for dir in ~/.claude/skills/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    lines=$(wc -l < "$skill_file")
    if [ "$lines" -gt 500 ]; then
      echo "OVERSIZED ($lines lines): $(basename "$dir")"
    fi
  fi
done
```

4. **Index-szinkron**: ellenőrizd, hogy a `.skill-index.md` egyezik-e a tényleges könyvtárakkal
```bash
if [ -f ~/.claude/skills/.skill-index.md ]; then
  echo "Index exists, checking sync..."
  # Compare index entries vs actual directories
  indexed=$(grep -oP '(?<=\[)[^\]]+' ~/.claude/skills/.skill-index.md | sort)
  actual=$(ls -d ~/.claude/skills/*/ 2>/dev/null | xargs -I{} basename {} | sort)
  diff <(echo "$indexed") <(echo "$actual")
fi
```

Így mutasd be a megállapításokat:
```
## Skill Audit Results

Total skills: {count} (global) + {count} (local)
Disk usage: {size}

### Issues Found
- [STALE] skill-name: last modified 2025-01-15 (130 days ago)
- [DUPLICATE] skill-a / skill-b: overlapping trigger "when deploying..."
- [OVERSIZED] skill-name: 720 lines (max 500)
- [UNINDEXED] skill-name: exists on disk but not in .skill-index.md

### Recommended Actions
1. DELETE skill-a (superseded by skill-b)
2. PATCH skill-c: move 300 lines to references/
3. REINDEX: regenerate .skill-index.md
```

## A skill-index újragenerálása

Ha saját skillt hozol létre, patchelsz vagy törölsz, generáld újra a SAJÁT indexedet: a telepítés
`scripts/skill-index.sh` szkriptjét a munkakönyvtáraddal mint argumentummal (a pontos út a CLAUDE.md-dben áll). Ez a
`./.claude/skills/.skill-index.md`-t írja, a globális skilleket a tieiddel összefésülve. A globális indexet
(`~/.claude/skills/.skill-index.md`) nem te írod.

## Globális skill módosítása

A `~/.claude/skills/`-t minden ágens betölti, ezért egy új globális skill vagy egy meglévő javítása csak javaslatként megy:

1. Írd meg a teljes SKILL.md-t piszkozatként a munkakönyvtáradban (pl. `./.claude/skill-javaslat/SKILL.md`);
   javításnál a jelenlegi szövegből indulj (`cat ~/.claude/skills/{name}/SKILL.md`), és a TELJES javított szöveget küldd
2. Egy-két mondatban írd le az indoklást egy mellette álló indoklás-fájlba
3. Küldd el a CLAUDE.md-dben megnevezett dashboard-segéddel (`marveen-api.sh`), a `skill-propose` igével:
   `skill-propose {name} <piszkozat SKILL.md> --reason-file <indoklás-fájl>` (ez a `POST /api/skills/propose`-t hívja)

Hogy azonnal élesedik, vagy a tulajdonos jóváhagyására vár, azt a telepítés skill-karantén kapcsolója dönti el; a
válasz `live` mezője megmondja. Egy létező név cserének számít, a régi változatról mentés készül.

## Buktatók

- NE írj a `~/.claude/skills/`, egy másik ágens `.claude/skills/` vagy a telepítés gyökerének `.claude/skills/` mappájába:
  ezeket mind a tiédtől eltérő sessionök töltik be, és a sub-ágens írási kapuja tiltja őket. A saját mappád szabad.
- A fő ágensnek nincs privát skill-mappája: a munkakönyvtára a telepítés gyökere, így a `./.claude/skills` mappáját
  minden sub-ágens is betölti. A fő ágens ezért minden új vagy módosított skillt szintén javaslatként küld.
- NE törölj skillt automatikusan a felhasználó megerősítése nélkül
- NE hozz létre skillt egyszeri feladatra (nézd meg a 2+ előfordulás szabályát)
- Az audit eredménye tanácsadó jellegű, nem hajtódik végre automatikusan
- A `.skill-index.md` csak az L0 illesztésre való; a teljes SKILL.md az L1
- macOS-en a `stat` szintaxisa eltér a Linuxétól; az audit-parancsok mindkettőt kezelik
- Ha egy skill külső API-kra vagy tokenekre hivatkozik, soha ne írd bele a tényleges értékeket

## Kapcsolat a többi mechanizmussal

| Mechanizmus | A skill-management szerepe |
|-----------|------------------------|
| retrospective | A retrospektív javasolja a változtatásokat; a skill-management végrehajtja őket |
| CLAUDE.md | A CLAUDE.md hivatkozik a skillekre; a skill-management karbantartja a könyvtárat |
| .skill-index.md | A skill-management minden módosítás után újragenerálja |
| seed-skills/ | A seed skillek sablonok; telepítés után szokásos skillekké válnak, amelyeket itt kezelsz |
