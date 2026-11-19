---
name: fleet-helper
description: Közös, függőség nélküli Python-segédek az ágensflottának: dashboard API (memória, üzenetek, kanban), Telegram MarkdownV2 escape és szabályalapú Mail.app-szűrés. Arra használd, hogy a determinisztikus munkát (lekérés, szűrés, SQL, formázás, escape) Pythonban végezd el, ne az LLM-körben égesd rá a modell tokenjeit. A dashboard-tokent hívásidőben olvassa a store/.dashboard-token fájlból, sosem égeti be.
---

# fleet-helper

Vidd ki a determinisztikus munkát (lekérés, szűrés, SQL, formázás, escape) a modellből
Pythonba, hogy a heartbeatek és az ütemezett feladatok ne költsenek tokent arra,
hogy minden ciklusban újra levezetik ugyanazt a csővezetéket. Csak Python 3 stdlib, nincs pip-függőség.

Nincs beégetett titok vagy személyes adat: a dashboard-tokent hívásidőben olvassa a
`store/.dashboard-token` fájlból, a projekt gyökere a `CLAW_DIR` változóból jön
(vagy automatikusan felismeri), a személyes feladó- és kulcsszólisták pedig egy gitignore-olt
`mail_rules.json` fájlban élnek (lásd `scripts/mail_rules.example.json`).

## Mikor használd
- Memória mentése és keresése, napi napló beküldése, inter-agent üzenetek küldése.
- Kanban olvasása (ma esedékes, beragadt, státusz szerint) kézzel írt SQL nélkül.
- Kanban-komment, mozgatás vagy mezőírás, ha a `scripts/kartya-es-ertesites.py`
  elutasítja az ágensedet (a névsora literál; lásd lent a "Kanban-írás" részt).
- Szöveg escape-elése Telegram MarkdownV2 üzenethez.
- Email-heartbeat: az olvasatlan leveleket előszűrd tömör JSON-ná, mielőtt a modell
  gondolkodni kezd rajtuk.
- Tokentakarékos heartbeat-kapu építése (lásd lent "A heartbeat-kapu minta" részt).

## Szkriptek
- `scripts/fleet.py`: dashboard API, kanban-olvasó segédek és MarkdownV2 escaper
  (CLI és importálható modul).
  - **KÉT escaper van, és a rossz választás elnémítja a formázást (2026-08-28-i mérés).**
    Az `mdv2` MINDENT escape-el, a `*`-ot IS: az `*felkover*` jelölőidből `\*felkover\*`
    lesz, tehát sima szöveg. Ez akkor helyes, ha PROGRAMBÓL rakod össze az üzenetet
    (escape-eled a dinamikus részt, aztán te teszed rá a `*`-ot). KÉZZEL ÍRT hosszú
    üzenethez (reggeli napindító) az `mdv2b` kell: az a `*`-ot meghagyja, minden mást
    escape-el, ÉS küldés előtt lefuttatja az `outgoing_gate_check`-et (em dash,
    ` -- `, páratlan csillag). Ha talál valamit, exit 2, és NEM ad kimenetet.
- `scripts/mail_triage.py`: szabályalapú szűrő az olvasatlan Mail.app-levelekre (macOS), JSON-t ad,
  sosem küld, és sosem jelöl olvasottnak.
- `scripts/gate_example.py`: referencia heartbeat-kapu; a shellből indított hívása MAGA
  a kötelező keep-alive tool-hívás (az LLM-kör nem marad ki, csak olcsó lesz).
- `scripts/mail_rules.example.json`: másold `mail_rules.json` néven (gitignore-olt), és
  írd bele a valódi feladókat és kulcsszavakat.
- `scripts/README.md`: a teljes használat és a heartbeat-kapu minta leírása.

## Gyors kezdés
🛑 **`../../`-RELATÍV UTAT HASZNÁLJ, NE PUSZTA RELATÍV UTAT: a shelled
CWD-je a saját ágenskönyvtárad (`<project-root>/agents/<name>/`), NEM a
repó gyökere, ezért egy lenti puszta relatív út ott a semmibe mutat.** Egy
sub-agent CWD-je mindig pontosan két szinttel a projekt gyökere alatt van
(`agentDir()` a `src/web/agent-config.ts` fájlban: `PROJECT_ROOT/agents/<name>`), így
a `../../` BÁRMELY ágensből, BÁRMELY gépen eléri a gyökeret, beégetett
abszolút út nélkül. (A máshol, hookok `command` mezőiben használt
`$CLAUDE_PROJECT_DIR` itt NEM segít: egy szokásos ágens-Bash hívásban
nincs beállítva, mérve üres.) (Egy éjszaka alatt kétszer is megharapott, 2026-08-17: két
flottaágens egy-egy gyökérszintű `find / -iname fleet.py` keresést futtatott, hogy megtalálja ezt a
szkriptet, és ez 10+ perces elszabadult keresés lett a macOS/iCloud mappák alatt.)
```bash
P=../../seed-skills/fleet-helper/scripts
python3 $P/fleet.py mdv2 "Tomorrow (8:00) - report!"   # escaped MarkdownV2 (kills *bold*)
cat brief.txt | python3 $P/fleet.py mdv2b            # keeps *bold*, refuses em dash / " -- "
python3 $P/fleet.py kanban-due
python3 $P/mail_triage.py 90                            # unread <= 90 min -> JSON
```

## Kanban-írás (komment, mozgatás, mezőállítás)
A `scripts/kartya-es-ertesites.py` a kapuzott út a kártya-kommenthez vagy a
státuszmozgatáshoz (ékezet-kapu, gazda-értesítés, az automatikus jelölő), és AHOL FUT, OTT
EZ AZ ÚT. A névsora viszont literál, így egy olyan telepítésen, amelynek ágensei
nincsenek benne, minden `--author` elutasításra kerül. Az alábbi háromnak nincs névsora: azt küldik, amit
a dashboard elfogad, és semmit nem ellenőriznek abból, amit a kapuzott eszköz ellenőriz.
```bash
P=../../seed-skills/fleet-helper/scripts
python3 $P/fleet.py kanban-comment <id> <author> "<text>"       # or "-": the text from stdin
python3 $P/fleet.py kanban-move <id> <status> <actor>           # actor REQUIRED
python3 $P/fleet.py kanban-set <id> <field> <value> <actor>     # "null" clears; actor REQUIRED
```
- **Az actor nem dísz.** A mozgató útvonal arra használja, hogy elnyomja a
  "task assigned to you" visszhangot, amikor a saját kártyádat mozgatod; nélküle a mozgatás
  ugyanúgy `{"ok":true}` választ ad, a visszhang pedig később megérkezik, és egy kört elvisz. A PUT
  útvonal a státuszváltási audit-eseménybe írja. A hiányzó argumentum használati
  hiba (exit 2), és semmi nem megy el.
- A `kanban-set` hívásonként EGY mezőt ír: title, description, status, assignee,
  priority, project, parent_id, due_date, sort_order, archived_at. Bármely más mező
  400-at ad, amely megnevezi az elfogadottakat, és a kártyához nem nyúl. Ez az egyetlen
  szállított út a due_date, project, parent_id és sort_order mezőhöz.
- Az itteni mozgatás vagy mezőállítás NEM hagy kommentet. Ahol az indok számít, előbb
  a kommentet írd meg.
- A törzs az argumentumokból `json.dumps`-szal épül, így a kommentben álló backtick és `$(...)`
  szöveg marad, sosem shell.

## A heartbeat-kapu minta (az igazán értékes ötlet)
A sűrű heartbeatek gyakran csak azért ébresztik fel a modellt, hogy determinisztikus ellenőrzéseket futtasson,
aztán csendben maradjon: elpazarolt tokenek. A kör naiv kihagyása veszélyes lehet, ha a
csatorna-transzportod (pl. egy stdio-csövön futó Telegram MCP) egy rendszeres
helyi tool-hívásra támaszkodik, hogy kapcsolatban maradjon. A biztonságos minta: tartsd meg a kört, de tedd
olccsá. A heartbeat első lépése shellből futtat egy `gate.py`-t (ez az egy
Bash-hívás MAGA a keep-alive), a kapu elvégzi a determinisztikus ellenőrzéseket, és kiír egy
`has_signal` jelzőt; `false` esetén a modell egy sort ír és megáll, `true` esetén
csak a mérlegelést és az értesítést végzi. Nulla ütemező- vagy runner-változás. A teljes
indoklást és két keservesen megtanult ütemezési leckét a `scripts/README.md` tartalmazza
(kerüld a cron-ütközést más heartbeatekkel; a `skipIfBusy` kompromisszuma).

## Biztonság
- A tokent hívásidőben olvassa a `store/.dashboard-token` fájlból; sosem írja ki, sosem kerül commitba.
- A kanban-OLVASÓ segédek (esedékes, beragadt, státusz) csak olvasó SQL-t futtatnak. A három
  ÍRÓ parancs a dashboard API-n megy a tokennel, mint itt minden más
  írás; ahol az ágensed rajta van a névsoron, inkább a `scripts/kartya-es-ertesites.py`-t
  használd.
- A `mail_rules.json` (a valódi feladóid) gitignore-olt.
