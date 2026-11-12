# Kind / Helm: Marveen egy lokális Kubernetes cluster-ben

## 🎯 Mit tud, miért érdekes

A Marveen egyetlen paranccsal elindítható egy lokális [kind](https://kind.sigs.k8s.io/) cluster-ben, a hosttól elszigetelve: nem kell hozzá `install.sh`, tmux, bun, python vagy Claude CLI a gépeden, csak Docker, kind, kubectl és helm. Egy pod fut a [hivatalos Docker image-gel](docker.md), egyetlen kifelé publikált porttal (a dashboard, `127.0.0.1:3420`), az állapot pedig PVC-ken él, ezért pod-újraindítás után is megmarad.

Ez nem skálázható éles üzem: az SQLite és a tmux session-ök miatt egyetlen replikáról van szó (`Recreate` strategy, `ReadWriteOnce` volume-ok). Lokális kipróbálásra, izolált test instance-ra való.

## Gyorsindítás

```bash
kind create cluster --config deploy/kind/kind-config.yaml
helm --kube-context kind-marveen upgrade --install marveen deploy/helm/marveen
kubectl --context kind-marveen exec deploy/marveen -- cat /opt/marveen/store/.dashboard-token
# nyisd meg: http://127.0.0.1:3420/?token=<a fenti token>
kind delete cluster --name marveen    # cluster törlése (a PVC-kkel együtt)
```

Az első indítás eltart egy ideig (kód-szinkron, first-boot beállítás); a pod akkor lesz ready, amikor a dashboard válaszol. A dashboard jelszavát, a Claude-bejelentkezést és a csatorna botját a beállító varázslóban adod meg, ugyanúgy, mint [a Docker útmutatóban](docker.md).

Az első indítás beállításai (`MARVEEN_CHANNEL`, `MARVEEN_AGENT_ID`, `MARVEEN_LANG`, `TZ`) sima chart értékek, és az install élettartamára rögzülnek (lásd [a Docker útmutatót](docker.md)):

```bash
helm --kube-context kind-marveen upgrade --install marveen deploy/helm/marveen \
  --set env.MARVEEN_CHANNEL=telegram --set env.MARVEEN_LANG=hu --set env.TZ=Europe/Budapest
```

A token Secretből is jöhet, annak kulcsai környezeti változóként kerülnek a konténerbe:

```bash
kubectl --context kind-marveen create secret generic marveen-secrets --from-literal=KEY=value
helm --kube-context kind-marveen upgrade --install marveen deploy/helm/marveen --set existingSecret=marveen-secrets
```

## 🛠 Hogyan működik

| Fájl | Szerep |
|------|--------|
| `Dockerfile` (a repo gyökerében) | A hivatalos image; a chart nem épít és nem pinel semmit a sajátjából |
| `deploy/helm/marveen/` | Deployment (1 replika, `Recreate`), két PVC, NodePort Service ([értékek](../deploy/helm/marveen/README.md)) |
| `deploy/kind/kind-config.yaml` | A node 30420-as portját csak a host `127.0.0.1:3420`-ra képezi |

**Volume-ok.** A hivatalos elrendezést és az image felhasználóját (uid 1000) követik:

| Pod-beli útvonal | Volume | Tartalom |
|------------------|--------|----------|
| `/opt/marveen` | `install` PVC | az install: a kód (az image-ből másolva), `.env`, `store/` (adatbázis, tokenek), agents, workspace |
| `/home/marveen` | `home` PVC | `~/.claude` (Claude-bejelentkezés, pluginok, skillek), `~/.claude.json` |

**A verziót az image adja.** Az image beállítja a `MARVEEN_DEPLOYMENT=docker`-t, ezért a dashboard frissítés gombja és a konténeren belüli CLI-frissítés ki van kapcsolva. Az új image hozza az új kódot és az új `claude` CLI-t (a `docker/code-sync.py` indításkor átmásolja az install volume-ba).

**Readiness.** A próba ugyanazt a `curl` ellenőrzést futtatja, mint az image `HEALTHCHECK`-je, így a hallgatózó, de még nem kész dashboard nem kap forgalmat.

A chart a `ghcr.io/szotasz/marveen:latest` image-et használja. Ha a saját, még nem publikált kódodat akarod kipróbálni, építsd meg a gyökér Dockerfile-lal, töltsd be a cluster-be, és add meg a chartnak:

```bash
docker build -t marveen:dev .
kind load docker-image marveen:dev --name marveen
helm --kube-context kind-marveen upgrade --install marveen deploy/helm/marveen --set image.repository=marveen --set image.tag=dev
```

## Korlátok

- Egyetlen replika; nincs HA és nincs skálázás.
- Pod-újraindításkor a tmux session-ök elvesznek, az ügynököket a meglévő recovery/auto-restart logika indítja újra.
- Tesztelve: arm64 (Apple Silicon) hoston; az amd64 build a hivatalos image CI-jában is lefut.
- Csak Linux-konténer; ugyanazok a kivételek érvényesek, mint [a Docker útmutatóban](docker.md) (Gromzo kapcsolat, Whisper, Bumblebee scan).
