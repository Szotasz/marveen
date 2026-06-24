# Dashboard Settings & Update Checker

> GitHub repo integration, external project path management, and automatic upstream update tracking.

---

## What it does / why it matters

The Dashboard handles two complementary functions:

1. **Dashboard Settings**: adding external GitHub repos and project directories — these projects also appear on the Marveen dashboard and agents can access them
2. **Update Checker**: monitors the `Szotasz/marveen` upstream repo's `main` branch and notifies you if the local version is behind

---

## Settings storage

```
store/dashboard-settings.json
```

```json
{
  "externalProjectPaths": [
    "/Users/jonas/projects/my-app"
  ],
  "githubRepos": [
    {
      "url": "https://github.com/owner/repo",
      "name": "owner--repo",
      "path": "/Users/jonas/Documents/marveen/store/github-repos/owner--repo",
      "installedAt": "2026-05-01T10:00:00.000Z",
      "envVars": {
        "API_KEY": "vault-secret-id-123"
      }
    }
  ]
}
```

---

## GitHub repo integration

### Add a repo (clone + install)

```
POST /api/settings/github-repos
Content-Type: application/json

{
  "url": "https://github.com/owner/repo-name",
  "envVars": {
    "OPENAI_API_KEY": "vault-secret-id-xyz"
  }
}
```

Steps in the background:

1. `git clone --depth 1 <url>` — into `store/github-repos/<owner>--<repo>/`
2. If `package.json` exists: `npm install --production`
3. If `.mcp.json` exists: env keys within it are automatically detected (`requiredEnvVars` field in the response)
4. The repo path is also added to the `externalProjectPaths` list

Response:
```json
{
  "repo": {
    "url": "...",
    "name": "owner--repo",
    "path": "...",
    "installedAt": "..."
  },
  "requiredEnvVars": ["OPENAI_API_KEY"]
}
```

If `requiredEnvVars` is non-empty, vault secrets must be wired up manually (see [Vault](vault.md)).

### List repos

```
GET /api/settings/github-repos
```

### Update a repo

```
POST /api/settings/github-repos/<name>/update
```

`git pull --ff-only` + `npm install --production` if `package.json` exists.

### Remove a repo

```
DELETE /api/settings/github-repos/<name>
```

Deletes the cloned directory and removes it from `externalProjectPaths` as well.

---

## External project paths

To make a local directory (without a repo) visible on the dashboard:

### Add

```
POST /api/settings/external-paths
Content-Type: application/json

{ "path": "/Users/jonas/projects/my-app" }
```

Required: absolute path to an existing directory.

### List

```
GET /api/settings/external-paths
```

### Remove

```
DELETE /api/settings/external-paths
Content-Type: application/json

{ "path": "/Users/jonas/projects/my-app" }
```

---

## Update Checker

The update checker runs in the background and **every 15 minutes** fetches the HEAD of the `Szotasz/marveen` GitHub repo's `main` branch, comparing it to the local `git HEAD`.

### Get update status

```
GET /api/updates/status
```

```json
{
  "current": "28bb041f...",
  "latest": "a1b2c3d4...",
  "behind": 3,
  "commits": [
    {
      "sha": "a1b2c3d4",
      "short": "a1b2c3d",
      "message": "feat(dashboard): new feature",
      "author": "Jonas",
      "date": "2026-06-10T09:00:00Z"
    }
  ],
  "remote": "Szotasz/marveen",
  "lastChecked": 1748956800000,
  "error": null
}
```

| Field | Description |
|-------|-------------|
| `current` | Local HEAD commit SHA |
| `latest` | Latest upstream commit SHA |
| `behind` | How many commits the local version is behind |
| `commits` | List of missing commits (newest first) |
| `remote` | Monitored GitHub repo |
| `lastChecked` | Timestamp of last check (epoch ms) |
| `error` | Error message if failed, otherwise `null` |

### Manual update check

```
POST /api/updates/refresh
```

Fetches upstream status immediately, without waiting 15 minutes.

---

## Dashboard

On the Dashboard main page an **"Update available" badge** appears in the top-right of the header if `behind > 0`. Clicking the badge shows the missing commits.

On the **Settings** page:
- GitHub repo management (add, update, remove)
- External project path list
- Update status and manual check button

---

## Examples

```bash
TOKEN=$(cat store/.dashboard-token)

# Add a GitHub repo
curl -s -X POST http://localhost:3420/api/settings/github-repos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url": "https://github.com/owner/my-mcp-server"}'

# Check update status
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/updates/status" | python3 -m json.tool

# Manual upstream check
curl -s -X POST http://localhost:3420/api/updates/refresh \
  -H "Authorization: Bearer $TOKEN"

# Remove a repo
curl -s -X DELETE http://localhost:3420/api/settings/github-repos/owner--my-mcp-server \
  -H "Authorization: Bearer $TOKEN"
```

---

## Important notes

- GitHub API calls are **unauthenticated** (rate limit: 60 requests/hour per IP) — sufficient for the 15-minute polling cycle.
- If the local HEAD is not on the GitHub remote (e.g. an unpushed commit or a different fork), the `compare` endpoint returns 404 and the `error` field indicates this.
- The `store/github-repos/` directory is excluded by `.gitignore` — cloned repos do not end up in Marveen's own repository.
- The `envVars` field stores Vault secret IDs, **never the actual values**.

---

## Related documents

- [Vault](vault.md) — managing and wiring up secret values
- [MCP configuration](mcp-config.md) — configuring MCP servers
- [Agent fleet](agent-fleet.md) — assigning external projects to agents
