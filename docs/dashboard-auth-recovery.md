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
```

A `reset-password` nem kéri a régi jelszót (ez a lényege), ezért minden
futásáról audit-bejegyzés készül és -- ha van bekötött csatorna -- Telegram-
értesítés megy a gazdának. Csatorna nélküli installon az értesítés csendben
kimarad; a visszaút sosem függ tőle.

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

## HTTP break-glass (token birtokában)

A dashboard-token birtokosa a `POST /api/auth/password` végponton
`current_password` nélkül, `username` megadásával állíthat át jelszót. Ez is
auditált (`security.break_glass_password_reset`) és csatorna-értesítést küld.
Csak `token` hitelesítéssel érhető el -- session, eszközkulcs vagy federation
principal 403-at kap.

## Audit

Minden fenti művelet a `config_change_log` táblába ír (`security.*` kulcsokkal,
kizárólag metaadat: felhasználónév és darabszámok, sosem hitelesítő anyag), és
a dashboard Audit nézetében a `config` forrás alatt kereshető.
