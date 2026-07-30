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
    en:macos.managed_has_slack) echo "  managed-settings.json already contains the channel plugins" ;;
    hu:macos.managed_has_slack) echo "  managed-settings.json mar tartalmazza a csatorna-pluginokat" ;;
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
    en:macos.migrate_missing) echo "  migrate.sh not found. Use the dashboard: http://localhost:${WEB_PORT:-3420} -> Migration" ;;
    hu:macos.migrate_missing) echo "  A migrate.sh nem található. Használd a dashboardot: http://localhost:${WEB_PORT:-3420} -> Költöztetés" ;;
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
    # APTLOCK1: dpkg/apt lock waiting (fresh Ubuntu/WSL: apt-daily holds it briefly)
    en:linux.apt_lock_waiting_prefix) echo "The package manager is busy (another process holds the dpkg lock):" ;;
    hu:linux.apt_lock_waiting_prefix) echo "A csomagkezelő foglalt (egy másik folyamat fogja a dpkg zárolást):" ;;
    en:linux.apt_lock_transient_hint) echo "On a fresh system this is usually the automatic update (apt-daily/unattended-upgrades) and clears on its own -- waiting up to 5 minutes..." ;;
    hu:linux.apt_lock_transient_hint) echo "Friss rendszeren ez általában az automatikus frissítés (apt-daily/unattended-upgrades), magától elenged -- várakozás legfeljebb 5 percig..." ;;
    en:linux.apt_lock_still_prefix) echo "still held by:" ;;
    hu:linux.apt_lock_still_prefix) echo "még mindig fogja:" ;;
    en:linux.apt_lock_freed_prefix) echo "Package manager lock released after" ;;
    hu:linux.apt_lock_freed_prefix) echo "A csomagkezelő zárolás felszabadult" ;;
    en:linux.apt_lock_unknown) echo "Cannot check who holds the package-manager lock (fuser not installed) -- if it is busy, apt itself will wait up to 3 minutes." ;;
    hu:linux.apt_lock_unknown) echo "Nem tudom megnézni, ki fogja a csomagkezelő zárolást (nincs fuser) -- ha foglalt, az apt maga vár rá legfeljebb 3 percig." ;;
    en:linux.apt_lock_timeout_head) echo "The package-manager lock is STILL held after 5 minutes by:" ;;
    hu:linux.apt_lock_timeout_head) echo "A csomagkezelő zárolást 5 perc után is fogja:" ;;
    en:linux.apt_lock_timeout_body1) printf '%s\n    sudo lsof /var/lib/dpkg/lock-frontend' "This is no longer the usual transient auto-update. Check what holds it (copy the line below):" ;;
    hu:linux.apt_lock_timeout_body1) printf '%s\n    sudo lsof /var/lib/dpkg/lock-frontend' "Ez már nem a szokásos átmeneti auto-frissítés. Nézd meg, mi fogja (másold az alábbi sort):" ;;
    en:linux.apt_lock_timeout_body2) printf '%s\n    sudo systemctl status unattended-upgrades\n%s' "If it is unattended-upgrades, let it finish -- status (copy the line below):" "  then re-run this installer. Do NOT kill a running dpkg." ;;
    hu:linux.apt_lock_timeout_body2) printf '%s\n    sudo systemctl status unattended-upgrades\n%s' "Ha az unattended-upgrades az, várd meg amíg végez -- állapot (másold az alábbi sort):" "  majd indítsd újra ezt a telepítőt. Futó dpkg-t NE lőj ki." ;;
    en:linux.apt_lock_timeout_fail) echo "Package manager is locked by another process -- re-run the installer once it finished." ;;
    hu:linux.apt_lock_timeout_fail) echo "A csomagkezelőt egy másik folyamat zárolja -- ha végzett, indítsd újra a telepítőt." ;;
    # MACOSOLD1: macOS version pre-flight before relying on Homebrew
    en:macos.ver_unknown) echo "Could not determine the macOS version (sw_vers failed) -- continuing, but if Homebrew fails, that may be why." ;;
    hu:macos.ver_unknown) echo "Nem sikerült megállapítani a macOS verziót (sw_vers hiba) -- folytatom, de ha a Homebrew elhasal, ez lehet az oka." ;;
    en:macos.ver_too_old_head) echo "This Mac runs macOS" ;;
    hu:macos.ver_too_old_head) echo "Ezen a gépen macOS" ;;
    en:macos.ver_too_old_body1) echo "Homebrew (which installs the dependencies) does not run on macOS older than 10.15, so installation cannot continue on this machine." ;;
    hu:macos.ver_too_old_body1) echo "fut, a Homebrew (ami a függőségeket telepítené) viszont 10.15-nél régebbi macOS-en nem indul el -- ezen a gépen a telepítés nem tud továbbmenni." ;;
    en:macos.ver_too_old_body2) echo "Two ways out: (1) update macOS on this machine, or (2) use the REMOTE install (a VPS) -- this Mac is perfectly enough to log in from." ;;
    hu:macos.ver_too_old_body2) echo "Két kiút: (1) frissítsd ezen a gépen a macOS-t, vagy (2) válaszd a TÁVOLI telepítést (VPS) -- ehhez ez a gép is bőven elég, csak bejelentkezni kell róla." ;;
    en:macos.ver_too_old_fail) echo "macOS below Homebrew's minimum (10.15) -- update macOS or use the remote install." ;;
    hu:macos.ver_too_old_fail) echo "A macOS a Homebrew minimuma (10.15) alatt van -- frissíts macOS-t, vagy használd a távoli telepítést." ;;
    en:macos.ver_unsupported_head) echo "Homebrew no longer supports this macOS version:" ;;
    hu:macos.ver_unsupported_head) echo "Ezt a macOS verziót a Homebrew már nem támogatja:" ;;
    en:macos.ver_unsupported_body) echo "It usually still works, but dependency installs may break (best-effort support below macOS 14). If it fails, the remote install (VPS) works from this machine too." ;;
    hu:macos.ver_unsupported_body) echo "Általában még működik, de a függőség-telepítés eltörhet (macOS 14 alatt best-effort a támogatás). Ha elhasal, a távoli telepítés (VPS) erről a gépről is megy." ;;
    en:macos.ver_unsupported_prompt) echo "Continue anyway? (y = yes / n = stop) [y]: " ;;
    hu:macos.ver_unsupported_prompt) echo "Folytassam így? (i = igen / n = megállok) [i]: " ;;
    en:macos.ver_unsupported_abort) echo "Stopped at your request -- consider the remote install, or update macOS and re-run." ;;
    hu:macos.ver_unsupported_abort) echo "Kérésedre megálltam -- érdemes a távoli telepítést választani, vagy macOS-frissítés után újrafuttatni." ;;
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
    # NPMPERM1: global npm prefix writability pre-flight
    en:npm.global_not_writable_head) echo "The global npm directory is not writable by your user:" ;;
    hu:npm.global_not_writable_head) echo "A globális npm könyvtár nem írható a felhasználóddal:" ;;
    en:npm.global_not_writable_why) echo "This is the default on Macs where Node came from the official nodejs.org installer (root-owned /usr/local). Two ways out:" ;;
    hu:npm.global_not_writable_why) echo "Ez az alapállapot olyan gépen, ahol a Node a hivatalos nodejs.org telepítőből jött (root-tulajdonú /usr/local). Két kiút:" ;;
    en:npm.remedy_1) echo "[1] LASTING (recommended): switch npm to your own prefix (~/.npm-global) -- no root-owned files, survives updates." ;;
    hu:npm.remedy_1) echo "[1] TARTÓS (ajánlott): az npm átállítása saját prefixre (~/.npm-global) -- nincs root-tulajdonú fájl, frissítéskor is megmarad." ;;
    en:npm.remedy_2) echo "[2] QUICK: install with sudo -- works now, but leaves root-owned files in the global node_modules." ;;
    hu:npm.remedy_2) echo "[2] GYORS: telepítés sudo-val -- most működik, de root-tulajdonú fájlokat hagy a globális node_modules-ban." ;;
    en:npm.remedy_prompt) echo "Which one? (1 = own prefix / 2 = sudo / n = stop) [1]: " ;;
    hu:npm.remedy_prompt) echo "Melyiket válasszam? (1 = saját prefix / 2 = sudo / n = megállok) [1]: " ;;
    en:npm.prefix_set) echo "npm prefix set to ~/.npm-global (PATH updated in your shell rc too)" ;;
    hu:npm.prefix_set) echo "npm prefix átállítva ~/.npm-global-ra (a PATH a shell rc-be is bekerült)" ;;
    en:npm.sudo_note) echo "Installing with sudo (root password may be asked)..." ;;
    hu:npm.sudo_note) echo "Telepítés sudo-val (a rendszergazdai jelszót kérheti)..." ;;
    en:npm.aborted) echo "Stopped: the global npm directory is not writable and no remedy was chosen." ;;
    hu:npm.aborted) echo "Megálltam: a globális npm könyvtár nem írható, és nem választottál megoldást." ;;
    # Error-translation layer (NPMPERM1/APTLOCK1/MACOSOLD1 -- the first three patterns)
    en:errxl.dpkg_lock) echo "TRANSLATED: the package manager (apt/dpkg) is locked by another process -- on a fresh system this is the automatic update. Wait a few minutes and re-run the installer." ;;
    hu:errxl.dpkg_lock) echo "FORDÍTÁS: a csomagkezelőt (apt/dpkg) egy másik folyamat zárolja -- friss rendszeren ez az automatikus frissítés. Várj pár percet, és indítsd újra a telepítőt." ;;
    en:errxl.npm_eacces) echo "TRANSLATED: npm has no write access to the global directory. Re-run the installer -- it now offers a fix (own prefix, or sudo)." ;;
    hu:errxl.npm_eacces) echo "FORDÍTÁS: az npm-nek nincs írásjoga a globális könyvtárra. Indítsd újra a telepítőt -- fel fogja ajánlani a megoldást (saját prefix, vagy sudo)." ;;
    en:errxl.macos_old) echo "TRANSLATED: this macOS is older than what Homebrew supports. Way out: update macOS, or use the remote install (this machine is enough to log in from)." ;;
    hu:errxl.macos_old) echo "FORDÍTÁS: ez a macOS régebbi, mint amit a Homebrew támogat. Kiút: macOS-frissítés, vagy a távoli telepítés (ehhez ez a gép is elég, csak bejelentkezni kell róla)." ;;
    en:errxl.network) echo "TRANSLATED: a network error (download failed / DNS / timeout). Check the connection and any proxy/VPN, then re-run the installer." ;;
    hu:errxl.network) echo "FORDÍTÁS: hálózati hiba (letöltés nem ment / DNS / timeout). Ellenőrizd a kapcsolatot és az esetleges proxy/VPN-t, majd indítsd újra a telepítőt." ;;
    en:errxl.unknown_head) echo "The failing tool appears to be:" ;;
    hu:errxl.unknown_head) echo "A hibázó eszköz a jelek szerint:" ;;
    en:errxl.unknown_next) echo "Copy the lines above when asking for help; re-running the installer is safe (finished steps are skipped)." ;;
    hu:errxl.unknown_next) echo "Segítségkéréshez a fenti sorokat másold ki; a telepítő újrafuttatása biztonságos (a kész lépéseket átugorja)." ;;
    # ── Fallback: return the key itself ──────────────────────────────
    *) echo "$key" ;;
  esac
}


# ═══════════════════════════════════════════════════════════════════════
# Shared install helpers (sourced by install-macos.sh AND install-linux.sh).
# Living here because this is the one file both installers already source --
# duplicating them per-script is how the mirror-drift class starts.
# ═══════════════════════════════════════════════════════════════════════

# NPMPERM1: is the global npm prefix writable? If not, offer the two remedies
# (kept strictly apart: [1] own prefix = lasting, no root-owned files;
# [2] sudo = quick but leaves root-owned files). Mode "auto" (arg 1) never
# prompts: it picks sudo with a visible note (for non-interactive fallback
# lanes). Sets NPM_NEEDS_SUDO=1 when the sudo route was chosen.
# Returns 1 only when the user explicitly stopped.
ensure_global_npm_writable() {
  local mode="${1:-interactive}" prefix nm probe
  NPM_NEEDS_SUDO=""
  command -v npm >/dev/null 2>&1 || return 0
  prefix=$(npm config get prefix 2>/dev/null || true)
  [ -n "$prefix" ] || return 0
  nm="$prefix/lib/node_modules"
  probe="$nm"
  while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do probe=$(dirname "$probe"); done
  [ -w "$probe" ] && return 0
  warn "$(_t npm.global_not_writable_head) ${nm}"
  echo -e "  $(_t npm.global_not_writable_why)"
  echo -e "  $(_t npm.remedy_1)"
  echo -e "  $(_t npm.remedy_2)"
  # Csak az explicit auto-mod valt kerdezes nelkul sudo-ra. Tty-t NEM
  # ellenorzunk: curl|bash futtatasnal a stdin nem tty, megis a felhasznalo
  # ul a gep elott -- es zart stdin-nel a read ures valaszt ad, ami az [1]
  # (tartos, root-mentes) defaultra esik, az a biztonsagos irany.
  if [ "$mode" = "auto" ]; then
    echo -e "  $(_t npm.sudo_note)"
    NPM_NEEDS_SUDO=1
    return 0
  fi
  local NPM_REMEDY=""
  read -rp "$(_t npm.remedy_prompt)" NPM_REMEDY || true
  NPM_REMEDY=${NPM_REMEDY:-1}
  case "$NPM_REMEDY" in
    1)
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global"
      export PATH="$HOME/.npm-global/bin:$PATH"
      local rc
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        grep -qs '\.npm-global/bin' "$rc" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$rc"
      done
      ok "$(_t npm.prefix_set)"
      ;;
    2)
      echo -e "  $(_t npm.sudo_note)"
      NPM_NEEDS_SUDO=1
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# Error-translation layer: known upstream failure patterns -> one clear
# sentence + a concrete next step; unknown -> at least WHICH tool broke and
# the last stderr lines. $1 = the stderr capture file. Never fails.
explain_install_error() {
  local log="$1" tail_txt tool
  [ -n "$log" ] && [ -s "$log" ] || return 0
  tail_txt=$(tail -c 4000 "$log" 2>/dev/null || true)
  [ -n "$tail_txt" ] || return 0
  echo ""
  if echo "$tail_txt" | grep -qiE 'could not get lock|lock-frontend|dpkg.+lock'; then
    echo -e "${ORANGE}$(_t errxl.dpkg_lock)${NC}"
  elif echo "$tail_txt" | grep -q 'EACCES' && echo "$tail_txt" | grep -q 'node_modules'; then
    echo -e "${ORANGE}$(_t errxl.npm_eacces)${NC}"
  elif echo "$tail_txt" | grep -qiE 'chkstk_darwin|system version is too old|your system is too old'; then
    echo -e "${ORANGE}$(_t errxl.macos_old)${NC}"
  elif echo "$tail_txt" | grep -qiE 'ENOTFOUND|Could not resolve|Connection refused|Connection timed out|Network is unreachable|curl: \(6\)|curl: \(7\)|curl: \(28\)'; then
    echo -e "${ORANGE}$(_t errxl.network)${NC}"
  else
    tool="?"
    echo "$tail_txt" | grep -q 'npm ERR' && tool="npm"
    echo "$tail_txt" | grep -qE '(^|\n)E: ' && tool="apt"
    echo "$tail_txt" | grep -qi 'dyld' && tool="dyld (Homebrew ruby)"
    echo "$tail_txt" | grep -qiE '(^|\n)(brew|Homebrew)' && tool="Homebrew"
    echo "$tail_txt" | grep -q 'curl:' && tool="curl"
    echo -e "${ORANGE}$(_t errxl.unknown_head) ${tool}${NC}"
    tail -n 5 "$log" 2>/dev/null | sed 's/^/    /'
    echo -e "  $(_t errxl.unknown_next)"
  fi
}
