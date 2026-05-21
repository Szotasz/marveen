# Skool CLI

> Egy közösségi platform teljes kezelése parancssorból — pedig nincs is hivatalos API-ja.

---

## 🎯 Mit tud / miért érdekes

A Skool egy népszerű közösségi platform, amihez **nincs publikus API**. Marveen mégis teljes parancssori eszközt használ hozzá: posztot ír, kurzust hoz létre a classroomban, képet/videót tölt fel, szavazást indít, tartalmat töröl — mind másodperc alatt, böngésző-kattintgatás nélkül.

Ez a [printing-press](printing-press-cli.md) HAR-útvonalával készült: egy belépett munkamenet forgalmát rögzítve a rendszer kiolvasta a platform belső végpontjait, és kész CLI-t generált belőlük.

**Kuriózum:** az első éles használat épp az volt, hogy a CLI-ről szóló posztot maga a CLI tette ki — másodpercek alatt, miközben kézzel ugyanez 10-30 másodperc kattintgatás lett volna posztonként.

---

## 🛠 Hogyan működik

### Felépítés

Generált Go CLI (`skool-pp-cli`), a `api2.skool.com` végpontjaira. Parancsok: `posts` (create/update/delete/comments), `courses` (CRUD + state + parent), `files` (presigned feltöltés), `polls`, `videos`, `self`, `search`, `sync`.

### Auth

A Skool cookie-alapú: a `auth_token` JWT egy env változón keresztül (`API2_SKOOL_API_KEY`). 401-re opcionális automatikus re-login (`SKOOL_EMAIL` + `SKOOL_PASSWORD`). A token ~1 éves élettartamú.

### Fontos tartalmi szabályok

- A `content` mező **sima szöveg, NEM HTML** — HTML tag-ek nyersen jelennének meg. Bekezdés: `\n\n`.
- A poszt a tulajdonos hangján, **egyes szám első személyben** íródik (nem többesszám).
- A `metadata.labels` (kategória) és `video_ids` **string**, nem array; a `group_id` UUID (nem slug).

### Email-szkenner buktató

Magic-link helyett érdemes 6-jegyű OTP-kódos belépést használni: a céges email-szkennerek a linket "elkattintják" (elhasználják a one-time tokent), a kódot viszont nem. Az OTP-kód hossza egyezzen a beviteli mezővel.

### Mikor CLI, mikor böngésző

CRUD, listázás, feltöltés → CLI (gyors, token-hatékony). Vizuális ellenőrzés vagy komplex egyedi UI-interakció → böngésző.
