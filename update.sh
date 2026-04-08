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

# Install deps if package.json changed
if git diff "$OLD_VERSION" "$NEW_VERSION" --name-only | grep -q "package.json"; then
  echo -e "  Fuggosegek frissitese..."
  npm install --silent
fi

# Rebuild
echo -e "  Forditas..."
npm run build --silent

# Restart services
echo -e "  Szolgaltatasok ujrainditasa..."
launchctl unload "$HOME/Library/LaunchAgents/com.marveen.dashboard.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.marveen.dashboard.plist" 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/com.marveen.channels.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.marveen.channels.plist" 2>/dev/null || true

echo ""
echo -e "${GREEN}✓ Frissitve: ${OLD_VERSION} -> ${NEW_VERSION}${NC}"
echo ""
