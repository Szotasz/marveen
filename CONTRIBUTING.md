# Hogyan járulhatsz hozzá a Marveen projekthez?

Örülünk, hogy érdeklődsz az AI csapat fejlesztése iránt! A következő lépésekkel tudsz csatlakozni:

- **Környezet beállítása:** Forkold a repót, majd futtasd a lokális telepítőt (`./install.sh`). A futtatáshoz szükséged lesz a megfelelő API kulcsokra (pl. Anthropic, Telegram bot token).
- **Branch-szabály:** A `develop` (és `main`) ágra KÖZVETLENÜL senki nem pushol. Minden új fejlesztés saját, beszédes nevű branch-en fut (pl. `feature/uj-mcp-connector` vagy `fix/telegram-hiba`), és Pull Requesten keresztül kerül be.
- **Új Skillek és Integrációk:** Ha új képességet adsz az ágenseknek, feltétlenül pótold a működés leírását a `docs/` mappában (pl. a `skill-factory.md` vagy új dokumentum formájában).
- **Tesztek futtatása:** `npm test` a `.nvmrc`-ben megadott Node-verzióval fut (`nvm use`). A `node_modules` natív modult tartalmaz (better-sqlite3), ami egyetlen Node ABI-hoz kötődik, ezért egy másik Node-verzió alatt a teszt-készlet nagy része olyan hibával bukik, aminek látszólag semmi köze a saját tárgyához. Ilyenkor a készlet ezt meg is mondja és megtagadja a futást, a javító paranccsal együtt. A tesztek a checkout alatt írnak, ezért éles telepítésben sem futnak: külön worktree kell hozzájuk (nem `/tmp` alatt).
- **Pull Request beküldése:** Nyiss PR-t a `develop` ág felé. A PR megnyitásakor automatikusan betöltődik a sablon (`.github/pull_request_template.md`); töltsd ki minden szakaszát, hogy a változtatásod egységesen, könnyen áttekinthetően legyen dokumentálva.

# How can you contribute to the Marveen project?

We are glad that you are interested in developing the AI team! You can join with the following steps:

- **Environment setup:** Fork the repo, then run the local installer (`./install.sh`). To run it, you will need the appropriate API keys (e.g. Anthropic, Telegram bot token).
- **Branch rule:** Nobody pushes DIRECTLY to `develop` (or `main`). Every new change runs on its own descriptively named branch (e.g. `feature/uj-mcp-connector` or `fix/telegram-bug`) and lands through a Pull Request.
- **New Skills and Integrations:** If you add a new skill to the agents, be sure to add a description of how it works in the `docs/` folder (e.g. in the form of `skill-factory.md` or a new document).
- **Running the tests:** `npm test` runs on the Node version named in `.nvmrc` (`nvm use`). `node_modules` contains a native module (better-sqlite3) bound to a single Node ABI, so under a different Node version most of the suite fails with an error that looks unrelated to the subject of each test. The suite says so and refuses to run in that case, and prints the command that fixes it. The tests write under the checkout they run in, so they also refuse to run inside a live install: use a separate worktree (not under `/tmp`).
- **Submit a Pull Request:** Open a PR against the `develop` branch. The template (`.github/pull_request_template.md`) loads automatically when you open the PR; fill in every section so your change is documented in a consistent, easy-to-review way.
