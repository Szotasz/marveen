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

## Titok-kapu / Secret gate

A `secret-gate` CI-job a valodi kapu. A lokalis pre-commit hook csak gyors
elorejelzes, es `--no-verify`-jal megkerulheto -- ne tekintsd elegnek.
The `secret-gate` CI job is the real gate; the local pre-commit hook is a fast
preview and can be skipped with `--no-verify`, so it is not sufficient on its own.

- [ ] Nincs a valtoztatasban bizonyitek-/artefaktum-mappa, titok-alaku string vagy idezett csatorna-uzenet.
      / No evidence or artifact directory, secret-shaped string, or quoted channel message in this change.

## Review-nyom / Review trace

Kulso szerzo PR-jet a szokasos modon hagyjuk jova (zold "Approved"). A flotta SAJAT PR-jen ez az
allapot technikai okbol nem elerheto -- minden agens ugyanazzal a GitHub-fiokkal ir --, ezert ott a
verdikt egy `COMMENTED` review-komment, aminek az elso sora `FLEET REVIEW -- GO` vagy `NO-GO`.
Reszletek: [CONTRIBUTING.md](../CONTRIBUTING.md).

An outside contributor's PR is approved the normal way (green "Approved"). A PR written by the fleet
cannot carry that state, because every agent writes through the same GitHub account, so the verdict
there is a `COMMENTED` review whose first line reads `FLEET REVIEW -- GO` or `NO-GO`.
