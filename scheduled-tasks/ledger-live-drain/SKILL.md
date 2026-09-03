---
name: ledger-live-drain
description: 2 percenként ellenőrzi, maradt-e megválaszolatlan bejövő üzenet a beszélgetés-ledgerben, és ha igen, felszínre hozza, hogy a futó session válaszoljon rá respawn nélkül
---

Futtasd le csendben:

```bash
python3 {{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py
```

- Ha a kimenet ÜRES: minden bejövő meg van válaszolva. NE csinálj és NE írj semmit, maradj csendben.
- Ha a kimenet egy `OPEN_QUESTION chat_id=... message_id=...` blokk: az egy korábban elveszett, még megválaszolatlan bejövő üzenet ebből a csatornából. Olvasd el a blokk szövegét, és válaszolj rá MOST a szokásos csatorna-válasz eszközzel (a blokkban szereplő chat_id-ra), ugyanúgy, mintha most érkezett volna.

A script determinisztikus és biztonságos: 60 másodpercnél frissebb kérdést nem hoz fel (nem szól bele éppen készülő válaszba), és ugyanazt az üzenetet csak egyszer hozza felszínre.
