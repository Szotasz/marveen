---
name: memoria-konzisztencia
description: Egyszer, a frissítés után - a memória és a szabályfájlok (CLAUDE.md, SKILL.md) összevetése és javítása
---

Ez a feladat EGYSZER fut: a telepítés most vette fel azt a verziót, amelyik a "Ha egy tény megváltozik"
szabályt hozta, és ehhez egyszer végig kell mérni a meglévő memóriát a szabályfájlokhoz. Az első sikeres
futás után a runner magától kikapcsolja, újra nem jön.

Először nézd meg, van-e már `<install>/store/memoria-konzisztencia-*/STATE.md`, amely nem `kész`. Ha van,
egy korábbi menet félbemaradt vagy még fut: ne kezdj újat, csak írd meg a gazdának, hol áll, és hogy a
folytatást kézzel kell kérni.

A token-keretet a runner quota-kapuja már az indítás előtt megnézte. Ha a keret menet közben fogy el,
állj meg, mentsd az állapotot a munkamappa `STATE.md`-jébe, és jelentsd a gazdának, hol tartasz; elölről
ne kezdd. Minden más szabályod és kapud ugyanúgy érvényes, mint máskor.

Töltsd be és hajtsd végre a `memoria-szabaly-konzisztencia` skillt. Szabályfájlba (CLAUDE.md, SKILL.md)
ez a futás nem ír, és emléket sem von vissza: a változtatások és a visszavonási lista javaslatként mennek
a gazdának. A végén egy rövid jelentés a gazdának a csatornádon, számokkal: visszavonásra javasolva
gazdánként (ehhez egyetlen igent kérsz), a javaslatfájl útja és a tételek száma.

Ha a menet félbemarad (keret, hiba, újraindulás), a részeredmény és a `STATE.md` a munkamappában van: írd
meg a gazdának, hol tart, és hogy a folytatást kézzel kell kérni, mert ez a feladat magától nem indul újra.
