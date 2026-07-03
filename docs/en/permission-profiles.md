# Permission Profiles

> Pre-defined tool permissions and filesystem access templates — a selectable profile at agent startup controls what the agent is allowed to do.

---

## What it does / why it matters

When the system starts a new agent, Claude Code's permission engine uses a **profile to decide** which tools and filesystem operations are allowed or denied. Without a permission profile every agent runs in `--dangerously-skip-permissions` mode (permissive) — profiles regulate and tighten this.

Two runtime modes:

| Mode | Description |
|------|-------------|
| `permissive` | Allows everything by default; the `deny` list blocks specific items |
| `strict` | Denies everything by default; only items on the `allow` list are permitted |

**In strict mode the `--dangerously-skip-permissions` flag is not added to the startup command**, so Claude Code actually enforces the permission list.

---

## Profile file location

```
templates/profiles/
  default.json
  developer-junior.json
  developer-senior.json
  marketer.json
  researcher.json
```

Each file is a self-contained JSON profile. Marveen **reads the directory dynamically** — adding a new `.json` file makes it immediately available on the dashboard (no restart needed).

---

## Profile structure

```json
{
  "id": "developer-junior",
  "label": "Developer (junior)",
  "description": "Feature development on own branch. Push to main is blocked.",
  "permissionMode": "strict",
  "filesystem": {
    "allow": [
      "Read(${AGENT_DIR}/**)",
      "Write(${AGENT_DIR}/**)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "WebFetch(*)"
    ],
    "deny": [
      "Read(${HOME}/.ssh/**)",
      "Bash(sudo:*)",
      "Bash(git push --force:*)",
      "Bash(git push origin main:*)"
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (filename = `<id>.json`) |
| `label` | Display name on the dashboard |
| `description` | Short description of intended use |
| `permissionMode` | `strict` or `permissive` |
| `filesystem.allow` | Allowed tools/paths |
| `filesystem.deny` | Denied tools/paths |

---

## Placeholders

The following placeholders in profile files are substituted at agent startup:

| Placeholder | Substituted value |
|-------------|-------------------|
| `${HOME}` | Machine's `HOME` directory |
| `${AGENT_DIR}` | Agent's working directory (`agents/<name>/`) |
| `${WORKDIR}` | Alias for `${AGENT_DIR}` |

---

## Built-in profiles

### `default` — Default (compatibility)

```json
{
  "permissionMode": "permissive",
  "filesystem": { "allow": [], "deny": [] }
}
```

For backwards compatibility with older agents. For new agents prefer a role-specific profile.

### `developer-junior` — Developer (junior)

- Mode: `strict`
- Allows: own `AGENT_DIR`, `/tmp`, git, npm, node, python3, curl, WebFetch/WebSearch
- Denies: `~/.ssh`, `~/.aws`, `~/.gnupg`, `sudo`, force-push, push to main/master

Use for: feature development on its own branch, in a sandboxed environment.

### `developer-senior` — Developer (senior, trusted)

- Mode: `permissive`
- Denies: `~/.ssh`, `~/.aws`, `~/.gnupg`, `sudo`, `rm -rf $HOME`, force-push

Use for: trusted agents that can do almost anything, but the most destructive commands remain blocked.

### `marketer` — Marketer

- Mode: `strict`
- Allows: own `AGENT_DIR`, `~/Downloads`, WebFetch/WebSearch, ls/cat
- Denies: everything that involves filesystem writes outside the agent's own folder; SSH/AWS/.env; exec-type commands

Use for: email drafts, newsletters, social content — reads web content, strictly limited.

### `researcher` — Researcher

Web search, reading, and downloading allowed; filesystem writes minimal (own folder + `/tmp`).

---

## API

### List profiles

```
GET /api/agents/profiles
```

Returns the id, label, description, and mode of all available profiles.

### Assign a profile to an agent

Set via the agent's configuration (see [Agent fleet](agent-fleet.md)):

```
PUT /api/agents/<name>/config
Content-Type: application/json

{ "permissionProfileId": "developer-junior" }
```

The new profile takes effect on the agent's next startup.

---

## Creating a custom profile

1. Create a new `.json` file in the `templates/profiles/` directory
2. Fill in the structure (`id`, `label`, `description`, `permissionMode`, `filesystem.allow/deny`)
3. The `id` must match the filename (without `.json`)
4. Marveen picks it up automatically — no restart needed

```json
{
  "id": "data-analyst",
  "label": "Data Analyst",
  "description": "SQL queries, CSV export, read-only.",
  "permissionMode": "strict",
  "filesystem": {
    "allow": [
      "Read(${AGENT_DIR}/**)",
      "Write(${AGENT_DIR}/**)",
      "Bash(sqlite3:*)",
      "Bash(python3:*)",
      "Bash(ls:*)",
      "Bash(cat:*)"
    ],
    "deny": [
      "Read(${HOME}/.ssh/**)",
      "Bash(sudo:*)",
      "Bash(rm:*)"
    ]
  }
}
```

---

## Important notes

- Telegram channel plugin permission prompts (Allow/Deny buttons in messages) **operate on a separate channel** and are not affected by the profile.
- In permissive mode the `deny` list is enforced but the `allow` list is ignored (no need to populate it).
- In strict mode **only** the tools/paths on the `allow` list are permitted.
- If a profile's `id` is not found on the filesystem, the system falls back to the `default` profile.

---

## Related documents

- [Agent fleet](agent-fleet.md) — configuring and starting agents
- [Vault](vault.md) — managing secret values (secrets must never go in a profile)
