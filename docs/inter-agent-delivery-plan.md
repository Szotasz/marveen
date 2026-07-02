# Megbízható inter-agent üzenetkézbesítés — terv

**Készült:** 2026-07-02 (Nagymester), a heti önfejlesztési benchmark nyomán.
**Kiváltó ok:** a migráció utáni ágens-teszt során kétszer beragadt a restic-ads input-mezője, a válaszok késve / rossz sorrendben vagy sehogy érkeztek, és a restic-ads rossz toollal (`SendMessage`) próbált válaszolni, ami némán elveszett.

## 1. A probléma

Az ágensek közti üzenetküldés jelenleg úgy működik, hogy a dashboard **billentyűzet-szimulációval** (`tmux send-keys`) a cél-ágens Claude Code TUI beviteli mezőjébe „gépeli" az üzenetet, majd egy záró `Enter`-t küld (`src/web/agent-process.ts` → `sendPromptToSession`, hívja `src/web/message-router.ts`).

Ez a réteg már **erősen meg van támogatva** (wait-until-idle kapu, 80 karakteres chunkolás, post-send retry loop `retry-enter` és `clear-and-resend` ágakkal a bracketed-paste placeholder ellen). Mégis marad reziduális törékenység, mert egy TUI-ba szimulált billentyűzet elvileg sem determinisztikus:

- A záró `Enter`-t a TUI raw módban időnként lenyeli → az üzenet **parkolva** marad a mezőben.
- PTY-kontenció esetén több chunk egy >700 bájtos olvasásba csúszik → `[Pasted text #N]` placeholder, amit sima Enter nem submitol.
- Ha a parkolt szöveg több vizuális sorra nyúlik, a sima Enter újsort szúr be, nem küld.

## 2. Gyökérokok (rangsorolva)

1. **Kézbesítés-igazolás hiánya.** A `message-router` a `sendPromptToSession` visszatérése után **azonnal** `markMessageDelivered`-et hív — nem azt igazolja, hogy az ágens ténylegesen *elindított egy kört* az üzenettel. Ha az Enter lenyelődött, az üzenet „delivered"-ként könyvelődik, de valójában parkol.
2. **Két „üzenetküldés" fogalom keveredik.** Az ágens a Claude Agent SDK `SendMessage`-ét (in-session al-ágensekre) tévesztette össze a helyes `POST /api/messages` úttal (perzisztens fleet-ágensekre). Nincs EGY validált, egyértelmű tool a válaszra.
3. **Alapból törékeny transzport.** Billentyűzet-szimuláció egy interaktív TUI-ba — a 2026-os multi-agent best practice szerint (out-of-order, swallowed-input hibák) event-driven, közvetlen kézbesítésre kell váltani ACK+retry-jal.

## 3. Terv — 3 lépcső

### 1. lépcső — Submission-igazolt kézbesítés (gyors, ~1-2 nap, kis kockázat)
- A `markMessageDelivered` csak akkor fusson le, ha a küldés utáni pane-capture **igazolja a submitet** (a TUI busy-be váltott / a box kiürült), nem pedig a `send-keys` puszta lefutásakor. A meglévő post-send retry loop már mintavételezi a pane-t — ott van a jel, csak a `delivered` flag-et kell utána tenni.
- Ha a retry-budget kimerül és nincs igazolt submit → ne `delivered`, hanem **maradjon pending + emeljünk figyelmeztetést** (Telegram Bakkinak / log), hogy egy válasz beragadt. Így soha nem tűnik el némán üzenet.
- **Haszon:** megszűnik a „delivered de parkol" hazugság; a te visszatérő „miért néma?" élményed gyökérokát célozza.

### 2. lépcső — Egy megbízható válasz-tool (közepes, ~1 hét)
- Vezessünk be egy **dedikált inter-agent MCP toolt** (`send_to_agent` / `reply_to_agent`), ami a validált `/api/messages` úton megy, sanitizált from/to-val, és **read-receipttel** (a küldő visszakapja: kézbesítve/olvasva). Ezzel megszűnik a `SendMessage` vs `curl` találgatás — EGY út van.
- Az ágensek CLAUDE.md-jében a kézi `curl`-t cseréljük erre a toolra.
- **Haszon:** a restic-ads-féle „rossz tool, néma veszteség" nem fordulhat elő.

### 3. lépcső — SDK-alapú üzenetsor (stratégiai, nagyobb)
- Közép távon az ágens-futtatást a **tmux-TUI helyett a Claude Agent SDK-ra** vinni: programozott input-queue, valódi kézbesítési garancia, strukturált state-átadás (a kutatás szerint: tipizált state-objektumok, nem nyers history), **nulla billentyűzet-szimuláció**.
- Ez a „végleges" megoldás, de nagy refaktor — csak az 1-2. lépcső mérése után érdemes eldönteni, kell-e egyáltalán (lehet, hogy az 1-2. lépcső elég megbízhatóvá teszi a jelenlegit).

## 4. Ajánlás

Kezdjük az **1. lépcsővel** (submission-igazolt kézbesítés + „beragadt üzenet" riasztás) — ez a legkisebb kockázat, a legnagyobb közvetlen haszon, és nem bontja meg a meglévő, jól hangolt retry-logikát. A 2. lépcső utána logikusan ráépül. A 3. lépcsőt csak mérés után.
