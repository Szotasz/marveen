#!/bin/bash
# Marveen - AI Team Setup
# Interactive installer for macOS

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
ORANGE='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

clear
echo ""
echo -e "${BOLD}  ▐▛███▜▌   Marveen${NC}"
echo -e "${BOLD} ▝▜█████▛▘  AI csapatod, ami fut amig te alszol.${NC}"
echo -e "${DIM}   ▘▘ ▝▝${NC}"
echo ""
echo -e "${DIM}  Telepito wizard - macOS${NC}"
echo ""

# Step 1: Check prerequisites
echo -e "${BOLD}[1/7] Elofeltetelek ellenorzese...${NC}"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $2"
    return 0
  else
    echo -e "  ${RED}✗${NC} $2 - hianyzik"
    return 1
  fi
}

MISSING=0
check_cmd "node" "Node.js (v20+)" || MISSING=1
check_cmd "npm" "npm" || MISSING=1
check_cmd "tmux" "tmux" || MISSING=1
check_cmd "git" "git" || MISSING=1

# Check Node version
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 20 ]; then
    echo -e "  ${RED}✗${NC} Node.js verzio: $(node -v) (minimum: v20)"
    MISSING=1
  fi
fi

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo -e "${ORANGE}Hianyzo fuggosegek telepitese Homebrew-val...${NC}"
  if ! command -v brew &>/dev/null; then
    echo -e "${RED}Homebrew nem talalhato. Telepitsd: https://brew.sh${NC}"
    exit 1
  fi
  command -v node &>/dev/null || brew install node@22
  command -v tmux &>/dev/null || brew install tmux
  echo -e "${GREEN}✓ Fuggosegek telepitve${NC}"
fi

# Bun (required by Telegram channels plugin)
if ! command -v bun &>/dev/null; then
  echo -e "  ${ORANGE}Bun telepitese (Telegram plugin fuggoseg)...${NC}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
check_cmd "bun" "Bun runtime"

# Check Claude Code CLI
echo ""
if ! command -v claude &>/dev/null; then
  echo -e "  ${RED}✗${NC} Claude Code CLI - hianyzik"
  echo -e "${ORANGE}Telepites: npm install -g @anthropic-ai/claude-code${NC}"
  read -p "Telepitsem most? (i/n) " INSTALL_CLAUDE
  if [ "$INSTALL_CLAUDE" = "i" ]; then
    npm install -g @anthropic-ai/claude-code
  else
    echo -e "${RED}Claude Code CLI szukseges a futtatáshoz.${NC}"
    exit 1
  fi
fi
echo -e "  ${GREEN}✓${NC} Claude Code CLI"

# Step 2: Claude authentication
echo ""
echo -e "${BOLD}[2/7] Claude bejelentkezes${NC}"
echo -e "${DIM}  Ha meg nem jelentkeztel be, most megteheted.${NC}"
read -p "  Szeretned most bejelentkezni? (i/n) " DO_AUTH
if [ "$DO_AUTH" = "i" ]; then
  claude auth login
fi

# Step 3: Personal info
echo ""
echo -e "${BOLD}[3/7] Szemelyes beallitasok${NC}"
read -p "  Mi a neved? " OWNER_NAME
# Chat ID is NOT asked here -- the user doesn't know it yet.
# It will be set automatically during the Telegram pairing flow.
CHAT_ID="0"

# Step 4: Telegram bot setup
echo ""
echo -e "${BOLD}[4/7] Telegram bot beallitas${NC}"
echo -e "${DIM}  Az AI asszisztensed Telegramon kommunikal veled.${NC}"
echo -e "${DIM}  1. Nyisd meg a @BotFather-t a Telegramban${NC}"
echo -e "${DIM}  2. Ird be: /newbot${NC}"
echo -e "${DIM}  3. Adj nevet a botodnak${NC}"
echo -e "${DIM}  4. Masold ide a kapott tokent:${NC}"
echo ""
read -p "  Telegram bot token (vagy hagyd uresen, kesobb is beallithatod): " BOT_TOKEN
read -p "  Mi legyen a botod neve? [Marveen]: " BOT_NAME
BOT_NAME=${BOT_NAME:-"Marveen"}

# Step 5: Install dependencies
echo ""
echo -e "${BOLD}[5/7] Fuggosegek telepitese...${NC}"
cd "$INSTALL_DIR"
npm install --silent
echo -e "  ${GREEN}✓${NC} npm csomagok telepitve"

# Build TypeScript
echo -e "  Forditas..."
npm run build --silent
echo -e "  ${GREEN}✓${NC} TypeScript leforditva"

# Step 6: Configuration
echo ""
echo -e "${BOLD}[6/7] Konfiguracio letrehozasa...${NC}"

# Create .env
(umask 077 && cat > "$INSTALL_DIR/.env" << ENVEOF
# Marveen konfiguracio
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
ALLOWED_CHAT_ID=${CHAT_ID}
OWNER_NAME=${OWNER_NAME}
ENVEOF
)
chmod 600 "$INSTALL_DIR/.env"
echo -e "  ${GREEN}✓${NC} .env letrehozva (chmod 600)"

# Create store directory
mkdir -p "$INSTALL_DIR/store"
mkdir -p "$INSTALL_DIR/agents"
echo -e "  ${GREEN}✓${NC} Konyvtarak letrehozva"

# Generate CLAUDE.md from template
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
      -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
      -e "s/{{CHAT_ID}}/$CHAT_ID/g" \
      -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
      "$INSTALL_DIR/templates/CLAUDE.md.template" > "$INSTALL_DIR/CLAUDE.md"
  echo -e "  ${GREEN}✓${NC} CLAUDE.md generalva"
fi

# Setup Telegram channel
if [ -n "$BOT_TOKEN" ] && [ "$BOT_TOKEN" != "" ]; then
  TELEGRAM_DIR="$HOME/.claude/channels/telegram"
  mkdir -p "$TELEGRAM_DIR"
  (umask 077 && echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > "$TELEGRAM_DIR/.env")
  chmod 600 "$TELEGRAM_DIR/.env"
  cat > "$TELEGRAM_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} Telegram csatorna konfigurálva"
fi

# Install Telegram plugin
echo -e "  Telegram plugin telepítés..."
claude plugin install telegram@claude-plugins-official 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Telegram plugin"

# Ollama + nomic-embed-text (szemantikus kereséshez)
echo ""
echo -e "  Ollama ellenőrzés (szemantikus memória kereséshez)..."
if command -v ollama &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Ollama telepítve"
else
  echo -e "  ${ORANGE}Ollama telepítése...${NC}"
  brew install ollama 2>/dev/null || curl -fsSL https://ollama.com/install.sh | sh
fi

# Start Ollama if not running
if ! curl -s http://localhost:11434/api/version &>/dev/null; then
  echo -e "  Ollama indítás..."
  ollama serve &>/dev/null &
  sleep 3
fi

# Pull nomic-embed-text model
if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
  echo -e "  nomic-embed-text modell letöltése (~274 MB)..."
  ollama pull nomic-embed-text
fi
echo -e "  ${GREEN}✓${NC} Ollama + nomic-embed-text kész"

# Whisper (speech-to-text for video transcription)
echo ""
echo -e "  Whisper telepítés (beszéd -> szöveg leirat)..."
if command -v mlx_whisper &>/dev/null || [ -f "$HOME/.local/bin/mlx_whisper" ]; then
  echo -e "  ${GREEN}✓${NC} mlx-whisper már telepítve (Apple Silicon optimalizált)"
elif command -v whisper &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} whisper már telepítve"
  echo -e "  ${DIM}  Tipp: pipx install mlx-whisper gyorsabb Apple Silicon-on${NC}"
else
  if command -v pipx &>/dev/null; then
    pipx install mlx-whisper 2>/dev/null && echo -e "  ${GREEN}✓${NC} mlx-whisper telepítve" || {
      brew install openai-whisper 2>/dev/null
      echo -e "  ${GREEN}✓${NC} openai-whisper telepítve"
    }
  else
    brew install pipx 2>/dev/null && pipx install mlx-whisper 2>/dev/null && echo -e "  ${GREEN}✓${NC} mlx-whisper telepítve" || {
      brew install openai-whisper 2>/dev/null
      echo -e "  ${GREEN}✓${NC} openai-whisper telepítve"
    }
  fi
fi

# ffmpeg (audio/video processing)
if ! command -v ffmpeg &>/dev/null; then
  echo -e "  ffmpeg telepítés..."
  brew install ffmpeg
fi
echo -e "  ${GREEN}✓${NC} ffmpeg kész"

# Optional: download a local LLM for agents
echo ""
echo -e "${DIM}  Az ágensek lokális modellel is futtathatók (adatbiztonság, nincs felhő).${NC}"
echo -e "${DIM}  Elérhető modellek:${NC}"
echo -e "${DIM}    1. qwen3.5:9b  (~6 GB) - gyors, jó minőség${NC}"
echo -e "${DIM}    2. gemma4:31b  (~19 GB) - legjobb lokális minőség${NC}"
echo -e "${DIM}    3. Kihagyás (később is letöltheted: ollama pull <modell>)${NC}"
read -p "  Melyiket töltse le? (1/2/3) [3]: " LLM_CHOICE
LLM_CHOICE=${LLM_CHOICE:-3}
if [ "$LLM_CHOICE" = "1" ]; then
  echo -e "  qwen3.5:9b letöltése..."
  ollama pull qwen3.5:9b
  echo -e "  ${GREEN}✓${NC} qwen3.5:9b kész"
elif [ "$LLM_CHOICE" = "2" ]; then
  echo -e "  gemma4:31b letöltése (ez eltarthat pár percig)..."
  ollama pull gemma4:31b
  echo -e "  ${GREEN}✓${NC} gemma4:31b kész"
else
  echo -e "  ${DIM}Kihagyva. Később: ollama pull qwen3.5:9b${NC}"
fi

# Step 7: LaunchAgent setup
echo ""
echo -e "${BOLD}[7/7] Automatikus inditas beallitasa...${NC}"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

NODE_PATH="$(which node)"

# Dashboard service
cat > "$PLIST_DIR/com.marveen.dashboard.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marveen.dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${INSTALL_DIR}/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/store/dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/store/dashboard.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
PLISTEOF

# Channels service (Telegram bridge)
cat > "$PLIST_DIR/com.marveen.channels.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.marveen.channels</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/scripts/channels.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/store/channels.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/store/channels.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
PLISTEOF

echo -e "  ${GREEN}✓${NC} LaunchAgent-ek letrehozva"

# Load LaunchAgents
launchctl load "$PLIST_DIR/com.marveen.dashboard.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/com.marveen.channels.plist" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Szolgaltatasok elinditva"

# Migration from previous system
echo ""
echo -e "${BOLD}Korábbi rendszer költöztetése${NC}"
echo -e "${DIM}  Ha volt korábbi AI asszisztensed (OpenClaw, egyéni bot), átmigrálhatod a memóriáját.${NC}"
read -p "  Szeretnéd most futtatni a költöztetést? (i/n) [n]: " DO_MIGRATE
DO_MIGRATE=${DO_MIGRATE:-n}
if [ "$DO_MIGRATE" = "i" ]; then
  if [ -f "$INSTALL_DIR/scripts/migrate.sh" ]; then
    "$INSTALL_DIR/scripts/migrate.sh"
  else
    echo -e "  ${ORANGE}A migrate.sh nem található. Használd a dashboardot: http://localhost:3420 -> Költöztetés${NC}"
  fi
fi

# Done!
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}${GREEN}  ✓ Marveen sikeresen telepitve!${NC}"
echo ""

# Read dashboard token for access URL
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
echo -e "  ${BOLD}Telegram:${NC} Irj a botodnak es parosits!"
echo ""
echo -e "  ${DIM}Kovetkezo lepesek:${NC}"
echo -e "  ${DIM}1. Nyisd meg a dashboardot a fenti URL-lel${NC}"
echo -e "  ${DIM}2. Irj a Telegram botodnak -- kapsz egy parosito kodot${NC}"
echo -e "  ${DIM}3. A terminalban futtasd: claude${NC}"
echo -e "  ${DIM}4. Ird be: /telegram:access pair AKOD${NC}"
echo -e "  ${DIM}5. Zard le: /telegram:access policy allowlist${NC}"
echo -e "  ${DIM}6. A Csapat oldalon hozhatsz letre agenseket${NC}"
echo ""
echo -e "  ${DIM}Frissites: ./update.sh${NC}"
echo -e "  ${DIM}Leallitas: ./scripts/stop.sh${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
