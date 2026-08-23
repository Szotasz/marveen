Minőségi Követelmények (Quality Guidelines)

Dokumentáció kötelező frissítése: Új funkciók hozzáadása, a meglévő logika megváltoztatása, vagy a konfigurációs fájlok módosítása kizárólag a vonatkozó dokumentáció egyidejű bővítésével/módosításával együtt küldhető be. Ha a kód változik, a leírásnak is követnie kell azt!

Tiszta kód és Formázás:
A projekt nagyrészt TypeScript és JavaScript alapú. Kérjük, használd a projektben konfigurált lintereket (pl. ESLint) és kódformázókat (pl. Prettier) a PR beküldése előtt.
TypeScript írásakor kerüld az any típus használatát; törekedj a szigorú és pontos típusdefiníciókra.
Python, Shell és PowerShell szkriptek esetén is kövesd az adott nyelv bevett formázási szabályait (pl. PEP 8 Python esetén).
Tesztelés: Minden új funkcióhoz, illetve hibajavításhoz mellékelni kell a megfelelő teszteket. Mielőtt beküldöd a PR-t, győződj meg róla, hogy az összes meglévő teszt sikeresen lefut, és a módosításod nem törte el a korábbi funkcionalitást.
Code Review (Kódátvizsgálás): Egyetlen kód sem kerülhet a fő ágba (main/master) anélkül, hogy legalább egy projekt karbantartó (maintainer) át ne nézte és jóvá nem hagyta volna. Törekedj a kisebb, könnyen áttekinthető PR-ok készítésére.

CSS és Alkalmazás-modularizáció (Design-rendszer):
Új CSS stílus SOHA nem kerülhet a megszűnt web/style.css fájlba. Minden új stílust a @layer réteg-sorrend szerint a megfelelő components/*.css vagy features/*.css fájlba kell írni.
A JS lazy-load boot-injektált callback-függőségei csak akkor tehetők lazy-vá, ha azok betöltése NEM blokkolja az alkalmazás alapvető inicializálását. Kritikus indulási függőségeket (pl. auth, routing, alap-UI) ne tegyél lazy-vá.

OpenAPI és SDK:
A docs/openapi.yaml a teljes API-felület egyetlen igazságforrása (single source of truth). Minden új vagy módosított végpontnál kötelező frissíteni.
A src/generated/api.ts GENERÁLT fájl - kézzel soha ne szerkeszd; futtatsd az npm run generate:sdk parancsot a specifikáció változtatása után.
Az OpenAPI specifikációban (docs/openapi.yaml) és a tesztekben SOHA ne szerepeljen valódi secret, token, jelszó vagy belső azonosító; csak névleges (placeholder) értékeket használj.

CI-kapuk:
A breaking-change detekció (oasdiff), a CHANGELOG-gate és az SDK-sync-gate megkerülése tilos. Ezek a kapuk az API kompatibilitást és a dokumentáció szinkronban tartását védik.
Ha bármelyik CI-kaput ki szeretnéd kapcsolni vagy megkerülni, az automatikusan PR-blokkolót von maga után. Ilyen igény esetén vedd fel a kapcsolatot a karbantartókkal.

Konfiguráció és Secret-kezelés (12-factor):
A 12-factor config-séma szerint a secretek kizárólag környezeti változóból vagy mount-ból érkezhetnek. Precedencia-sorrend: overrides > /run/secrets > .env > default.
Config-fájlba, OpenAPI példákba és tesztekbe SOHA ne kerüljön valódi titok (jelszó, token, API-kulcs, kapcsolati karakterlánc).

API-verziózás és Deprecation:
Minden API-változtatásnak visszafelé kompatibilisnek kell lennie. Meglévő végpontok eltávolítása csak az api-deprecation-policy.md szerinti deprecation-folyamattal lehetséges: minimum 6 hónapos ablak a kanonikus verzió kiadásától, RFC 8594 Sunset-fejléc, és a tulajdonos explicit jóváhagyása szükséges.
A régi verzió eltávolítása külön PR-ban történjen; az openapi.yaml-ból is ki kell venni, és npm run generate:sdk szükséges utána.

Biztonsági Követelmények (Security Guidelines)
Érzékeny adatok (Secrets & Tokens): Soha, semmilyen körülmények között ne commitolj jelszavakat, API kulcsokat, tokeneket vagy privát hitelesítő adatokat a kódbázisba!
Különösen figyelj erre a Shell és PowerShell automatizációs szkriptek írásakor.
Ezeket az adatokat környezeti változókból (.env) vagy a CI/CD pipeline secrets-kezelőjéből kell beolvasni.
Függőségek (Dependencies) kezelése: Csak hivatalos és megbízható forrásból származó csomagokat adj a projekthez (pl. npm, PyPI). Beküldés előtt ellenőrizd a sebezhetőségeket az npm audit (vagy a használt csomagkezelő megfelelő) parancsával.
Biztonságos Szkriptelés: A projektben található Shell és PowerShell fájlok módosításakor fokozottan ügyelj a "Command Injection" (parancsinjekció) elkerülésére. Mindig validáld és megfelelően escape-eld a felhasználói vagy külső forrásból származó bemeneteket.
Biztonsági rések bejelentése: Ha biztonsági rést fedezel fel a projektben, kérjük, ne nyiss publikus Issue-t! Ehelyett vedd fel a kapcsolatot a karbantartókkal privát csatornán (pl. e-mailben a megadott címen), hogy a hibát még a nyilvánosságra hozatal előtt javíthassuk.




Quality Guidelines

Required Documentation Updates: Adding new features, changing existing logic, or modifying configuration files can only be submitted with a simultaneous extension/modification of the relevant documentation. If the code changes, the description must follow suit!

Clean Code and Formatting:
The project is largely based on TypeScript and JavaScript. Please use the linters (e.g. ESLint) and code formatters (e.g. Prettier) configured in the project before submitting a PR.
When writing TypeScript, avoid using the type any; strive for strict and precise type definitions.
For Python, Shell, and PowerShell scripts, follow the established formatting rules of the given language (e.g. PEP 8 for Python).
Testing: All new features or bug fixes must be accompanied by appropriate tests. Before submitting a PR, make sure that all existing tests pass and that your change does not break any previous functionality.
Code Review: No code should be pushed to the main/master branch without being reviewed and approved by at least one project maintainer. Aim to keep PRs small and easy to read.

CSS and Application Modularization (Design System):
New CSS must never be added to the retired web/style.css file. All new styles must be placed in the appropriate components/*.css or features/*.css file following the @layer cascade order.
JS lazy-load boot-injected callback dependencies may only be made lazy if their loading does NOT block the application's core initialization. Critical startup dependencies (e.g. auth, routing, base UI) must not be lazy-loaded.

OpenAPI and SDK:
docs/openapi.yaml is the single source of truth for the entire API surface. It must be updated for every new or modified endpoint.
src/generated/api.ts is a GENERATED file - never edit it manually; run npm run generate:sdk after changing the specification.
The OpenAPI specification (docs/openapi.yaml) and tests must NEVER contain real secrets, tokens, passwords, or internal identifiers; use placeholder values only.

CI Gates:
Bypassing or disabling the breaking-change detection (oasdiff), the CHANGELOG-gate, or the SDK-sync-gate is not permitted. These gates protect API compatibility and keep documentation in sync.
Any attempt to disable or bypass a CI gate automatically results in a PR blocker. Contact the maintainers if such a need arises.

Configuration and Secret Management (12-factor):
Following the 12-factor config schema, secrets must only come from environment variables or mounts. Precedence order: overrides > /run/secrets > .env > default.
Real secrets (passwords, tokens, API keys, connection strings) must NEVER appear in config files, OpenAPI examples, or tests.

API Versioning and Deprecation:
All API changes must be backward compatible. Removing existing endpoints is only allowed through the deprecation process defined in api-deprecation-policy.md: a minimum 6-month window from the canonical version release, an RFC 8594 Sunset header, and explicit owner approval are required.
Endpoint removal must be done in a separate PR; it must also be removed from openapi.yaml, and npm run generate:sdk must be run afterwards.

Security Guidelines
Secrets & Tokens: Never, under any circumstances, commit passwords, API keys, tokens, or private credentials to the codebase!
Be especially careful when writing Shell and PowerShell automation scripts.
This data should be read from environment variables (.env) or from the secrets manager of the CI/CD pipeline.
Manage Dependencies: Only add packages from official and trusted sources to your project (e.g. npm, PyPI). Before submitting, check for vulnerabilities with npm audit (or the appropriate command of your package manager).
Secure Scripting: When modifying Shell and PowerShell files in your project, take extra care to avoid "Command Injection". Always validate and properly escape user or external input.
Report Vulnerabilities: If you discover a vulnerability in your project, please do not open a public Issue! Instead, contact the maintainers privately (e.g. by email at the address provided) so that we can fix the bug before it is made public.
