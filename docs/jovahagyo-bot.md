# Jóváhagyás Telegram-gombbal (külön jóváhagyó bot)

Kanban 80d0e3c6. A jóváhagyás-kérés egy külön boton megy ki, Jóváhagyom / Elutasítom gombbal, és a
gombnyomást a dashboard-szerver fogadja. Ágens nem nyúl hozzá. Alapból KI van kapcsolva; kikapcsolva a
jóváhagyás a dashboardon megy, bejelentkezve.

## Miért külön bot

A fő bot frissítéseit (getUpdates) a csatorna-plugin húzza, és egy botnak egyszerre csak egy ilyen olvasója
lehet. Ha a gombot a fő bot küldené, a nyomás a pluginhoz érkezne, és onnan nincs olyan út a szerverig,
amit egy ugyanazon a gépi felhasználón futó ágens ne tudna hamisítani: egy fájlt meg tud írni, egy
lemezről olvasott kulcsot el tud olvasni. A külön botot csak a szerver olvassa, a nyomás tehát a
Telegramtól, TLS-en, közvetlenül a szerver folyamatába jön, és a nyomó azonosítóját (from.id) a Telegram
írja bele.

## Beüzemelés (a gazda teendője)

1. A BotFather-nél új bot (`/newbot`), például "Marveen jóváhagyás". A tokent ne küldd el senkinek, chatben sem.
2. Az új botnak írj egy `/start` üzenetet a saját Telegramodról. Enélkül a bot nem írhat neked; ilyenkor a
   kérés a megszokott módon, a fő boton megy ki, gomb nélkül.
3. A tokent írd a `store/.approval-bot-token` fájlba (egyetlen sor), és állítsd a jogot 0600-ra:
   `chmod 600 store/.approval-bot-token`.
4. A dashboard Beállítások oldalán kapcsold be a "Jóváhagyás Telegram-gombbal" kapcsolót
   (`APPROVAL_BOT_ENABLED`), és indítsd újra a dashboardot.
5. Próba: egy sub-ágens nyisson egy kérést. Az új bottól jön egy üzenet két gombbal.

Az aláíró kulcs (`store/.approval-bot-key`) az első indításkor magától jön létre, 0600-as joggal.

## Mit ellenőriz a szerver minden gombnyomásnál

1. A nyomó rajta van a fő csatorna `allowFrom` listáján, a saját privát chatjében nyom, és ez az a chat,
   ahová a szerver a kérdést küldte.
2. Az az üzenet, amit a szerver ehhez a kéréshez küldött. Egy ágens a bot tokenjével küldhet üzenetet
   gombokkal, de azok a gombok nem csinálnak semmit.
3. A gomb adatának aláírása (HMAC) egyezik.
4. A kérés még függőben van, és nem járt le.
5. A jóváhagyás két nyomás. Az első a kérés szövegét az ADATBÁZISBÓL újraírja, és megerősítést kér; a
   megerősítés 5 percig érvényes. Így ha valaki a bot tokenjével átírta az üzenet szövegét, a döntés előtt
   a valódi kérés áll ott. Az elutasítás egy nyomás.

Döntés után az üzenet a végeredményt mutatja, az adatbázisbeli szöveggel. Ha a kérést közben a dashboardon
eldöntötték vagy lejárt, a gomb ezt írja ki, és nem változtat semmit.

## Ami megmarad (tudva)

- A bot tokenje a lemezen van. Aki el tudja olvasni, üzenetet küldhet a nevében és átírhatja az üzeneteit,
  de gombot nyomni a gazda nevében nem tud. Az átírást a két lépéses megerősítés kezeli.
- Védekezés a tokennel való visszaélés ellen: az `api.telegram.org` ne kerüljön egyetlen sub-ágens
  egress-listájára sem. A sandboxolt ágensek (Bash sandbox) eleve nem érik el. A token és a kulcs fájlját
  a self-pace kapu védett fájljai közé vettük, így a sub-ágensek Write/Edit eszközzel nem írhatják.
- Csak Telegramon. Discordon, Slacken a jóváhagyás a dashboardon marad.
