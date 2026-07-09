#!/usr/bin/env bash
# One-command post-install Claude Code auth for a Marveen install that was set up
# WITHOUT auth (installer option 3, "skip / set up later"). Prompts for an OAuth
# setup-token or an API key, writes it into <install>/.env, restarts the Marveen
# services, and verifies.
#
# SAFE + TARGETED: it ONLY updates the chosen Claude auth line in .env (atomic,
# no duplicate lines, every other env var preserved) and restarts the services.
# It does NOT re-run the installer and NEVER touches owner / access / identity
# config (no access.json / owner-config / CLAUDE.md clobber) -- so it cannot
# lock the owner out. Idempotent (re-run safe) and reversible (remove the line).
#
# macOS (launchctl) + Linux (systemd --user), root-VPS-aware.
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$INSTALL_DIR/.env"

BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[0;32m'; ORANGE='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${ORANGE}!${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*"; }

echo -e "${BOLD}Marveen -- Claude Code auth beallitasa${NC}"
echo -e "  Install: $INSTALL_DIR"
echo ""

# --- 1. Auth method + value ---
echo -e "  ${BOLD}1.${NC} OAuth token  ${DIM}(Pro/Max elofizetes -- egy bongeszos gepen: claude setup-token)${NC}"
echo -e "  ${BOLD}2.${NC} API key      ${DIM}(Anthropic Console, pay-as-you-go)${NC}"
read -rp "  Valasztas [1]: " MODE
MODE="${MODE:-1}"
if [ "$MODE" = "2" ]; then
  AUTH_KEY="ANTHROPIC_API_KEY"; OTHER_KEY="CLAUDE_CODE_OAUTH_TOKEN"
  read -rp "  ANTHROPIC_API_KEY (sk-ant-...): " AUTH_VAL
else
  AUTH_KEY="CLAUDE_CODE_OAUTH_TOKEN"; OTHER_KEY="ANTHROPIC_API_KEY"
  echo -e "  ${DIM}Egy bongeszos gepen: claude setup-token -> masold ide a tokent.${NC}"
  read -rp "  OAuth token (sk-ant-oat01-...): " AUTH_VAL
fi
AUTH_VAL="$(printf '%s' "$AUTH_VAL" | tr -d '[:space:]')"
if [ -z "$AUTH_VAL" ]; then err "Ures ertek -- kilepes, .env valtozatlan."; exit 1; fi

# --- 2. Safe idempotent .env update (atomic; never sed; preserves other env) ---
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
umask 077
touch "$ENV_FILE" 2>/dev/null || { err "Nem irhato: $ENV_FILE"; exit 1; }
tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || { err "mktemp sikertelen"; exit 1; }
# Drop any prior line for the chosen key, keep everything else verbatim, append new.
grep -v "^${AUTH_KEY}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
printf '%s=%s\n' "$AUTH_KEY" "$AUTH_VAL" >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
ok "$AUTH_KEY frissitve: $ENV_FILE (chmod 600)"
if grep -q "^${OTHER_KEY}=" "$ENV_FILE" 2>/dev/null; then
  warn "Megjegyzes: a masik auth-kulcs ($OTHER_KEY) is jelen van az .env-ben. Ha vissza akarsz valtani, tavolitsd el kezzel."
fi

# The credentials-guard (opt-in) reads the fleet OAuth token from this file; keep
# it in sync so a guarded install authenticates too. Harmless when unused.
if [ "$AUTH_KEY" = "CLAUDE_CODE_OAUTH_TOKEN" ] && [ -d "$INSTALL_DIR/store" ]; then
  printf '%s' "$AUTH_VAL" > "$INSTALL_DIR/store/.claude-oauth-token" 2>/dev/null \
    && chmod 600 "$INSTALL_DIR/store/.claude-oauth-token" 2>/dev/null \
    && ok "store/.claude-oauth-token szinkronban (credentials-guard)"
fi

# --- 3. Restart services (owner/access config UNTOUCHED) ---
SLUG="$(grep -E '^MAIN_AGENT_ID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
SLUG="${SLUG:-marveen}"
echo ""
echo -e "  Szolgaltatasok ujrainditasa..."
if [ -x "$INSTALL_DIR/scripts/stop.sh" ] && [ -x "$INSTALL_DIR/scripts/start.sh" ]; then
  "$INSTALL_DIR/scripts/stop.sh" >/dev/null 2>&1 || true
  "$INSTALL_DIR/scripts/start.sh" >/dev/null 2>&1 || true
else
  case "$(uname -s)" in
    Darwin) launchctl kickstart -k "gui/$(id -u)/com.${SLUG}.dashboard" 2>/dev/null || true
            launchctl kickstart -k "gui/$(id -u)/com.${SLUG}.channels" 2>/dev/null || true ;;
    Linux)  systemctl --user restart "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null || true ;;
    *)      warn "Ismeretlen OS -- indits ujra kezzel: $INSTALL_DIR/scripts/start.sh" ;;
  esac
fi
ok "Szolgaltatasok ujrainditva (${SLUG}-dashboard / ${SLUG}-channels)"

# --- 4. Verify (auth status = no API-spend; doctor for the rest) ---
echo ""
echo -e "  Ellenorzes..."
if command -v claude >/dev/null 2>&1 && timeout 25 claude auth status </dev/null >/dev/null 2>&1; then
  ok "claude auth status: bejelentkezve"
else
  warn "claude auth status nem erositi meg a bejelentkezest -- ellenorizd a tokent/halozatot."
fi
if [ -x "$INSTALL_DIR/scripts/doctor.sh" ]; then
  echo ""
  bash "$INSTALL_DIR/scripts/doctor.sh" || true
fi
echo ""
ok "Kesz. Ha a bejovo channel-uzenetek meg sem jonnek, futtasd: bash $INSTALL_DIR/scripts/doctor.sh"
