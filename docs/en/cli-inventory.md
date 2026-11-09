# CLI inventory

> The command-line tools the fleet can run, on one page next to the MCP servers ([HU](../cli-inventory.md)).

---

## 🎯 What it does / why it matters

The MCP page in the Connections group lists MCP servers only. A [Printing Press](../printing-press-cli.md) CLI can reach a live account just as well, and so far the dashboard did not see it. The **Connections > CLI** page lists these tools, laid out like the MCP page: stat cards, one group per folder, one card per tool, and a detail window on click.

The detail window shows:
- **binary, version, license, folder**: from the CLI's `manifest.json`;
- **authentication**: the mode and the NAMES of the environment variables it needs (never a value);
- **commands**: the top-level commands with a short description and their subcommands;
- **skills that name it**: the global and per-agent skills that mention the binary name (only the agent and skill name, nothing of the skill text);
- **README excerpt**: the start of the folder's README.

The list builds itself, with no hand-kept register.

---

## 🛠 How it works

- **Generator:** `scripts/cli-inventory.py` writes `store/cli-inventory.json` (atomically, deterministically, with no network call of its own).
- **Route:** `GET /api/cli-inventory` (bearer-gated, GET only) serves the file and regenerates it when it is missing, older than an hour, or on `?refresh=1` (the page's Refresh button). A failed regeneration serves the previous file together with the error; with no file the answer is a 500, never an empty list. Only the owner can start a regeneration (see below). The structure mirrors the adopted open-source inventory (`/api/opensource-inventory`) on purpose.
- **Folders:** the `CLI_INVENTORY_DIRS` setting (see [config-reference](config-reference.md)). **It is empty by default, and empty means the inventory is off:** nothing runs, the route answers `{ "enabled": false }`, and the CLI page says it can be turned on in Settings. Naming a folder turns it on, for example the Printing Press library (`~/printing-press/library`). Every immediate subfolder holding a `manifest.json` in a configured folder is one tool. The generator has no default folder either: without `--dir` it stops with an error before it starts anything.
- **From the manifest** only `display_name`, `version`, `description` and `license` are taken; `author`, `user_config` and `server` are not.

### The generator RUNS the binaries it finds

For the command list the generator **starts each subfolder's `*-pp-cli` file with the dashboard user's rights**, with a descriptive call only: `agent-context`, or `--help` when that is missing. Each call:
- has a 5-second timeout; on timeout the whole process group is stopped;
- runs with stdin closed, an empty temporary `HOME` and working directory (removed afterwards), and an environment of `PATH`, `HOME` and `LANG` only: no inherited token reaches it.

This is **not a sandbox**: the binary may write files or open network connections meanwhile. **So name in `CLI_INVENTORY_DIRS` only folders whose binaries you trust.** Of its output, only the fields listed above reach the JSON.

### Only the owner starts a run

The generator (a `?refresh=1`, or the regeneration of a missing file or one older than an hour) is **started only by the owner's dashboard session** (the same owner gate as every other owner action: the password login, or the owner's login cookie beside the token). Every other caller, the shared token and the agent tokens alike, gets its answer without a run:
- on `?refresh=1` a 403 (`owner_session_required`), as for every owner action;
- for a stale file the saved inventory, marked `cache.regen_skipped: "owner_session_required"` (the page says only the owner can refresh it);
- with no file `{ "enabled": true, "pending": true }` (the page: no inventory yet), not a 500.

So holding a token is not enough to make the dashboard run a binary; only the owner's visit or click starts a run.

For the same reason **only the owner may set `CLI_INVENTORY_DIRS`**: on the Settings page a change or a reset needs the dashboard login, and the shared agent token gets a 403. The key lives in the overrides only: a `.env` line that differs from the default does not count (the Settings page marks it). If an agent could point it at its own folder, the dashboard would run a binary placed there with its own rights, outside the agent hooks' gates.

### What is kept out

- Nothing outside the configured folders is read: symlinks are not followed (no subfolder, binary or README); the number skipped is `summary.skipped_symlinks`.
- As a last step every string passes a scrub: e-mail addresses, URL query strings and fragments (`?token=`, `?key=`, `#access_token=`), `key=value` secrets and token-shaped values are replaced by `[redacted]`; the number of replacements is `summary.redactions`.

### Not in it yet

Wrapper permission output (e.g. a read-only wrapper), authentication expiry and a usage counter are a later extension.

The CLI's own per-command "read-only" annotation is deliberately NOT shown: a parent command's annotation does not cover its subcommands (measured: writing subcommands under a command group annotated read-only), so read as a permission it would mislead.
