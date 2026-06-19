# MCP Configuration — Fleet Agents

Documented: 2026-06-10 (Zoe, kanban #21)

## Summary

| Agent | MCP server | Auth type | Config location |
|-------|------------|-----------|-----------------|
| marveen | google-workspace | OAuth (jonas) | `.mcp.json` (repo root) |
| marveen | spotify | OAuth (~/.spotify-mcp/credentials.json) | `.mcp.json` (repo root) |
| dave | gitlab | PAT (env) | `agents/dave/.mcp.json` |
| dave | google-workspace | OAuth (jonas) | `agents/dave/.mcp.json` |
| peter | garmin | token-cache (garth) | `agents/peter/.mcp.json` |
| peter | google-workspace | OAuth (jonas) | `agents/peter/.mcp.json` |
| poly | pollinations | none | `agents/poly/.mcp.json` |
| poly | video | none | `agents/poly/.mcp.json` |
| rick | gitlab | PAT (env) | `agents/rick/.mcp.json` |
| rick | google-workspace | OAuth (jonas) | `agents/rick/.mcp.json` |
| zack | gitlab | PAT (env) | `agents/zack/.mcp.json` |
| zack | google-workspace | OAuth (jonas) | `agents/zack/.mcp.json` |
| zoe | gitlab | PAT (env) | `agents/zoe/.mcp.json` |
| zoe | google-workspace | OAuth (jonas) | `agents/zoe/.mcp.json` |

---

## Detailed configuration

### marveen — `.mcp.json` (repo root)

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp", "serve"]
    },
    "spotify": {
      "command": "npx",
      "args": ["-y", "@tbrgeek/spotify-mcp-server"]
    }
  }
}
```

**Google Workspace:** OAuth, account name: `jonas`. Tools: Gmail, Calendar, Drive, Docs, Sheets.

**Spotify:** OAuth, token cache: `~/.spotify-mcp/credentials.json`. Auth command (not the npx subcommand — README bug): `node $(npm root -g)/@tbrgeek/spotify-mcp-server/dist/scripts/authenticate.js`. Token ~1h, refresh token present. Playback requires Spotify Premium.

---

### dave — `agents/dave/.mcp.json`

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "<PAT>",
        "GITLAB_API_URL": "https://gitlab.com/api/v4",
        "USE_PIPELINE": "true",
        "USE_MILESTONE": "true",
        "USE_GITLAB_WIKI": "true"
      }
    },
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp", "serve"]
    }
  }
}
```

**GitLab:** community server (`@zereight/mcp-gitlab`), PAT auth (the native GitLab MCP is not available on the Free tier). PAT: `glpat-bciAR-...` (user: `cett`). Pipeline, milestone, wiki enabled.

**Google Workspace:** OAuth, account: `jonas`.

---

### peter — `agents/peter/.mcp.json`

```json
{
  "mcpServers": {
    "garmin": {
      "command": "uvx",
      "args": [
        "--python", "3.12",
        "--from", "git+https://github.com/Taxuspt/garmin_mcp",
        "garmin-mcp"
      ]
    },
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp", "serve"]
    }
  }
}
```

**Garmin:** `Taxuspt/garmin_mcp` (MIT), uvx + Python 3.12, token-cache based (garth library). One-time auth: `uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth`. Token expiry: ~6 months; renew: `...garmin-mcp-auth --force-reauth`.

**Google Workspace:** OAuth, account: `jonas`.

---

### poly — `agents/poly/.mcp.json`

```json
{
  "mcpServers": {
    "pollinations": {
      "command": "npx",
      "args": ["-y", "@pollinations/mcp"]
    },
    "video": {
      "command": "uv",
      "args": [
        "--directory", "/Users/jonasgergo/.local/share/mcp-servers/video-audio-mcp",
        "run", "server.py"
      ]
    }
  }
}
```

**Pollinations:** image and text generation, no auth.

**Video:** local Python server (`video-audio-mcp`), `uv run server.py`, no auth.

---

### rick — `agents/rick/.mcp.json`

Same GitLab + Google Workspace config as dave (same PAT).

---

### zack — `agents/zack/.mcp.json`

Same GitLab + Google Workspace config as dave (same PAT).

---

### zoe — `agents/zoe/.mcp.json`

Same GitLab + Google Workspace config as dave (same PAT).

---

## Smoke test results (2026-06-10)

### GitLab (Zoe session)
- `whoami` → OK: user `cett`, active, gitlab.com
- Auth: PAT valid

### Google Workspace (Zoe session)
- `listAccounts` → OK: `jonas` account configured (2026-06-10T17:31:31Z)
- Auth: OAuth valid

### Garmin (Peter) — not tested from Zoe session
- Config present, token-cache based
- To test, use Peter session: `@peter Garmin: what's the current step count?`

### Poly MCPs — not tested from Zoe session
- Pollinations and video-audio: need own session
- To test: `@poly Generate a test image: "blue sky"`

### Spotify (Marveen) — not tested from Zoe session
- Config present, OAuth cache valid (per memory, last confirmed 2026-06-10)
- To test, use Marveen session

---

## Notes

- All GitLab agents (dave, rick, zack, zoe) share the same PAT. When it expires, all four must be updated at once.
- The `google-workspace-mcp` OAuth token is in the system credential store; every agent sees the same `jonas` account.
- Configs are scoped: each `.mcp.json` lives exclusively in the agent's directory, not in global settings.json.
- PAT tokens are in the `.mcp.json` env section; the `agents/` directory is gitignored, so they never enter the repo.
