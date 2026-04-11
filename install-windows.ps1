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
$botToken = Read-Host "  Telegram bot token (vagy hagyd üresen)"
$chatId = Read-Host "  Telegram chat ID (vagy hagyd üresen)"

wsl bash -c @"
cd $installPath

# Create .env
cat > .env << 'ENVEOF'
TELEGRAM_BOT_TOKEN=$botToken
ALLOWED_CHAT_ID=$chatId
OWNER_NAME=$ownerName
ENVEOF

echo '  ✓ .env létrehozva'

# Generate CLAUDE.md from template
if [ -f templates/CLAUDE.md.template ]; then
    sed 's/{{OWNER_NAME}}/$ownerName/g' templates/CLAUDE.md.template > CLAUDE.md
    echo '  ✓ CLAUDE.md generálva'
fi

# Create directories
mkdir -p store agents

# Setup Telegram
if [ -n '$botToken' ]; then
    mkdir -p ~/.claude/channels/telegram
    echo 'TELEGRAM_BOT_TOKEN=$botToken' > ~/.claude/channels/telegram/.env
    echo '{"dmPolicy":"allowlist","allowFrom":["$chatId"],"groups":{},"pending":{}}' > ~/.claude/channels/telegram/access.json
    echo '  ✓ Telegram csatorna konfigurálva'
fi

# Install Telegram plugin
claude plugin install telegram@claude-plugins-official 2>/dev/null || true
echo '  ✓ Telegram plugin'
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
Write-Host "  Telegram bridge indítása:" -ForegroundColor White
Write-Host "    wsl bash -c 'cd $installPath && tmux new-session -d -s marveen-channels ""claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official""'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Frissítés:" -ForegroundColor White
Write-Host "    wsl bash -c 'cd $installPath && ./update.sh'" -ForegroundColor Cyan
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
