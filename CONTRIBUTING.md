# Hogyan járulhatsz hozzá a Marveen projekthez?

Örülünk, hogy érdeklődsz az AI csapat fejlesztése iránt! A következő lépésekkel tudsz csatlakozni:

- **Környezet beállítása:** Forkold a repót, majd futtasd a lokális telepítőt (`./install.sh`). A futtatáshoz szükséged lesz a megfelelő API kulcsokra (pl. Anthropic, Telegram bot token).
- **Branch-szabály:** A `develop` (és `main`) ágra KÖZVETLENÜL senki nem pushol. Minden új fejlesztés saját, beszédes nevű branch-en fut (pl. `feature/uj-mcp-connector` vagy `fix/telegram-hiba`), és Pull Requesten keresztül kerül be.
- **Új Skillek és Integrációk:** Ha új képességet adsz az ágenseknek, feltétlenül pótold a működés leírását a `docs/` mappában (pl. a `skill-factory.md` vagy új dokumentum formájában).
- **Pull Request beküldése:** Nyiss PR-t a `develop` ág felé. A PR megnyitásakor automatikusan betöltődik a sablon (`.github/pull_request_template.md`); töltsd ki minden szakaszát, hogy a változtatásod egységesen, könnyen áttekinthetően legyen dokumentálva.

# How can you contribute to the Marveen project?

We are glad that you are interested in developing the AI team! You can join with the following steps:

- **Environment setup:** Fork the repo, then run the local installer (`./install.sh`). To run it, you will need the appropriate API keys (e.g. Anthropic, Telegram bot token).
- **Branch rule:** Nobody pushes DIRECTLY to `develop` (or `main`). Every new change runs on its own descriptively named branch (e.g. `feature/uj-mcp-connector` or `fix/telegram-bug`) and lands through a Pull Request.
- **New Skills and Integrations:** If you add a new skill to the agents, be sure to add a description of how it works in the `docs/` folder (e.g. in the form of `skill-factory.md` or a new document).
- **Submit a Pull Request:** Open a PR against the `develop` branch. The template (`.github/pull_request_template.md`) loads automatically when you open the PR; fill in every section so your change is documented in a consistent, easy-to-review way.
