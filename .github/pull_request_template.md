<!--
  HU + EN. Töltsd ki minden szakaszt. / Fill in every section.
  A jelölőnégyzeteket így pipáld: [x]  /  Tick a box like this: [x]
-->

## A változtatás típusa / Type of change

- [ ] Bug fix (hibajavítás / bug fix)
- [ ] Új funkció (feature / new feature)
- [ ] Dokumentáció (docs)
- [ ] Egyéb / Other:

## Rövid leírás / Summary

<!-- HU: Foglald össze, milyen problémát old meg a PR és milyen technikai megközelítést alkalmaztál.
     EN: Summarize what problem this PR solves and the technical approach you took. -->

## Kapcsolódó issue / Related issue

Closes #

## Ellenőrzőlista / Checklist

- [ ] Kipróbáltam a módosítást a lokális környezetben (Telegram/Slack + dashboard), az ágensek hiba nélkül kommunikálnak. / Tested locally (Telegram/Slack + dashboard); the agents communicate without errors.
- [ ] Frissítettem a `docs/` mappát, ha a változtatás érinti a telepítést vagy az architektúrát. / Updated `docs/` if the change affects installation or architecture.
- [ ] A kód nem tartalmaz beleégetett szenzitív adatot (API kulcs, token, személyes adat). / No hardcoded secrets (API keys, tokens, personal data).
- [ ] Saját, beszédes nevű branch-ről nyitom (nem közvetlenül `develop`-ra). / Opened from an own, descriptively named branch (not directly on `develop`).
- [ ] Ha a változtatás egy napló (`store/dashboard.log`) vagy CLI-kimenet sorformátumát módosítja, a Rövid leírásba tettem egy `LOG-FORMAT:` sort a régi és az új alakkal, hogy a kiadási jegyzet vigye. / If the change alters the line format of a log (`store/dashboard.log`) or of CLI output, I added a `LOG-FORMAT:` line to the Summary with the old and the new shape, so the release notes carry it.

## Titok-kapu / Secret gate

A `secret-gate` CI-job a valódi kapu. A lokális pre-commit hook csak gyors
előrejelzés, és `--no-verify`-jal megkerülhető -- ne tekintsd elégnek.
The `secret-gate` CI job is the real gate; the local pre-commit hook is a fast
preview and can be skipped with `--no-verify`, so it is not sufficient on its own.

- [ ] Nincs a változtatásban bizonyíték-/artefaktum-mappa, titok-alakú string vagy idézett csatorna-üzenet.
      / No evidence or artifact directory, secret-shaped string, or quoted channel message in this change.

## Review-nyom / Review trace

Külső szerző PR-jét a szokásos módon hagyjuk jóvá (zöld "Approved"). A flotta SAJÁT PR-jén ez az
állapot technikai okból nem elérhető -- minden ágens ugyanazzal a GitHub-fiókkal ír --, ezért ott a
verdikt egy `COMMENTED` review-komment, aminek az első sora a három állapot egyike:
`FLEET REVIEW -- GO`, `FLEET REVIEW -- FIX-THEN-GO` vagy `FLEET REVIEW -- NO-GO`.
A `FIX-THEN-GO` azt jelenti, hogy érdemben nincs blokkoló: a kommentben MEGNEVEZETT javításoknak be
kell menniük, a szerző pedig a PR-en olvassa vissza őket -- új review-kör nem kell, de a merge megvárja
azt a visszaolvasást.
Részletek: [CONTRIBUTING.md](https://github.com/Szotasz/marveen/blob/develop/CONTRIBUTING.md).

An outside contributor's PR is approved the normal way (green "Approved"). A PR written by the fleet
cannot carry that state, because every agent writes through the same GitHub account, so the verdict
there is a `COMMENTED` review whose first line is one of three states: `FLEET REVIEW -- GO`,
`FLEET REVIEW -- FIX-THEN-GO` or `FLEET REVIEW -- NO-GO`. `FIX-THEN-GO` means nothing is blocking on
the substance: the fixes NAMED in the comment must land and the author reads them back on the PR. No
second review round, but the merge waits for that readback.
