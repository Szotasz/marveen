# Marveen - Windows telepítő (WSL alapú)
# Futtatás: PowerShell-ben: .\install-windows.ps1

Write-Host ""
Write-Host "  ▐▛███▜▌   Marveen" -ForegroundColor Cyan
Write-Host " ▝▜█████▛▘  AI csapatod, ami fut amíg te alszol." -ForegroundColor Cyan
Write-Host "   ▘▘ ▝▝" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Windows telepítő (WSL alapú)" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Check if WSL is available
Write-Host "[1/5] WSL ellenőrzés..." -ForegroundColor White

$wslInstalled = $false
try {
    $wslOutput = wsl --status 2>&1
    if ($LASTEXITCODE -eq 0 -or $wslOutput -match "Default Distribution") {
        $wslInstalled = $true
        Write-Host "  ✓ WSL telepítve" -ForegroundColor Green
    }
} catch {}

if (-not $wslInstalled) {
    Write-Host "  ✗ WSL nem található" -ForegroundColor Red
    Write-Host ""
    Write-Host "  A Marveen WSL-ben fut (Windows Subsystem for Linux)." -ForegroundColor Yellow
    Write-Host "  Telepítéshez futtasd rendszergazdaként:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    wsl --install" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Újraindítás után futtasd újra ezt a scriptet." -ForegroundColor Yellow
    Write-Host ""

    $doInstall = Read-Host "  Telepítsem most a WSL-t? (i/n)"
    if ($doInstall -eq "i") {
        Write-Host "  WSL telepítés indítása (rendszergazda jogok szükségesek)..." -ForegroundColor Yellow
        Start-Process -Verb RunAs -FilePath "wsl" -ArgumentList "--install" -Wait
        Write-Host ""
        Write-Host "  WSL telepítve. Indítsd újra a gépet, majd futtasd újra ezt a scriptet." -ForegroundColor Green
        exit 0
    }
    exit 1
}

# Step 2: Check WSL distro
Write-Host ""
Write-Host "[2/5] Linux disztribúció ellenőrzés..." -ForegroundColor White

$distros = wsl --list --quiet 2>&1
if ($distros -match "Ubuntu") {
    Write-Host "  ✓ Ubuntu elérhető" -ForegroundColor Green
} else {
    Write-Host "  Ubuntu telepítése..." -ForegroundColor Yellow
    wsl --install -d Ubuntu
    Write-Host "  ✓ Ubuntu telepítve" -ForegroundColor Green
    Write-Host "  Hozz létre egy felhasználónevet és jelszót az Ubuntu-ban," -ForegroundColor Yellow
    Write-Host "  majd futtasd újra ezt a scriptet." -ForegroundColor Yellow
    exit 0
}

# Step 3: Install dependencies in WSL
Write-Host ""
Write-Host "[3/5] Függőségek telepítése WSL-ben..." -ForegroundColor White

wsl bash -c @"
set -e

# Node.js 22
if ! command -v node &>/dev/null; then
    echo '  Node.js telepítése...'
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo "  ✓ Node.js \$(node -v)"

# tmux
if ! command -v tmux &>/dev/null; then
    echo '  tmux telepítése...'
    sudo apt-get install -y tmux
fi
echo '  ✓ tmux'

# git
if ! command -v git &>/dev/null; then
    sudo apt-get install -y git
fi
echo '  ✓ git'

# ffmpeg
if ! command -v ffmpeg &>/dev/null; then
    sudo apt-get install -y ffmpeg
fi
echo '  ✓ ffmpeg'

# Ollama
if ! command -v ollama &>/dev/null; then
    echo '  Ollama telepítése...'
    curl -fsSL https://ollama.com/install.sh | sh
fi
echo '  ✓ Ollama'

# Claude Code CLI
if ! command -v claude &>/dev/null; then
    echo '  Claude Code CLI telepítése...'
    sudo npm install -g @anthropic-ai/claude-code
fi
echo '  ✓ Claude Code CLI'

# Bun (Telegram plugin fuggoseg)
if ! command -v bun &>/dev/null; then
    echo '  Bun telepítése...'
    curl -fsSL https://bun.sh/install | bash
    export PATH="\$HOME/.bun/bin:\$PATH"
fi
echo '  ✓ Bun'
"@

Write-Host "  ✓ Függőségek telepítve" -ForegroundColor Green

# Step 4: Clone and setup Marveen
Write-Host ""
Write-Host "[4/5] Marveen telepítése WSL-ben..." -ForegroundColor White

$installPath = Read-Host "  Telepítési útvonal WSL-ben [~/marveen]"
if ([string]::IsNullOrEmpty($installPath)) { $installPath = "~/marveen" }

wsl bash -c @"
set -e

INSTALL_DIR="$installPath"

# Clone repo
if [ ! -d "\$INSTALL_DIR" ]; then
    git clone https://github.com/Szotasz/marveen.git "\$INSTALL_DIR"
    echo '  ✓ Repó klónozva'
else
    echo '  ✓ Marveen mappa már létezik'
fi

cd "\$INSTALL_DIR"

# Install npm dependencies
npm install --silent
echo '  ✓ npm csomagok telepítve'

# Build
npm run build --silent
echo '  ✓ TypeScript lefordítva'

# Ollama models
if command -v ollama &>/dev/null; then
    # Start Ollama if not running
    if ! curl -s http://localhost:11434/api/version &>/dev/null; then
        nohup ollama serve &>/dev/null &
        sleep 3
    fi

    # Pull embedding model
    if ! ollama list 2>/dev/null | grep -q 'nomic-embed-text'; then
        echo '  nomic-embed-text letöltése (~274 MB)...'
        ollama pull nomic-embed-text
    fi
    echo '  ✓ Ollama + nomic-embed-text'
fi
"@

Write-Host "  ✓ Marveen telepítve" -ForegroundColor Green

# Step 5: Configuration
Write-Host ""
Write-Host "[5/5] Konfiguráció..." -ForegroundColor White

$ownerName = Read-Host "  Mi a neved?"

Write-Host ""
Write-Host "  Csatorna beallitas:" -ForegroundColor White
Write-Host "    1. Telegram (alapertelmezett)" -ForegroundColor Cyan
Write-Host "    2. Slack" -ForegroundColor Cyan
$provChoice = Read-Host "  Valassz (1/2) [1]"
if ($provChoice -eq "2") { $channelProvider = "slack" } else { $channelProvider = "telegram" }

$botToken = ""
$slackBotToken = ""
$slackAppToken = ""

if ($channelProvider -eq "telegram") {
    $botToken = Read-Host "  Telegram bot token (vagy hagyd üresen)"
} else {
    $slackBotToken = Read-Host "  Bot Token (xoxb-...)"
    $slackAppToken = Read-Host "  App-Level Token (xapp-...)"
}

$chatId = "0"

wsl bash -c @"
cd $installPath

# Create .env
(umask 077 && cat > .env << 'ENVEOF'
CHANNEL_PROVIDER=$channelProvider
OWNER_NAME=$ownerName
ENVEOF
)
if [ '$channelProvider' = 'telegram' ]; then
  echo 'TELEGRAM_BOT_TOKEN=$botToken' >> .env
  echo 'ALLOWED_CHAT_ID=$chatId' >> .env
else
  echo 'SLACK_BOT_TOKEN=$slackBotToken' >> .env
  echo 'SLACK_APP_TOKEN=$slackAppToken' >> .env
fi
chmod 600 .env
echo '  ✓ .env létrehozva (chmod 600)'

# Generate CLAUDE.md from template
if [ -f templates/CLAUDE.md.template ]; then
    sed 's/{{OWNER_NAME}}/$ownerName/g' templates/CLAUDE.md.template > CLAUDE.md
    echo '  ✓ CLAUDE.md generálva'
fi

# Create directories
mkdir -p store agents

# Setup channel state
CHANNEL_DIR=~/.claude/channels/$channelProvider
mkdir -p "\$CHANNEL_DIR"
if [ '$channelProvider' = 'telegram' ] && [ -n '$botToken' ]; then
    (umask 077 && echo 'TELEGRAM_BOT_TOKEN=$botToken' > "\$CHANNEL_DIR/.env")
    chmod 600 "\$CHANNEL_DIR/.env"
    echo '{"dmPolicy":"pairing","allowFrom":[],"groups":{},"pending":{}}' > "\$CHANNEL_DIR/access.json"
    echo '  ✓ Telegram csatorna konfigurálva'
elif [ '$channelProvider' = 'slack' ] && [ -n '$slackBotToken' ]; then
    (umask 077 && printf 'SLACK_BOT_TOKEN=$slackBotToken\nSLACK_APP_TOKEN=$slackAppToken\n' > "\$CHANNEL_DIR/.env")
    chmod 600 "\$CHANNEL_DIR/.env"
    echo '{"dmPolicy":"pairing","allowFrom":[],"groups":{},"pending":{}}' > "\$CHANNEL_DIR/access.json"
    echo '  ✓ Slack csatorna konfigurálva'
fi

# Install channel plugin
if [ '$channelProvider' = 'telegram' ]; then
    claude plugin marketplace add anthropics/claude-plugins-official 2>/dev/null || true
    claude plugin install telegram@claude-plugins-official 2>/dev/null || true
    echo '  ✓ Telegram plugin'
else
    claude plugin marketplace add jeremylongshore/claude-code-slack-channel 2>/dev/null || true
    claude plugin install slack@jeremylongshore/claude-code-slack-channel 2>/dev/null || true
    echo '  ✓ Slack plugin'
fi

# Pre-accept Claude Code first-run dialogs so the tmux-spawned headless
# session (Telegram bridge) doesn't park on them forever. Without this,
# the first launch hits "Bypass Permissions mode" + "Trust this folder"
# prompts on a non-interactive TTY and stays stuck.
mkdir -p ~/.claude
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const cj = path.join(os.homedir(), ".claude.json");
let d = {}; try { d = JSON.parse(fs.readFileSync(cj, "utf8")); } catch {}
d.hasCompletedOnboarding = true;
if (!d.theme) d.theme = "dark";
fs.writeFileSync(cj, JSON.stringify(d, null, 2), { mode: 0o600 });
const sj = path.join(os.homedir(), ".claude", "settings.json");
let s = {}; try { s = JSON.parse(fs.readFileSync(sj, "utf8")); } catch {}
s.skipDangerousModePermissionPrompt = true;
fs.mkdirSync(path.dirname(sj), { recursive: true });
fs.writeFileSync(sj, JSON.stringify(s, null, 2), { mode: 0o600 });
console.log("  ✓ Claude Code first-run flags");
'
"@

# Done!
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  ✓ Marveen sikeresen telepítve!" -ForegroundColor Green -BackgroundColor Black
Write-Host ""
Write-Host "  Indítás:" -ForegroundColor White
Write-Host "    wsl bash -c 'cd $installPath && node dist/index.js &'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Dashboard:" -ForegroundColor White
Write-Host "    http://localhost:3420" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Channel bridge indítása:" -ForegroundColor White
Write-Host "    wsl bash -c 'cd $installPath && bash scripts/channels.sh &'" -ForegroundColor Cyan
Write-Host "    (a channels.sh tartalmazza a first-run dialog auto-accept guardot)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Frissítés:" -ForegroundColor White
Write-Host "    wsl bash -c 'cd $installPath && ./update.sh'" -ForegroundColor Cyan
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
