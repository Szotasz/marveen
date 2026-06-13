Minőségi Követelmények (Quality Guidelines)

Dokumentáció kötelező frissítése: Új funkciók hozzáadása, a meglévő logika megváltoztatása, vagy a konfigurációs fájlok módosítása kizárólag a vonatkozó dokumentáció egyidejű bővítésével/módosításával együtt küldhető be. Ha a kód változik, a leírásnak is követnie kell azt!

Tiszta kód és Formázás:
A projekt nagyrészt TypeScript és JavaScript alapú. Kérjük, használd a projektben konfigurált lintereket (pl. ESLint) és kódformázókat (pl. Prettier) a PR beküldése előtt.
TypeScript írásakor kerüld az any típus használatát; törekedj a szigorú és pontos típusdefiníciókra.
Python, Shell és PowerShell szkriptek esetén is kövesd az adott nyelv bevett formázási szabályait (pl. PEP 8 Python esetén).
Tesztelés: Minden új funkcióhoz, illetve hibajavításhoz mellékelni kell a megfelelő teszteket. Mielőtt beküldöd a PR-t, győződj meg róla, hogy az összes meglévő teszt sikeresen lefut, és a módosításod nem törte el a korábbi funkcionalitást.
Code Review (Kódátvizsgálás): Egyetlen kód sem kerülhet a fő ágba (main/master) anélkül, hogy legalább egy projekt karbantartó (maintainer) át ne nézte és jóvá nem hagyta volna. Törekedj a kisebb, könnyen áttekinthető PR-ok készítésére.

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

Security Guidelines
Secrets & Tokens: Never, under any circumstances, commit passwords, API keys, tokens, or private credentials to the codebase!
Be especially careful when writing Shell and PowerShell automation scripts.
This data should be read from environment variables (.env) or from the secrets manager of the CI/CD pipeline.
Manage Dependencies: Only add packages from official and trusted sources to your project (e.g. npm, PyPI). Before submitting, check for vulnerabilities with npm audit (or the appropriate command of your package manager).
Secure Scripting: When modifying Shell and PowerShell files in your project, take extra care to avoid "Command Injection". Always validate and properly escape user or external input.
Report Vulnerabilities: If you discover a vulnerability in your project, please do not open a public Issue! Instead, contact the maintainers privately (e.g. by email at the address provided) so that we can fix the bug before it is made public.
