# Running Marveen with Docker

Marveen runs as a single container with Docker Compose, with Ollama next to it for the semantic memory search. Everything you would answer in the installer (the owner, the agent's name, the Claude login, the chat channel and its pairing) you do in the dashboard's setup wizard after the first start.

## What you need

- A Linux server with Docker Engine and the Compose plugin (`docker compose version`), x86_64 or arm64.
- **Size:** 2 vCPU and 8 GB RAM is the recommended size, with Ollama. Several Claude Code sessions run at the same time (the main agent, the heartbeat, every sub-agent). Without Ollama a smaller machine may do; measure it on yours.
- A Claude subscription. You log in with a token from `claude setup-token`.
- A bot for the chat channel you choose: Telegram (default), Discord or Slack.

## Start

<!-- DOCKERGUIDEBUILD1108 (decided before the release, owner, with the Tuesday promote): the image is not published
     yet (MARVEEN_PUBLISH_IMAGE is off), so "docker compose up -d" stops with "error from registry: denied" and does
     not build by itself (measured on a Hostinger VPS, HOSTINGERDOCKER1107). Either this step says "--build" or the
     image is published. Do not ship this step unchanged. -->
```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
docker compose up -d
docker compose logs marveen      # prints the dashboard link once it is up
```

**Choosing the channel and other settings:** the channel is chosen **before** the first start, with `MARVEEN_CHANNEL=telegram|discord|slack` in a `.env` file next to `docker-compose.yml` or in your shell. It is fixed for this install. Other optional settings:

- `MARVEEN_AGENT_ID`: the main agent's id, default `marveen`; also fixed.
- `MARVEEN_LANG`: `en` or `hu`.
- `TZ`: e.g. `Europe/Budapest`.
- `MARVEEN_VERSION`: the image tag, default `latest`.

## Open the dashboard

The dashboard listens on the server's `127.0.0.1:3420` only. Plain http on a public address would carry the login cookie and the access token unencrypted, so the compose file never publishes it there. Reach it in one of three ways:

- **Marveen Bridge:** connect it to the server.
- **SSH tunnel:** `ssh -L 3420:127.0.0.1:3420 <user>@<server>`, then open the link from `docker compose logs marveen` on your computer.
- **Your own domain with HTTPS:** point the domain's DNS at the server, then:
  ```bash
  MARVEEN_DOMAIN=marveen.example.com docker compose --profile tls up -d
  ```
  Caddy gets a certificate automatically and forwards to the dashboard. Open `https://marveen.example.com/?token=...`, using the token from the log.

The link carries the install's access token. Set the dashboard password in the wizard's first step; after that you log in with it, and the token link is not needed.

## The setup wizard

1. The dashboard password (the owner's login).
2. The owner's and the agent's names.
3. **Claude login.** Run `claude setup-token` on a computer with a browser, or in the container: `docker compose exec marveen claude setup-token`. Paste the token into the wizard. The wizard checks it before saving it.
4. The channel bot's token.
5. Pairing: message your bot, and approve the code in the dashboard.

The main agent starts as soon as the token is saved.

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
