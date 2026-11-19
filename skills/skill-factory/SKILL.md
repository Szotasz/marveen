---
name: skill-factory
description: Bármely munkafolyamatból, beszélgetésből vagy bemutatott folyamatból újrahasznosítható SKILL.md-t készít. Akkor használd, ha a felhasználó azt mondja: "turn this into a skill" (alakítsd skillé), "make a skill from this" (csinálj ebből skillt), "save this workflow" (mentsd el ezt a munkafolyamatot), "remember how to do this" (jegyezd meg, hogyan kell ezt csinálni), vagy egy összetett, többlépéses feladat befejezése után, amelynek megismételhetőnek kell lennie. Ezekre is indul: "tanítsd meg magad", "jegyezd meg ezt a folyamatot", "csinálj ebből skill-t".
---

# Skill Factory

Alakítsd a bemutatott munkafolyamatokat újrahasznosítható skillekké. Ez egy meta-skill: más skilleket hoz létre.

## Mikor használd

- A felhasználó kifejezetten azt kéri, hogy egy munkafolyamatból készíts skillt
- A felhasználó azt mondja: "remember how to do this" vagy "save this process"
- Egy összetett feladat (5+ tool-hívás) után, amely újrahasznosítható lehet
- Ha a felhasználó kijavítja a megközelítésedet, és a javítás általánosítható
- Magyar indító kifejezések: "tanítsd meg magad", "csinálj skill-t", "jegyezd meg"

## Eljárás

### 1. lépés: Bontsd ki a munkafolyamatot

Elemezd a jelenlegi beszélgetést (vagy a megadott munkafolyamatot), és azonosítsd:

1. **Indító feltételek**: Mikor kapcsoljon be ez a skill?
2. **Bemenet**: Mire van szüksége a skillnek az induláshoz?
3. **Lépések**: Melyek a konkrét lépések (sorrendben)?
4. **Használt eszközök**: Mely toolok és parancsok vettek részt benne?
5. **Döntési pontok**: Hol kellett választanod?
6. **Hibakezelés**: Mi romlott el, és hogyan javítottad?
7. **Kimenet**: Mi a várt eredmény?

### 2. lépés: Általánosíts

Ne csak az adott esetet másold le. Absztraháld:

- A konkrét fájlneveket cseréld `[input-file]` mintákra
- A konkrét URL-eket cseréld `[target-url]` mintákra
- Azonosítsd, mely részek állandók és melyek változók
- Jegyezd fel az előfeltételeket és a függőségeket
- Gondold végig azokat a szélső eseteket, amelyeket az eredeti munkafolyamat nem fedett le

### 3. lépés: Írd meg a SKILL.md-t

**Előbb a hely.** Az alábbi blokk a SAJÁT mappádba ír, egy csak általad használt skill számára. NE futtasd olyan skillhez,
amely minden ágensnek szól, egy globális skill javításához, vagy ha te vagy a fő ágens (a munkakönyvtára a
projekt gyökere, amelynek `.claude/skills` mappáját minden sub-agent betölti): ezeket minden skill-mappán kívül írd meg piszkozatban, és
javaslatként küldd be, ahogy a blokk utáni megjegyzés mondja.

```bash
SKILL_NAME="[kebab-case-name]"
mkdir -p .claude/skills/$SKILL_NAME

cat > .claude/skills/$SKILL_NAME/SKILL.md << 'EOF'
---
name: [skill-name]
description: [What it does + when to trigger. Be specific and "pushy" -- include multiple trigger phrases so the skill activates when needed.]
---

# [Skill Name]

## When to Use
[List concrete trigger conditions and contexts]

## Prerequisites
[Dependencies, tools, access needed -- skip if none]

## Procedure
1. [First step -- be specific, include commands]
2. [Second step]
...

## Pitfalls
- **[Problem]**: [How to solve it]

## Verification
- [How to confirm the result is correct]

## Examples
**Example 1:**
Input: [what the user said]
Output: [what was produced]
EOF
```

Ez a SAJÁT mappádba írja a skillt (a munkakönyvtárad `.claude/skills` mappájába), amelyet csak te töltesz be. A minden
ágensnek szóló skillt, vagy egy meglévő globális skill (`~/.claude/skills`) javítását soha nem írod oda közvetlenül: küldd a
teljes SKILL.md-t a `POST /api/skills/propose` végpontra (törzs: `{"name": ..., "skill_md": ..., "reason": ...}`, a
dashboard-tokennel). Karanténban vár, amíg a gazda jóvá nem hagyja; egy már létező név cserévé válik, és a jóváhagyás elmenti
a régi változatot; csere esetén az élő skill többi fájlja megmarad. A javaslat csak a SKILL.md-t viszi: egy ÚJ
globális skill, amelynek szkriptek vagy referenciák kellenek, a gazda döntése (kérdezd meg; ő be tud importálni egy archívumot a
dashboard Skills oldalán, ami szintén karanténba kerül). A fő ágensnek nincs privát mappája, ezért mindig javaslatot küld.

### 4. lépés: Adj hozzá kiegészítő fájlokat (ha kell)

Ha a munkafolyamat szkripteket vagy sablonokat is tartalmaz:

```bash
mkdir -p .claude/skills/$SKILL_NAME/scripts
mkdir -p .claude/skills/$SKILL_NAME/references
```

- `scripts/`: futtatható kód determinisztikus vagy ismétlődő feladatokhoz
- `references/`: dokumentáció, amely szükség szerint töltődik be a kontextusba
- `assets/`: sablonok, ikonok vagy más statikus fájlok

### 5. lépés: Futtasd a lintert (kötelező)

Ellenőrizd az új vagy módosított skillt az Anthropic "Skill authoring best practices" útmutatója alapján (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):

```bash
L=../../scripts/skill-lint.mjs; [ -f "$L" ] || L=scripts/skill-lint.mjs   # sub-agent cwd: agents/<name>/; main agent: the install root
node "$L" .claude/skills/$SKILL_NAME
```

Ha megállapítást jelez (nem nulla kilépési kód), javítsd, és futtasd újra, amíg tiszta nem lesz. Az általa ellenőrzött szabályok:
- "Keep SKILL.md body under 500 lines for optimal performance" (a frontmatter utáni törzs).
- "For reference files longer than 100 lines, include a table of contents at the top" (egy 100 sornál hosszabb `references/` fájl).
- "Keep references one level deep from SKILL.md": minden kiegészítő fájlra maga a SKILL.md hivatkozik, nem csak egy másik kiegészítő fájl.
- A SKILL.md minden relatív markdown-hivatkozása létező fájlra mutat.

A linter csak jelez, sosem ír át semmit. Külső forrásból telepített skillt ne írj át miatta.

### 6. lépés: Frissítsd a skill-indexet

```bash
bash scripts/skill-index.sh
```

### 7. lépés: Ellenőrizd

Teszteld fejben a skillt:
- Elindulna a leírás egy valószerű felhasználói üzenetre?
- Elég világosak a lépések ahhoz, hogy az eredeti kontextus nélkül is követni lehessen őket?
- Le vannak fedve a szélső esetek a Pitfalls szakaszban?
- 500 sor alatt van a SKILL.md törzse, és átmegy a linteren (5. lépés)?

## Buktatók

- **Túlillesztés egyetlen példára**: Ne csak a pontosan végrehajtott lépéseidet mentsd el. Általánosíts, hogy hasonló, de eltérő bemenetekre is működjön.
- **Túl homályos leírás**: A leírás mező az elsődleges indító. Légy konkrét, és adj meg több megfogalmazást.
- **Hiányzó hibakezelés**: Ha az eredeti munkafolyamat közben hibákba futottál, dokumentáld őket a Pitfalls szakaszban.
- **Túl hosszú**: A SKILL.md maradjon 500 sor alatt. A nagy tartalmat tedd a `references/` alkönyvtárba.
- **Duplikált skillek**: Létrehozás előtt nézd meg a `~/.claude/skills/.skill-index.md` fájlban, van-e már hasonló skill. Új létrehozása helyett patcheld azt.

## Skill-minőségi ellenőrzőlista

Véglegesítés előtt ellenőrizd:
- [ ] A leírás több indító kifejezést tartalmaz
- [ ] A lépések számozottak és konkrétak
- [ ] A parancsok bemásolhatók (nincs pszeudokód)
- [ ] A változók egyértelműen `[brackets]` jelöléssel szerepelnek
- [ ] A Pitfalls szakaszban legalább egy bejegyzés van
- [ ] A Verification szakasz elmondja, hogyan igazold a sikert
- [ ] 500 sor alatt van, és a `skill-lint` semmit nem jelez
