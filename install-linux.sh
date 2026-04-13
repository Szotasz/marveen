#!/bin/bash
# Marveen telepito -- Ubuntu/Debian
# Hasznalat: bash install-linux.sh

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; exit 1; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${BOLD}Marveen telepito -- Ubuntu/Debian${NC}"
echo ""

# --- [1/6] Elofeltetelek ---
echo -e "${BOLD}[1/6] Elofeltetelek ellenorzese...${NC}"

if ! command -v apt-get &>/dev/null; then
  fail "Ez a telepito csak Ubuntu/Debian rendszeren fut (apt-get szukseges)"
fi

MISSING_PKGS=""
for pkg in git tmux lsof curl python3; do
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
  sudo apt-get update -qq
  # Node.js v20 (nem a regi apt verzio)
  if echo "$MISSING_PKGS" | grep -q nodejs; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
    MISSING_PKGS=$(echo "$MISSING_PKGS" | sed 's/ nodejs//')
  fi
  # shellcheck disable=SC2086
  sudo apt-get install -y $MISSING_PKGS -qq
fi

ok "git $(git --version | awk '{print $3}')"
ok "node $(node --version)"
ok "npm $(npm --version)"
ok "tmux $(tmux -V | awk '{print $2}')"
ok "lsof"

# --- [2/6] Claude Code telepites ---
echo ""
echo -e "${BOLD}[2/6] Claude Code telepitese...${NC}"

if command -v claude &>/dev/null; then
  ok "claude mar telepitve: $(claude --version 2>/dev/null || echo 'ok')"
else
  echo -e "  Letoltes: https://claude.ai/install.sh"
  curl -fsSL https://claude.ai/install.sh | bash
  ok "claude telepitve -> ~/.local/bin/claude"
fi

# ~/.local/bin hozzaadasa PATH-hoz (ha meg nincs)
if ! grep -q '\.local/bin' ~/.bashrc 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  warn "PATH bovitve: ~/.local/bin hozzaadva ~/.bashrc-hez (forras: source ~/.bashrc)"
fi
export PATH="$HOME/.local/bin:$PATH"

# --- [3/6] Ollama telepites ---
echo ""
echo -e "${BOLD}[3/6] Ollama telepitese...${NC}"

if command -v ollama &>/dev/null; then
  ok "ollama mar telepitve"
else
  echo -e "  Letoltes: https://ollama.com/install.sh"
  curl -fsSL https://ollama.com/install.sh | sh
  ok "ollama telepitve"
fi

# Ollama service elinditasa (ha meg nem fut)
if ! pgrep -x ollama &>/dev/null; then
  echo -e "  Ollama inditasa hatterben..."
  ollama serve &>/dev/null &
  sleep 3
fi

echo -e "  nomic-embed-text modell letoltese (szukseges a memoria rendszerhez)..."
ollama pull nomic-embed-text --quiet 2>/dev/null || warn "nomic-embed-text letoltese sikertelen (kezzel: ollama pull nomic-embed-text)"

# --- [4/6] Marveen telepites ---
echo ""
echo -e "${BOLD}[4/6] Marveen build...${NC}"

cd "$INSTALL_DIR"

echo -e "  npm ci..."
npm ci --silent

echo -e "  TypeScript build..."
npm run build --silent

mkdir -p store
ok "build kesz"

# .env beallitas
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  warn ".env fajl letrehozva a peldabol -- szerkeszd meg: $INSTALL_DIR/.env"
else
  chmod 600 "$INSTALL_DIR/.env"
  ok ".env mar letezik"
fi

# --- [5/6] Systemd user unitok ---
echo ""
echo -e "${BOLD}[5/6] Systemd user unitok generalasa...${NC}"

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# marveen-dashboard.service
cat > "$SYSTEMD_DIR/marveen-dashboard.service" << EOF
[Unit]
Description=Marveen Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env node $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=5
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

# marveen-channels.service
cat > "$SYSTEMD_DIR/marveen-channels.service" << EOF
[Unit]
Description=Marveen Channels (Telegram bridge)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/channels.sh
Restart=on-failure
RestartSec=5
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

# marveen-morning.service (a timer hivja)
cat > "$SYSTEMD_DIR/marveen-morning.service" << EOF
[Unit]
Description=Marveen Reggeli Napindito

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/scripts/morning-briefing.sh
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF

# marveen-morning.timer
cat > "$SYSTEMD_DIR/marveen-morning.timer" << EOF
[Unit]
Description=Marveen Reggeli Napindito Timer
Requires=marveen-morning.service

[Timer]
OnCalendar=*-*-* 07:27:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable marveen-dashboard marveen-channels marveen-morning.timer

ok "systemd unitok generalva es engedelyezve"

# loginctl enable-linger: headless szerveren szukseges (user session boot utan is el)
if ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
  if sudo loginctl enable-linger "$USER" 2>/dev/null; then
    ok "loginctl linger engedelyezve ($USER)"
  else
    warn "loginctl linger nem sikerult -- headless szerveren a servicek nem indulnak el automatikusan boot utan"
  fi
fi

# --- [6/6] Konfiguracio es ellenorzes ---
echo ""
echo -e "${BOLD}[6/6] Ellenorzes...${NC}"

# .env tartalma OK?
if grep -q "your_telegram_bot_token_here" "$INSTALL_DIR/.env"; then
  warn ".env nincs kitoltve! Szerkeszd meg: $INSTALL_DIR/.env"
  echo ""
  echo -e "  Szukseges valtozok:"
  echo -e "    TELEGRAM_BOT_TOKEN=..."
  echo -e "    ALLOWED_CHAT_ID=..."
  echo -e "    OWNER_NAME=..."
else
  # Service inditas
  systemctl --user start marveen-dashboard marveen-channels 2>/dev/null || true
  sleep 2

  # Dashboard ellenorzes
  if curl -s http://localhost:3420/api/auth/status &>/dev/null; then
    ok "Dashboard fut"
  else
    warn "Dashboard meg nem valaszol (indulas folyamatban lehet)"
    echo -e "  Ellenorzes: curl http://localhost:3420/api/auth/status"
    echo -e "  Logok: journalctl --user -u marveen-dashboard -f"
  fi

  # Dashboard token URL megjelenitese
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
fi

echo ""
echo -e "${BOLD}Telepites kesz!${NC}"
echo ""
echo -e "  Hasznos parancsok:"
echo -e "    ${DIM}bash scripts/start.sh${NC}          -- inditas"
echo -e "    ${DIM}bash scripts/stop.sh${NC}           -- leallitas"
echo -e "    ${DIM}tmux attach -t marveen-channels${NC} -- Telegram bridge konzol"
echo -e "    ${DIM}journalctl --user -u marveen-dashboard -f${NC} -- dashboard logok"
echo -e "    ${DIM}journalctl --user -u marveen-channels -f${NC}  -- channels logok"
echo ""
