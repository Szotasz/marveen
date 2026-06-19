# MCP Configuration — Fleet Agents

Dokumentálva: 2026-06-10 (Zoe, kanban #21)

## Összefoglalás

| Agent | MCP szerver | Auth típus | Config helye |
|-------|-------------|------------|--------------|
| marveen | google-workspace | OAuth (jonas) | `.mcp.json` (repo root) |
| marveen | spotify | OAuth (~/.spotify-mcp/credentials.json) | `.mcp.json` (repo root) |
| dave | gitlab | PAT (env) | `agents/dave/.mcp.json` |
| dave | google-workspace | OAuth (jonas) | `agents/dave/.mcp.json` |
| peter | garmin | token-cache (garth) | `agents/peter/.mcp.json` |
| peter | google-workspace | OAuth (jonas) | `agents/peter/.mcp.json` |
| poly | pollinations | nincs | `agents/poly/.mcp.json` |
| poly | video | nincs | `agents/poly/.mcp.json` |
| rick | gitlab | PAT (env) | `agents/rick/.mcp.json` |
| rick | google-workspace | OAuth (jonas) | `agents/rick/.mcp.json` |
| zack | gitlab | PAT (env) | `agents/zack/.mcp.json` |
| zack | google-workspace | OAuth (jonas) | `agents/zack/.mcp.json` |
| zoe | gitlab | PAT (env) | `agents/zoe/.mcp.json` |
| zoe | google-workspace | OAuth (jonas) | `agents/zoe/.mcp.json` |

---

## Részletes konfiguráció

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

**Google Workspace:** OAuth, account name: `jonas`. Eszközök: Gmail, Calendar, Drive, Docs, Sheets.

**Spotify:** OAuth, token cache: `~/.spotify-mcp/credentials.json`. Auth parancs (nem az npx subcommand, README-bug): `node $(npm root -g)/@tbrgeek/spotify-mcp-server/dist/scripts/authenticate.js`. Token ~1h, refresh token megvan. Playback Spotify Premiumot igényel.

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

**GitLab:** community szerver (`@zereight/mcp-gitlab`), PAT auth (a natív GitLab MCP Free tier-en nem elérhető). PAT: `glpat-bciAR-...` (Jónás Gergő, user: `cett`). Pipeline, milestone, wiki engedélyezve.

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

**Garmin:** `Taxuspt/garmin_mcp` (MIT), uvx + Python 3.12, token-cache alapú (garth library). Egyszeri auth: `uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth`. Token lejárat: ~6 hónap; megújítás: `...garmin-mcp-auth --force-reauth`.

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

**Pollinations:** kép- és szöveggenerálás, nincs auth.

**Video:** lokális Python szerver (`video-audio-mcp`), `uv run server.py`, nincs auth.

---

### rick — `agents/rick/.mcp.json`

Dave-val azonos GitLab + Google Workspace konfig (ugyanaz a PAT).

---

### zack — `agents/zack/.mcp.json`

Dave-val azonos GitLab + Google Workspace konfig (ugyanaz a PAT).

---

### zoe — `agents/zoe/.mcp.json`

Dave-val azonos GitLab + Google Workspace konfig (ugyanaz a PAT).

---

## Smoke teszt eredmények (2026-06-10)

### GitLab (Zoe session)
- `whoami` -> OK: user `cett` (Jónás Gergő), aktív, gitlab.com
- Auth: PAT érvényes

### Google Workspace (Zoe session)
- `listAccounts` -> OK: `jonas` account konfigurálva (2026-06-10T17:31:31Z)
- Auth: OAuth érvényes

### Garmin (Peter) — nem tesztelve Zoe session-ből
- Konfig megvan, token-cache alapú
- Teszteléshez Peter session kell: `@peter Garmin: mi az aktuális lépésszám?`

### Poly MCP-k — nem tesztelve Zoe session-ből
- Pollinations és video-audio: saját session kell
- Teszteléshez: `@poly Generálj egy teszképet: "blue sky"`

### Spotify (Marveen) — nem tesztelve Zoe session-ből
- Konfig megvan, OAuth cache érvényes (memória szerint 2026-06-10-én lefutott)
- Teszteléshez Marveen session kell

---

## Megjegyzések

- Az összes GitLab-os agent (dave, rick, zack, zoe) ugyanazt a PAT-ot használja. Ha lejár, mind a négyet egyszerre kell frissíteni.
- A `google-workspace-mcp` OAuth token a rendszer-szintű credential store-ban van; minden agent ugyanazt a `jonas` accountot látja.
- Konfigurációk scope-olva: minden `.mcp.json` kizárólag az adott agent könyvtárában van, nem globális settings.json-ban.
- A PAT tokenek a `.mcp.json` env szekciójában vannak; az `agents/` mappa gitignore-olt, így nem kerülnek repóba.
