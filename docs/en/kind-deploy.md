# Kind / Docker / Helm: Marveen in a local Kubernetes cluster

## 🎯 What it means, why it matters

Marveen can be started with one command in a local [kind](https://kind.sigs.k8s.io/) cluster, isolated from the host: no `install.sh`, tmux, bun, python or Claude CLI on your machine, only Docker, kind, kubectl and helm. One pod runs, with a single published port (the dashboard, `127.0.0.1:3420`), and its state lives on PVCs, so it survives a pod restart.

This is not a scalable production setup: SQLite and tmux sessions make it a single replica (`Recreate` strategy, `ReadWriteOnce` volumes). It is meant for trying Marveen locally and for isolated test instances.

## Quick start

```bash
make -f deploy/Makefile up      # image build + kind cluster + helm install
kubectl exec deploy/marveen -- cat /app/store/.dashboard-token
# open: http://127.0.0.1:3420/?token=<the token above>
make -f deploy/Makefile down    # delete the cluster (PVCs included)
```

The pod does not print the dashboard token to its log (the stream is not a terminal), so read it from the file. After you sign in, onboarding walks you through Claude authentication and the channel (Telegram) setup.

With secrets (the `env` key of the Secret holds the content of a `.env`; it only seeds the first start):

```bash
kubectl create secret generic marveen-secrets --from-file=env=./kind.env
make -f deploy/Makefile deploy SECRET=marveen-secrets
```

## 🛠 How it works

| File | Role |
|------|------|
| `deploy/docker/Dockerfile` | Multi-stage build: `build` (tsc, `npm prune`) → `runtime` (`node:22-bookworm-slim`, non-root) |
| `deploy/docker/entrypoint.sh` | Prepares `.env` and the state directories, installs the channel plugin |
| `deploy/helm/marveen/` | Deployment (1 replica, `Recreate`), two PVCs, NodePort Service ([values](../../deploy/helm/marveen/README.md)) |
| `deploy/kind/kind-config.yaml` | Maps the node's port 30420 to the host's `127.0.0.1:3420` |
| `deploy/Makefile` | `up`, `cluster`, `image`, `load`, `deploy`, `down` |

**Image.** The runtime layer holds `tmux git sqlite3 lsof python3 unzip zstd tini`, the pinned Claude CLI (`ARG CLAUDE_CODE_VERSION`) and `bun` (the Telegram plugin runs on it). The build stage replaces the SDK's own `claude` binary with a link to the global CLI, so ~230 MB do not land in the layers twice. The runtime files travel in a single layer (`/out`). `tini` is PID 1 so the zombies of the tmux and Claude processes are reaped.

**`.env`.** The app reads its settings from `/app/.env` (so does `scripts/channels.sh`, with `grep`), ignores the process environment, and the dashboard writes it back (by atomic rename, so it cannot be a symlink or a file mount). The entrypoint therefore keeps the durable copy in `store/.env`: it restores from there at start and mirrors changes back every 3 seconds while running. On the very first start `/config/env` (the Secret's `env` key) is the seed; afterwards the copy on the PVC is the source of truth. To re-seed: `kubectl exec deploy/marveen -- rm /app/store/.env`, then restart the pod. `WEB_HOST` defaults to `0.0.0.0`.

**Persistent state.**

| Path in the pod | Volume | Content |
|-----------------|--------|---------|
| `/app/store` | `store` PVC | database, `.env`, dashboard token, `data/{.claude,agents,workspace,reports}` |
| `/home/node/.claude` | `claude-home` PVC | Claude login, plugins |

`/app/.claude` (the Telegram token and pairing allowlist), `/app/agents`, `workspace` and `reports` are symlinks into `store/data/`, so the runtime state that lives next to the code survives as well.

**Channel.** The entrypoint installs the Telegram plugin (`telegram@claude-plugins-official`) in the background, with retries; set the `CHANNEL_PLUGIN` environment variable for a different one. `channels.sh` is started by the dashboard (after you save), there is no separate service supervisor.

## Limits

- A single replica; no HA and no scaling.
- A pod restart loses the tmux sessions; the existing recovery/auto-restart logic brings the agents back.
- The image has no `.git`, so the git-based update checker does not work; update by rebuilding the image (`make -f deploy/Makefile up`).
- Tested on an arm64 (Apple Silicon) host. The amd64 build has not been tried.
- Linux containers only: no macOS keychain or launchd; authentication goes through an OAuth token or the dashboard onboarding.
