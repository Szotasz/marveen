# `claude mcp list` és a csatornát birtokló session

**Mérve: 2026-09-21, ClaudeClaw fejlesztői gépen, eldobható próba-ügynökön.**
A rövid figyelmeztetés minden ügynök CLAUDE.md-jében áll; ez a lap a mögötte lévő mérés.

## A bejelentés

Külső beküldő (VPS-es, konténeres telepítés) jelezte, hogy a `claude mcp list` egészség-ellenőrzés
leválasztotta a futó session saját MCP plugin szerverét, és ezzel megölte egy ügynök
Telegram-csatornájának bejövő ágát, miközben a parancs kimenete `Connected`-et írt.

Ez nem a mi kódunk: Claude Code viselkedés. Azért dokumentáljuk, mert a keretrendszer pont olyan
ügynököket seedel, akik csatornát birtokolnak.

## A fixtúra

Eldobható próba-ügynök (`probamcp`), a már létező teszt-boton, nem új provisioning. A hét élő,
csatornát birtokló ügynökhöz nem nyúltunk.

A próba-session ténylegesen csatornát birtokol:

```
/opt/homebrew/bin/claude ... --channels plugin:telegram@claude-plugins-official
gyermekei: 7 MCP-szerver + a telegram plugin (bun run ... telegram/0.0.6 ... start)
```

## A mérés, két külön körben

Az "előtte" állapotot KÜLÖN körben vettük fel, mielőtt bármi futott volna. Enélkül egy
"nem megy a reply tool" eredmény megkülönböztethetetlen attól, hogy soha nem is ment.

| | folyamat-szint | tool-szint |
|---|---|---|
| **előtte** | plugin-processz ÉL (indulás: a session indulásával azonos másodperc) | mind a négy `mcp__plugin_telegram_telegram__*` eszköz jelen |
| **beavatkozás** | `claude mcp list` | exit code **0** |
| **utána** | plugin-processz HALOTT, új nem indult | mind a négy eszköz elérhetetlen |

A parancs kimenete a leállított szerverre, szó szerint:

```
plugin:telegram:telegram: bun run --cwd .../telegram/0.0.6 --shell=bun --silent start - ✔ Connected
```

A session ezt kapta ugyanekkor:

```
The following deferred tools are no longer available (their MCP server disconnected)
The following MCP servers are configured but failed to connect -- plugin:telegram:telegram
```

## Amit a mérés MEGÁLLAPÍT

1. A leállás **szelektív**: a csatorna-plugin szervert viszi el, a többi MCP-szerver változatlanul él.
2. A hatás a parancsot futtató **sessionre korlátozódik**: a mérés alatt a másik nyolc session
   telegram-plugin szervere mind élt.
3. A parancs **nem jelzi**: exit 0, és a kimenet `Connected`-et ír a szerverre, amit épp leállít.
4. A **session újraindítása visszahozza** a plugint. A kár tehát nem végleges csatorna-halál, hanem
   csatorna-halál az újraindításig. (Mérve: újraindítás után a plugin-processz és mind a négy eszköz
   visszajött, majd a parancs megismétlése után ismét eltűnt.)

## Amit a mérés NEM állapít meg

**Egy VALÓDI bejövő üzenet sorsát nem mértük.** Ahhoz ember kell, aki ír a botnak, és a mérés
idején erre nem került sor. A bejövő ág halálát a külső beküldő mérte a saját telepítésén; mi a
tool- és plugin-oldalt reprodukáltuk. A két állítás nem mosható össze.

## KI SZÁMÍT "csatornát birtokló session"-nek (2026-09-22, mérve, Boni cáfolata)

**Nem csak a fő agens.** Ez a dokumentum eddig hallgatólagosan a fő channels-agentről szólt, és ebből
2026-09-22-én egy rossz állítást vezettem le: azt mondtam egy flotta-sub-agentnek (Boni), hogy a
korlát rá nem vonatkozik, mert "az ő sessionje nem birtokol csatornát".

**Ő megmérte, és tévedtem:** a Telegram plugin mind a négy eszköze (`reply`, `react`,
`edit_message`, `download_attachment`) ott van az ő toolsetjében, és nem csak betöltődnek: ugyanazon
a napon tényleges küldés is ment velük (a reggeli pénzügyi összefoglaló, Telegram message id 782).
Ez a lényegi különbség, és a doksi máshol is ezt védi: a séma betöltése szükséges, de nem elégséges,
a LEFUTÁS a bizonyíték. Ráadásul nem kivételes eset: legalább ÖT ütemezett feladatának a szövege
írja elő, hogy a SAJÁT reply tooljával küldjön a gazdának (`napi-szamla-feldolgozas`,
`reggeli-penzugyi-riasztasok`, `billingo-wise-egyeztetes`, `claude-viselkedes-orszem`,
`heti-skill-audit`). Tehát az ő sessionje is birtokol csatornát, és a korlát rá is áll.

**A HELYES PRÓBA, mielőtt bárkinek azt mondod, hogy rá nem vonatkozik:** nem az agens szerepe dönt
(fő agens kontra sub-agent), hanem hogy a plugin eszközei benne vannak-e az ADOTT session
toolsetjében. Ezt ToolSearch-csel vagy a session eszközlistájából lehet megnézni, és a kérdés egy
lekérdezés, nem levezetés. A két mérce nem mond ellent egymásnak: a HATÓKÖR-kérdéshez (vonatkozik-e
rá a korlát) a jelenlét elég, mert ott a plugin csatoltsága a kérdés; annak BIZONYÍTÁSÁHOZ, hogy a
csatorna tényleg él, a lefutás kell.

**ÉS A KOCKÁZAT ASZIMMETRIÁJA DÖNT, NEM A FORMA:** ugyanabban a körben felmerült a session-belső
`/mcp` slash-parancs is, mint a CLI-hívás "másik felülete". Boni nem próbálta ki, és helyesen.
A `claude mcp list`-re MÉRT viselkedés az, hogy `Connected`-et ír, nullával tér vissza, és közben a
plugin meghal (3. pont); a `/mcp`-re ezt NEM mértük, és épp ezért nem is lehetett rá támaszkodni.
A döntés alapja az volt, hogy a `/mcp` ugyanabba a családba esik, a várható haszon pedig NULLA volt
(egy restart két percen belül jött, és ugyanazt oldotta meg), a lefelé mutató kockázat viszont a
saját Telegram-ága. Nulla várható haszon mellett bármekkora kockázat rossz csere.

## A mechanizmus (mérve 2026-10-10, élő sub-agentnél)

A fenti mérés azt mutatta meg, HOGY leáll a plugin, azt nem, hogy MIÉRT. Egy élő esetből
(a `hacker` sub-agent a saját sessionjéből három `claude -p` hívást indított) most megvan az ok, és
az nem a `claude mcp list` sajátja, hanem minden olyan gyerek-`claude` folyamaté, amely betölti a
csatorna-plugint.

1. **A plugin egyetlen pollert enged.** A Telegram plugin `server.ts`-e indulásakor beolvassa a
   `$TELEGRAM_STATE_DIR/bot.pid` fájlt, és az ott álló `server.ts` folyamatot SIGTERM-mel leállítja
   (`telegram channel: replacing stale poller pid=<N>`), mert egy bot tokenjére egyszerre csak egy
   `getUpdates`-fogyasztó lehet. A logika árva (crash után ottmaradt) pollerekre készült, de nem
   ellenőrzi, hogy a régi poller árva-e: azt nézi, hogy `server.ts` folyamat-e. Egy élő session
   pollere ugyanígy megy.
2. **A gyerek örökli az állapot-mappát.** A sub-agent sessionjének környezetében ott a
   `TELEGRAM_STATE_DIR` és a `CLAUDE_CONFIG_DIR`; egy Bash-ből indított `claude` ezeket örökli,
   betölti az engedélyezett csatorna-plugint, és az UGYANAZT a `bot.pid`-et olvassa. A
   `claude mcp list` ugyanígy elindítja a plugin-szervereket az egészség-ellenőrzéshez.
3. **Utána senki nem pollol.** A gyerek kilép, a saját pollere is leáll, a szülő pollere már halott.

A bizonyíték szó szerint (a gyerek MCP-logja macOS-en,
`~/Library/Caches/claude-cli-nodejs/<cwd-slug>/mcp-logs-plugin-telegram-telegram/`):
```
05:32:52.873Z  Server stderr: telegram channel: replacing stale poller pid=45479
05:32:53.548Z  Sending SIGINT to MCP server process
05:32:53.712Z  MCP server process exited cleanly
```
A szülő session plugin-logja 05:32:44-kor (az utolsó bejövő üzenet) elhallgat, és a session
újraindításáig (05:42) nem is ír többet.

**A bejövő ág ebben az esetben:** a leállás alatt (05:38:50Z) küldött üzenet NEM veszett el, a session
újraindítása után megérkezett. Ez egy eset, nem általános garancia: azt mutatja, hogy a kiesés
késleltetett, nem elveszett kézbesítést jelentett.

**Biztonságos gyerek-hívás**, ha egy csatornát birtokló sessionből mégis kell `claude` (például
modell-mérés): a gyerek környezetéből vedd ki a `TELEGRAM_*` (és más csatorna) változókat, és adj neki
saját, plugin nélküli `CLAUDE_CONFIG_DIR`-t, így más `bot.pid`-et lát, és csatorna-plugint sem tölt be.

## Amit ebből NE olvass ki

Nem tiltjuk a `claude mcp list`-et. Hasznos diagnosztika, és csatorna nélküli sessionben nincs mit
elrontania. A korlát a **csatornát birtokló session**, nem a parancs. Ugyanez áll a `claude -p`-re és
minden más gyerek-`claude` hívásra: leválasztott környezettel (lásd fent) ártalmatlan.

## Helyreállítás

Ha mégis megtörtént: indítsd újra a session-t. A plugin a session indulásával jön vissza; a
csatorna-eszközök ezzel együtt válnak újra elérhetővé.
