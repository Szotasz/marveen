# Kind / Docker / Helm: Marveen egy lokális Kubernetes cluster-ben

## 🎯 Mit tud, miért érdekes

A Marveen egyetlen paranccsal elindítható egy lokális [kind](https://kind.sigs.k8s.io/) cluster-ben, a hosttól elszigetelve: nem kell hozzá `install.sh`, tmux, bun, python vagy Claude CLI a gépeden, csak Docker, kind, kubectl és helm. Egy pod fut, egyetlen kifelé publikált porttal (a dashboard, `127.0.0.1:3420`), az állapot pedig PVC-ken él, ezért pod-újraindítás után is megmarad.

Ez nem skálázható éles üzem: az SQLite és a tmux session-ök miatt egyetlen replikáról van szó (`Recreate` strategy, `ReadWriteOnce` volume-ok). Lokális kipróbálásra, izolált test instance-ra való.

## Gyorsindítás

```bash
make -f deploy/Makefile up      # image build + kind cluster + helm install
kubectl exec deploy/marveen -- cat /app/store/.dashboard-token
# nyisd meg: http://127.0.0.1:3420/?token=<a fenti token>
make -f deploy/Makefile down    # cluster törlése (a PVC-kkel együtt)
```

A dashboard tokenjét a pod nem írja a logba (a kimenet nem terminál), ezért kell a fájlból kiolvasni. A belépés után az onboarding végigvezet a Claude-hitelesítésen és a csatorna (Telegram) beállításán.

Titkokkal együtt (a Secret `env` kulcsa egy `.env` tartalma, csak az első indításkor szolgál magként):

```bash
kubectl create secret generic marveen-secrets --from-file=env=./kind.env
make -f deploy/Makefile deploy SECRET=marveen-secrets
```

## 🛠 Hogyan működik

| Fájl | Szerep |
|------|--------|
| `deploy/docker/Dockerfile` | Multi-stage build: `build` (tsc, `npm prune`) → `runtime` (`node:22-bookworm-slim`, nem root) |
| `deploy/docker/entrypoint.sh` | `.env` és a state directory-k előkészítése, csatorna-plugin telepítése |
| `deploy/helm/marveen/` | Deployment (1 replika, `Recreate`), két PVC, NodePort Service ([értékek](../deploy/helm/marveen/README.md)) |
| `deploy/kind/kind-config.yaml` | A node 30420-as portját a host `127.0.0.1:3420`-ra képezi |
| `deploy/Makefile` | `up`, `cluster`, `image`, `load`, `deploy`, `down` |

**Image.** A runtime layer tartalma: `tmux git sqlite3 lsof python3 unzip zstd tini`, a rögzített verziójú Claude CLI (`ARG CLAUDE_CODE_VERSION`) és a `bun` (a Telegram plugin ezt futtatja). Az SDK saját `claude` binárisát a build stage egy linkre cseréli a globális CLI-hez, hogy ~230 MB ne kerüljön kétszer a layerekbe. A runtime fájlok egyetlen layer-ben (`/out`) mennek át. A `tini` a PID 1, hogy a tmux és a Claude folyamatok zombijai ne maradjanak.

**`.env`.** Az app a beállításait az `/app/.env` fájlból olvassa (a `scripts/channels.sh` is `grep`-pel onnan), a process környezetet nem nézi, és a dashboard vissza is írja (atomic rename-mel, ezért nem lehet symlink vagy fájl-mount). Az entrypoint ezért a tartós másolatot a `store/.env`-ben tartja: induláskor onnan állítja vissza, futás közben 3 másodpercenként visszamásolja. Az első indításkor a `/config/env` (Secret `env` kulcsa) a mag, utána a PVC-n lévő példány az igazság. Újra-seedeléshez: `kubectl exec deploy/marveen -- rm /app/store/.env`, majd a pod újraindítása. A `WEB_HOST` alapból `0.0.0.0`-ra áll.

**Persistence.**

| Pod-beli útvonal | Volume | Tartalom |
|------------------|-------|----------|
| `/app/store` | `store` PVC | adatbázis, `.env`, dashboard token, `data/{.claude,agents,workspace,reports}` |
| `/home/node/.claude` | `claude-home` PVC | Claude-bejelentkezés, pluginok |

Az `/app/.claude` (Telegram token és párosítási allowlist), az `/app/agents`, a `workspace` és a `reports` symlink a `store/data/` alá, így a kód melletti runtime state is megmarad.

**Csatorna.** A Telegram plugin (`telegram@claude-plugins-official`) telepítését az entrypoint végzi a háttérben, ismétlésekkel; a `CHANNEL_PLUGIN` környezeti változóval másik plugin is megadható. A `channels.sh`-t a dashboard indítja (mentés után), nincs külön service supervisor.

## Korlátok

- Egyetlen replika; nincs HA és nincs skálázás.
- Pod-újraindításkor a tmux session-ök elvesznek, az ügynököket a meglévő recovery/auto-restart logika indítja újra.
- Az image-ben nincs `.git`, ezért a git-alapú update checker nem működik; frissíteni az image újraépítésével kell (`make -f deploy/Makefile up`).
- Tesztelve: arm64 (Apple Silicon) hoston. Az amd64 build nincs kipróbálva.
- Csak Linux-konténer: a macOS-es keychain és a launchd nincs benne, a hitelesítés OAuth-tokennel vagy a dashboard onboardingján megy.
