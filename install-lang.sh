#!/bin/bash
# Install script i18n helper — sourced by install-macos.sh and install-linux.sh
# MARVEEN_LANG=hu (default) or MARVEEN_LANG=en

_t() {
  local key="$1"
  local lang="${MARVEEN_LANG:-hu}"
  case "${lang}:${key}" in
    # ── Sections ──────────────────────────────────────────────────────
    en:section_1) echo "[1/7] Checking prerequisites..." ;;
    hu:section_1) echo "[1/7] Előfeltételek ellenőrzése..." ;;
    en:section_2_macos) echo "[2/7] Claude login" ;;
    hu:section_2_macos) echo "[2/7] Claude bejelentkezés" ;;
    en:section_2_linux) echo "[2/7] Claude Code + Bun installation..." ;;
    hu:section_2_linux) echo "[2/7] Claude Code + Bun telepítése..." ;;
    en:section_3_macos) echo "[3/7] Personal settings" ;;
    hu:section_3_macos) echo "[3/7] Személyes beállítások" ;;
    en:section_3_linux) echo "[3/7] Claude login" ;;
    hu:section_3_linux) echo "[3/7] Claude bejelentkezés" ;;
    en:section_4_macos) echo "[4/7] Channel setup" ;;
    hu:section_4_macos) echo "[4/7] Csatorna beállítás" ;;
    en:section_4_linux) echo "[4/7] Personal settings" ;;
    hu:section_4_linux) echo "[4/7] Személyes beállítások" ;;
    en:section_5) echo "[5/7] Installing dependencies..." ;;
    hu:section_5) echo "[5/7] Függőségek telepítése..." ;;
    en:section_6_macos) echo "[6/7] Creating configuration..." ;;
    hu:section_6_macos) echo "[6/7] Konfiguráció létrehozása..." ;;
    en:section_6_linux) echo "[6/7] Ollama + Whisper..." ;;
    hu:section_6_linux) echo "[6/7] Ollama + Whisper..." ;;
    en:section_7) echo "[7/7] Setting up autostart..." ;;
    hu:section_7) echo "[7/7] Automatikus indítás beállítása..." ;;
    en:section_checks) echo "Verification..." ;;
    hu:section_checks) echo "Ellenőrzés..." ;;
    # ── Interactive prompts ───────────────────────────────────────────
    en:prompt_open_claude) echo "  Open Claude Code to diagnose the error? (y/n) [n]: " ;;
    hu:prompt_open_claude) echo "  Megnyissam Claude Code-ot a hiba diagnosztizálásához? (i/n) [n]: " ;;
    en:prompt_install_claude) echo "Install now? (y/n) " ;;
    hu:prompt_install_claude) echo "Telepítsem most? (i/n) " ;;
    en:prompt_login) echo "  Would you like to log in now? (y/n) " ;;
    hu:prompt_login) echo "  Szeretnéd most bejelentkezni? (i/n) " ;;
    en:prompt_your_name) echo "  Your name? " ;;
    hu:prompt_your_name) echo "  Mi a neved? " ;;
    en:prompt_channel_select_macos) echo "  Choose (1/2) [1]: " ;;
    hu:prompt_channel_select_macos) echo "  Válassz (1/2) [1]: " ;;
    en:prompt_channel_select_linux) echo "  Choose (1/2/3) [1]: " ;;
    hu:prompt_channel_select_linux) echo "  Válassz (1/2/3) [1]: " ;;
    en:prompt_telegram_token) echo "  Telegram bot token (or leave empty, set later): " ;;
    hu:prompt_telegram_token) echo "  Telegram bot token (vagy hagyd üresen, később is beállíthatod): " ;;
    en:prompt_slack_bot_token) echo "  Bot Token (xoxb-...): " ;;
    hu:prompt_slack_bot_token) echo "  Bot Token (xoxb-...): " ;;
    en:prompt_slack_app_token) echo "  App-Level Token (xapp-...): " ;;
    hu:prompt_slack_app_token) echo "  App-Level Token (xapp-...): " ;;
    en:prompt_discord_bot_token) echo "  Discord bot token (or leave empty, set later): " ;;
    hu:prompt_discord_bot_token) echo "  Discord bot token (vagy hagyd üresen, később is beállíthatod): " ;;
    en:prompt_discord_channel_id) echo "  Discord channel ID: " ;;
    hu:prompt_discord_channel_id) echo "  Discord channel ID: " ;;
    en:prompt_discord_user_id) echo "  Your Discord user ID (operator): " ;;
    hu:prompt_discord_user_id) echo "  A Te Discord user ID-d (operator): " ;;
    en:prompt_bot_name) echo "  What should your bot be named? [Marveen]: " ;;
    hu:prompt_bot_name) echo "  Mi legyen a botod neve? [Marveen]: " ;;
    en:prompt_pair_code) echo "  Pairing code (or leave empty, do it later): " ;;
    hu:prompt_pair_code) echo "  Párosító kód (vagy hagyd üresen, ha később csinálod): " ;;
    en:prompt_migrate) echo "  Would you like to run the migration now? (y/n) [n]: " ;;
    hu:prompt_migrate) echo "  Szeretnéd most futtatni a költöztetést? (i/n) [n]: " ;;
    en:prompt_whisper) echo "  Would you like to install Whisper? (y/n) [n]: " ;;
    hu:prompt_whisper) echo "  Szeretnéd telepíteni a Whisper-t? (i/n) [n]: " ;;
    en:prompt_swap) echo "  Create a 2 GB swap file? (y/n) [y]: " ;;
    hu:prompt_swap) echo "  Létrehozzak 2 GB swap fájlt? (i/n) [i]: " ;;
    en:prompt_vps_continue) echo "  Continue installation? (y/n) [y]: " ;;
    hu:prompt_vps_continue) echo "  Folytassam a telepítést? (i/n) [i]: " ;;
    en:prompt_auth_mode) echo "  Choice (1/2/3) [2]: " ;;
    hu:prompt_auth_mode) echo "  Választás (1/2/3) [2]: " ;;
    # ── Key messages ─────────────────────────────────────────────────
    en:warn_pair_missing) echo "  WARNING: Telegram pairing was not completed!" ;;
    hu:warn_pair_missing) echo "  FIGYELEM: Telegram párosítás nem történt meg!" ;;
    en:success_installed) echo "  ✓ Marveen successfully installed!" ;;
    hu:success_installed) echo "  ✓ Marveen sikeresen telepítve!" ;;
    # ── Fallback: return the key itself ──────────────────────────────
    *) echo "$key" ;;
  esac
}
