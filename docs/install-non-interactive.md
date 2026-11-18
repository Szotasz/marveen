# Non-interactive Linux install (`install-linux.sh --non-interactive`)

For scripted installs (a test VPS set up by an agent, a customer's provisioning script): the installer asks
nothing. Every answer comes from an environment variable or a documented default, secrets come only from files,
and anything missing stops the run before the first install step, naming the variable (exit code 1).

Linux only (`install-linux.sh`; `install.sh` passes the flag through on Linux). Without the flag the installer
behaves exactly as before: the same questions, the same output, the same files.

## Quick start

```bash
cd ~
git clone --branch main https://github.com/Szotasz/marveen.git
cd marveen

# 1. Claude auth: the token from `claude setup-token` (run on a machine with a browser)
mkdir -p store && install -m 600 /dev/null store/.claude-oauth-token
printf '%s\n' 'sk-ant-oat01-...' > store/.claude-oauth-token

# 2. The channel secret, in a file of its own (mode 600)
install -m 600 /dev/null ~/telegram-token
printf '%s\n' '123456789:AA...' > ~/telegram-token

# 3. Run
MARVEEN_OWNER_NAME="Teszt Elek" \
MARVEEN_CHANNEL=telegram \
MARVEEN_BOT_NAME=Marveen \
MARVEEN_TELEGRAM_TOKEN_FILE=~/telegram-token \
  bash install-linux.sh --non-interactive

# 4. The secret now lives where the installer wrote it: remove the copy
rm -f ~/telegram-token
```

Do not run the installer with shell tracing (`DEBUG=1`, `bash -x`) while it reads secrets: a trace prints variable values.

The run must start from a Marveen checkout (the directory with `package.json`); a standalone downloaded
`install-linux.sh` is refused in this mode, because the token has to be in the checkout's `store/` before the run.

## Requirements

| What | How |
|---|---|
| Claude auth | `store/.claude-oauth-token` in the checkout, pre-placed (mode 600). An install `.env` that already carries `CLAUDE_CODE_OAUTH_TOKEN=` or `ANTHROPIC_API_KEY=` counts too (the same check the services use). No token: the run stops. The auth questions are never asked. |
| sudo | The installer still calls `sudo` for packages, swap and the machine-wide channel settings. Run it as root over SSH, or as a user with passwordless sudo: a password prompt has no one to answer it. |

## Variables

### Required

| Variable | Value |
|---|---|
| `MARVEEN_OWNER_NAME` | Your name (one line). |
| `MARVEEN_CHANNEL` | `telegram`, `slack`, `discord`, `gromzo` or `teams`. |
| `MARVEEN_BOT_NAME` | The main agent's name (one line). |

### Per channel (required for that channel)

| Channel | Variable | Value |
|---|---|---|
| telegram | `MARVEEN_TELEGRAM_TOKEN_FILE` | Path of a file holding the BotFather token. |
| slack | `MARVEEN_SLACK_BOT_TOKEN_FILE` | Path of a file holding the bot token (`xoxb-...`). |
| slack | `MARVEEN_SLACK_APP_TOKEN_FILE` | Path of a file holding the app token (`xapp-...`). |
| discord | `MARVEEN_DISCORD_BOT_TOKEN_FILE` | Path of a file holding the bot token. |
| discord | `MARVEEN_DISCORD_CHANNEL_ID` | The channel ID. |
| discord | `MARVEEN_DISCORD_USER_ID` | Your (operator) user ID. |
| teams | `MARVEEN_TEAMS_BOT_APP_ID` | The Azure Bot's app (client) ID. |
| teams | `MARVEEN_TEAMS_BOT_TENANT_ID` | The tenant ID. |
| teams | `MARVEEN_TEAMS_BOT_APP_PASSWORD_FILE` | Path of a file holding the client secret. |
| gromzo | (none) | Connected later from the Marveen Bridge. |

### Optional (documented defaults)

| Question | Variable | Default |
|---|---|---|
| Language | `MARVEEN_LANG` (`hu` or `en`) | `hu` (with `install.sh`, the language question is skipped) |
| Dashboard port | `--port N` or `WEB_PORT` | `3420` |
| Create a 2 GB swap file (asked only below 2 GB RAM + swap) | `MARVEEN_SWAP` (`i`/`y` = yes, `n` = no) | yes, as Enter does |
| Install Whisper | `MARVEEN_WHISPER` (`i`/`y` = yes, `n` = no) | no, as Enter does |
| "VPS detected, continue?" (headless) | none | continue |
| Migrate an earlier system | none | no (run `scripts/migrate.sh` or the dashboard later) |
| Telegram pairing code | none | skipped: pair on the dashboard; the end of the run says so |
| Open Claude Code to diagnose a failure | none | no (the command is printed) |

## Secrets

- A secret is read from its file only: the first line, surrounding whitespace and a trailing CR cut (the same value a
  typed answer gives). It goes straight into the variable the interactive question fills, so it ends up exactly where
  an interactive install writes it, and nowhere else: it is not echoed, not logged, not copied.
- A secret given as an environment VALUE is refused, and the run stops before any step: `MARVEEN_TELEGRAM_TOKEN`,
  `MARVEEN_BOT_TOKEN`, `MARVEEN_SLACK_BOT_TOKEN`, `MARVEEN_SLACK_APP_TOKEN`, `MARVEEN_DISCORD_BOT_TOKEN`,
  `MARVEEN_TEAMS_BOT_APP_PASSWORD`, `MARVEEN_API_KEY`, `MARVEEN_OAUTH_TOKEN`. An env value is inherited by every
  process the installer starts and is readable in `/proc`; a file with mode 600 is not.
- A missing, unreadable or empty secret file is an error naming its variable.

## After the run

- The channel is not paired (no one is there to type a pairing code). Pair it on the dashboard, at the address the
  last line of the run prints.
- The dashboard token is in `store/.dashboard-token` (it is printed only to a terminal).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Installed. |
| 1 | A value is missing or invalid (the message names the variable), the token is missing, or an install step failed. |

## Not the Bridge's headless mode

The Marveen Bridge installs with its own, derived headless script and its own switch (`MARVEEN_NONINTERACTIVE=1` plus
`MARVEEN_*` presets). `--non-interactive` is separate: it is turned on only by the flag, never by an environment
variable, so the Bridge's runs are not affected, and the Bridge's switch does not turn this mode on.
