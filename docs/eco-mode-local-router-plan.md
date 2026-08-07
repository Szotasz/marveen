# Eco-mode helyi LLM-útválasztó — terv (v1)

Kártya: #132 (panikgomb / eco-mode). Alapja a #133 benchmark (2026-08-07,
nyers adatok: `store/local-model-bench-2026-08-07/`). Ez a terv a #132
(3) tartalék-forgatókönyv és (4) feladat-router pontjait dolgozza ki a két
helyi GPU-s gépre. Végrehajtás: prisma PR-workflow, marveen review.

## 1. Cél és nem-cél

**Cél:** a flotta LLM-munkájának útvonalazható része menjen helyi gépre,
három kiváltó esetén:
- eco-mode / hard-cap aktív (költségplafon átlépve),
- a feladat-osztály helyi modellel képesség-esés nélkül fut (mért, #133),
- folytonossági eset: a felhő-út (vagy a gyártói tmux-út) kiesik.

**Nem-cél:** a többlépéses, tool-hívásos ügynök-munka helyi kiváltása.
Ezt NEM mértük be; amíg nincs rá mérés, a terv explicit felhőn hagyja.
(Mérni a #133 folytatásaként lehet, külön kör.)

## 2. Leltár (mért állapot, 2026-08-07)

| Gép | VRAM | Szerep | Modellek (szerep) |
|---|---|---|---|
| air903max (192.168.2.189 / .163) | 24 GB | elsődleges | laguna-xs.2:fixed (kód, 102 t/s), qwen3-coder (általános, 143 t/s), gemma4:31b-magyar (magyar, 30 t/s) |
| StrikeX (192.168.2.31) | 16 GB | másodlagos, rövid-promptos | qwen3:14b (magyar+ált.), qwen2.5-coder:14b (kód), qwen3-coder (részleges kilógás, 50 t/s) |
| peci01 (192.168.2.122) | – | router + státusz hoszt | nem inferál (EPYC, nincs GPU) |

Mért korlátok, amiket a router betart:
- **laguna** csak `/api/chat`-en megy (generate degenerál); számolós
  strukturált feladatnál `think: true` kell. Stop + 8k ctx a tagbe sütve.
- **gemma4** default gondolkodó módban üres választ ad ollama alatt →
  mindig `think: false` (a `-magyar` tag mintavétele már konzervatív).
- **StrikeX prompt-feldolgozása lassú** (52–570 t/s): >8k tokenes prompt
  oda nem mehet; a hosszú-kontextusú munka air903max-ra megy.
- Mindkét Windows-gép tűzfalaz (ping nem jár), az ollama API az egyetlen
  jel — a health-check erre épül.

## 3. Architektúra

Kis router-szolgáltatás a **peci01**-en (24/7-es gép, mindkét GPU-hostot
eléri, már ott fut a start.otthon státusz-infra):

- **API:** OpenAI-kompatibilis `/v1/chat/completions` + natív ollama
  passthrough. Így az agensek, a scheduled promptok ÉS az OpenWebUI is
  tudja hívni, kliens-módosítás nélkül.
- **Routing-tábla:** feladat-osztály → (gép, modell, kötelező opciók).
  A hívó vagy explicit osztályt ad (`x-task-class` fejléc / mezőnév),
  vagy a router a defaultot használja (általános).
- **Health:** az llm-gen.sh-val azonos próbák (version/tags/ps, 4 mp
  timeout); a lekapcsolt gép kikerül a rotációból, banner a start.otthon
  lapon már van hozzá.
- **Sorbanállás:** gépenként 1 konkurens kérés (VRAM-realitás), gép-en
  belül modell szerinti kötegelés a 13–18 mp-es modellcsere-thrash ellen;
  `keep_alive` a köteg végéig.
- **Failover:** air903max ↔ StrikeX az osztály-táblázat szerint (a hosszú
  kontextus kivétel: az csak air903max, ha nincs, várakozik/felhő).

## 4. Feladat-osztályok → útvonal

| Osztály | Elsődleges | Tartalék | Megjegyzés |
|---|---|---|---|
| strukturált/JSON kinyerés, címkézés, digest | air903max/qwen3-coder | StrikeX/qwen3:14b | képesség-esés nélkül (mért) |
| összefoglalás (HU/EN, ≤8k) | air903max/qwen3-coder | StrikeX/qwen3:14b | |
| magyar user-felé szöveg | air903max/gemma4:31b-magyar | StrikeX/qwen3:14b | gemma think=false |
| kód-értelmezés, kis patch | air903max/laguna-xs.2:fixed | StrikeX/qwen2.5-coder:14b | laguna: chat+think szabály |
| hosszú kontextus (8–16k) | air903max/qwen3-coder | (nincs) → felhő | StrikeX prompt-eval miatt |
| ügynök-hurok, tool-use, kritikus döntés | felhő | – | nem mért, nem-cél |

## 5. Eco-mode / hard-cap bekötés

A meglévő F2-kapcsoló és a kvóta-őrség (quota-guard) mellé egy harmadik
állapot: **local-first**. Cap-átlépéskor a jelenlegi viselkedés a
felfüggesztés; ehelyett ami a fenti táblában helyi-képes osztály, az a
routerre megy, és csak a maradék függ fel. A memoria-heartbeat kivétel
marad (host-kontextus-függő, korábbi prisma-döntés).

## 6. Folytonossági határok (a #132 (3) pontja, őszintén)

- **LLM nélkül is fut:** scheduler, watchdog, kanban-mechanika, státusz
  oldalak, backupok, csatorna-plumbing.
- **Helyi modellel fut:** a 4. szakasz táblájának első négy osztálya.
- **Kiesik:** a Claude-szintű több-lépéses ügynök-munka (delegálás,
  review, komplex döntések). Ez a határ méréssel tolható, de ma itt van.

## 7. Fázisok (prisma PR-ok)

1. **P1 — router MVP:** statikus tábla + health + OpenAI-endpoint, sor
   nélkül (elutasít, ha a gép foglalt). Teszt: a #133 battéria a routeren
   át, osztályonként a várt gépre jut.
2. **P2 — eco-bekötés:** quota-guard hook a local-first állapotra;
   schedule-promptok osztály-címkéje (task-config mező).
3. **P3 — mérés:** route-számláló + latencia + "mit vitt el a helyi gép"
   a költség-attribúcióba (a #4eab2df1 címkézés-szállal összeér).
4. **P4 — router R&D:** pontozás/beárazás (a #132 (4) eredeti scope-ja),
   csak a P1–P3 tapasztalataival.

## 8. Ismert buktatók (mérésből)

- Modell-thrash: 20 GB-os modellek cseréje 13–18 mp — kötegelés nélkül a
  router rosszabb, mint a közvetlen hívás.
- A két Windows-gép elaludhat/frissülhet: a health-gate kötelező, és a
  „nem elérhető" állapot hangos legyen (start.otthon banner + heartbeat).
- Ollama-oldalon nincs auth: a router LAN-only marad (a Caddy remote_ip
  mintája), kifelé semmi nem publikálódik.
- A gemma/laguna tag-szabályok (think, stop) a routerben KÓDBAN legyenek,
  ne prompt-konvencióban — a hívó ne tudhassa elrontani.
