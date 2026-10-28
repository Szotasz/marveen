# Hook metadata and env switches (HOOKDRIFT926)

> A sidecar file next to `.claude/settings.json` catches a silently edited hook, a reordered hook list and a command that points at a missing script before any of them reaches production.

Magyar változat: [../hook-metaadatok.md](../hook-metaadatok.md)

---

## 🎯 What it does / why it matters

Hooks (gates, loggers, channel helpers) live in one large JSON block in `settings.json`. A badly resolved merge, a mistyped matcher or a renamed script raises no error: the hook simply stops running, and nobody notices until a gate lets through something it should have stopped.

The sidecar records, for every hook, what its command and matcher were when someone last approved them on purpose. CI checks that settings and sidecar agree. When they do not, it names the hook, its position and what changed.

The other half is a small helper library (`scripts/hooks/hook_switches.py`): one env var switches off a logging hook (for example the high-volume `tool-log-capture`), while no env value can switch off a gate.

---

## 🛠 How it works

### The sidecar

`.claude/hooks.metadata.json`, next to the settings file. Every matcher group (event + index) has a stable `id`, a one-line `purpose`, the `hook` name (script file stem), a `gate` flag and a `fingerprint` (sha256 over the event, the matcher and the command text; the timeout is NOT part of it). It is a sidecar because the Claude Code settings schema allows no custom keys on hook objects.

### After editing hooks

When you add, remove, re-command, re-match or reorder hooks, update the sidecar in the same commit:

```bash
python3 scripts/hook-metadata.py --update     # rewrites the sidecar and prints the diff
python3 scripts/hook-metadata.py              # validate: 0 = ok, 1 = findings, 2 = unreadable input
```

Review the diff: a moved hook keeps its `id` and `purpose`; a new hook's `purpose` is drafted from the first sentence of its script's docstring (replace a `TODO` by hand). Any settings file can be checked, for example a locally modified copy: `python3 scripts/hook-metadata.py --settings /path/.claude/settings.json` (the sidecar defaults to the file next to it; `--metadata` and `--project-dir` override).

Finding codes:

| Code | Meaning |
|------|---------|
| `MISSING_METADATA` | a hook has no sidecar entry |
| `ORPHAN_METADATA` | an entry describes a hook that is gone from settings |
| `DRIFT` | command or matcher edited without updating the sidecar |
| `REORDERED` | a known hook sits at a different position (silent reorder) |
| `MISSING_SCRIPT` | a command names a script file that does not exist |
| `FORBIDDEN_KEY` | a key outside the hook schema in settings (e.g. `id`, `description`) |
| `SCHEMA` | structurally broken hooks block |
| `BAD_METADATA` | malformed sidecar (top level not an object, bad index, duplicate id, a `hook` field that does not match the script the group runs, bad `non_disableable` list) |
| `GATE_NOT_LOCKED` / `GATE_UNFLAGGED` | the `gate` flag and the lock list disagree, or a `-gate` / `-guard` hook is not locked |

CI (`.github/workflows/test.yml`) runs the validator's tests and the validator itself on the repo's settings.

### Env switches

`MARVEEN_DISABLED_HOOKS=tool-log-capture` disables the listed hooks, if they use the `hook_switches` helper (currently: `tool-log-capture`). A listed hook exits 0 before reading its input.

**Locked** hooks can NOT be disabled from the environment: their names are ignored whatever the variable says. An env var is exactly what the wrong party can set: a prompt injection or a careless `export`.

The lock list has two parts:

1. **Built-in floor:** `hook_switches.DEFAULT_NON_DISABLEABLE`, every gate and guard shipped with the repo (`outgoing-copy-gate`, `email-approval-gate`, `email-send-gate`, `egress-gate`, `credential-gate`, `destructive-gate`, `fleet-freeze-gate`, `telegram-reply-guard` and the rest). A test fails when a shipped `-gate` / `-guard` hook is missing from it.
2. **The install's own additions:** the sidecar's top-level `non_disableable` list. An installation puts its own gates and audit ledgers here, without editing `hook_switches.py`:

```json
{
  "version": 1,
  "non_disableable": ["my-post-gate", "outgoing-mail-ledger"],
  "hooks": { "...": [] }
}
```

The list can only ADD: nothing in data can remove a name from the built-in floor. If the sidecar exists but its lock list cannot be read, every hook counts as locked until it is fixed (the safe direction): none is env-disableable, and oversize input blocks on all of them. The validator reports the two kinds of breakage differently, see the table below.

#### What `--update` will and will not write

One invariant, enforced by a single function (`preflight()`) that is the only gate in front of the write: `--update` writes the sidecar only after BOTH inputs (the settings it regenerates from and the existing sidecar) have been read and checked with zero settings `SCHEMA` / `FORBIDDEN_KEY` findings and nothing it cannot carry over, and the new text has been built and encoded. On anything else it exits 2 and the sidecar is byte-identical. All checks run before the temp file is created; a failure while writing (any exception) is also exit 2, with the temp file removed.

Carry-over rule: it writes back exactly what it read, except the fields it regenerates (`version`, `_comment` and the `hooks` entries; ids and purposes follow their hook). A present `non_disableable` value is written back verbatim, `null` included. Unknown top-level keys are carried over unchanged rather than refused (the gentler choice: nothing is lost). The `gate` flags come from the effective lock list (built-in floor plus the sidecar's `non_disableable` names); while that list is malformed, an entry keeps its old flag.

Which old entry a group inherits (its `id` and `purpose`), so that a label never moves to a different group: first every exact fingerprint match at the same position, across all groups; then every remaining exact fingerprint match anywhere in the event (a moved hook); only then, for the leftovers (an edited command or matcher), the leftover groups of one script inherit the leftover entries of that script in order, and only when both counts are equal. If they differ (an edit mixed with an insert or delete of the same script), pairing them would be a guess, so those groups get a fresh id and a drafted purpose; an old id that no group inherits is not reused in that run. Inserting a new group of a script that is already wired several times (for example `outgoing-copy-gate`) therefore leaves every sibling's id and purpose where it was.

| Input state | Validator | `--update` |
|---|---|---|
| settings: missing, cannot be opened, not valid JSON, or nested too deeply to parse | exit 2 (unreadable input) | exit 2, refuses |
| settings: no `hooks` key while the sidecar has entries (a truncated or wrong file is more likely than "every hook removed") | exit 1, `ORPHAN_METADATA` for every entry | exit 2, refuses; remove the entries by hand if every hook really went |
| settings: top level or `hooks` not an object, an event not an array, a group / handler not an object, a group without a non-empty `hooks` array, a command handler without `command`, text that is not valid UTF-8 | exit 1, `SCHEMA` | exit 2, refuses |
| settings: a key outside the hook schema (`id`, `description` ...) | exit 1, `FORBIDDEN_KEY` | exit 2, refuses |
| settings: a command names a missing script | exit 1, `MISSING_SCRIPT` | writes (nothing is lost), then exit 1 `MISSING_SCRIPT` |
| sidecar: cannot be opened, not valid JSON (e.g. merge-conflict markers), or nested too deeply to parse | exit 2, `cannot read metadata` | exit 2, refuses |
| sidecar: top level or `hooks` not an object (or `hooks` missing), an event not an array, an entry not an object | exit 1, `BAD_METADATA` | exit 2, refuses |
| sidecar entry: an unknown key, a missing key, or a wrong type (`index` int, `id` non-empty string, `hook` string or null, `gate` boolean, `purpose` string, `fingerprint` string), or a repeated `id` | exit 1, `BAD_METADATA` for `index`, `id`, `fingerprint`, `gate`, `hook`; `purpose` is not type-checked (a missing one warns) | exit 2, refuses |
| sidecar: `version` present and not exactly the integer 1 (`true`, `"1"`, `1.0`, `2`) | not checked | exit 2, refuses |
| sidecar: text the new file could not encode as UTF-8 (a lone surrogate escape) | not checked | exit 2, refuses |
| sidecar: `non_disableable` present but not an array of names (`null` included) | exit 1, `BAD_METADATA` | writes the value back verbatim, keeps the old `gate` flags, then exit 1 `BAD_METADATA` |
| sidecar: unknown top-level keys | ignored | carried over unchanged |
| writing the new file fails (temp file, chmod, replace) | - | exit 2, sidecar untouched, temp file removed |

Resolve a conflict or restore the file first. Without a sidecar only the built-in floor applies. The sidecar's location is derived from where `hook_switches.py` lives (`.claude/hooks.metadata.json` under the repo root) and is deliberately not overridable from the environment.

#### Input cap and inheritance

`MARVEEN_HOOK_INPUT_MAX_BYTES` (default 8 MiB) caps the hook's stdin payload. Over the cap a logging hook skips the call silently (fail-open), a locked hook blocks with exit 2 (fail-closed).

A hook inherits the variable from the Claude Code process, so set it before the session starts (or in the `env` block of settings.json). An `export` in a running session's Bash tool stays in that Bash subprocess and never reaches the hook. (This follows from process inheritance; it was not measured on a live session, nor was the `env` block's effect on hooks.)

### Wiring a new hook to the switch

A hook that uses the helper wraps the import in `try` and falls back to its previous behaviour on an import error, so the switch can never become a new way for a hook to break a session:

```python
try:
    import hook_switches
except Exception:
    payload = json.load(sys.stdin)
else:
    if hook_switches.is_disabled("my-logger"):
        sys.exit(0)
    raw = hook_switches.read_hook_stdin("my-logger")
    if raw is None:          # oversize input on a logging hook: fail open
        sys.exit(0)
    payload = json.loads(raw)
```

The idea comes from affaan-m/ECC's `hooks.metadata.json` (MIT); none of its code is used.
