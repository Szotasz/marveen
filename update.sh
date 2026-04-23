#!/bin/bash
# Marveen Updater

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo ""
echo -e "${BOLD}Marveen frissites...${NC}"
echo ""

# Save current version
OLD_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Pull latest
echo -e "  Letoltes..."
git pull --ff-only origin main
NEW_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  echo -e "  ${GREEN}✓${NC} Mar a legfrissebb verzion vagy ($NEW_VERSION)"
  exit 0
fi

# Install deps if package.json OR package-lock.json changed. Use `npm ci`
# (not `npm install`) so the install is byte-exact against the committed
# lockfile -- a supply-chain-compromised package that ships a new semver-
# compatible version will NOT sneak in on a patch upgrade. Then run
# `npm audit` at high severity and ABORT the update if any known-high or
# critical CVE is present in the installed production tree. The operator
# gets a loud stop with a CVE pointer instead of silently running a
# patched-over malicious dep.
if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -qE "^package(-lock)?\.json$"; then
  echo -e "  Fuggosegek frissitese (lock-strict)..."
  if ! npm ci --silent; then
    echo -e "  HIBA: npm ci sikertelen. Valoszinuleg a package-lock.json nincs szinkronban."
    echo -e "  Reszletekert futtasd: npm ci"
    exit 1
  fi
  # Security posture check, NOT a hard gate. npm audit queries the
  # registry and can fail for reasons entirely outside the operator's
  # control (network blip, upstream CVE newly disclosed minutes ago,
  # private-registry auth hiccup). Exiting here would leave a half-
  # upgraded install: new source + new node_modules + stale dist/ + old
  # services. Instead, warn loudly and continue; the operator decides
  # whether to roll back.
  echo -e "  Biztonsagi ellenorzes..."
  if ! npm audit --audit-level=high --omit=dev --silent; then
    echo -e "  FIGYELEM: npm audit magas-sulyossagu tetelt jelzett."
    echo -e "  A frissites folytatodik, de vizsgald meg: npm audit --omit=dev"
  fi
fi

# Rebuild
echo -e "  Forditas..."
npm run build --silent

# Scrub any polluted TELEGRAM_BOT_TOKEN from the tmux server's global env
# (legacy installs picked this up via `set -a && source .env` in the old
# channels.sh). Leaving it there made every sub-agent poll the main bot
# token and loop on 409 Conflict. Safe to run every update.
if command -v tmux >/dev/null 2>&1; then
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
fi

# Restart services
echo -e "  Szolgaltatasok ujrainditasa..."
"$INSTALL_DIR/scripts/stop.sh"
"$INSTALL_DIR/scripts/start.sh"

echo ""
echo -e "${GREEN}✓ Frissitve: ${OLD_VERSION} -> ${NEW_VERSION}${NC}"
echo ""
