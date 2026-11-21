---
name: memoria-konzisztencia
description: Egyszer, a frissítés után - a memória és a szabályfájlok (CLAUDE.md, SKILL.md) összevetése és javítása
---

Ez a feladat EGYSZER fut: a telepítés most vette fel azt a verziót, amelyik a "Ha egy tény megváltozik"
szabályt hozta, és ehhez egyszer végig kell mérni a meglévő memóriát a szabályfájlokhoz. Az első sikeres
futás után a runner magától kikapcsolja, újra nem jön.

A token-keretet a runner quota-kapuja már az indítás előtt megnézte: ha szűk lett volna, ez a futás el
sem indul, és a feladat a következő éjjel újra próbál. A token-keretnél itt ne állj meg még egyszer:
ha most emiatt kilépsz, a futás késznek számít, és a feladat végleg kikapcsol. Minden más szabályod és
kapud ugyanúgy érvényes, mint máskor.

Töltsd be és hajtsd végre a `memoria-szabaly-konzisztencia` skillt. Szabályfájlba (CLAUDE.md, SKILL.md)
ez a futás nem ír: a változtatások javaslatként mennek a gazdának. A végén egy rövid jelentés a gazdának
a csatornádon, számokkal: visszavonva gazdánként, a javaslatfájl útja és a tételek száma.

Ha a menet félbemarad (keret, hiba, újraindulás), a részeredmény a munkamappában van: írd meg a
gazdának, hol tart, és hogy a folytatást kézzel kell kérni, mert ez a feladat magától nem indul újra.
