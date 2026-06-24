# Dashboard beállítások és frissítéskezelő

> GitHub repo-integráció, külső projekt-útvonalak kezelése, és az upstream frissítések automatikus követése.

---

## 🎯 Mit tud / miért érdekes

A Dashboard két egymást kiegészítő funkciót kezel:

1. **Beállítások (Dashboard Settings)**: külső GitHub repók és projekt-könyvtárak hozzáadása -- a Marveen dashboardon megjelennek ezek a projektek is, az ügynökök hozzáférhetnek hozzájuk
2. **Frissítéskezelő (Update Checker)**: a `Szotasz/marveen` upstream repo `main` branch-ét figyeli, és értesít ha a helyi verzió mögött van

---

## 🗂 Beállítások tárolása

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

## 🔗 GitHub repo integráció

### Repo hozzáadása (klónozás + telepítés)

```
POST /api/settings/github-repos
Content-Type: application/json

{
  "url": "https://github.com/owner/repo-neve",
  "envVars": {
    "OPENAI_API_KEY": "vault-secret-id-xyz"
  }
}
```

Lépések a háttérben:

1. `git clone --depth 1 <url>` -- a `store/github-repos/<owner>--<repo>/` könyvtárba
2. Ha van `package.json`: `npm install --production`
3. Ha van `.mcp.json`: a benne lévő env kulcsok automatikusan felismerésre kerülnek (`requiredEnvVars` mezőben visszajönnek)
4. A repo elérési útja bekerül az `externalProjectPaths` listába is

Válasz:
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

Ha a `requiredEnvVars` nem üres, a vault-titkokat manuálisan kell bekötni (lásd [Vault](vault.md)).

### Repók listázása

```
GET /api/settings/github-repos
```

### Repo frissítése

```
POST /api/settings/github-repos/<name>/update
```

`git pull --ff-only` + `npm install --production` ha van `package.json`.

### Repo eltávolítása

```
DELETE /api/settings/github-repos/<name>
```

Törli a klónozott könyvtárat és eltávolítja az `externalProjectPaths`-ból is.

---

## 📂 Külső projekt-könyvtárak

Ha egy repo nélküli helyi könyvtárat szeretnél a dashboardon láthatóvá tenni:

### Hozzáadás

```
POST /api/settings/external-paths
Content-Type: application/json

{ "path": "/Users/jonas/projects/my-app" }
```

Kötelező: abszolút elérési út, létező könyvtár.

### Listázás

```
GET /api/settings/external-paths
```

### Eltávolítás

```
DELETE /api/settings/external-paths
Content-Type: application/json

{ "path": "/Users/jonas/projects/my-app" }
```

---

## 🔄 Frissítéskezelő (Update Checker)

A frissítéskezelő a háttérben **15 percenként** lekéri a `Szotasz/marveen` GitHub repo `main` branch HEAD-jét, és összehasonlítja a helyi `git HEAD`-del.

### Frissítési állapot lekérése

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

| Mező | Leírás |
|------|--------|
| `current` | Helyi HEAD commit SHA |
| `latest` | Upstream legfrissebb commit SHA |
| `behind` | Hány committal van mögötte a helyi verzió |
| `commits` | A lemaradt commit-ok listája (legújabb elöl) |
| `remote` | Figyelt GitHub repo |
| `lastChecked` | Utolsó ellenőrzés időpontja (epoch ms) |
| `error` | Hiba esetén hibaüzenet, egyébként `null` |

### Manuális frissítés-ellenőrzés

```
POST /api/updates/refresh
```

Azonnal lekéri az upstream állapotot, nem vár 15 percet.

---

## 🖥 Dashboard

A Dashboard főoldalán a **fejléc jobb felső sarkában** megjelenik egy "Frissítés elérhető" badge, ha `behind > 0`. A badge-re kattintva megjelennek a lemaradt commit-ok.

A **Beállítások** oldalon:
- GitHub repók kezelése (hozzáadás, frissítés, eltávolítás)
- Külső projekt-könyvtárak listája
- Frissítési állapot és manuális ellenőrzés gomb

---

## 💡 Példák

```bash
TOKEN=$(cat store/.dashboard-token)

# GitHub repo hozzáadása
curl -s -X POST http://localhost:3420/api/settings/github-repos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url": "https://github.com/owner/my-mcp-server"}'

# Frissítési állapot ellenőrzése
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/updates/status" | python3 -m json.tool

# Manuális upstream-ellenőrzés
curl -s -X POST http://localhost:3420/api/updates/refresh \
  -H "Authorization: Bearer $TOKEN"

# Repo eltávolítása
curl -s -X DELETE http://localhost:3420/api/settings/github-repos/owner--my-mcp-server \
  -H "Authorization: Bearer $TOKEN"
```

---

## ⚠️ Fontos megjegyzések

- A GitHub API-hívások **nem autentikáltak** (rate limit: 60 kérés/óra IP-nként) -- ez elegendő a 15 perces lekérési ciklushoz.
- Ha a helyi HEAD nincs a GitHub remoten (pl. unpushed commit vagy másik fork), a `compare` endpoint 404-et ad, és `error` mezőben jelzi.
- A `store/github-repos/` könyvtár tartalmát a `.gitignore` kizárja -- a klónozott repók nem kerülnek be a Marveen saját repo-jába.
- Az `envVars` mezőben Vault secret ID-k tárolódnak, **soha nem maga az érték**.

---

## Kapcsolódó dokumentumok

- [Vault](vault.md) -- titkos értékek kezelése és bekötése
- [MCP konfiguráció](mcp-config.md) -- MCP szerverek konfigurálása
- [Ügynök-flotta](agent-fleet.md) -- külső projektek ügynökhöz rendelése
