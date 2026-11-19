# Dashboard belépés: visszaút és vészhelyzeti reset

Mi történik, ha elfelejtetted a jelszót, kizártad magad, vagy egy kiadott
hitelesítő adat (eszközkulcs, böngésző-session) rossz kézbe került? Ez a doksi
a visszautakat írja le. Alapelv: **aki a gazdagépen parancsot tud futtatni, az
a gyökér-hitelesítő** -- minden visszaút erre épül, és egyik sem függ a webes
kaputól vagy a Telegramtól.

## `npm run dashboard-user` -- a break-glass eszköz

A CLI közvetlenül az SQLite-ot írja (nincs HTTP, nincs auth-kapu), ezért akkor
is működik, ha a webes belépés félre van konfigurálva, throttlingol, vagy el
sem érhető:

```bash
npm run dashboard-user -- list                          # kik léteznek
npm run dashboard-user -- reset-password <felhasznalo>  # új jelszó (elfelejtett jelszó után)
npm run dashboard-user -- remove <felhasznalo>          # user törlése; az utolsó user törlése = vissza token-only módba
npm run dashboard-user -- sessions:clear [<felhasznalo>] # böngésző-sessionök törlése
npm run dashboard-user -- security:reset                # VÉSZHELYZETI RESET (lásd lent)
npm run dashboard-user -- totp:off <felhasznalo>        # kétlépcsős belépés ki (elveszett telefon ÉS biztonsági kódok)
```

A `totp:off` a `reset-password`-höz hasonlóan semmilyen bizonyítékot nem kér a gépen futáson kívül, ezért ugyanúgy
audit-bejegyzést (`security.break_glass_totp_off`) és értesítést hagy. Hogy a kétlépcsős belépés be van-e kapcsolva,
az adatbázis is őrzi (`dashboard_users.totp_enabled`), ezért a `store/.dashboard-totp.json` törlése NEM kapcsolja ki:
ha a fájl hiányzik vagy sérült, a bekapcsolt jelzőjű felhasználó belépése 503-at ad, sosem enged be csak jelszóval
(akinél a jelző nincs bekapcsolva, az sérült fájl mellett is beléphet a jelszavával). Ilyenkor előbb a `totp:off`
(törli a jelzőt, és szól, ha a fájl sérült), utána a sérült fájl javítása vagy törlése a gépen. A weben (jelszóval
és kóddal) kikapcsolt kétlépcsős belépésről is értesítés megy a gazdának.

A `reset-password` nem kéri a régi jelszót (ez a lényege), ezért minden
futásáról audit-bejegyzés készül és -- ha van bekötött csatorna -- Telegram-
értesítés megy a gazdának. Csatorna nélküli installon az értesítés csendben
kimarad; a visszaút sosem függ tőle.

### Docker- és Hostinger-telepítésen

A konténer képében nincs TypeScript-futtató, ezért ott az `npm run dashboard-user` nem fut (`tsx: not found`). Ugyanez
a CLI lefordítva a konténeren belül fut, `node`-dal, ugyanazokkal a parancsokkal:

```bash
docker compose exec marveen node dist/dashboard-user-cli.js totp:off <felhasznalo>
docker compose exec marveen node dist/dashboard-user-cli.js reset-password <felhasznalo>
docker compose exec marveen node dist/dashboard-user-cli.js list
```

Hostingeren nincs saját compose-mappa: SSH-val lépj be, a konténer nevét a `docker ps` adja (`-marveen-1`-re végződik),
és ugyanez a parancs `docker exec -it <a-nev> node dist/dashboard-user-cli.js ...` alakban fut. A részletek a
[docker.md "Locked out" szakaszában](docker.md#locked-out-lost-password-or-phone) vannak.

## `security:reset` -- a pánikgomb

Egy lépésben:

- **minden eszközkulcsot visszavon** (Bridge, telefon -- újra kell párosítani),
- **minden böngésző-munkamenetet töröl** (mindenki újra jelentkezik be),
- a jövőbeli belépés-kényszerítő kapcsolókat (ha lesznek) alaphelyzetbe állítja.

Amihez NEM nyúl: a jelszavak és a userek megmaradnak, és a dashboard-token
továbbra is működik. Ez tehát nem gyári visszaállítás, hanem a "kiadott
hozzáférések közül valamelyik elszabadult, vágjuk el MOST mindet" kar.

A futó szerver legfeljebb 60 másodpercen belül érvényesíti a resetet (a
hitelesítő-cache a következő használatnál észleli a törölt sort); restart nem
szükséges.

## Bridge-párosítás visszavonása

A Biztonság fülön párosított Bridge-eszköz kulcsának visszavonása
(`Visszavonás` gomb, vagy `DELETE /api/auth/device-keys/<id>`) EGYBEN vonja
vissza a két hozzáférés-felet: az eszközkulcsot ÉS az `authorized_keys`-ből az
eszköz SSH-sorát. Az eszközkulcs AZONNAL megszűnik, tehát a
dashboard-hozzáférés rögtön záródik; a törölt SSH-sorral új alagút sem
nyitható. Egy MÁR FELÉPÜLT ssh-alagút viszont a következő bontásig
(app-újraindítás, hálózatváltás, alvás) életben maradhat, mert az sshd a futó
kapcsolatokat nem ellenőrzi újra. Ha azonnali vágás kell, állítsd le a Bridge
appot az eszközön, vagy zárd le a szerveren az eszköz élő SSH-kapcsolatát.
Ha az SSH-sor törlése hibára fut, a felület külön figyelmeztetést mutat --
ilyenkor a sort kézzel töröld: a Marveent futtató user
`~/.ssh/authorized_keys` fájljából vedd ki az eszköz
`marveen-remote:<install-id>` kommentű sorát. Az eszköz ettől nem "kizárt
felhasználó": újra-párosítással (új kulcs-sor beillesztése) bármikor
visszahozható. A `security:reset` a
párosított kulcsokat is visszavonja, de az SSH-sorokat nem bántja -- azok a
kulcs nélkül csak egy zárt alagutat adnak, és a következő párosítás
install-id alapján felülírja őket.

## HTTP-n nincs jelszó-reset a régi jelszó nélkül

A `POST /api/auth/password` végpont csak bejelentkezett sessionnel, a jelenlegi
jelszó megadásával állít át jelszót. A dashboard-tokennel ez 403
(`cli_recovery_only`): a token nem különbözteti meg a gazdát mástól, aki
birtokolja. Ugyanígy, ha már van dashboard-login, a token nem ad ki
eszközkulcsot, nem párosít Bridge-et, és nem vesz fel vagy töröl felhasználót;
ezekhez a gazda sessionje kell. Ugyanez áll a föderációs társ felvételére, a
teljes föderációs konfig írására (`PUT /api/federation/peers`), a társ
szerkesztésére (`PATCH`), a föderáció bekapcsolására, a társ bejövő tokenjének
cseréjére és felfedésére, az operátor-kapcsolók átírására
(`PUT /api/operator-access`) és a felhasználónevek listájára
(`GET /api/auth/users`): mind `owner_session_required` 403. Elfelejtett jelszónál
a helyreállítás útja a fenti CLI: `npm run dashboard-user -- reset-password <felhasználó>`.

Bridge-only telepítésnél a gazdának nincs shellje a szerveren: a Bridge-kulcs
SSH-sora csak a dashboard-portra enged alagutat (`permitopen`), parancsot nem
futtat. Elfelejtett jelszónál ezért az az SSH-belépés marad, amellyel a szervert
telepítették; azon át fut a fenti `reset-password`.

## Audit

Minden fenti művelet a `config_change_log` táblába ír (`security.*` kulcsokkal,
kizárólag metaadat: felhasználónév és darabszámok, sosem hitelesítő anyag), és
a dashboard Audit nézetében a `config` forrás alatt kereshető.
