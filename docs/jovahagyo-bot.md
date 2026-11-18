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
3. A tokent írd a `store/.approval-bot-token` fájlba (egyetlen sor), és állítsd a jogot 0600-ra:
   `chmod 600 store/.approval-bot-token`.
4. A dashboard Beállítások oldalán kapcsold be a "Jóváhagyás Telegram-gombbal" kapcsolót
   (`APPROVAL_BOT_ENABLED`), és indítsd újra a dashboardot.
5. Párosítás (bejelentkezve, a dashboardon): `POST /api/approvals/bot/pairing-code` egy egyszer használható
   kódot ad, 10 percig érvényes. Küldd el az új botnak a saját Telegramodról, privát chatben:
   `/start <kód>`. Utána a dashboard (Jóváhagyások, bejelentkezve) megmutatja, MELYIK fiók küldte a kódot
   (név és Telegram-azonosító): ha az AZONOSÍTÓ a tiéd, erősítsd meg. A nevet ne nézd, azt bárki bármire
   beállíthatja. Csak ekkor tárolja a szerver a SAJÁT
   adatbázisában a fiókot és a chatet, és ezután csak ezt fogadja el. Ha nem a te fiókod áll ott, ne
   erősítsd meg: valaki más küldte el előbb a kódot (például a bot tokenjével). Új kóddal újrapárosítható.
   Párosítás nélkül a kérés a megszokott módon, a fő boton megy ki, gomb nélkül.
   Az API: `POST /api/approvals/bot/pairing-code`, `GET /api/approvals/bot/pairing`,
   `POST /api/approvals/bot/pairing/confirm`.
6. Próba: egy sub-ágens nyisson egy kérést. Az új bottól jön egy üzenet két gombbal.

Az aláíró kulcs (`store/.approval-bot-key`) az első indításkor magától jön létre, 0600-as joggal.

## Mit ellenőriz a szerver minden gombnyomásnál

1. A nyomó a párosított fiók, a párosított privát chatben nyom, és ez az a chat, ahová a szerver a kérdést
   küldte. A fő csatorna `access.json`-ja és az `ALLOWED_CHAT_ID` ebben nem számít: azokat az ágensek
   gépi felhasználója is írhatja.
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
  de gombot nyomni a gazda nevében nem tud. MEGMARADÓ KOCKÁZAT: a token birtokosa az üzenetet a szerver
  újraírása UTÁN is átírhatja, tehát a "Megerősítem" melletti szöveg csak annyira megbízható, mint a token.
  A két lépés ezt az ablakot szűkíti, de nem zárja be. Ha a token kiszivárgott: új tokent kérj a
  BotFathertől, és párosíts újra.
- Védekezés a tokennel való visszaélés ellen: az `api.telegram.org` ne kerüljön egyetlen sub-ágens
  egress-listájára sem. A sandboxolt ágensek (Bash sandbox) eleve nem érik el. A token és a kulcs fájlját
  a self-pace kapu védett fájljai közé vettük, így a sub-ágensek Write/Edit eszközzel nem írhatják.
- A párosító kódot bárki "elégetheti", aki ismeri a bot nevét: öt rossz `/start` után a kód érvénytelen.
  Hozzáférést ez nem ad, csak új kódot kell kérni.
- Csak Telegramon. Discordon, Slacken a jóváhagyás a dashboardon marad.
