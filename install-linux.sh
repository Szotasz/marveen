#!/bin/bash
# Marveen - AI Team Setup
# Interactive installer for Linux (Ubuntu/Debian)

set -e
[ "${DEBUG:-0}" = "1" ] && set -x

# Ha a terminal tipusa ismeretlen (pl. xterm-ghostty), visszaesunk xterm-256color-ra
if ! tput longname &>/dev/null 2>&1; then
  export TERM=xterm-256color
fi

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${ORANGE}!${NC} $*"; }

INSTALL_STEP="init"

offer_claude_fallback() {
  local step="$1" err_msg="$2" line_info="${3:+:$3}"
  if ! command -v claude &>/dev/null; then
    return
  fi
  echo ""
  echo -e "${ORANGE}Claude Code elerheto a gepen.${NC}"
  local prompt="Marveen installer failed at step \"${step}\". Error: ${err_msg}. Script: install-linux.sh${line_info}. Repo: https://github.com/Szotasz/marveen. OS: $(lsb_release -ds 2>/dev/null || cat /etc/os-release 2>/dev/null | head -1 || echo Linux). Node: $(node -v 2>/dev/null || echo missing). Dir: ${INSTALL_DIR}. Your task: diagnose this Marveen installer failure. The install scripts are install.sh (macOS) and install-linux.sh. Read the relevant section, check for missing dependencies or permission issues, and suggest concrete shell commands to fix."
  if [ -t 0 ]; then
    read -p "  Megnyissam Claude Code-ot a hiba diagnosztizalasahoz? (i/n) [n]: " OPEN_CLAUDE
    OPEN_CLAUDE=${OPEN_CLAUDE:-n}
    if [ "$OPEN_CLAUDE" = "i" ]; then
      claude --prompt "$prompt"
      return
    fi
  fi
  echo -e "  ${DIM}Futtasd manualisan:${NC}"
  echo -e "  ${DIM}claude --prompt \"$(echo "$prompt" | sed 's/"/\\"/g')\"${NC}"
}

fail() {
  echo -e "  ${RED}✗${NC} $*"
  offer_claude_fallback "$INSTALL_STEP" "$*" "${BASH_LINENO[0]}"
  exit 1
}

on_error() {
  echo ""
  echo -e "${RED}Varatlan hiba a(z) '${INSTALL_STEP}' lepesben (sor: $1).${NC}"
  offer_claude_fallback "$INSTALL_STEP" "Unexpected error at line $1" "$1"
  exit 1
}
trap 'on_error $LINENO' ERR

# Ha a <marker> szoveg nem talalhato az rc fajlban, hozzaadja a <sort>.
# Mindket fajlt kezeli (.bashrc, .zshrc) ha leteznek.
# Hasznalat: ensure_in_rc "keres_minta" "hozzaadando sor"
ensure_in_rc() {
  local marker="$1" line="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '%s\n' "$line" >>"$rc"
    warn "RC frissitve ($(basename "$rc")): $line"
  done
}

# Tobbsoros blokkot ad az rc fajlokhoz ha a <marker> meg nem szerepel bennuk.
# Hasznalat: ensure_block_in_rc "marker" "$BLOKK_VALTOZO"
ensure_block_in_rc() {
  local marker="$1" block="$2"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    grep -qF "$marker" "$rc" 2>/dev/null && continue
    printf '\n%s\n' "$block" >>"$rc"
    warn "RC blokk hozzaadva ($(basename "$rc")): $marker"
  done
}

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

clear
echo ""
echo -e "${BOLD}  ▐▛███▜▌   Marveen${NC}"
echo -e "${BOLD} ▝▜█████▛▘  AI csapatod, ami fut amig te alszol.${NC}"
echo -e "${DIM}   ▘▘ ▝▝${NC}"
echo ""
echo -e "${DIM}  Telepito wizard - Linux (Ubuntu/Debian)${NC}"
echo ""

INSTALL_STEP="prerequisites"
# ─────────────────────────────────────────────
# [1/7] Elofeltetelek
# ─────────────────────────────────────────────
echo -e "${BOLD}[1/7] Elofeltetelek ellenorzese...${NC}"

if ! command -v apt-get &>/dev/null; then
  fail "Ez a telepito csak Ubuntu/Debian rendszeren fut (apt-get szukseges)"
fi

# RAM check: npm build can fail on low-memory instances (e.g. t3.micro)
if command -v free &>/dev/null; then
  TOTAL_RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
  TOTAL_SWAP_MB=$(free -m | awk '/^Swap:/ {print $2}')
  TOTAL_AVAIL=$((TOTAL_RAM_MB + TOTAL_SWAP_MB))
  if [ "$TOTAL_AVAIL" -lt 2048 ]; then
    warn "Kevés memória: ${TOTAL_RAM_MB} MB RAM + ${TOTAL_SWAP_MB} MB swap = ${TOTAL_AVAIL} MB"
    echo -e "  ${ORANGE}Az npm build legalabb 2 GB memoriat igenyel.${NC}"
    if [ "$TOTAL_SWAP_MB" -lt 1024 ]; then
      read -p "  Letrehozzak 2 GB swap fajlt? (i/n) [i]: " CREATE_SWAP
      CREATE_SWAP=${CREATE_SWAP:-i}
      if [ "$CREATE_SWAP" = "i" ]; then
        echo -e "  Swap letrehozasa (sudo szukseges)..."
        sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
        if swapon --show | grep -q '/swapfile'; then
          ok "2 GB swap aktivalva"
          if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
            ok "Swap hozzaadva az /etc/fstab-hoz (ujrainditas utan is megmarad)"
          fi
        else
          warn "Swap letrehozas sikertelen. A build elbukthat."
        fi
      else
        warn "Swap kihagyva. Ha a build elbukik, futtasd: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
      fi
    fi
  else
    ok "Memoria: ${TOTAL_RAM_MB} MB RAM + ${TOTAL_SWAP_MB} MB swap"
  fi
fi

MISSING_PKGS=""
for pkg in ffmpeg git tmux lsof curl python3 pipx unzip; do
  if ! command -v "$pkg" &>/dev/null; then
    MISSING_PKGS="$MISSING_PKGS $pkg"
  fi
done

# Node.js v20+ ellenorzes
NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo "0")
  [ "$NODE_VER" -ge 20 ] && NODE_OK=true
fi
$NODE_OK || MISSING_PKGS="$MISSING_PKGS nodejs"

if [ -n "$MISSING_PKGS" ]; then
  warn "Hianyzo csomagok:$MISSING_PKGS"
  echo -e "  Telepites sudo-val..."
  if echo "$MISSING_PKGS" | grep -q nodejs; then
    echo -e "  Node.js v22 repo hozzaadasa (nodesource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  else
    sudo apt-get update -qq
  fi
  # shellcheck disable=SC2086
  sudo apt-get install -y $MISSING_PKGS -qq
fi

hash -r

# Ellenorzes: node es npm tenyleg elerheto-e
command -v node &>/dev/null || fail "Node.js telepitese sikertelen. Ellenorizd: sudo apt-get install nodejs"
command -v npm &>/dev/null || fail "npm nem talalhato a nodejs csomag utan sem. Ellenorizd: dpkg -l nodejs"

ok "ffmpeg $(ffmpeg -version | awk 'NR==1 {print $3}')"
ok "git $(git --version | awk '{print $3}')"
ok "lsof $(lsof -v 2>&1 | awk '/^    revision:/ {print $2}')"
ok "node $(node --version)"
ok "npm $(npm --version)"
ok "pipx" $(pipx --version)
ok "python3 $(python3 --version | awk '{print $2}')"
ok "tmux $(tmux -V | awk '{print $2}')"
ok "unzip" $(unzip -v | awk 'NR==1 {print $2}')

INSTALL_STEP="claude-bun-install"
# ─────────────────────────────────────────────
# [2/7] Claude Code + Bun telepitese
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[2/7] Claude Code + Bun telepitese...${NC}"

# ~/.local/bin eloszor, hogy a claude check mar jo PATH-on fusson
ensure_in_rc '.local/bin' 'export PATH="$HOME/.local/bin:$PATH"'
export PATH="$HOME/.local/bin:$PATH"

if command -v claude &>/dev/null; then
  ok "claude mar telepitve: $(claude --version 2>/dev/null || echo 'ok')"
else
  echo -e "  Claude Code telepitese (~/.local/bin)..."
  curl -fsSL https://claude.ai/install.sh | bash
  hash -r
  ok "claude telepitve -> ~/.local/bin/claude"
fi

# Linuxbrew (ha telepitve van)
if [ -x "/home/linuxbrew/.linuxbrew/bin/brew" ]; then
  ensure_in_rc 'linuxbrew' 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"'
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
  ok "Linuxbrew PATH beallitva"
fi

# XDG_RUNTIME_DIR + DBUS: headless szerveren automatikusan beallitjuk
# (detektalas: nincs DISPLAY es nincs WAYLAND_DISPLAY)
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  XDG_BLOCK='# marveen-user-bus: XDG_RUNTIME_DIR + DBUS headless szerveren
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi'
  ensure_block_in_rc 'marveen-user-bus' "$XDG_BLOCK"
  # Aktivaljuk az aktualis sessionban is
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ] && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi
  ok "XDG_RUNTIME_DIR / DBUS beallitva (headless)"
fi

# Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if command -v bun &>/dev/null; then
  ok "bun mar telepitve: $(bun --version)"
else
  echo -e "  Bun telepitese (Telegram plugin fuggoseg)..."
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  if ! command -v bun &>/dev/null; then
    echo -e "  ${RED}✗${NC} Bun telepites sikertelen. Probalj manualisan: curl -fsSL https://bun.sh/install | bash"
  else
    ok "bun telepitve"
  fi
fi
ensure_in_rc 'BUN_INSTALL' 'export BUN_INSTALL="$HOME/.bun"'
ensure_in_rc '.bun/bin' 'export PATH="$BUN_INSTALL/bin:$PATH"'

INSTALL_STEP="claude-auth"
# ─────────────────────────────────────────────
# [3/7] Claude bejelentkezes
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[3/7] Claude bejelentkezes${NC}"

IS_HEADLESS=false
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  IS_HEADLESS=true
fi

if claude auth status &>/dev/null; then
  ok "Claude mar be van jelentkezve"
else
  echo -e "  ${ORANGE}Nincs aktiv Claude bejelentkezes.${NC}"
  if [ "$IS_HEADLESS" = "true" ]; then
    echo ""
    echo -e "  ${BLUE}Headless szerver detektalva (nincs DISPLAY).${NC}"
    echo -e "  ${BLUE}Bongeszo-alapu bejelentkezes nem lehetseges.${NC}"
    echo -e "  ${BOLD}Ajanlott: OAuth token (2) vagy API key (1).${NC}"
    echo ""
  fi
  echo ""
  echo -e "  Valassz bejelentkezesi modot:"
  echo -e "  ${BOLD}1.${NC} API key ${DIM}(Anthropic Console -> fizeteses/pay-as-you-go)${NC}"
  echo -e "  ${BOLD}2.${NC} OAuth token ${DIM}(Pro/Max elofizetes - tokennel egy masik geprol)${NC}"
  echo -e "  ${BOLD}3.${NC} Kihagyas ${DIM}(kesobb allitod be)${NC}"
  echo ""
  if [ "$IS_HEADLESS" = "true" ]; then
    read -p "  Valasztas (1/2/3) [2]: " AUTH_MODE
    AUTH_MODE=${AUTH_MODE:-2}
  else
    read -p "  Valasztas (1/2/3) [3]: " AUTH_MODE
    AUTH_MODE=${AUTH_MODE:-3}
  fi

  if [ "$AUTH_MODE" = "1" ]; then
    echo ""
    echo -e "  ${DIM}API kulcsot itt talalod: https://console.anthropic.com/settings/keys${NC}"
    read -p "  ANTHROPIC_API_KEY (sk-ant-...): " ANTHROPIC_API_KEY_INPUT
    if [ -n "$ANTHROPIC_API_KEY_INPUT" ]; then
      export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY_INPUT"
      ensure_in_rc 'ANTHROPIC_API_KEY' "export ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY_INPUT\""
      ok "ANTHROPIC_API_KEY beallitva"
    else
      warn "API key nem lett megadva, kihagyas."
    fi

  elif [ "$AUTH_MODE" = "2" ]; then
    echo ""
    echo -e "  ${ORANGE}Lepesek egy boengeszos gepen:${NC}"
    echo -e "  ${BOLD}1.${NC} Nyiss egy terminalt egy olyan gepen ahol van bongeszo"
    echo -e "  ${BOLD}2.${NC} Futtasd: ${BLUE}claude setup-token${NC}"
    echo -e "  ${BOLD}3.${NC} A bongeszo megnyilik, jelentkezz be a Claude fiokoddal"
    echo -e "  ${BOLD}4.${NC} Masold vissza ide a kiirt tokent:"
    echo ""
    read -p "  OAuth token: " OAUTH_TOKEN_INPUT
    if [ -n "$OAUTH_TOKEN_INPUT" ]; then
      export CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN_INPUT"
      ensure_in_rc 'CLAUDE_CODE_OAUTH_TOKEN' "export CLAUDE_CODE_OAUTH_TOKEN=\"$OAUTH_TOKEN_INPUT\""
      # Ellenorzes
      if claude auth status &>/dev/null; then
        ok "OAuth token elfogadva, bejelentkezes sikeres"
      else
        warn "Token beallitva, de az ellenorzes sikertelen -- ellenorizd a tokent."
      fi
    else
      warn "Token nem lett megadva, kihagyas."
    fi

  else
    echo -e "  ${DIM}Kihagyva. Kesobb allitsd be:${NC}"
    echo -e "  ${DIM}  export ANTHROPIC_API_KEY=sk-ant-...${NC}"
    echo -e "  ${DIM}  vagy: claude setup-token (boengeszos gepen), majd export CLAUDE_CODE_OAUTH_TOKEN=...${NC}"
  fi
fi

# Mark the Claude Code first-run wizard as completed so the tmux-spawned
# `claude --channels ...` process doesn't stop on the theme picker and
# block the Telegram plugin from ever initializing.
mkdir -p "$HOME/.claude"
python3 - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.path.expanduser("~/.claude.json"))
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        data = {}
data["hasCompletedOnboarding"] = True
if not data.get("theme"):
    data["theme"] = "dark"
p.write_text(json.dumps(data, indent=2))
try:
    os.chmod(p, 0o600)
except Exception:
    pass
PYEOF

# Pre-accept the --dangerously-skip-permissions confirmation dialog so the
# headless `claude --channels ...` session in scripts/channels.sh doesn't
# park on it forever (the dialog needs interactive Enter and there's no TTY
# attached). Claude Code maintains this flag itself once accepted manually,
# but we have to seed it before the first systemd-spawned session.
python3 - <<'PYEOF'
import json, os, pathlib
p = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        data = {}
data["skipDangerousModePermissionPrompt"] = True
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(data, indent=2))
try:
    os.chmod(p, 0o600)
except Exception:
    pass
PYEOF
echo -e "  ${GREEN}✓${NC} Claude Code first-run beallitas kesz"

INSTALL_STEP="personal-info"
# ─────────────────────────────────────────────
# [4/7] Szemelyes beallitasok
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4/7] Szemelyes beallitasok${NC}"
read -p "  Mi a neved? " OWNER_NAME
# Chat ID is NOT asked here -- the user doesn't know it yet.
# It will be set automatically during the Telegram pairing flow.
CHAT_ID="0"

# VPS/cloud MCP warning (headless only)
if [ "$IS_HEADLESS" = "true" ]; then
  echo ""
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${ORANGE}  FIGYELEM: VPS / cloud szerver detektalva${NC}"
  echo -e "${ORANGE}  Ha a claude.ai fiokodban sok MCP connector van${NC}"
  echo -e "${ORANGE}  engedelyezve, a headless session megprobalja betolteni${NC}"
  echo -e "${ORANGE}  mindet, ami instabilitast okozhat.${NC}"
  echo ""
  echo -e "  ${BOLD}Javasoljuk:${NC} lepj be a claude.ai Settings oldalara es"
  echo -e "  tiltsd le a felesleges MCP-ket telepites elott."
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  read -p "  Folytassam a telepitést? (i/n) [i]: " CONTINUE_MCP
  CONTINUE_MCP=${CONTINUE_MCP:-i}
  if [ "$CONTINUE_MCP" != "i" ]; then
    echo -e "  ${DIM}Telepites megszakitva. Tiltsd le a felesleges MCP-ket, majd futtasd ujra.${NC}"
    exit 0
  fi
fi

# Channel provider setup
echo ""
echo -e "${BOLD}  Csatorna beallitas${NC}"
echo -e "${DIM}  Melyik csatornan kommunikaljon az AI asszisztensed?${NC}"
echo -e "  ${BOLD}1.${NC} Telegram (alapertelmezett)"
echo -e "  ${BOLD}2.${NC} Slack"
echo ""
read -p "  Valassz (1/2) [1]: " PROVIDER_CHOICE
PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}
if [ "$PROVIDER_CHOICE" = "2" ]; then
  CHANNEL_PROVIDER="slack"
else
  CHANNEL_PROVIDER="telegram"
fi
ok "Csatorna: $CHANNEL_PROVIDER"

BOT_TOKEN=""
SLACK_BOT_TOKEN=""
SLACK_APP_TOKEN=""

if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Telegramon kommunikal veled.${NC}"
  echo -e "${DIM}  1. Nyisd meg a @BotFather-t a Telegramban${NC}"
  echo -e "${DIM}  2. Ird be: /newbot${NC}"
  echo -e "${DIM}  3. Adj nevet a botodnak${NC}"
  echo -e "${DIM}  4. Masold ide a kapott tokent:${NC}"
  echo ""
  read -p "  Telegram bot token (vagy hagyd uresen, kesobb is beallithatod): " BOT_TOKEN
else
  echo ""
  echo -e "${DIM}  Az AI asszisztensed Slack-en kommunikal veled.${NC}"
  echo -e "${DIM}  1. Hozz letre egy Slack App-ot: api.slack.com/apps${NC}"
  echo -e "${DIM}  2. Engedeld a Socket Mode-ot${NC}"
  echo -e "${DIM}  3. OAuth & Permissions > Bot Token Scopes:${NC}"
  echo -e "${DIM}     app_mentions:read, channels:history, channels:join,${NC}"
  echo -e "${DIM}     channels:read, chat:write, files:read, files:write,${NC}"
  echo -e "${DIM}     groups:history, im:history, reactions:write, users:read${NC}"
  echo -e "${DIM}  4. Event Subscriptions > Bot Events:${NC}"
  echo -e "${DIM}     app_mention, message.channels, message.groups, message.im${NC}"
  echo -e "${DIM}  5. Installald a workspace-be${NC}"
  echo ""
  read -p "  Bot Token (xoxb-...): " SLACK_BOT_TOKEN
  read -p "  App-Level Token (xapp-...): " SLACK_APP_TOKEN
fi

read -p "  Mi legyen a botod neve? [Marveen]: " BOT_NAME
BOT_NAME=${BOT_NAME:-"Marveen"}

# Derive the ASCII slug the backend uses everywhere (tmux sessions, systemd
# unit labels, DB agent_id, API routing). NFKD + ASCII + lowercase dashes,
# empty fallback to "marveen" so we never end up with a blank identifier.
MAIN_AGENT_ID=$(python3 - "$BOT_NAME" <<'PYEOF'
import sys, unicodedata, re
s = sys.argv[1].strip()
s = unicodedata.normalize('NFKD', s).encode('ASCII', 'ignore').decode()
s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
print(s or 'marveen')
PYEOF
)
if [ "$MAIN_AGENT_ID" != "marveen" ]; then
  echo -e "  ${DIM}Ügynök belső azonosító: ${MAIN_AGENT_ID}${NC}"
fi

INSTALL_STEP="npm-install"
# ─────────────────────────────────────────────
# [5/7] Fuggosegek telepitese + konfiguracic
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[5/7] Fuggosegek telepitese...${NC}"
cd "$INSTALL_DIR"

echo -e "  npm install..."
if ! (npm ci --loglevel warn 2>/dev/null || npm install --loglevel warn); then
  fail "npm install sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "npm csomagok telepitve"

INSTALL_STEP="typescript-build"
echo -e "  TypeScript forditas..."
if ! npm run build --loglevel warn; then
  fail "TypeScript forditas sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "TypeScript leforditva"

mkdir -p "$INSTALL_DIR/store"
mkdir -p "$INSTALL_DIR/agents"
ok "Konyvtarak letrehozva"

INSTALL_STEP="configuration"
# .env letrehozasa
echo ""
echo -e "${BOLD}  Konfiguracio letrehozasa...${NC}"

(
  umask 077 && cat >"$INSTALL_DIR/.env" <<ENVEOF
# Main agent konfiguracio
CHANNEL_PROVIDER=${CHANNEL_PROVIDER}
OWNER_NAME=${OWNER_NAME}
BOT_NAME=${BOT_NAME}
MAIN_AGENT_ID=${MAIN_AGENT_ID}
ENVEOF
)
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  echo "TELEGRAM_BOT_TOKEN=${BOT_TOKEN}" >> "$INSTALL_DIR/.env"
  echo "ALLOWED_CHAT_ID=${CHAT_ID}" >> "$INSTALL_DIR/.env"
else
  echo "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}" >> "$INSTALL_DIR/.env"
  echo "SLACK_APP_TOKEN=${SLACK_APP_TOKEN}" >> "$INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"
ok ".env letrehozva (chmod 600)"

# CLAUDE.md generalasa template-bol
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
    -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
    -e "s/{{CHAT_ID}}/$CHAT_ID/g" \
    -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
    -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
    "$INSTALL_DIR/templates/CLAUDE.md.template" >"$INSTALL_DIR/CLAUDE.md"
  ok "CLAUDE.md generalva"
else
  warn "CLAUDE.md.template nem talalhato, CLAUDE.md nem generalhato"
fi

# SOUL.md generalasa template-bol (personality definition for the main agent).
if [ -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
      -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
      "$INSTALL_DIR/templates/SOUL.md.template" > "$INSTALL_DIR/SOUL.md"
  ok "SOUL.md generalva"
elif [ ! -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  warn "SOUL.md.template nem talalhato, SOUL.md nem generalhato"
fi

# Default scheduled tasks scaffoldolasa ~/.claude/scheduled-tasks/ ala. A
# template-ek {{MAIN_AGENT_ID}} placeholdert hasznalnak, igy a felhasznalo
# valasztott agent slugja kerul be a hardcoded "marveen" helyett. Letezo task
# konyvtarakat soha nem irjuk felul.
SCHED_TPL_DIR="$INSTALL_DIR/templates/scheduled-tasks"
SCHED_TARGET_DIR="$HOME/.claude/scheduled-tasks"
if [ -d "$SCHED_TPL_DIR" ]; then
  mkdir -p "$SCHED_TARGET_DIR"
  for tpl in "$SCHED_TPL_DIR"/*/; do
    [ -d "$tpl" ] || continue
    task_name=$(basename "$tpl")
    target="$SCHED_TARGET_DIR/$task_name"
    if [ -d "$target" ]; then
      continue
    fi
    mkdir -p "$target"
    for f in "$tpl"*; do
      [ -f "$f" ] || continue
      sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
          -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
          -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
          -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
          "$f" > "$target/$(basename "$f")"
    done
    ok "Utemezett feladat scaffoldolva: $task_name"
  done
fi

# Seed scheduled tasks: from seed-scheduled-tasks/ into ~/.claude/scheduled-tasks/
# Idempotent: skip directories that already exist. Templates use {{MAIN_AGENT_ID}},
# {{BOT_NAME}}, {{OWNER_NAME}}, {{INSTALL_DIR}} placeholders.
SEED_SCHED_DIR="$INSTALL_DIR/seed-scheduled-tasks"
if [ -d "$SEED_SCHED_DIR" ]; then
  mkdir -p "$SCHED_TARGET_DIR"
  SCHED_NEW=0
  SCHED_SKIP=0
  for tpl in "$SEED_SCHED_DIR"/*/; do
    [ -d "$tpl" ] || continue
    task_name=$(basename "$tpl")
    [[ "$task_name" == "bumblebee-hygiene-scan" ]] && continue
    target="$SCHED_TARGET_DIR/$task_name"
    if [ -d "$target" ]; then
      SCHED_SKIP=$((SCHED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    for f in "$tpl"*; do
      [ -f "$f" ] || continue
      sed -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
          -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
          -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
          -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
          "$f" > "$target/$(basename "$f")"
    done
    SCHED_NEW=$((SCHED_NEW + 1))
  done
  if [ "$SCHED_NEW" -gt 0 ] || [ "$SCHED_SKIP" -gt 0 ]; then
    ok "Seed scheduled tasks: ${SCHED_NEW} uj, ${SCHED_SKIP} kihagyva"
  fi
  if [ "$SCHED_NEW" -gt 0 ]; then
    STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
    if [ ! -f "$STATE_FILE" ]; then
      echo '{"last_audit_at":null}' > "$STATE_FILE"
      ok "kanban-audit state inicializalva"
    fi
  fi
fi

# Seed bumblebee threat-intel catalogs into ~/.claude/tools/
BB_SEED_TI="$INSTALL_DIR/seed-scheduled-tasks/bumblebee-hygiene-scan/threat-intel"
BB_TARGET_TI="$HOME/.claude/tools/bumblebee-threat-intel"
if [ -d "$BB_SEED_TI" ] && [ ! -d "$BB_TARGET_TI" ]; then
  mkdir -p "$BB_TARGET_TI"
  cp "$BB_SEED_TI"/*.json "$BB_TARGET_TI/" 2>/dev/null
  ok "Bumblebee threat-intel katalogusok telepitve"
fi

# Seed config: copy default config files into store/ (idempotent: never overwrite)
SEED_CONFIG_DIR="$INSTALL_DIR/seed-config"
if [ -d "$SEED_CONFIG_DIR" ]; then
  for cfg in "$SEED_CONFIG_DIR"/*.json; do
    [ -f "$cfg" ] || continue
    cfg_name=$(basename "$cfg")
    target="$INSTALL_DIR/store/$cfg_name"
    if [ ! -f "$target" ]; then
      cp "$cfg" "$target"
      ok "Seed config: $cfg_name"
    fi
  done
fi

# Channel state directory setup
CHANNEL_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"
mkdir -p "$CHANNEL_DIR"

if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  (umask 077 && echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" >"$CHANNEL_DIR/.env")
  chmod 600 "$CHANNEL_DIR/.env"
  cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  ok "Telegram csatorna konfigurálva"
elif [ "$CHANNEL_PROVIDER" = "slack" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  (umask 077 && cat >"$CHANNEL_DIR/.env" <<SLACKENVEOF
SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN
SLACK_APP_TOKEN=$SLACK_APP_TOKEN
SLACKENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat >"$CHANNEL_DIR/access.json" <<ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
ACCESSEOF
  ok "Slack csatorna konfigurálva"
fi

# Channel plugin install
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  PLUGIN_MARKETPLACE="anthropics/claude-plugins-official"
  PLUGIN_ID="telegram@claude-plugins-official"
  PLUGIN_SHORT="telegram"
else
  PLUGIN_MARKETPLACE="Szotasz/marveen-marketplace"
  PLUGIN_ID="slack-channel@marveen-marketplace"
  PLUGIN_SHORT="slack-channel"
fi

echo -e "  ${CHANNEL_PROVIDER} plugin telepites..."
claude plugin marketplace add "$PLUGIN_MARKETPLACE" 2>/dev/null || true
if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
  ok "${CHANNEL_PROVIDER} plugin telepitve"
else
  echo -e "  ${ORANGE}Elso probalkozas sikertelen, ujraprobalok...${NC}"
  sleep 2
  if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
    ok "${CHANNEL_PROVIDER} plugin telepitve (masodik probalkozesal)"
  else
    echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin telepites sikertelen."
    echo -e "  ${DIM}  (Lehetseges ok: Claude meg nincs bejelentkezve)${NC}"
    echo -e "  Bejelentkezes utan futtasd:"
    echo -e "  ${BLUE}claude plugin install ${PLUGIN_ID}${NC}"
    echo ""
  fi
fi

# Enable plugin at project scope so --channels can boot-time activate it
cd "$INSTALL_DIR"
if claude plugin enable "$PLUGIN_SHORT@marveen-marketplace" --scope project 2>/dev/null || \
   claude plugin enable "$PLUGIN_ID" --scope project 2>/dev/null; then
  ok "${CHANNEL_PROVIDER} plugin project-scope-ban engedelyezve"
else
  warn "Plugin project-scope enable sikertelen. Futtasd kezzel:"
  echo -e "  ${DIM}cd $INSTALL_DIR && claude plugin enable ${PLUGIN_ID} --scope project${NC}"
fi

# skill-factory telepitese (self-learning meta-skill)
SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$INSTALL_DIR/skills/skill-factory" ]; then
  mkdir -p "$SKILLS_DIR/skill-factory"
  cp -r "$INSTALL_DIR/skills/skill-factory/"* "$SKILLS_DIR/skill-factory/"
  ok "skill-factory telepitve"
fi

# Seed skills: fleet-level skills from seed-skills/ into ~/.claude/skills/
# Idempotent: skip directories that already exist (never overwrite user customizations)
SEED_SKILLS_DIR="$INSTALL_DIR/seed-skills"
if [ -d "$SEED_SKILLS_DIR" ]; then
  SEED_NEW=0
  SEED_SKIP=0
  for skill_dir in "$SEED_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    target="$SKILLS_DIR/$skill_name"
    if [ -d "$target" ]; then
      SEED_SKIP=$((SEED_SKIP + 1))
      continue
    fi
    mkdir -p "$target"
    for f in "$skill_dir"*; do
      [ -f "$f" ] || continue
      cp "$f" "$target/$(basename "$f")"
    done
    SEED_NEW=$((SEED_NEW + 1))
  done
  if [ "$SEED_NEW" -gt 0 ] || [ "$SEED_SKIP" -gt 0 ]; then
    ok "Seed skills: ${SEED_NEW} uj, ${SEED_SKIP} kihagyva (mar letezik)"
  fi
fi

INSTALL_STEP="ollama-whisper"
# ─────────────────────────────────────────────
# [6/7] Ollama + Whisper
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[6/7] Ollama + Whisper...${NC}"

# --- Ollama telepites ---
echo -e "  Ollama ellenorzese (szemantikus memoria kereseshez)..."
if command -v ollama &>/dev/null; then
  ok "ollama mar telepitve"
else
  echo -e "  Ollama telepitese..."
  curl -fsSL https://ollama.com/install.sh | sh
  ok "ollama telepitve"
fi

# A telepito letrehoz egy ollama.service systemd egységet és elindítja.
# Ha megis nem futna, systemctl-lel indítjuk -- NEM ollama serve &
if ! curl -s http://localhost:11434/api/version &>/dev/null; then
  echo -e "  Ollama service indítása..."
  sudo systemctl enable --now ollama 2>/dev/null || true
  # Megvarjuk amig az API valaszol (max 15 mp)
  for i in $(seq 1 15); do
    curl -s http://localhost:11434/api/version &>/dev/null && break
    sleep 1
  done
fi

# Modell letoltese az Ollama HTTP API-n keresztul (CLI script-ben ismert TTY-bug miatt)
# stream:false --> szinkron, egyetlen valaszt ad vissza a letoltes utan
ollama_pull() {
  local model="$1" size="$2"
  if curl -s http://localhost:11434/api/tags | grep -q "\"$model\""; then
    ok "$model mar letoltve"
    return 0
  fi
  echo -e "  $model letoltese ($size)..."
  local status
  status=$(curl -s --max-time 600 \
    -X POST http://localhost:11434/api/pull \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$model\", \"stream\": false}" |
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null)
  if [ "$status" = "success" ]; then
    ok "$model kesz"
  else
    warn "$model letoltese sikertelen (status: $status) -- kezzel: ollama pull $model"
  fi
}

# nomic-embed-text (szemantikus memoria, kotelozo)
ollama_pull "nomic-embed-text" "~274 MB"

# Opcionalis lokalis LLM
echo ""
echo -e "${DIM}  Az agensek lokalis modellel is futtathatoak (adatbiztonság, nincs felho).${NC}"
echo -e "${DIM}  Elerheto modellek:${NC}"
echo -e "${DIM}    1. qwen3.5:9b  (~6 GB)  - gyors, jo minoseg${NC}"
echo -e "${DIM}    2. gemma4:31b (~19 GB) - legjobb lokalis minoseg${NC}"
echo -e "${DIM}    3. Kihagyas   (kesobb: ollama pull <modell>)${NC}"
read -p "  Melyiket toltse le? (1/2/3) [3]: " LLM_CHOICE
LLM_CHOICE=${LLM_CHOICE:-3}
case "$LLM_CHOICE" in
1) ollama_pull "qwen3.5:9b" "~6 GB" ;;
2) ollama_pull "gemma4:31b" "~19 GB" ;;
*) echo -e "  ${DIM}Kihagyva. Kesobb: ollama pull qwen3.5:9b${NC}" ;;
esac

# --- Whisper (opcionalis) ---
echo ""
echo -e "  Whisper telepites (beszed -> szoveg leirat, opcionalis)..."
if command -v whisper &>/dev/null; then
  ok "whisper mar telepitve"
else
  read -p "  Szeretned telepiteni a Whisper-t? (i/n) [n]: " DO_WHISPER
  DO_WHISPER=${DO_WHISPER:-n}
  if [ "$DO_WHISPER" = "i" ]; then
    pipx install openai-whisper 2>/dev/null &&
      ok "openai-whisper telepitve" ||
      warn "whisper telepites sikertelen (kezzel: pipx install openai-whisper)"
  else
    echo -e "  ${DIM}Kihagyva. Kesobb: pipx install openai-whisper${NC}"
  fi
fi

INSTALL_STEP="systemd"
# ─────────────────────────────────────────────
# [7/7] Automatikus inditas (systemd)
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}[7/7] Automatikus inditas beallitasa (systemd)...${NC}"

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

NODE_PATH="$(which node)"
DASH_UNIT="${MAIN_AGENT_ID}-dashboard"
CHAN_UNIT="${MAIN_AGENT_ID}-channels"
MORN_UNIT="${MAIN_AGENT_ID}-morning"

# Detect the host timezone so the scheduled-task runner (which reads
# cron expressions in Node's local TZ) fires at the operator's wall
# clock, not the VPS UTC default. If detection fails or the host is
# already UTC, we emit a comment instead so the unit stays explicit.
SYSTEM_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"
SYSTEM_TZ="${SYSTEM_TZ%$'\n'}"
if [ -n "$SYSTEM_TZ" ] && [ "$SYSTEM_TZ" != "Etc/UTC" ] && [ "$SYSTEM_TZ" != "UTC" ]; then
  TZ_LINE="Environment=TZ=$SYSTEM_TZ"
else
  TZ_LINE="# no explicit TZ detected; inheriting host default"
fi

# ${DASH_UNIT}.service
cat >"$SYSTEMD_DIR/${DASH_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:$INSTALL_DIR/store/dashboard.log
StandardError=append:$INSTALL_DIR/store/dashboard.error.log
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}

[Install]
WantedBy=default.target
EOF

# ${CHAN_UNIT}.service
cat >"$SYSTEMD_DIR/${CHAN_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Channels (Telegram bridge)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/channels.sh
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5
StandardOutput=append:$INSTALL_DIR/store/channels.log
StandardError=append:$INSTALL_DIR/store/channels.error.log
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=USER=$USER
Environment=TERM=xterm-256color
Environment=LANG=${LANG:-en_US.UTF-8}
${TZ_LINE}

[Install]
WantedBy=default.target
EOF

# ${MORN_UNIT}.service (a timer hivja)
cat >"$SYSTEMD_DIR/${MORN_UNIT}.service" <<EOF
[Unit]
Description=${BOT_NAME} Reggeli Napindito

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/morning-briefing.sh
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
${TZ_LINE}
EOF

# ${MORN_UNIT}.timer
cat >"$SYSTEMD_DIR/${MORN_UNIT}.timer" <<EOF
[Unit]
Description=${BOT_NAME} Reggeli Napindito Timer
Requires=${MORN_UNIT}.service

[Timer]
OnCalendar=*-*-* 07:27:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 1. linger eloszor: ez engedelyezi a user systemd sessiont boot utan is,
#    es headless-en az aktualis script futasa alatt is szukseges lehet
if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  ok "loginctl linger mar engedelyezve ($USER)"
elif sudo loginctl enable-linger "$USER" 2>/dev/null; then
  ok "loginctl linger engedelyezve ($USER)"
else
  warn "loginctl linger nem sikerult -- a servicek esetleg nem indulnak el boot utan (sudo szukseges)"
fi

# 2. XDG_RUNTIME_DIR + DBUS garantalasa systemctl --user-hoz
#    (a korabbi XDG-blokk csak headless-detektalasnál fut, itt mindig kell)
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

# 3. daemon-reload + enable
systemctl --user daemon-reload
systemctl --user enable "${DASH_UNIT}" "${CHAN_UNIT}" "${MORN_UNIT}.timer" 2>/dev/null || true
ok "systemd unitok generalva es engedelyezve"

# 4. Inditás
systemctl --user start "${DASH_UNIT}" "${CHAN_UNIT}" 2>/dev/null || true

# 5. Allapotellenorzes (rovid varakozas utan)
sleep 2
SVCFAIL=0
for svc in "${DASH_UNIT}" "${CHAN_UNIT}"; do
  if systemctl --user is-active --quiet "$svc" 2>/dev/null; then
    ok "$svc fut"
  else
    echo -e "  ${RED}✗${NC} $svc nem indult el"
    echo -e "  ${DIM}Log: journalctl --user -u $svc -n 20${NC}"
    SVCFAIL=1
  fi
done
[ "$SVCFAIL" -eq 0 ] && ok "Mindket szolgaltatas fut"

# Ellenorzes
sleep 3
echo ""
echo -e "${BOLD}Ellenorzes...${NC}"
if [ "$CHANNEL_PROVIDER" = "telegram" ] && ! command -v bun &>/dev/null; then
  echo -e "  ${RED}✗${NC} Bun nem talalhato. A Telegram plugin nem fog mukodni."
  echo -e "  ${BOLD}Javitas:${NC} curl -fsSL https://bun.sh/install | bash"
  echo -e "  ${DIM}Utana: source ~/.bashrc && ./scripts/start.sh${NC}"
fi
PLUGIN_CHECK_PATTERN="${CHANNEL_PROVIDER}"
if ! claude plugin list 2>/dev/null | grep -q "$PLUGIN_CHECK_PATTERN"; then
  echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin nincs telepitve."
  echo -e "  ${BOLD}Javitas:${NC} claude plugin install ${PLUGIN_ID}"
  echo -e "  ${DIM}Utana: systemctl --user restart ${CHAN_UNIT}${NC}"
else
  ok "${CHANNEL_PROVIDER} plugin ellenorizve"
fi

# ─────────────────────────────────────────────
# Channel pairing (Telegram only; Slack uses OAuth / App install)
# ─────────────────────────────────────────────
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  echo ""
  echo -e "${BOLD}Telegram parositas${NC}"

  ACCESS_FILE="$CHANNEL_DIR/access.json"

  # Megvarjuk amig a channels service tenyleg valaszol (max 15 mp)
  echo -e "  Varakozas a Telegram bridge elindulasara..."
  BRIDGE_OK=false
  for i in $(seq 1 15); do
    if systemctl --user is-active --quiet "${CHAN_UNIT}" 2>/dev/null; then
      BRIDGE_OK=true
      break
    fi
    sleep 1
  done

  if [ "$BRIDGE_OK" = "false" ]; then
    warn "A ${CHAN_UNIT} service nem indult el. Parositas kihagyva."
    echo -e "  ${DIM}Ellenorizd: journalctl --user -u ${CHAN_UNIT} -n 30${NC}"
    echo -e "  ${DIM}Kesobb: systemctl --user start ${CHAN_UNIT}, majd irj a botodnak${NC}"
  else
    ok "Telegram bridge fut"
    echo ""
    echo -e "  ${BOLD}1.${NC} Nyisd meg a Telegram appot es irj a botodnak (barmit, pl. \"Szia\")"
    echo -e "  ${BOLD}2.${NC} A bot valaszol egy parosito kodot"
    echo -e "  ${BOLD}3.${NC} Masold ide a kapott kodot:"
    echo ""
    read -p "  Parosito kod (vagy hagyd uresen ha kesobb csinalod): " PAIR_CODE

    if [ -n "$PAIR_CODE" ]; then
      if [ ! -f "$ACCESS_FILE" ]; then
        warn "access.json nem talalhato: $ACCESS_FILE"
        echo -e "  ${DIM}Bizonyosodj meg rola, hogy a bot futott amikor uzeneteket kuldtel neki.${NC}"
      else
        # PAIR_CODE env-en at adjuk at, hogy elkerüljük a shell injection-t
        PENDING_CHAT_ID=$(PAIR_CODE="$PAIR_CODE" python3 -c "
import json, os
with open('$ACCESS_FILE') as f:
    data = json.load(f)
code = os.environ['PAIR_CODE']
for c, info in data.get('pending', {}).items():
    if c == code:
        print(info.get('chatId', info.get('from', '')))
        break
" 2>/dev/null)

        if [ -n "$PENDING_CHAT_ID" ]; then
          PENDING_CHAT_ID="$PENDING_CHAT_ID" python3 -c "
import json, os
with open('$ACCESS_FILE') as f:
    data = json.load(f)
chat_id = os.environ['PENDING_CHAT_ID']
if chat_id not in data.get('allowFrom', []):
    data.setdefault('allowFrom', []).append(chat_id)
data['pending'] = {}
data['dmPolicy'] = 'allowlist'
with open('$ACCESS_FILE', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null
          CHAT_ID="$PENDING_CHAT_ID"
          sed -i "s/^ALLOWED_CHAT_ID=.*/ALLOWED_CHAT_ID=${CHAT_ID}/" "$INSTALL_DIR/.env"
          ok "Parositas sikeres! (chat ID: $PENDING_CHAT_ID)"
          ok ".env ALLOWED_CHAT_ID frissitve"
          ok "Policy: allowlist (csak te erheted el a botot)"
          # Ujrainditjuk, hogy felvegye az uj access.json-t
          systemctl --user restart "${CHAN_UNIT}" 2>/dev/null || true
          ok "${CHAN_UNIT} ujraindítva (uj konfig betoltve)"
        else
          warn "A kod nem talalhato az access.json pending bejegyzesei kozott."
          echo -e "  ${DIM}Lehetseges okok:${NC}"
          echo -e "  ${DIM}  - A bot meg nem kapta meg az uzeneteidet (varj par masodpercet)${NC}"
          echo -e "  ${DIM}  - Elgepeles a kodban${NC}"
          echo -e "  ${DIM}Kesobb: claude -> /telegram:access pair $PAIR_CODE${NC}"
        fi
      fi
    else
      echo -e "  ${DIM}Rendben, kesobb is parosithatsz.${NC}"
      echo -e "  ${DIM}Futtasd: claude, majd /telegram:access pair AKOD${NC}"
    fi
  fi
fi

# ─────────────────────────────────────────────
# Korabbi rendszer koltoztetese
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Korabbi rendszer koltoztetese${NC}"
echo -e "${DIM}  Ha volt korabbi AI asszisztensed (OpenClaw, egyeni bot), atmigralhato a memoriai.${NC}"
read -p "  Szeretned most futtatni a koltoztetest? (i/n) [n]: " DO_MIGRATE
DO_MIGRATE=${DO_MIGRATE:-n}
if [ "$DO_MIGRATE" = "i" ]; then
  if [ -f "$INSTALL_DIR/scripts/migrate.sh" ]; then
    "$INSTALL_DIR/scripts/migrate.sh"
  else
    warn "A migrate.sh nem talalhato. Hasznald a dashboardot: http://localhost:3420 -> Koltoztes"
  fi
fi

# Warn if Telegram pairing was skipped
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ "$CHAT_ID" = "0" ]; then
  echo ""
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}  FIGYELEM: Telegram parositas nem tortent meg!${NC}"
  echo -e "${ORANGE}  Az ALLOWED_CHAT_ID=0 marad az .env-ben, ami azt jelenti${NC}"
  echo -e "${ORANGE}  hogy a bot NEM fog valaszolni senkinek.${NC}"
  echo ""
  echo -e "  ${BOLD}Javitas:${NC}"
  echo -e "  1. Irj a botodnak Telegramon (barmit)"
  echo -e "  2. Masold a kapott parosito kodot"
  echo -e "  3. Futtasd: ${BOLD}claude${NC}, majd ${BOLD}/telegram:access pair AKOD${NC}"
  echo -e "${ORANGE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

# ─────────────────────────────────────────────
# Kesz!
# ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}${GREEN}  ✓ Marveen sikeresen telepitve!${NC}"
echo ""

DASH_TOKEN=""
if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
  DASH_TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
fi
if [ -n "$DASH_TOKEN" ]; then
  echo -e "  ${BOLD}Dashboard:${NC} ${BLUE}http://localhost:3420/?token=${DASH_TOKEN}${NC}"
  echo -e "  ${DIM}(Nyisd meg egyszer, utana a bongeszo megjegyzi a tokent)${NC}"
else
  echo -e "  ${BOLD}Dashboard:${NC} http://localhost:3420"
  echo -e "  ${DIM}(A tokenes URL-t a szerver logban talalod)${NC}"
fi
echo -e "  ${BOLD}Telegram:${NC} Irj a botodnak!"
echo ""
echo -e "  ${DIM}Kovetkezo lepesek:${NC}"
echo -e "  ${DIM}1. Nyisd meg a dashboardot a fenti URL-lel${NC}"
echo -e "  ${DIM}2. Irj a botodnak Telegramon -- mar valaszolnia kell${NC}"
echo -e "  ${DIM}3. A Csapat oldalon hozhatsz letre tobb agenst${NC}"
echo ""
echo -e "  ${DIM}Hasznos parancsok:${NC}"
echo -e "  ${DIM}  systemctl --user status ${DASH_UNIT} ${CHAN_UNIT} --no-pager${NC}"
echo -e "  ${DIM}  journalctl --user -u ${DASH_UNIT} -f${NC}    -- dashboard logok"
echo -e "  ${DIM}  journalctl --user -u ${CHAN_UNIT} -f${NC}     -- channels logok"
echo -e "  ${DIM}  ./update.sh${NC}                                  -- frissites"
echo -e "  ${DIM}  ./scripts/start.sh${NC}                           -- indítás"
echo -e "  ${DIM}  ./scripts/stop.sh${NC}                            -- leallitas"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
