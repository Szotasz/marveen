# Marveen — Docker környezet

## 1. Mi ez?

A Marveen konténerizált futtatókörnyezete: egyetlen **multistage** `Dockerfile` és egy
`docker-compose.yml`, amivel a rendszer egy kicsi Linux (Debian *bookworm-slim*, **Node 22**)
konténerben fut — a szükséges eszközökkel (`tmux`, `git`, `python3`, `ffmpeg`, `sqlite3`, `claude`
CLI). Az állapot (adatbázis, tokenek, ügynök-munkakönyvtárak) **mountolt kötetekben** marad meg, a
konfiguráció pedig egy **docker-specifikus `.env.docker`** fájlból jön.

Miért jó ez itt konkrétan? A projekt Linux-first: Windowson a tesztek egy része *környezeti* okból
elhasal (`tmux`/`git`/`python3` hiánya, Node 25). A konténer a projekt által támogatott Node 22-t és
minden eszközt hozza — így a suite ténylegesen lefut.

## 2. Hogyan használd?

```bash
# 1) Készíts docker-env fájlt a mintából, és töltsd ki (tokenek, port):
cp .env.docker.example .env.docker
#   szerkeszd: WEB_PORT, majd EGY Claude-hitelesítés (OAuth token vagy API kulcs)

# 2) Építs és indíts (a -d háttérben futtat):
docker compose up -d --build

# 3) Nézd a logot / állapotot:
docker compose logs -f marveen
docker compose ps            # a healthcheck "healthy" állapotát is mutatja

# 4) Dashboard: http://localhost:3420  (vagy a WEB_PORT-od)

# 5) Leállítás / teljes törlés:
docker compose down          # konténer le, kötetek MEGMARADNAK
docker compose down -v       # kötetek is törlődnek (adatvesztés!)
```

Csak image-építés, futtatás nélkül:

```bash
docker build -t marveen:local .
```

Opcionális local-LLM offload (Ollama sidecar):

```bash
docker compose --profile ollama up -d          # elindítja az ollama szolgáltatást is
# majd a .env.docker-ben: OLLAMA_URL=http://ollama:11434
```

## 3. Hogyan működik?

```mermaid
sequenceDiagram
    actor Dev as Fejlesztő
    participant Compose as docker compose
    participant Build as Build (multistage)
    participant Cont as marveen konténer
    participant Vol as Kötetek (store/ ...)

    Dev->>Compose: up -d --build
    Compose->>Build: deps → build (tsc) → prod-deps → runtime
    Note over Build: better-sqlite3 fordítása a deps/prod-deps<br/>stage-ben; runtime csak futásidejű eszközök
    Build-->>Compose: marveen:local image (non-root, healthcheck)
    Compose->>Cont: indítás (tini PID1 → node dist/index.js)
    Cont->>Vol: store/claudeclaw.db + állapot csatolása
    Cont-->>Compose: HEALTHCHECK GET :WEB_PORT → healthy
    Dev->>Cont: böngésző → dashboard (WEB_PORT)
```

**Build stage-ek:**
- **deps** — minden függőség (dev is) + fordítói lánc (`python3`, `make`, `g++`) a `better-sqlite3`
  natív modulhoz; a `package*.json`-ra cache-elve.
- **build** — `npm run build` (`tsc` → `dist/`).
- **prod-deps** — csak production `node_modules` (a natív modul a runtime-mal azonos alapon fordul,
  így ABI-kompatibilis).
- **runtime** — `node:22-bookworm-slim` + futásidejű OS-eszközök + `claude` CLI; ide másolódik a
  `dist/`, a prod `node_modules` és a statikus asset (`web/`, `templates/`, `scripts/`,
  `seed-skills/`). **Non-root** (`node` user), **HEALTHCHECK** a dashboard porton, **tini** a PID 1.

**Állapot (kötetek):** minden futásidejű állapot a `/app` alatti, gitignore-olt alkönyvtárakban él,
ezeket named volume-ként csatoljuk (nem sülnek bele az image-be):
`store/` (benne a `store/claudeclaw.db` SQLite adatbázis, tokenek, beállítások), `agents/`,
`workspace/`, `reports/`, `.channels-config/`, `mcp-servers/`.

## 4. Technikai részletek

- **Alap-image:** `node:22-bookworm-slim`. A `package.json` engines `>=20 <24` — a 22 LTS ezen belül
  van; Alpine helyett Debian (glibc), mert a `better-sqlite3` és az `ffmpeg`/python-venv így stabil.
- **Futásidejű eszközök** (mire kellenek): `tmux` (az ügynökök `claude` példányai tmux
  munkamenetben futnak), `git` (update-checker, git-protect hook), `tar` (mentés/visszaállítás),
  `gawk` (install/status scriptek), `python3`+`python3-venv` (guard hookok), `sqlite3` (DB),
  `ffmpeg` (hang/opus), `curl`+`ca-certificates`, `tini` (a tmux/gyerek-folyamatfa reap-elése).
- **Claude CLI:** build-időben `curl https://claude.ai/install.sh | bash` telepíti a `node` user
  `~/.local/bin`-jébe (best-effort: offline build esetén az image használható marad, a CLI runtime-ban
  telepíthető vagy a host `~/.claude` read-only mountolható — ld. a compose fájl kommentjét).
- **Hitelesítés:** headless futáshoz `.env.docker`-ben `CLAUDE_CODE_OAUTH_TOKEN` vagy
  `ANTHROPIC_API_KEY`, VAGY a host `~/.claude` read-only csatolása.
- **Optimalizációk:** BuildKit `--mount=type=cache` az apt- és npm-cache-re; réteg-sorrend
  (`package*.json` előbb, forrás utóbb) → forrásváltozás nem futtatja újra a `npm ci`-t; `.dockerignore`
  kizárja a `node_modules`/`.git`/`dist`/állapot/titok fájlokat; non-root user; `HEALTHCHECK`;
  többlépcsős build, hogy a fordítói lánc ne kerüljön a futó image-be.
- **Adatbázis:** `store/claudeclaw.db` (WAL) — a `store/` kötet része, így a `down`/rebuild túléli.
- **Sorvégek:** a `.gitattributes` a `Dockerfile`/`docker-compose*.yml`/`.dockerignore`/`.env*`
  fájlokat LF-re kényszeríti (a repo `autocrlf=true` egyébként CRLF-et adna, ami a `RUN` lépéseket
  elrontaná).
- **Titkok:** a `.env.docker` gitignore-olt; csak a `.env.docker.example` verziózott.

## 5. Tech stack

Docker (multistage, BuildKit) · Docker Compose · `node:22-bookworm-slim` (Debian) · Node 22 / TypeScript
(`tsc` → `dist/`) · better-sqlite3 (natív, WAL) · tini · tmux · git · python3 · ffmpeg · sqlite3 ·
Claude Code CLI · (opcionális) Ollama sidecar a local-LLM offloadhoz.
