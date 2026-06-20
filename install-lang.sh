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
    # ── Tagline / wizard ─────────────────────────────────────────────
    en:tagline) echo "Your AI team, running while you sleep." ;;
    hu:tagline) echo "AI csapatod, ami fut amíg te alszol." ;;
    en:macos.wizard_title) echo "  Setup wizard - macOS" ;;
    hu:macos.wizard_title) echo "  Telepítő wizard - macOS" ;;
    en:linux.wizard_title) echo "  Setup wizard - Linux/VPS" ;;
    hu:linux.wizard_title) echo "  Telepítő wizard - Linux/VPS" ;;
    # ── Claude Code fallback ──────────────────────────────────────────
    en:macos.claude_available) echo "Claude Code is available on this machine." ;;
    hu:macos.claude_available) echo "Claude Code elérhető a gépen." ;;
    en:macos.fallback_manual) echo "  Run manually:" ;;
    hu:macos.fallback_manual) echo "  Futtasd manuálisan:" ;;
    # ── Prerequisites ─────────────────────────────────────────────────
    en:macos.missing) echo "- missing" ;;
    hu:macos.missing) echo "- hianyzik" ;;
    en:macos.install_missing_deps) echo "Installing missing dependencies via Homebrew..." ;;
    hu:macos.install_missing_deps) echo "Hianyzo függőségek telepítése Homebrew-val..." ;;
    en:macos.installing_homebrew) echo "Homebrew not found. Attempting install (sudo password may be required)..." ;;
    hu:macos.installing_homebrew) echo "Homebrew nincs telepítve. Megprobalom most (sudo jelszo kellhet)..." ;;
    en:macos.deps_installed) echo "✓ Dependencies installed" ;;
    hu:macos.deps_installed) echo "✓ Függőségek telepítve" ;;
    # ── Bun ──────────────────────────────────────────────────────────
    en:macos.installing_bun) echo "  Installing Bun (Telegram plugin dependency)..." ;;
    hu:macos.installing_bun) echo "  Bun telepítése (Telegram plugin függőség)..." ;;
    en:macos.bun_install_failed) echo "  Bun install failed. Try manually: curl -fsSL https://bun.sh/install | bash" ;;
    hu:macos.bun_install_failed) echo "  Bun telepites sikertelen. Probalj manuálisan: curl -fsSL https://bun.sh/install | bash" ;;
    # ── Claude Code CLI ───────────────────────────────────────────────
    en:macos.claude_missing) echo "  Claude Code CLI - missing" ;;
    hu:macos.claude_missing) echo "  Claude Code CLI - hianyzik" ;;
    en:macos.install_claude_hint) echo "Install: npm install -g @anthropic-ai/claude-code" ;;
    hu:macos.install_claude_hint) echo "Telepites: npm install -g @anthropic-ai/claude-code" ;;
    # ── Auth ──────────────────────────────────────────────────────────
    en:macos.auth_hint_1) echo "  If you haven't logged in yet, you can do so now." ;;
    hu:macos.auth_hint_1) echo "  Ha meg nem jelentkeztel be, most megteheted." ;;
    en:macos.auth_hint_2) echo "  If the browser auth flow hangs, press Ctrl+C to exit" ;;
    hu:macos.auth_hint_2) echo "  Ha a browser-os authorize-flow megakad, Ctrl+C-vel kilephetsz" ;;
    en:macos.auth_hint_3) echo "  -- the installation will continue, you can log in manually later." ;;
    hu:macos.auth_hint_3) echo "  -- a telepites folytatodik, kesobb manualisan tudsz belepni." ;;
    en:macos.auth_later) echo "  Installation continues. Log in later: claude auth login" ;;
    hu:macos.auth_later) echo "  A telepites folytatodik. Belepheted kesobb: claude auth login" ;;
    en:macos.firstrun_done) echo "  Claude Code first-run setup done" ;;
    hu:macos.firstrun_done) echo "  Claude Code first-run beállítás kész" ;;
    en:macos.headless_test) echo "  Headless Claude Code test..." ;;
    hu:macos.headless_test) echo "  Headless Claude Code teszt..." ;;
    en:macos.headless_ok) echo "  Headless Claude Code working (claude --print responded)" ;;
    hu:macos.headless_ok) echo "  Headless Claude Code futtathato (claude --print valaszolt)" ;;
    en:macos.headless_fail) echo "Headless Claude Code probe FAILED. Agent creation WILL fail later." ;;
    hu:macos.headless_fail) echo "Headless Claude Code probe SIKERTELEN. Az agent-letrehozas KESOBB EL fog hasalni." ;;
    # ── Channel selection ─────────────────────────────────────────────
    en:macos.channel_select_hint) echo "  Which channel should your AI assistant use?" ;;
    hu:macos.channel_select_hint) echo "  Melyik csatornan kommunikaljon az AI asszisztensed?" ;;
    en:macos.channel_option_1) echo "  1. Telegram (default)" ;;
    hu:macos.channel_option_1) echo "  1. Telegram (alapertelmezett)" ;;
    # ── Managed settings ──────────────────────────────────────────────
    en:macos.managed_update) echo "  managed-settings.json needs updating (sudo)." ;;
    hu:macos.managed_update) echo "  A managed-settings.json frissítése szükséges (sudo)." ;;
    en:macos.managed_updated) echo "  managed-settings.json updated" ;;
    hu:macos.managed_updated) echo "  managed-settings.json frissítve" ;;
    en:macos.managed_has_slack) echo "  managed-settings.json already contains the Slack plugin" ;;
    hu:macos.managed_has_slack) echo "  managed-settings.json mar tartalmazza a Slack plugint" ;;
    en:macos.managed_create) echo "  Managed settings creation required (sudo)." ;;
    hu:macos.managed_create) echo "  Managed settings létrehozása szükséges (sudo)." ;;
    en:macos.managed_created) echo "  managed-settings.json created" ;;
    hu:macos.managed_created) echo "  managed-settings.json létrehozva" ;;
    # ── Agent ID / build ──────────────────────────────────────────────
    en:macos.agent_id_info) echo "  Internal agent ID: " ;;
    hu:macos.agent_id_info) echo "  Ügynök belső azonosító: " ;;
    en:macos.npm_done) echo "npm packages installed" ;;
    hu:macos.npm_done) echo "npm csomagok telepítve" ;;
    en:macos.building) echo "  Building..." ;;
    hu:macos.building) echo "  Forditas..." ;;
    en:macos.ts_built) echo "TypeScript compiled" ;;
    hu:macos.ts_built) echo "TypeScript leforditva" ;;
    # ── Config files ──────────────────────────────────────────────────
    en:macos.env_created) echo "  .env created (chmod 600)" ;;
    hu:macos.env_created) echo "  .env létrehozva (chmod 600)" ;;
    en:macos.dirs_created) echo "  Directories created" ;;
    hu:macos.dirs_created) echo "  Könyvtárak létrehozva" ;;
    en:macos.claude_md_generated) echo "  CLAUDE.md generated" ;;
    hu:macos.claude_md_generated) echo "  CLAUDE.md generalva" ;;
    en:macos.soul_md_generated) echo "  SOUL.md generated" ;;
    hu:macos.soul_md_generated) echo "  SOUL.md generalva" ;;
    # ── Channel config ────────────────────────────────────────────────
    en:macos.tg_channel_configured) echo "  Telegram channel configured" ;;
    hu:macos.tg_channel_configured) echo "  Telegram csatorna konfigurálva" ;;
    en:macos.slack_channel_configured) echo "  Slack channel configured" ;;
    hu:macos.slack_channel_configured) echo "  Slack csatorna konfigurálva" ;;
    # ── Plugin ────────────────────────────────────────────────────────
    en:macos.plugin_retry) echo "  First attempt failed, retrying..." ;;
    hu:macos.plugin_retry) echo "  Elso probalkozas sikertelen, ujraprobalok..." ;;
    en:macos.plugin_manual_hint) echo "  Run manually later:" ;;
    hu:macos.plugin_manual_hint) echo "  Futtasd kesobb kezzel:" ;;
    # ── Skills / tasks ────────────────────────────────────────────────
    en:macos.skill_factory_installed) echo "  skill-factory installed" ;;
    hu:macos.skill_factory_installed) echo "  skill-factory telepítve" ;;
    en:macos.kanban_state_init) echo "  kanban-audit state initialized" ;;
    hu:macos.kanban_state_init) echo "  kanban-audit state inicializálva" ;;
    en:macos.bumblebee_installed) echo "  Bumblebee threat-intel catalogs installed" ;;
    hu:macos.bumblebee_installed) echo "  Bumblebee threat-intel katalógusok telepítve" ;;
    # ── Ollama ────────────────────────────────────────────────────────
    en:macos.ollama_check) echo "  Checking Ollama (semantic memory search)..." ;;
    hu:macos.ollama_check) echo "  Ollama ellenőrzés (szemantikus memória kereséshez)..." ;;
    en:macos.ollama_installed) echo "  Ollama installed" ;;
    hu:macos.ollama_installed) echo "  Ollama telepítve" ;;
    en:macos.ollama_installing) echo "  Installing Ollama..." ;;
    hu:macos.ollama_installing) echo "  Ollama telepítése..." ;;
    en:macos.ollama_starting) echo "  Starting Ollama..." ;;
    hu:macos.ollama_starting) echo "  Ollama indítás..." ;;
    en:macos.nomic_downloading) echo "  Downloading nomic-embed-text model (~274 MB)..." ;;
    hu:macos.nomic_downloading) echo "  nomic-embed-text modell letöltése (~274 MB)..." ;;
    en:macos.ollama_done) echo "  Ollama + nomic-embed-text ready" ;;
    hu:macos.ollama_done) echo "  Ollama + nomic-embed-text kész" ;;
    # ── Whisper / ffmpeg ──────────────────────────────────────────────
    en:macos.whisper_installing) echo "  Installing Whisper (speech-to-text)..." ;;
    hu:macos.whisper_installing) echo "  Whisper telepítés (beszéd -> szöveg leirat)..." ;;
    en:macos.mlx_whisper_installed) echo "  mlx-whisper already installed (Apple Silicon optimized)" ;;
    hu:macos.mlx_whisper_installed) echo "  mlx-whisper már telepítve (Apple Silicon optimalizált)" ;;
    en:macos.whisper_installed) echo "  whisper already installed" ;;
    hu:macos.whisper_installed) echo "  whisper már telepítve" ;;
    en:macos.ffmpeg_installing) echo "  Installing ffmpeg..." ;;
    hu:macos.ffmpeg_installing) echo "  ffmpeg telepítés..." ;;
    en:macos.ffmpeg_done) echo "  ffmpeg ready" ;;
    hu:macos.ffmpeg_done) echo "  ffmpeg kész" ;;
    # ── LaunchAgent / services ────────────────────────────────────────
    en:macos.launchagents_created) echo "  LaunchAgents created" ;;
    hu:macos.launchagents_created) echo "  LaunchAgent-ek létrehozva" ;;
    en:macos.services_started) echo "  Services started" ;;
    hu:macos.services_started) echo "  Szolgaltatasok elinditva" ;;
    # ── Telegram pairing ──────────────────────────────────────────────
    en:macos.tg_pairing_title) echo "Telegram pairing" ;;
    hu:macos.tg_pairing_title) echo "Telegram parositas" ;;
    en:macos.tg_pairing_hint) echo "  The bot is running, now pair it with your account." ;;
    hu:macos.tg_pairing_hint) echo "  A bot fut, most ossze kell parosítanod vele." ;;
    en:macos.pairing_later) echo "  OK, you can pair later." ;;
    hu:macos.pairing_later) echo "  Rendben, kesobb is parosithatsz." ;;
    # ── Migration section ─────────────────────────────────────────────
    en:macos.migration_title) echo "Migrating previous system" ;;
    hu:macos.migration_title) echo "Korábbi rendszer költöztetése" ;;
    en:macos.migration_hint) echo "  If you had a previous AI assistant (OpenClaw, custom bot), you can migrate its memory." ;;
    hu:macos.migration_hint) echo "  Ha volt korábbi AI asszisztensed (OpenClaw, egyéni bot), átmigrálhatod a memóriáját." ;;
    en:macos.migrate_missing) echo "  migrate.sh not found. Use the dashboard: http://localhost:3420 -> Migration" ;;
    hu:macos.migrate_missing) echo "  A migrate.sh nem található. Használd a dashboardot: http://localhost:3420 -> Költöztetés" ;;
    # ── Done section ──────────────────────────────────────────────────
    en:dash.token_hint) echo "  (Open once; the browser will remember the token)" ;;
    hu:dash.token_hint) echo "  (Nyisd meg egyszer, utana a bongeszo megjegyzi a tokent)" ;;
    en:dash.no_token_hint) echo "  (The token URL can be found in the server log)" ;;
    hu:dash.no_token_hint) echo "  (A tokenes URL-t a szerver logban talalod)" ;;
    en:telegram.write_hint) echo "  Telegram: Write to your bot!" ;;
    hu:telegram.write_hint) echo "  Telegram: Irj a botodnak!" ;;
    en:next_steps.title) echo "  Next steps:" ;;
    hu:next_steps.title) echo "  Kovetkezo lepesek:" ;;
    en:next_steps.1) echo "  1. Open the dashboard at the URL above" ;;
    hu:next_steps.1) echo "  1. Nyisd meg a dashboardot a fenti URL-lel" ;;
    en:next_steps.2) echo "  2. Write to your bot on Telegram -- it should respond" ;;
    hu:next_steps.2) echo "  2. Irj a botodnak Telegramon -- mar valaszolnia kell" ;;
    en:next_steps.3) echo "  3. On the Team page you can create more agents" ;;
    hu:next_steps.3) echo "  3. A Csapat oldalon hozhatsz letre tobb agenst" ;;
    en:next_steps.useful_title) echo "  Useful commands:" ;;
    hu:next_steps.useful_title) echo "  Hasznos parancsok:" ;;
    en:next_steps.update) echo "-- update" ;;
    hu:next_steps.update) echo "-- frissites" ;;
    en:next_steps.start) echo "-- start" ;;
    hu:next_steps.start) echo "-- inditas" ;;
    en:next_steps.stop) echo "-- stop" ;;
    hu:next_steps.stop) echo "-- leallitas" ;;
    # ── scripts/start.sh ──────────────────────────────────────────────
    # ── Linux-specific ───────────────────────────────────────────────
    en:linux.low_ram_prefix) echo "Low RAM:" ;;
    hu:linux.low_ram_prefix) echo "Kevés memória:" ;;
    en:linux.tg_channel_configured) echo "Telegram channel configured" ;;
    hu:linux.tg_channel_configured) echo "Telegram csatorna konfigurálva" ;;
    en:linux.slack_channel_configured) echo "Slack channel configured" ;;
    hu:linux.slack_channel_configured) echo "Slack csatorna konfigurálva" ;;
    en:linux.discord_channel_configured) echo "Discord channel configured" ;;
    hu:linux.discord_channel_configured) echo "Discord csatorna konfigurálva" ;;
    en:linux.ollama_starting) echo "  Starting Ollama service..." ;;
    hu:linux.ollama_starting) echo "  Ollama service indítása..." ;;
    en:linux.chan_restarted) echo "restarted (new config loaded)" ;;
    hu:linux.chan_restarted) echo "ujraindítva (uj konfig betoltve)" ;;
    en:linux.start_hint) echo "-- start" ;;
    hu:linux.start_hint) echo "-- indítás" ;;
    en:start.starting) echo "starting..." ;;
    hu:start.starting) echo "inditas..." ;;
    en:start.channel_started) echo "✓ Channel started" ;;
    hu:start.channel_started) echo "✓ Csatorna inditva" ;;
    # ── scripts/stop.sh ───────────────────────────────────────────────
    en:stop.stopping) echo "stopping..." ;;
    hu:stop.stopping) echo "leallitas..." ;;
    en:stop.stopped) echo "stopped" ;;
    hu:stop.stopped) echo "leallitva" ;;
    # ── scripts/migrate.sh ────────────────────────────────────────────
    en:migrate.title) echo "Marveen - System Migration" ;;
    hu:migrate.title) echo "Marveen - Rendszer költöztetés" ;;
    en:migrate.subtitle) echo "Migrating previous AI assistant" ;;
    hu:migrate.subtitle) echo "Korábbi AI asszisztens átmigrálása" ;;
    en:migrate.section_1) echo "[1/4] Source selection" ;;
    hu:migrate.section_1) echo "[1/4] Forrás megadása" ;;
    en:migrate.source_prompt) echo "  Where are you migrating from?" ;;
    hu:migrate.source_prompt) echo "  Honnan költözöl?" ;;
    en:migrate.source_2) echo "  2. Custom Claude bot / other system" ;;
    hu:migrate.source_2) echo "  2. Egyéni Claude bot / más rendszer" ;;
    en:migrate.source_3) echo "  3. Single directory (general)" ;;
    hu:migrate.source_3) echo "  3. Egyetlen mappa (általános)" ;;
    en:migrate.prompt_choose) echo "  Choose (1/2/3): " ;;
    hu:migrate.prompt_choose) echo "  Válassz (1/2/3): " ;;
    en:migrate.prompt_path) echo "  Workspace / directory path: " ;;
    hu:migrate.prompt_path) echo "  Workspace / mappa útvonala: " ;;
    en:migrate.prompt_agent) echo "  Import to which agent? [marveen]: " ;;
    hu:migrate.prompt_agent) echo "  Melyik ágenshez importáljak? [marveen]: " ;;
    en:migrate.section_2) echo "[2/4] Scanning source..." ;;
    hu:migrate.section_2) echo "[2/4] Rendszer feltérképezése..." ;;
    en:migrate.found_memory) echo "(cold memory)" ;;
    hu:migrate.found_memory) echo "(cold memória)" ;;
    en:migrate.found_soul) echo "(personality)" ;;
    hu:migrate.found_soul) echo "(személyiség)" ;;
    en:migrate.found_user) echo "(user profile)" ;;
    hu:migrate.found_user) echo "(felhasználói profil)" ;;
    en:migrate.found_agents) echo "(agent config)" ;;
    hu:migrate.found_agents) echo "(ágens konfig)" ;;
    en:migrate.found_tools) echo "(tools)" ;;
    hu:migrate.found_tools) echo "(eszközök)" ;;
    en:migrate.found_log) echo "(daily log)" ;;
    hu:migrate.found_log) echo "(napi napló)" ;;
    en:migrate.found_cron) echo "(scheduled tasks)" ;;
    hu:migrate.found_cron) echo "(ütemezés)" ;;
    en:migrate.found_memory_file) echo "(memory)" ;;
    hu:migrate.found_memory_file) echo "(memória)" ;;
    en:migrate.section_3) echo "[3/4] Migration..." ;;
    hu:migrate.section_3) echo "[3/4] Migráció..." ;;
    en:migrate.migrating_soul) echo "  Saving personality..." ;;
    hu:migrate.migrating_soul) echo "  Személyiség átmentése..." ;;
    en:migrate.migrated_soul) echo "  Personality saved to memory" ;;
    hu:migrate.migrated_soul) echo "  Személyiség mentve a memóriába" ;;
    en:migrate.migrating_user) echo "  Saving user profile..." ;;
    hu:migrate.migrating_user) echo "  Felhasználói profil átmentése..." ;;
    en:migrate.migrated_user) echo "  User profile saved" ;;
    hu:migrate.migrated_user) echo "  Felhasználói profil mentve" ;;
    en:migrate.importing_memories) echo "  Importing memories with AI categorization..." ;;
    hu:migrate.importing_memories) echo "  Memóriák importálása AI kategorizálással..." ;;
    en:migrate.total_prefix) echo "  Total: " ;;
    hu:migrate.total_prefix) echo "  Összesen: " ;;
    en:migrate.total_suffix) echo " files found" ;;
    hu:migrate.total_suffix) echo " fájl található" ;;
    en:migrate.chunks_prefix) echo " memory chunks to process..." ;;
    hu:migrate.chunks_prefix) echo " memória chunk feldolgozása..." ;;
    en:migrate.done) echo "  ✓ Migration complete!" ;;
    hu:migrate.done) echo "  ✓ Költöztetés kész!" ;;
    en:migrate.view_memories) echo "  Imported memories can be viewed on the dashboard:" ;;
    hu:migrate.view_memories) echo "  Az importált memóriák a dashboardon tekinthetők meg:" ;;
    # ── Fallback: return the key itself ──────────────────────────────
    *) echo "$key" ;;
  esac
}
