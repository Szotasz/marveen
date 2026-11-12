# Kind / Helm: Marveen in a local Kubernetes cluster

## 🎯 What it means, why it matters

Marveen can be started with one command in a local [kind](https://kind.sigs.k8s.io/) cluster, isolated from the host: no `install.sh`, tmux, bun, python or Claude CLI on your machine, only Docker, kind, kubectl and helm. One pod runs the [official Docker image](../docker.md), with a single published port (the dashboard, `127.0.0.1:3420`), and its state lives on PVCs, so it survives a pod restart.

This is not a scalable production setup: SQLite and tmux sessions make it a single replica (`Recreate` strategy, `ReadWriteOnce` volumes). It is meant for trying Marveen locally and for isolated test instances.

## Quick start

```bash
make -f deploy/Makefile up      # build the root Dockerfile + kind cluster + helm install
kubectl --context kind-marveen exec deploy/marveen -- cat /opt/marveen/store/.dashboard-token
# open: http://127.0.0.1:3420/?token=<the token above>
make -f deploy/Makefile down    # delete the cluster (PVCs included)
```

The first start takes a while (code sync, first-boot setup); the pod becomes ready when the dashboard answers. Set the dashboard password and finish the Claude login and the channel bot in the setup wizard, exactly as in [the Docker guide](../docker.md).

First-start settings (`MARVEEN_CHANNEL`, `MARVEEN_AGENT_ID`, `MARVEEN_LANG`, `TZ`) are plain chart values, fixed for the install (see [the Docker guide](../docker.md)):

```bash
helm --kube-context kind-marveen upgrade --install marveen deploy/helm/marveen \
  --set env.MARVEEN_CHANNEL=telegram --set env.MARVEEN_LANG=en --set env.TZ=Europe/Budapest
```

A token can come from a Secret, whose keys are injected as environment variables:

```bash
kubectl --context kind-marveen create secret generic marveen-secrets --from-literal=KEY=value
make -f deploy/Makefile deploy SECRET=marveen-secrets
```

## How it works

| File | Role |
|------|------|
| `Dockerfile` (repo root) | The official image; the chart does not build or pin anything of its own |
| `deploy/helm/marveen/` | Deployment (1 replica, `Recreate`), two PVCs, NodePort Service ([values](../../deploy/helm/marveen/README.md)) |
| `deploy/kind/kind-config.yaml` | Maps the node's port 30420 to the host's `127.0.0.1:3420` only |
| `deploy/Makefile` | `up`, `cluster`, `image`, `load`, `deploy`, `down` (all pinned to the `kind-marveen` context) |

**Volumes.** They follow the official layout and the image's user (uid 1000):

| Path in the pod | Volume | Content |
|-----------------|--------|---------|
| `/opt/marveen` | `install` PVC | the install: the code (copied from the image), `.env`, `store/` (database, tokens), agents, workspace |
| `/home/marveen` | `home` PVC | `~/.claude` (Claude login, plugins, skills), `~/.claude.json` |

**Image owns the version.** The image sets `MARVEEN_DEPLOYMENT=docker`, so the dashboard's update button and the in-container CLI update are off. A new image brings the new code and the new `claude` CLI (`docker/code-sync.py` copies it into the install volume on start).

**Readiness.** The probe runs the same `curl` check as the image's `HEALTHCHECK`, so a dashboard that listens but is not ready receives no traffic.

By default the chart uses `ghcr.io/szotasz/marveen:latest`; `make up` builds the root Dockerfile as `marveen:dev`, loads it into the cluster, and installs that.

## Limits

- Single replica; no HA and no scaling.
- A pod restart ends the tmux sessions; the existing recovery/auto-restart logic starts the agents again.
- Tested on arm64 (Apple Silicon); the amd64 build is covered by the official image's CI.
- Linux container only; the same exclusions as in [the Docker guide](../docker.md) apply (Gromzo connection, Whisper, Bumblebee scan).
