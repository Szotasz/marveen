# Running Marveen with Docker

Marveen runs as a single container with Docker Compose, with Ollama next to it for the semantic memory search. Everything you would answer in the installer (the owner, the agent's name, the Claude login, the chat channel and its pairing) you do in the dashboard's setup wizard after the first start.

## What you need

- A Linux server with Docker Engine and the Compose plugin (`docker compose version`), x86_64 or arm64.
  **Installing Docker:** on a fresh Ubuntu or Debian server, Docker's own install script sets up both (measured on Ubuntu 24.04):
  ```bash
  curl -fsSL https://get.docker.com -o get-docker.sh
  sudo sh get-docker.sh
  ```
  For other systems, follow [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
- **Size:** 2 vCPU and 8 GB RAM is the recommended size, with Ollama. Several Claude Code sessions run at the same time (the main agent, the heartbeat, every sub-agent). Without Ollama a smaller machine may do; measure it on yours.
- **Disk:** about 12 GB for the two images (Ollama's is about 8.5 GB of it, Marveen's about 3 GB) and about 1 GB for the data at the start. If you build the Marveen image yourself, add about 5 GB of build cache (measured on a clean Ubuntu 24.04 server).
- A Claude subscription. You log in with a token from `claude setup-token`.
- A bot for the chat channel you choose: Telegram (default), Discord or Slack.

## Start

```bash
git clone -b main https://github.com/Szotasz/marveen.git
cd marveen
docker compose up -d
docker compose logs marveen      # prints the dashboard link once it is up
```

`-b main` takes the released version: the guide and the compose file of the last release, which can be older than the page you are reading. Without it, `git clone` takes the development branch.

If the start stops with an error from the registry, the image cannot be downloaded:

- `not found`: no image has the tag you asked for. Image tags are plain versions, without a `v` (`1.50.0`, not `v1.50.0`); see `MARVEEN_VERSION` below.
- `denied`: the image cannot be downloaded from here (no access to it).

In both cases nothing is created. You can also [build the image yourself](#build-the-image-yourself).

**Choosing the channel and other settings:** the channel is chosen **before** the first start, with `MARVEEN_CHANNEL=telegram|discord|slack` in a `.env` file next to `docker-compose.yml` or in your shell. It is fixed for this install. Other optional settings:

- `MARVEEN_AGENT_ID`: the main agent's id, default `marveen`; also fixed.
- `MARVEEN_LANG`: `en` (default) or `hu`, the install's language: the agent's files and the dashboard. You can also switch it on the setup wizard's first screen (Magyar / English); see [The setup wizard](#the-setup-wizard).
- `TZ`: e.g. `Europe/Budapest`.
- `MARVEEN_VERSION`: the image tag, default `latest`. A release's tag is its version without a `v`, e.g. `1.50.0`.

## Open the dashboard

The dashboard listens on the server's `127.0.0.1:3420` only. Plain http on a public address would carry the login cookie and the access token unencrypted, so the compose file never publishes it there. Reach it in one of three ways:

- **Marveen Bridge:** connect it to the server.
- **SSH tunnel:** `ssh -L 3420:127.0.0.1:3420 <user>@<server>`, then open the link from `docker compose logs marveen` on your computer.
- **Your own domain with HTTPS:** point the domain's DNS at the server, then:
  ```bash
  MARVEEN_DOMAIN=marveen.example.com docker compose --profile tls up -d
  ```
  Caddy gets a certificate automatically and forwards to the dashboard. Open `https://marveen.example.com/`: before the dashboard password exists it asks for the one-time **setup code**, the `Marveen setup code` line in `docker compose logs marveen` (it works once, for 2 hours; `docker compose restart marveen` prints a new one). On the HTTPS address the dashboard accepts only the browser login: the access token, agent tokens and device keys work on `127.0.0.1:3420` only (the Bridge and an SSH tunnel keep using that). Only ports 80 and 443 open to the internet (Caddy's); the dashboard's 3420 stays on `127.0.0.1`. Caddy's config is written from `MARVEEN_DOMAIN` when it starts (HTTPS with HSTS, no referrer), so there is no file to edit. `COMPOSE_PROFILES=tls` in the environment does the same as `--profile tls`.

The link carries the install's access token. Set the dashboard password in the wizard's first step; after that you log in with it, and the token link is not needed.

## On a Hostinger VPS

Hostinger's Docker Manager deploys [`docker/hostinger-compose.yml`](../docker/hostinger-compose.yml), the file the "Deploy on Hostinger" button points at. It is the same Marveen and Ollama as `docker-compose.yml`, made for a panel that gets this one file and not the repository: a pinned Marveen version, no `build:`, and a default for every setting (the language is English unless you set `MARVEEN_LANG`).

- **HTTPS on the VPS's own name (optional):** set two environment variables for the project: `MARVEEN_DOMAIN` to the VPS's host name (Hostinger gives each VPS one, e.g. `srv123456.hstgr.cloud`, or use your own domain pointed at the VPS) and `COMPOSE_PROFILES=tls`. Caddy then gets a certificate and serves the dashboard at `https://<that name>`; only ports 80 and 443 open, 3420 stays on `127.0.0.1`. The first visit asks for the one-time setup code: the `Marveen setup code` line in **View logs**. Without these two variables nothing changes.

- **The dashboard link:** in Docker Manager, open the project's **⋮** menu and choose **View logs**; the link is in the `marveen` container's output.
- **Opening the dashboard:** it listens on the VPS's `127.0.0.1:3420` only, as above. Use the Marveen Bridge, or an SSH tunnel from your computer (Hostinger's Docker VPS template logs you in as `root`):
  ```bash
  ssh -L 3420:127.0.0.1:3420 root@<your VPS's IP>
  ```
  then open the link from the log on your computer.
- **Locked out (lost password or phone):** see [Locked out](#locked-out-lost-password-or-phone); on Hostinger with `docker exec -it <name>-marveen-1 ...` over SSH.

## The setup wizard

1. The dashboard password (the owner's login).
2. The owner's and the agent's names.
3. **Claude login.** Run `claude setup-token` on a computer with a browser, or in the container: `docker compose exec marveen claude setup-token`. Paste the token into the wizard. The wizard checks it before saving it.
4. The channel bot's token.
5. Pairing: message your bot, and approve the code in the dashboard.

The main agent starts as soon as the token is saved.

**The language:** the wizard's first screen has a Magyar / English switch. Before you have signed in it changes the wizard's text only; once you have signed in, it changes the install's language. The agent's files that you have not edited (`CLAUDE.md`, `SOUL.md`, the shipped skills and scheduled tasks) are written again in the new language. A file you edited is left as it is, and the wizard lists it. The switch works until the main agent first starts.

### After the wizard: the name rule of the outgoing-text check

Marveen checks the text of every outgoing message and e-mail before it leaves. One part of that check is yours to set up: the wrong spellings of names that must never go out (your own name, your company's). The rule lives in the install volume, in `/opt/marveen/store/outgoing-copy-gate-rules.json`, and no install creates it, because it names you. Until it exists, the check lets messages through without the name part and **warns on every send** that the name check did not run.

Create it, for example for the name Kovács that must never go out as Kovacs:

```bash
docker compose exec -T marveen sh -c 'umask 077; cat > /opt/marveen/store/outgoing-copy-gate-rules.json' <<'EOF'
{"bad_name_patterns": ["\\bKovacs\\b"], "correction": "The correct spelling is Kovács."}
EOF
```

`bad_name_patterns` is a list of Python regular expressions for the wrong forms; `correction` is the line the check shows next to a hit. A file that cannot be read as this shape stops outgoing e-mail until it is fixed, so check the JSON before you save it.

If you decide you need no name rule, say so in the file, and the warning stops: `{"bad_name_patterns": [], "no_name_rule": true, "no_name_rule_reason": "<why>"}`.

## Locked out: lost password or phone

The break-glass commands run inside the container, on the server (being on the machine is the proof). The image has no TypeScript runner, so they run with node, not `npm run`:

```bash
# the two-step sign-in off (lost phone and backup codes)
docker compose exec marveen node dist/dashboard-user-cli.js totp:off <username>
# a new dashboard password (asks for it twice)
docker compose exec marveen node dist/dashboard-user-cli.js reset-password <username>
# list the logins
docker compose exec marveen node dist/dashboard-user-cli.js list
```

On a Hostinger VPS there is no `docker compose` project folder of your own: log in with SSH, find the container with `docker ps` (its name ends in `-marveen-1`), and run the same command with `docker exec -it <that name> node dist/dashboard-user-cli.js ...`. Each command leaves an audit line and, when a channel is set up, tells the owner.

## What is where

| | |
|---|---|
| `marveen-install` volume (`/opt/marveen`) | The install: the code (copied from the image) and its state: `.env`, `store/` (the database, the tokens), `agents/`, `workspace/`, ... |
| `marveen-home` volume (`/home/marveen`) | Claude Code's own files: `~/.claude` (skills, scheduled tasks, hooks, the channel plugin), `~/.claude.json` |
| `ollama-models` volume | The Ollama models |
| The image | The code, the `claude` CLI and `bun` at a fixed version |

Back up the two `marveen-*` volumes. The Claude token and the bot tokens live in them.

## Update

```bash
docker compose pull
docker compose up -d
```

**What a new image changes:** a new image is a new Marveen version and a new `claude` CLI. On start, the container copies the new code into the install volume and checks every file against the image before anything runs; the state is not touched. The dashboard's update button and `update.sh` do nothing in a container, and they say so.

With an image you built yourself, `docker compose pull` cannot download it: update with `git pull`, then build it again as below.

## Build the image yourself

The compose file only downloads the image; it never builds one. To run your own build:

```bash
git clone -b main https://github.com/Szotasz/marveen.git
cd marveen
docker build -t ghcr.io/szotasz/marveen:latest --build-arg MARVEEN_COMMIT="$(git rev-parse HEAD)" .
docker compose up -d
```

`docker compose up -d` uses the image you built: it downloads only an image that is not on the server yet. The build takes about 5 GB of build cache on top of the image; `docker builder prune` frees it afterwards.

## Without Ollama

```bash
docker compose up -d marveen
```

The memory search falls back to full-text search. Set `MARVEEN_OLLAMA_URL=` (empty) so the dashboard does not look for it.

## Troubleshooting

### A download stops or times out on IPv6

**What you see:** the start (or `docker compose pull`) stops while it downloads a large image layer, with
`failed to copy: ... read: connection timed out`, and the address in the message is an IPv6 one (in square brackets).
It happens on servers whose IPv6 route drops long downloads.

**First:** run the same command again. The layers already downloaded are kept, and a second try often gets through.

**If it keeps stopping on IPv6:** let Docker prefer IPv4 for its downloads. IPv6 stays on; only the order in which the
addresses are tried changes. Both changes are needed: Docker does not read `/etc/gai.conf` on its own, the second file
makes it use the system's resolver, which does.

```bash
echo 'precedence ::ffff:0:0/96  100' | sudo tee -a /etc/gai.conf
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment=GODEBUG=netdns=cgo\n' | sudo tee /etc/systemd/system/docker.service.d/ipv4-first.conf
sudo systemctl daemon-reload
sudo systemctl restart docker
```

Then run the start command from [Start](#start) again. Restarting Docker restarts the Marveen containers; their data
stays in the volumes.

**Side effect:** the `/etc/gai.conf` line makes every program on this server prefer IPv4, not only Docker.

**To undo:**

```bash
sudo sed -i '/^precedence ::ffff:0:0\/96  100$/d' /etc/gai.conf
sudo rm /etc/systemd/system/docker.service.d/ipv4-first.conf
sudo systemctl daemon-reload
sudo systemctl restart docker
```

## Not in the container

- The Gromzo connection (it needs the host's root-only sockets).
- Speech-to-text with Whisper.
- The Bumblebee supply-chain scan.

Use the Linux installer if you need these.
