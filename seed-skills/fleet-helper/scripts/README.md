# fleet-helper

Közös, függőség nélküli Python-segédek egy ClaudeClaw-típusú ágensflottához. A
cél: a determinisztikus munkát (lekérés, szűrés, SQL, formázás, escape) Pythonban végezd el,
ne az LLM-körön belül égesd rá a modell tokenjeit. Csak Python 3
stdlib.

Nincs beégetett titok vagy személyes adat: a dashboard-tokent hívásidőben olvassa a
`store/.dashboard-token` fájlból, az utak a `CLAW_DIR` változóból jönnek (vagy automatikusan
felismeri őket), a személyes feladó- és kulcsszólisták pedig egy gitignore-olt
`mail_rules.json` fájlban élnek (lásd `mail_rules.example.json`).

## fleet.py: dashboard API, kanban és MarkdownV2
CLI (kevesebb token, mint egy curl-blokk), vagy importáld modulként:

```bash
python3 fleet.py mdv2 "Tomorrow (8:00) - report!"   # escaped MarkdownV2
python3 fleet.py mem-save  <agent> "text" warm "k1, k2"
python3 fleet.py mem-search <agent> "query" warm
python3 fleet.py msg <from> <to> "message"
python3 fleet.py agents
python3 fleet.py kanban-due | kanban-stuck <sec> | kanban-status <status>
python3 fleet.py kanban-comment <id> <author> <text|->   # writes; see SKILL.md "Kanban writes"
python3 fleet.py kanban-move <id> <status> <actor>
python3 fleet.py kanban-set <id> <field> <value> <actor>
```

MarkdownV2: az `escape_mdv2()` a literál szöveget escape-eli. Előbb a dinamikus szöveget escape-eld,
aztán tedd a saját `*...*` félkövér jelölőidet az escape-elt darabok köré.

## mail_triage.py: szabályalapú szűrő az olvasatlan levelekre (macOS Mail.app)
Hitelesítés nélküli (osascript), JSON-t ad, sosem küld, és sosem jelöl olvasottnak. Kosarak:
`important` / `review` / `dropped`. A valódi feladók és kulcsszavak a `mail_rules.json` fájlba kerülnek.

## A heartbeat-kapu minta (az érdekes rész)

A sűrű ágens-"heartbeatek" (N percenkénti rendszeres ellenőrzések) gyakran csak azért ébresztik fel az LLM-et,
hogy determinisztikus ellenőrzéseket futtasson (levél olvasása, DB-lekérdezés, naptár átnézése), és
aztán eldöntse, hogy nincs mit jelenteni. Ez nagyrészt elpazarolt token.

A naiv javítás ("hagyd ki az LLM-kört, ha semmi nem változott") veszélyes lehet: ha a
csatorna-transzportod (pl. egy stdio-csövön futó Telegram MCP szerver) arra támaszkodik, hogy az
ágens rendszeresen helyi tool-hívást végez, és így marad kapcsolatban, akkor a kör teljes
kihagyása miatt a cső tétlenné válik és lekapcsol (a bejövő üzenetek elvesznek).

A minta, amely EZ a kockázat NÉLKÜL hozza a megtakarítást:

1. Tartsd meg a heartbeat-kört, de tedd olccsá. A heartbeat kötelező első
   lépése egyetlen `gate.py` futtatása shellből. **Ez az egy Bash-hívás MAGA a
   keep-alive helyi tool-hívás**, így a transzport melegen marad.
2. A `gate.py` minden determinisztikus ellenőrzést (levélszűrés, kanban-SQL,
   naptár-átnézés) a modellen kívül végez el, és kiír egy tömör JSON-t egy `has_signal` jelzővel.
3. Ha `has_signal == false`: a modell egy rövid sort ír és megáll. Nincs
   külső üzenet, és ami a lényeg, nincs modellen belüli AppleScript, SQL vagy szűrés.
4. Ha `has_signal == true`: a modell csak a mérlegelést végzi (megéri-e
   felszínre hozni? hogyan fogalmazza meg), és elküldi az értesítést.

A tokenmegtakarítás nem a kör kihagyásából jön (a keep-alive hívás eddig is
kötelező volt), hanem abból, hogy a "minden ciklusban az LLM gondolja végig az
AppleScript+SQL+szűrés láncot" helyébe az lép, hogy "az LLM lefuttat egy kaput és elolvas egy apró
JSON-t". Az ütemező és a runner magjához egyáltalán nem kell nyúlni: ez csupán a
heartbeat-prompt átírása és a kapu-szkript.

Ütemezési buktatók (élő teszten, keserves úton tanulva):

1. **Kerüld a cron-ütközést más heartbeatekkel.** Ha két heartbeat ugyanabba a
   percbe esik ugyanabban a sessionben, az egyik következetesen veszít (elnyeli a
   másik köre), és a ciklusa csendben soha nem fut le. Egy `*/30` feladat (:00,:30)
   mindig ütközik egy `*/15` feladattal (:00,:15,:30,:45). NE ütemezz kapuzott
   heartbeatet :00/:15/:30/:45 percre (vagy bármely percre, amit más heartbeat használ): válassz
   eltolt perceket, pl. `7,23,37,53 * * * *`. Valójában ez volt az oka annak, hogy
   az első három élő ciklusunk soha nem indult el, nem a `skipIfBusy`.
2. **`skipIfBusy`:** a kapuzott heartbeatnek is le kell futnia a körének, hogy a
   keep-alive elsüljön. `skipIfBusy:true` mellett egy foglalt session teljesen elejtheti
   a ciklust. Ahol a keep-alive számít, inkább `skipIfBusy:false` (sorba állítja a
   promptot); a ciklusonkénti munka eleve olcsó, így a sorba állítás ártalmatlan.

A `gate_example.py` egy referencia-kapu (levél, kanban, naptár), amelyet átalakíthatsz.

## Felépítés
```
fleet.py                 # shared lib + CLI
mail_triage.py           # unread-mail filter
gate_example.py          # reference heartbeat gate (keep-alive == the gate call)
mail_rules.example.json  # copy to mail_rules.json (gitignored) with real values
```

## Biztonsági megjegyzések
- A tokent hívásidőben olvassa a `store/.dashboard-token` fájlból. Sosem írd ki, és sosem commitold.
- A kanban-olvasó segédek csak olvasó SQL-t futtatnak; a három író parancs (kanban-comment / kanban-move / kanban-set) a dashboard API-n megy, lásd a SKILL.md "Kanban-írás" részét (a move és a set esetén az actor kötelező).
- A `mail_rules.json` (a valódi feladóid) legyen gitignore-olt (lásd `.gitignore`).

## Licenc
MIT, összhangban a szülőprojekttel (ClaudeClaw / marveen).
