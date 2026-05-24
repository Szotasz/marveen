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
INSTALL_STEP="init"

ok() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${ORANGE}!${NC} $*"; }

offer_claude_fallback() {
  local step="$1" err_msg="$2" line_info="${3:+:$3}"
  if ! command -v claude &>/dev/null; then
    return
  fi
  echo ""
  echo -e "${ORANGE}Claude Code elérhető a gépen.${NC}"
  local prompt="Marveen installer failed at step \"${step}\". Error: ${err_msg}. Script: install.sh${line_info}. Repo: https://github.com/Szotasz/marveen. OS: macOS $(sw_vers -productVersion 2>/dev/null || echo unknown). Node: $(node -v 2>/dev/null || echo missing). Dir: ${INSTALL_DIR}. Your task: diagnose this Marveen installer failure. The install scripts are install.sh (macOS) and install-linux.sh. Read the relevant section, check for missing dependencies or permission issues, and suggest concrete shell commands to fix."
  if [ -t 0 ]; then
    read -p "  Megnyissam Claude Code-ot a hiba diagnosztizálásához? (i/n) [n]: " OPEN_CLAUDE
    OPEN_CLAUDE=${OPEN_CLAUDE:-n}
    if [ "$OPEN_CLAUDE" = "i" ]; then
      claude --prompt "$prompt"
      return
    fi
  fi
  echo -e "  ${DIM}Futtasd manuálisan:${NC}"
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

clear
echo ""
echo -e "${BOLD}  ▐▛███▜▌   Marveen${NC}"
echo -e "${BOLD} ▝▜█████▛▘  AI csapatod, ami fut amig te alszol.${NC}"
echo -e "${DIM}   ▘▘ ▝▝${NC}"
echo ""
echo -e "${DIM}  Telepito wizard - macOS${NC}"
echo ""

# Step 1: Check prerequisites
INSTALL_STEP="prerequisites"
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
  echo -e "${ORANGE}Hianyzo függőségek telepítése Homebrew-val...${NC}"
  if ! command -v brew &>/dev/null; then
    echo -e "${ORANGE}Homebrew nincs telepítve. Megprobalom most (sudo jelszo kellhet)...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Homebrew on Apple Silicon installs to /opt/homebrew; add it to PATH now
    # so subsequent `brew` calls in this script succeed without a shell restart.
    if [ -x /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
    if ! command -v brew &>/dev/null; then
      fail "Homebrew telepitese sikertelen. Telepitsd manualisan (https://brew.sh) es futtasd ujra az installert."
    fi
  fi
  command -v node &>/dev/null || brew install node@22
  command -v tmux &>/dev/null || brew install tmux
  command -v git &>/dev/null || brew install git
  echo -e "${GREEN}✓ Függőségek telepítve${NC}"
fi

# Bun (required by Telegram channels plugin)
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun &>/dev/null; then
  echo -e "  ${ORANGE}Bun telepítése (Telegram plugin függőség)...${NC}"
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  # Source the profile that bun installer modified
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null
  [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo -e "  ${RED}✗${NC} Bun telepites sikertelen. Probalj manuálisan: curl -fsSL https://bun.sh/install | bash"
  fi
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
    fail "Claude Code CLI szukseges a futtatashoz. Telepitsd: npm install -g @anthropic-ai/claude-code"
  fi
fi
echo -e "  ${GREEN}✓${NC} Claude Code CLI"

INSTALL_STEP="claude-setup"
# Step 2: Claude Code first-run flags (BEFORE auth login)
#
# Reason: ha a `claude auth login` browser-flow megakad (timeout, Ctrl+C,
# vagy a felhasznalo nem klikkel a "Trust this browser?"-ben), a `set -e`
# alatt a script kilep es a flag-set NEM fut le -- onnantol a tmux-spawned
# headless session orokre parkol a "Trust this folder" / theme-picker /
# Bypass Permissions promptokon. Tehat a flag-set FOLY-RA `auth login`
# ELOTT, hogy ezek a defensive default-ok mindenkeppen a helyukre keruljenek.
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
echo -e "  ${GREEN}✓${NC} Claude Code first-run flags pre-set"

INSTALL_STEP="claude-auth"
# Step 2b: Claude authentication (kept tolerant -- ha megakad, folytatjuk)
echo ""
echo -e "${BOLD}[2/7] Claude bejelentkezes${NC}"
echo -e "${DIM}  Ha meg nem jelentkeztel be, most megteheted.${NC}"
echo -e "${DIM}  Ha a browser-os authorize-flow megakad, Ctrl+C-vel kilephetsz${NC}"
echo -e "${DIM}  -- a telepites folytatodik, kesobb manualisan tudsz belepni.${NC}"
read -p "  Szeretned most bejelentkezni? (i/n) " DO_AUTH
if [ "$DO_AUTH" = "i" ]; then
  set +e
  claude auth login
  AUTH_RC=$?
  set -e
  if [ "$AUTH_RC" -ne 0 ]; then
    echo -e "  ${ORANGE}⚠${NC} Auth login nem fejezodott be sikeresen (exit $AUTH_RC)."
    echo -e "  ${DIM}A telepites folytatodik. Belepheted kesobb: ${BOLD}claude auth login${NC}"
  fi
fi
echo -e "  ${GREEN}✓${NC} Claude Code first-run beállítás kész"

INSTALL_STEP="personal-info"
# Step 3: Personal info
echo ""
echo -e "${BOLD}[3/7] Személyes beállítások${NC}"
read -p "  Mi a neved? " OWNER_NAME
# Chat ID is NOT asked here -- the user doesn't know it yet.
# It will be set automatically during the Telegram pairing flow.
CHAT_ID="0"

INSTALL_STEP="channel-setup"
# Step 4: Channel provider setup
echo ""
echo -e "${BOLD}[4/7] Csatorna beállítás${NC}"
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
echo -e "  ${GREEN}✓${NC} Csatorna: $CHANNEL_PROVIDER"

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
  echo -e "${DIM}  3. Adj hozza scope-okat: chat:write, channels:read, files:write${NC}"
  echo -e "${DIM}  4. Installald a workspace-be${NC}"
  echo ""
  read -p "  Bot Token (xoxb-...): " SLACK_BOT_TOKEN
  read -p "  App-Level Token (xapp-...): " SLACK_APP_TOKEN

  # Managed settings: Claude Code requires allowedChannelPlugins at system level
  MANAGED_DIR="/Library/Application Support/ClaudeCode"
  MANAGED_FILE="$MANAGED_DIR/managed-settings.json"
  SLACK_ENTRY='{"plugin":"slack-channel","marketplace":"marveen-marketplace"}'
  TELEGRAM_ENTRY='{"plugin":"telegram","marketplace":"claude-plugins-official"}'
  REQUIRED_JSON="{\"allowedChannelPlugins\":[$SLACK_ENTRY,$TELEGRAM_ENTRY]}"

  if [ -f "$MANAGED_FILE" ]; then
    HAS_SLACK=$(sudo python3 -c "
import json, sys
try:
  d = json.load(open('$MANAGED_FILE'))
  plugins = d.get('allowedChannelPlugins', [])
  sys.exit(0 if any(p.get('plugin')=='slack-channel' and p.get('marketplace')=='marveen-marketplace' for p in plugins) else 1)
except: sys.exit(1)
" 2>/dev/null && echo "yes" || echo "no")
    if [ "$HAS_SLACK" = "no" ]; then
      echo -e "  ${ORANGE}⚠${NC} A managed-settings.json frissítése szükséges (sudo)."
      echo "$REQUIRED_JSON" | sudo python3 -c "
import json, sys
new = json.loads(sys.stdin.read())
try:
  with open('$MANAGED_FILE') as f: existing = json.load(f)
except: existing = {}
plugins = existing.get('allowedChannelPlugins', [])
for entry in new['allowedChannelPlugins']:
  if not any(p.get('plugin')==entry['plugin'] and p.get('marketplace')==entry['marketplace'] for p in plugins):
    plugins.append(entry)
existing['allowedChannelPlugins'] = plugins
print(json.dumps(existing, indent=2))
" | sudo tee "$MANAGED_FILE" > /dev/null
      echo -e "  ${GREEN}✓${NC} managed-settings.json frissítve"
    else
      echo -e "  ${GREEN}✓${NC} managed-settings.json mar tartalmazza a Slack plugint"
    fi
  else
    echo -e "  ${ORANGE}⚠${NC} Managed settings létrehozása szükséges (sudo)."
    sudo mkdir -p "$MANAGED_DIR"
    echo "$REQUIRED_JSON" | python3 -c "import json,sys; print(json.dumps(json.loads(sys.stdin.read()),indent=2))" | sudo tee "$MANAGED_FILE" > /dev/null
    echo -e "  ${GREEN}✓${NC} managed-settings.json létrehozva"
  fi
fi

read -p "  Mi legyen a botod neve? [Marveen]: " BOT_NAME
BOT_NAME=${BOT_NAME:-"Marveen"}

# Derive the ASCII slug the backend uses everywhere (tmux sessions, plist
# labels, DB agent_id, API routing). NFKD + ASCII + lowercase dashes, empty
# fallback to "marveen" so we never end up with a blank identifier.
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

# Step 5: Install dependencies
INSTALL_STEP="npm-install"
echo ""
echo -e "${BOLD}[5/7] Függőségek telepítése...${NC}"
cd "$INSTALL_DIR"
if ! npm install --loglevel warn; then
  fail "npm install sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "npm csomagok telepítve"

# Build TypeScript
INSTALL_STEP="typescript-build"
echo -e "  Forditas..."
if ! npm run build --loglevel warn; then
  fail "TypeScript forditas sikertelen. Ellenorizd a hibauzeneteket fentebb."
fi
ok "TypeScript leforditva"

INSTALL_STEP="configuration"
# Step 6: Configuration
echo ""
echo -e "${BOLD}[6/7] Konfiguráció létrehozása...${NC}"

# Create .env
(umask 077 && cat > "$INSTALL_DIR/.env" << ENVEOF
# Main agent konfiguracio
CHANNEL_PROVIDER=${CHANNEL_PROVIDER}
OWNER_NAME=${OWNER_NAME}
BOT_NAME=${BOT_NAME}
MAIN_AGENT_ID=${MAIN_AGENT_ID}
ENVEOF
)
# Append provider-specific tokens
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  echo "TELEGRAM_BOT_TOKEN=${BOT_TOKEN}" >> "$INSTALL_DIR/.env"
  echo "ALLOWED_CHAT_ID=${CHAT_ID}" >> "$INSTALL_DIR/.env"
else
  echo "SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}" >> "$INSTALL_DIR/.env"
  echo "SLACK_APP_TOKEN=${SLACK_APP_TOKEN}" >> "$INSTALL_DIR/.env"
fi
chmod 600 "$INSTALL_DIR/.env"
echo -e "  ${GREEN}✓${NC} .env létrehozva (chmod 600)"

# Create store directory
mkdir -p "$INSTALL_DIR/store"
mkdir -p "$INSTALL_DIR/agents"
echo -e "  ${GREEN}✓${NC} Könyvtárak létrehozva"

# Generate CLAUDE.md from template
if [ -f "$INSTALL_DIR/templates/CLAUDE.md.template" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
      -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
      -e "s/{{CHAT_ID}}/$CHAT_ID/g" \
      -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
      -e "s/{{MAIN_AGENT_ID}}/$MAIN_AGENT_ID/g" \
      "$INSTALL_DIR/templates/CLAUDE.md.template" > "$INSTALL_DIR/CLAUDE.md"
  echo -e "  ${GREEN}✓${NC} CLAUDE.md generalva"
else
  echo -e "  ${ORANGE}⚠${NC} CLAUDE.md.template nem talalhato, CLAUDE.md nem generalhato"
fi

# Generate SOUL.md from template (personality definition for the main agent).
# Sub-agents get theirs from the LLM generator, but the main agent didn't
# have one before, so the dashboard showed "Nincs SOUL.md".
if [ -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  sed -e "s/{{OWNER_NAME}}/$OWNER_NAME/g" \
      -e "s/{{BOT_NAME}}/$BOT_NAME/g" \
      "$INSTALL_DIR/templates/SOUL.md.template" > "$INSTALL_DIR/SOUL.md"
  echo -e "  ${GREEN}✓${NC} SOUL.md generalva"
elif [ ! -f "$INSTALL_DIR/templates/SOUL.md.template" ] && [ ! -f "$INSTALL_DIR/SOUL.md" ]; then
  echo -e "  ${ORANGE}⚠${NC} SOUL.md.template nem talalhato, SOUL.md nem generalhato"
fi

# Scaffold default scheduled tasks into ~/.claude/scheduled-tasks/. Templates
# carry {{MAIN_AGENT_ID}} placeholders so tasks target the user's chosen agent
# slug rather than hardcoded "marveen". Skip task dirs that already exist --
# never overwrite user customizations.
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
    echo -e "  ${GREEN}✓${NC} Utemezett feladat scaffoldolva: $task_name"
  done
fi

# Setup channel state directory
CHANNEL_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"
mkdir -p "$CHANNEL_DIR"

if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  (umask 077 && echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" > "$CHANNEL_DIR/.env")
  chmod 600 "$CHANNEL_DIR/.env"
  cat > "$CHANNEL_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} Telegram csatorna konfigurálva"
elif [ "$CHANNEL_PROVIDER" = "slack" ] && [ -n "$SLACK_BOT_TOKEN" ]; then
  (umask 077 && cat > "$CHANNEL_DIR/.env" << SLACKENVEOF
SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN
SLACK_APP_TOKEN=$SLACK_APP_TOKEN
SLACKENVEOF
  )
  chmod 600 "$CHANNEL_DIR/.env"
  cat > "$CHANNEL_DIR/access.json" << ACCESSEOF
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
ACCESSEOF
  echo -e "  ${GREEN}✓${NC} Slack csatorna konfigurálva"
fi

# Install channel plugin
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  PLUGIN_MARKETPLACE="anthropics/claude-plugins-official"
  PLUGIN_ID="telegram@claude-plugins-official"
else
  PLUGIN_MARKETPLACE="jeremylongshore/claude-code-slack-channel"
  PLUGIN_ID="slack@jeremylongshore/claude-code-slack-channel"
fi

echo -e "  ${CHANNEL_PROVIDER} plugin telepites..."
claude plugin marketplace add "$PLUGIN_MARKETPLACE" 2>/dev/null || true
if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} ${CHANNEL_PROVIDER} plugin telepítve"
else
  echo -e "  ${ORANGE}Elso probalkozas sikertelen, ujraprobalok...${NC}"
  sleep 2
  if claude plugin install "$PLUGIN_ID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} ${CHANNEL_PROVIDER} plugin telepítve (masodik próbálkozással)"
  else
    echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin telepites sikertelen."
    echo -e "  ${BOLD}Futtasd kesobb kezzel:${NC}"
    echo -e "  ${BLUE}claude plugin install ${PLUGIN_ID}${NC}"
    echo ""
  fi
fi

# Install skill-factory (self-learning meta-skill)
SKILLS_DIR="$HOME/.claude/skills"
if [ -d "$INSTALL_DIR/skills/skill-factory" ]; then
  mkdir -p "$SKILLS_DIR/skill-factory"
  cp -r "$INSTALL_DIR/skills/skill-factory/"* "$SKILLS_DIR/skill-factory/"
  echo -e "  ${GREEN}✓${NC} skill-factory telepítve"
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
    echo -e "  ${GREEN}✓${NC} Seed skills: ${SEED_NEW} új, ${SEED_SKIP} kihagyva (már létezik)"
  fi
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
    echo -e "  ${GREEN}✓${NC} Seed scheduled tasks: ${SCHED_NEW} új, ${SCHED_SKIP} kihagyva"
  fi
  # Init state files for seeded tasks
  if [ "$SCHED_NEW" -gt 0 ]; then
    STATE_FILE="$INSTALL_DIR/store/kanban-audit-state.json"
    if [ ! -f "$STATE_FILE" ]; then
      echo '{"last_audit_at":null}' > "$STATE_FILE"
      echo -e "  ${GREEN}✓${NC} kanban-audit state inicializálva"
    fi
  fi

  # Seed bumblebee threat-intel catalogs into ~/.claude/tools/
  BB_SEED_TI="$SEED_SCHED_DIR/bumblebee-hygiene-scan/threat-intel"
  BB_TARGET_TI="$HOME/.claude/tools/bumblebee-threat-intel"
  if [ -d "$BB_SEED_TI" ] && [ ! -d "$BB_TARGET_TI" ]; then
    mkdir -p "$BB_TARGET_TI"
    cp "$BB_SEED_TI"/*.json "$BB_TARGET_TI/" 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Bumblebee threat-intel katalógusok telepítve"
  fi
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
      echo -e "  ${GREEN}✓${NC} Seed config: $cfg_name"
    fi
  done
fi

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

INSTALL_STEP="launchagent"
# Step 7: LaunchAgent setup
echo ""
echo -e "${BOLD}[7/7] Automatikus indítás beállítása...${NC}"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

NODE_PATH="$(which node)"
DASHBOARD_PLIST="com.${MAIN_AGENT_ID}.dashboard"
CHANNELS_PLIST="com.${MAIN_AGENT_ID}.channels"

# Dashboard service
cat > "$PLIST_DIR/${DASHBOARD_PLIST}.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DASHBOARD_PLIST}</string>
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
cat > "$PLIST_DIR/${CHANNELS_PLIST}.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHANNELS_PLIST}</string>
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
  <key>ThrottleInterval</key>
  <integer>30</integer>
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
    <key>USER</key>
    <string>${USER}</string>
    <key>TERM</key>
    <string>xterm-256color</string>
    <key>LANG</key>
    <string>${LANG:-en_US.UTF-8}</string>
  </dict>
</dict>
</plist>
PLISTEOF

echo -e "  ${GREEN}✓${NC} LaunchAgent-ek létrehozva"

# Load LaunchAgents
launchctl load "$PLIST_DIR/${DASHBOARD_PLIST}.plist" 2>/dev/null || true
launchctl load "$PLIST_DIR/${CHANNELS_PLIST}.plist" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Szolgaltatasok elinditva"

# Verify channel plugin is working
sleep 3
echo ""
echo -e "${BOLD}Ellenorzes...${NC}"
if [ "$CHANNEL_PROVIDER" = "telegram" ] && ! command -v bun &>/dev/null; then
  echo -e "  ${RED}✗${NC} Bun nem talalhato. A Telegram plugin nem fog mukodni."
  echo -e "  ${BOLD}Javitas:${NC} curl -fsSL https://bun.sh/install | bash"
  echo -e "  ${DIM}Utana: source ~/.zshrc && ./scripts/start.sh${NC}"
fi
PLUGIN_CHECK_PATTERN="${CHANNEL_PROVIDER}"
if ! claude plugin list 2>/dev/null | grep -q "$PLUGIN_CHECK_PATTERN"; then
  echo -e "  ${RED}✗${NC} ${CHANNEL_PROVIDER} plugin nincs telepítve."
  echo -e "  ${BOLD}Javitas:${NC} claude plugin install ${PLUGIN_ID}"
  echo -e "  ${DIM}Utana: ./scripts/stop.sh && ./scripts/start.sh${NC}"
else
  echo -e "  ${GREEN}✓${NC} ${CHANNEL_PROVIDER} plugin ellenorizve"
fi

# Channel pairing flow (Telegram only; Slack uses OAuth / App install)
if [ "$CHANNEL_PROVIDER" = "telegram" ] && [ -n "$BOT_TOKEN" ]; then
  echo ""
  echo -e "${BOLD}Telegram parositas${NC}"
  echo -e "${DIM}  A bot fut, most ossze kell parosítanod vele.${NC}"
  echo ""
  echo -e "  ${BOLD}1.${NC} Nyisd meg a Telegram appot es irj a botodnak (barmit, pl. \"Szia\")"
  echo -e "  ${BOLD}2.${NC} A bot kuld neked egy parosito kodot"
  echo -e "  ${BOLD}3.${NC} Masold ide a kapott kodot:"
  echo ""
  read -p "  Parosito kod (vagy hagyd uresen ha kesobb csinalod): " PAIR_CODE
  if [ -n "$PAIR_CODE" ]; then
    ACCESS_FILE="$CHANNEL_DIR/access.json"
    if [ -f "$ACCESS_FILE" ]; then
      # Get the chat ID from the pending pairing in access.json
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
        # Approve the pairing and switch to allowlist
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
        sed -i '' "s/^ALLOWED_CHAT_ID=.*/ALLOWED_CHAT_ID=${CHAT_ID}/" "$INSTALL_DIR/.env"
        ok "Parositas sikeres! (chat ID: $PENDING_CHAT_ID)"
        ok ".env ALLOWED_CHAT_ID frissitve"
        ok "Policy: allowlist (csak te erheted el a botot)"
      else
        # Fallback: try tmux send-keys approach
        echo -e "  ${ORANGE}A kod nem talalhato az access.json-ban.${NC}"
        echo -e "  ${DIM}Probald kesobb a terminalban: claude, majd /telegram:access pair $PAIR_CODE${NC}"
      fi
    fi
  else
    echo -e "  ${DIM}Rendben, kesobb is parosithatsz.${NC}"
    echo -e "  ${DIM}Futtasd: claude, majd /telegram:access pair AKOD${NC}"
  fi
fi

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

# Done!
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}${GREEN}  ✓ Marveen sikeresen telepítve!${NC}"
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
echo -e "  ${BOLD}Telegram:${NC} Irj a botodnak!"
echo ""
echo -e "  ${DIM}Kovetkezo lepesek:${NC}"
echo -e "  ${DIM}1. Nyisd meg a dashboardot a fenti URL-lel${NC}"
echo -e "  ${DIM}2. Irj a botodnak Telegramon -- mar valaszolnia kell${NC}"
echo -e "  ${DIM}3. A Csapat oldalon hozhatsz letre tobb agenst${NC}"
echo ""
echo -e "  ${DIM}Frissites: ./update.sh${NC}"
echo -e "  ${DIM}Leallitas: ./scripts/stop.sh${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
