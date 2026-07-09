---
name: post-rollback-diagnose
description: On-demand diagnózis egy sikertelen frissítés + auto-rollback után. A dashboard "Frissítés diagnózisa" gombja indítja (opt-in). NEM cron-vezérelt.
---

[Operator-kezdeményezett feladat a dashboardról: sikertelen frissítés diagnózisa]

A legutóbbi frissítés elbukott, és a rendszer automatikusan visszaállt a korábbi, működő verzióra. A box MOST a régi, működő verzión fut, tehát NINCS sürgősség. Nyugodtan, körültekintően dolgozz. A felhasználó a dashboardon explicit kérte ezt a diagnózist (Claude kredit jóváhagyva).

Cél: derítsd ki, MIÉRT bukott a frissítés, és ha biztonságosan javítható, javítsd.

Ha van backend/dev al-ügynököd, delegáld neki a diagnózist és a javítást, majd ellenőrizd; ha nincs, végezd el magad.

Diagnózis források (olvasd ELŐSZÖR):
- `{{INSTALL_DIR}}/store/update.log` -- a bukás konkrét oka (a legutóbbi futás a fájl végén)
- `{{INSTALL_DIR}}/store/update.last-result` -- a rögzített kimenet (status, phase, message)
- `git status`, `git log @{u}..HEAD`, `git log --oneline -10`

KÖTELEZŐ guardrailek (SOHA ne szegd meg):
- SOHA ne `git push --force` / `-f`. Force-push tilos.
- SOHA ne dobj el helyi változást. Ha a working tree piszkos: `git stash` (NEM `git checkout`/`reset --hard` a helyi munkára). A stash-t hagyd meg, ne dropold.
- A frissítés/rollback maga a robusztus `update.sh` dolga. NE írj párhuzamos update- vagy rollback-logikát; a diagnózisod arról szóljon, miért bukott, és a javítás a gyökér-okot célozza (pl. package-lock szinkron, node ABI, build-hiba, divergált history).
- Ha kódot módosítasz a javításhoz: előbb LOKÁLISAN `npm run build`, majd győződj meg róla, hogy a build zöld, MIELŐTT bármit késznek jelentesz. Ne indítsd újra magadtól a szolgáltatást éles környezetben; a következő frissítés/restart úgyis ezt teszi.
- Ha divergált history a gyökér-ok (a helyi checkout előrébb van az upstreamnél): NE reszeteld erőszakkal. Írd le pontosan, mely helyi commitok vannak (`git log @{u}..HEAD`), és kérd az operatőr döntését, mielőtt bármit átrendezel.

Amikor kész vagy (akár javítottad, akár csak diagnózis): jelentsd az eredményt röviden -- a gyökér-ok, mit tettél (vagy mit javasolsz), és hogy a build zöld-e. A box közben végig a működő régi verzión maradt.
