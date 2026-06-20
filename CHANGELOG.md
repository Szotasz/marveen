# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [v1.12.1] - 2026-06-20

### Fixed

- fix(install-linux): make ollama install step non-fatal by @ResticHungary
- fix(dashboard): mobil/Tailscale PWA vault-iras (CSRF same-origin) by @Szotasz

## [v1.12.0] - 2026-06-19

### Fixed

- fix(dashboard): stop standalone PWA horizontal drag (sticky-safe clip) by @Szotasz
- fix(dashboard): render the main-agent model badge dynamically by @Szotasz
- fix(dashboard): runtime owner identity in chat view by @Szotasz
- fix(channel-mcp-reconnect): confirm idle (positive) in dismissMcpMenu, not absence-of-menu by @kovesdan

### Changed

- chore(deps): npm audit fix (safe, non-breaking) by @Szotasz
- docs: branch rule in CONTRIBUTING + bilingual PR template by @Szotasz
- Disk-space guard + mid-session stuck-/mcp-modal guard by @kovesdan

## [v1.11.0] - 2026-06-18

_No pull requests merged in this release._

## [v1.11.1] - 2026-06-18

_No pull requests merged in this release._

## [v1.11.2] - 2026-06-18

### Added

- Feat/tips tricks doc by @cett
- feat(dashboard): lapozás a beszélgetés-nézetben (korábbiak betöltése) by @juhasz007-maker
- Feat/naplo unified Napló (audit log) page -- config change-log, idea status, store files, event log by @cett
- feat(channels): Google Chat (Cloud Pub/Sub) channel provider by @buglime
- feat(update): --reseed-fleet to force-refresh fleet-canonical seeds by @Szotasz
- feat(kanban): archived cards dedicated view with restore by @cett
- feat(scripts): add Google Docs reader/editor helper by @attila-fiREG
- feat(security): optional hardening tools (force-push guard, SAST, host hardening) by @attila-fiREG

### Fixed

- fix(channel-mcp-reconnect): fully dismiss /mcp modal on failure by @tutker
- fix(agent-scaffold): generated agent CLAUDE.md includes the megszeghe… by @juhasz007-maker
- fix(dashboard): standalone PWA token-paste fallback on auth-fail by @Szotasz

## [v1.10.0] - 2026-06-17

### Added

- feat(notify): prefix the sender agent name on non-main notifications by @Szotasz
- Feat/kanban labels filters by @cett
- Feat/dashboard settings: központi Beállítások-felület (config-registry + overrides + /api/settings + UI) by @cett
- feat(dashboard): PWA installability + configurable allowed origins by @nortops
- Feat/settings v2 by @cett
- feat(ideabox): comment threads, impact/effort scoring, status filter + lifecycle (audit, stale, reversal, definition-of-done) by @cett

### Changed

- docs(channels): seeded scheduled-task owner-notify convention by @Szotasz

## [v1.9.0] - 2026-06-16

### Added

- Feat/Kanban detail/editor improvements by @cett
- Feat/kanban card aging vizuális jelzés (aging-csík + napszámláló) by @cett
- Feat/oszloponkénti WIP-limit badge (kihasználtság-alapú szín-állapotok) by @cett
- Feat/kanban: swimlane nézet (csoportosítás felelős vagy prioritás szerint) by @cett
- feat(dashboard): group scheduled tasks by cron cadence by @attila-fiREG
- feat(channels): wire up whatsapp provider by @Szotasz

### Fixed

- fix(ideas): AI-submitted kanban cards use the agent display name, not… by @cett

### Changed

- agents: scope a sub-agent's channel plugin from its own token, not the (null) explicit provider field by @koorbela
- docs(readme): highlight kanban views + link missing feature docs by @cett

## [v1.8.0] - 2026-06-14

### Added

- feat(schedules): run history log with token estimates and auto-collection by @cett
- feat(kanban): subtask embedding + full-width columns ( +) by @cett

### Fixed

- fix: fleet-local fixes -- better-sqlite3 ABI rebuild + Node-pin + scheduled-task framing (no-op root cause) by @oSanyi
- fix(install): drop the interactive brand prompt -- always brand as the agent by @Szotasz

### Changed

- Make the product brand fully configurable (complete the BOT_NAME branding) by @koorbela

## [v1.7.4] - 2026-06-13

### Fixed

- fix(channels): recover paste-placeholder stuck input + wait-for-idle send gate by @koorbela
- fix(schedule-runner): drop coercive keep-alive injection from heartbeat prompts by @theisszsolt
- fix(agents): scope channel plugins per sub-agent at spawn (kill dup telegram pollers) by @Szotasz

### Changed

- docs: scheduled tasks részletes dokumentáció by @cett
- Kódminőség, Biztonság és Dokumentálás - javaslat. by @cett
- Create CONTRIBUTING.md with contribution guidelines by @cett

## [v1.7.3] - 2026-06-12

### Added

- feat(dashboard): Napló (recall) page -- main-agent filter option, default newest-first order, sort toggle by @cett
- feat(dashboard): kanban auto-refresh via Visibility API + 30s polling by @cett
- feat(telegram): plugin-independent "working…" progress indicator + watchdog by @tutker
- feat(dashboard): readable per-agent conversation view from transcript by @juhasz007-maker
- feat(agents): persona-model fit analysis with runtime signals by @cett
- feat(dashboard): docs viewer — newest-first sort + raw .md download by @juhasz007-maker
- feat(monitor): auto-recover sessions stuck in a blocking interactive … by @attila-fiREG

### Fixed

- fix(dashboard): stop terminal-modal vibration and modal content overflow by @vinterpeter
- fix(channels): reap CLAUDE_PLUGIN_ROOT-style orphan pollers + plugin-alive fallback by @Szotasz
- fix(stuck-input): drive robust clear+re-inject recovery on the fast w… by @juhasz007-maker
- fix(dashboard): mobile-login QR uses server LAN IP, not localhost origin by @Szotasz
- fix(channel-monitor): exponential back-off for repeated failed plugin-restarts by @Szotasz
- fix(update-checker): handle customised fork instead of erroring on lo… by @attila-fiREG

### Changed

- channels: scope the second orphan-poller reap to the main agent by @koorbela

## [v1.7.2] - 2026-06-11

### Added

- feat(dashboard): read-only Docs viewer for the project docs/ folder by @juhasz007-maker

### Fixed

- fix(dashboard): scrollback + stable paging in agent terminal widget by @juhasz007-maker
- fix(channel-monitor): extend stuck-input re-inject recovery to sub-ag… by @juhasz007-maker
- fix(updater): make self-update branch-agnostic instead of hardcoding … by @cett

## [v1.7.0] - 2026-06-10

_No pull requests merged in this release._

## [v1.7.1] - 2026-06-10

### Added

- feat(schedule): auto-start a stopped agent on cron + manual Run now by @Janokapapa
- feat(schedule): command-type scheduled tasks (raw shell on cron) by @Janokapapa
- feat(agents): run agents on remote hosts over SSH + tmux (, rebased+fixed) by @Szotasz
- feat: fleet-helper skill (deterministic heartbeat gate + MarkdownV2 + mail-triage) by @tutker
- feat(agent): interactive-tmux worker backend for runAgent (jun.15 subscription migration) by @Szotasz
- feat(kanban): dispatched task result lands on its own card by @Janokapapa

### Fixed

- fix(dream-engine): correct memory-backfill endpoint path (was 404 reembed) + {{WEB_PORT}} scaffold by @Szotasz
- fix(token-usage): match main agent by encoded project path by @jocoo
- fix(managed-settings): cross-platform support + platform-independent tests by @Janokapapa
- fix(tests): use in-memory DB so unit tests never write to the live store by @HiperiorNr1
- fix(seed): substitute {{WEB_PORT}} in install scripts + hygiene known-set by @Szotasz
- fix(dashboard): render team graph as a nested tree by @attila-fiREG
- fix(channels): provider-specific poller matching in coordinator/liveness (close masking gap) by @HiperiorNr1
- fix(channels): respawn-stamp on resumeMarveenSession + spell-peak discriminator (kill self-respawn loop) by @HiperiorNr1

## [v1.6.0] - 2026-06-07

### Added

- feat(gitnexus): opt-in per-repo post-commit auto-rebuild hook by @Szotasz
- feat(support-mail): support@ mailbox CLI tooling (secret/PII-scanned) by @Szotasz

### Fixed

- fix(gitnexus): BSD/macOS-safe in-place block update in autorebuild installer by @Szotasz
- fix(scaffold): config-driven scheduled-task templating + identity hygiene guard (reconciled+) by @Szotasz
- fix(support-mail): strip to generic config-driven IMAP/SMTP CLI (no operator data) by @Szotasz

### Changed

- chore(branding): rename user-facing ClaudeClaw -> Marveen (docs/UI only) by @Szotasz
- chore(gitignore): ignore local one-off artifacts by @Szotasz
- chore(gitignore): ignore operator's local support auto-reply by @Szotasz

## [v1.4.0] - 2026-06-06

_No pull requests merged in this release._

## [v1.5.0] - 2026-06-06

### Added

- feat(activity): click card to open terminal modal by @Szotasz
- feat(main-agent): codify sub-agent unknown-sender auto-approval (allowlist-gated, default-deny) by @Szotasz

### Fixed

- fix(activity): responsive console height and grid by @Szotasz
- fix(stuck-tool-call-watcher): recover via respawn-pane (no client-kick) + reap + CPU guard by @Szotasz

## [v1.2.0] - 2026-06-05

_No pull requests merged in this release._

## [v1.3.0] - 2026-06-05

### Added

- feat(dashboard): custom image upload when creating an agent by @Szotasz

### Fixed

- fix(install-windows): re-entry loop -- detect existing WSL/Ubuntu (UTF-16 null strip) by @Szotasz
- fix(ledger-replay): derive owner name from OWNER_NAME, not hardcoded "Gyula" by @Szotasz
- fix(channels): in-session plugin-liveness watchdog (dashboard-independent backstop) by @Szotasz
- fix(channel-monitor): recover a channel message stranded at the prompt (stuck-input watchdog) by @Szotasz
- fix(dashboard): route load-bearing 'marveen' literals through window._marveen.agentId by @Szotasz

## [v1.1.0] - 2026-06-03

### Added

- feat: Linux compatibility (issue) by @Szotasz
- Add scripts/monitor_agents.sh: peek at every agent in iTerm2 via tmux -CC by @zollak
- feat(web): scope-based MCP connector grouping by @zollak
- feat(web): external project paths for MCP connector scanning by @zollak
- feat(web): vault env auto-sync and sensitive key scan & import by @zollak
- feat(agent-process): per-agent CLAUDE_CONFIG_DIR via agent-config.json by @koorbela
- feat(web): add DeepSeek-V4-Pro model support by @Szotasz
- feat(install): scaffold default scheduled tasks (folyamatos-ellenorzes) by @Szotasz
- feat(scheduler): add skipIfBusy task flag to drop short-cadence ticks silently by @Szotasz
- feat(update): auto-stash dirty working tree on opt-in by @Szotasz
- feat(agents): multi-channel binding UI for Telegram by @Szotasz
- feat(scaffold): golden rule -- ping Marveen on unknown Telegram sender first message by @Szotasz
- feat(scaffold): add skill-generation rules to new agent CLAUDE.md by @Szotasz
- feat(kanban): project field + filter + autocomplete by @Szotasz
- feat(scaffold): seed default scheduled tasks on startup by @Szotasz
- feat(scaffold): add time-handling rules to agent CLAUDE.md by @Szotasz
- feat(hooks): auto-resize large Telegram-received images by @Szotasz
- feat(update): auto-sync hooks via update.sh by @Szotasz
- feat(agent-process): wire stuck-input + truncated-preamble detectors into sendPromptToSession by @Szotasz
- feat(channels): add ChannelProvider abstraction for multi-channel support by @Szotasz
- feat(agents): make agent start/stop and scaffold channel-provider-aware by @Szotasz
- feat(monitor): generalize telegram-monitor to channel-monitor by @Szotasz
- feat(api): provider-aware channel routes and invite system by @Szotasz
- feat(dashboard): generalize channel tab UI for multi-provider support by @Szotasz
- feat(install): add multi-channel provider support to installers and scripts by @Szotasz
- feat(docs): Slack channel tests, README guide, provider-agnostic SKILLs by @Szotasz
- feat(slack): managed-settings pre-flight + enabledPlugins lockdown by @Szotasz
- feat(slack): channel request workflow with audit log watcher by @Szotasz
- feat(channel-requests): approve modal with requireMention/allowFromAll toggles by @Szotasz
- feat(slack): app manifest YAML generator and setup modal by @Szotasz
- feat(slack): smoke-test script, dashboard endpoint and UI button by @Szotasz
- feat(install-linux): detect host timezone and emit Environment=TZ for user units by @HiperiorNr1
- feat(channel): generalized MCP reconnect helper + health monitor by @Szotasz
- feat(seed): add seed-skills/ and seed-scheduled-tasks/ with install/update integration by @Szotasz
- feat(recall): session recall API + dashboard napló view by @Szotasz
- feat(background-tasks): background task spawn + dashboard UI by @Szotasz
- feat(kanban): auto breakdown via LLM with subtask hierarchy by @Szotasz
- feat(breakdown): claude -p headless spawn replaces API keys by @Szotasz
- feat(autonomy): dashboard UI + API for granular autonomy control by @Szotasz
- feat(connectors-hu): one-click CLI installer API endpoints by @Szotasz
- feat(dashboard): connectors.hu cross-promo banner on Connectors page by @Szotasz
- feat(seed): Bumblebee supply-chain hygiene scan scheduled task by @Szotasz
- feat(security): add content sanitization to memory POST endpoint by @Szotasz
- feat: add MIT LICENSE and package.json license field by @pvojnisek
- feat(scheduler): forceSend + targetSession to fix busy-retry loop by @Szotasz
- feat(skills): add /handoff seed skill by @Szotasz
- feat(seed-skills): add retrospective and skill-management skills by @Szotasz
- feat(install): Claude Code fallback on installer failure by @Szotasz
- feat(dashboard): avatar upload with drag&drop + Telegram notify by @Szotasz
- feat(channels): add Discord as third channel provider by @Szotasz
- feat(dashboard): token usage monitor by @gezabenko-ai
- feat(dashboard): per-agent auth-mode selection by @Szotasz
- feat(dashboard): auth-mode UI v2 — radio-card + action buttons (3 modes) by @Szotasz
- feat(models): add Opus 4.8 to the model picker by @Szotasz
- feat(marveen): main agent default model 4.8 + detail panel reads from API by @Szotasz
- feat(agents): allow channel-less agents to start (inter-agent only) by @kovesdan
- feat(dashboard): live agent model + tmux session name, restart-on-model-change by @NoirHun
- feat(mcp-catalog): gitignored mcp-catalog.local.json overlay merged into the catalog by @NoirHun
- feat(dashboard-discord): provider-aware Channel tab + Marveen first-class by @DeliLevente99
- feat(hooks): channel-reply-guard — catch missing channel replies by @kovesdan
- feat(backup): cover skills/scheduled-tasks/channel token/launchd + migration runbook by @kleinheinczg
- feat(kanban): filter by assignee + owner 'what's on me' view, robust assignee chip by @kleinheinczg
- feat(dashboard): live agent activity panel by @theisszsolt
- feat(channels): durable Telegram-channel stability + deafness recovery hardening by @kovesdan
- feat(heartbeat): dedicated channel-less heartbeat agent (Szabi 2026-06-02) by @Szotasz
- feat(channel-coordinator): standalone Telegram inbound poller (decouple ingest from TUI) by @Szotasz
- feat(continuity): deterministic conversation-continuity ledger (hooks + durable transcript) by @kovesdan
- feat(install): dnf/Fedora support + Discord provider in Linux installer by @DeliLevente99
- Feature/donat communication profile by @latnaborsodi
- feat(kanban): wake the assigned agent when a card moves to in_progress by @kleinheinczg
- feat(dashboard): mobile-responsive shell — off-canvas sidebar + hamburger (<=768px) by @kleinheinczg
- feat(dashboard): inter-agent message log + compose on the Team page (b5) by @kleinheinczg
- feat(auto-restart): per-agent scheduled session restart + live context size by @kleinheinczg
- feat(channel-coordinator): backfill-mode hybrid (native primary, coordinator only when down) by @Szotasz
- feat(dashboard): status tooltips + breathing working badge by @kleinheinczg
- feat(dashboard): messages chat subpage with threads + pagination by @Szotasz
- feat(dashboard): agent reauth badge + one-click /login + live terminal backend by @Szotasz
- feat(recovery): autonomous re-auth healer (detect + best-effort /login + escalate) by @Szotasz
- feat(recovery): compact task-state re-injection for sub-agents by @Szotasz

### Fixed

- fix(web): rewrite soft reconnect to reliably navigate /mcp menu by @gezabenko-ai
- fix(web): MCP connector fixes and lost feature restoration by @zollak
- fix: restore --continue flag + PR/ post-testing fixes by @zollak
- fix(web): dismiss 'How is Claude doing this session' modal pre-flight by @Szotasz
- fix(memory): run daily digest sub-agent in a dedicated cwd by @Szotasz
- fix(web): dismiss "Resume from summary" modal pre-flight by @Szotasz
- fix(pane-state): recognize background-shells footer variant by @koorbela
- fix(pane-state): widen shells-variant tail to recognize hidden-tasks footer by @koorbela
- fix(memory): isolate daily-digest sub-agent from telegram plugin by @Szotasz
- fix(agent-process): post-restart pre-flight modal dismiss by @Szotasz
- fix(telegram-monitor): require 2 negative ticks before recovery escalation by @Szotasz
- fix(telegram-monitor): soft reconnect via Up wraparound to Telegram entry by @Szotasz
- fix(telegram-monitor): silence stage-1 disconnect alert by @Szotasz
- fix(agents): auto-poll telegram tab so pending shows up without click by @Szotasz
- fix(heartbeat): quiet window after 22:00 -- only db-warning escalates by @Szotasz
- fix(heartbeat): drop stale-waiting trigger + tell agent to stay silent by @Szotasz
- fix(install): unstick first-run dialogs on fresh Mac/Windows installs by @Szotasz
- fix(heartbeat): keep Telegram bun stdio alive with no-op tool call by @Szotasz
- fix(heartbeat): make no-op tool call the FIRST mandatory step by @Szotasz
- fix(telegram-monitor): dynamic Telegram entry index in soft reconnect (replaces Up wraparound) by @Szotasz
- fix(telegram-monitor): brute-force Up walk to Telegram submenu by @Szotasz
- fix(dashboard): route main agent CLAUDE.md to project root by @Szotasz
- fix(scaffold): portable PROJECT_ROOT instead of hardcoded ~/ClaudeClaw by @gezabenko-ai
- fix(napindito): skip AI news for sub-agents by @Szotasz
- fix(updater): ignore HEARTBEAT.md in dirty-tree check by @Szotasz
- fix(slack): pass SLACK_APP_TOKEN through dashboard setup flow by @Szotasz
- fix(slack): persist channelProvider in agent-config on setup/disconnect by @Szotasz
- fix(agent): override pathToClaudeCodeExecutable on glibc Linux to avoid musl mismatch by @HiperiorNr1
- fix(channels): tighten dialog auto-accept patterns to avoid false matches by @HiperiorNr1
- fix(channel-monitor): stage 2+3 recovery Telegram alert spam by @Szotasz
- fix(connectors-hu): extend PATH for launchd-spawned dashboard by @Szotasz
- fix: remove hardcoded paths, centralize config by @Szotasz
- fix: replace hardcoded install path with {{INSTALL_DIR}} placeholder by @Szotasz
- fix(install): eliminate silent failures + missing Linux scaffolding by @Szotasz
- fix(security): pass PAIR_CODE via env instead of shell interpolation by @Szotasz
- fix(install): enrich fallback prompt with script+line, repo URL, explicit task by @Szotasz
- fix(install): AWS user feedback -- all 6 fixes by @Szotasz
- fix(slack): 6-bug chain breaking fresh Slack install by @Szotasz
- fix(dashboard): ékezetek az avatar feltöltés Telegram üzeneteiben és UI-on by @Szotasz
- fix(channel): use pluginPaneId for tmux pane matching in reconnect by @gezabenko-ai
- fix(channel): add missing pluginPaneId to Discord provider by @gezabenko-ai
- fix(linux): propagate API key/OAuth token to channels process by @Szotasz
- fix(dashboard): ékezetek a maradék UI-szövegekben (Mentés, Mégse, Összekapcsolás) by @Szotasz
- fix(dashboard): toast z-index above modal overlay by @Szotasz
- fix(install): .nvmrc + Node <24 cap + VPS remote access docs by @Szotasz
- fix(channels): make Discord plugin actually work end-to-end (tagged dev-channels flag + channel-group bootstrap) by @DeliLevente99
- fix(kanban): replace hardcoded 'Marveen' with BOT_NAME by @theisszsolt
- fix(channels): reject duplicate bot tokens at setup by @Szotasz
- fix(channels): add channelsEnabled:true to managed-settings + fix python script by @Szotasz
- fix(kanban-ui): inline-edit assignee on detail view + clarify comment-author dropdown by @theisszsolt
- fix(wsl): systemd fallback + channel token isolation + restart safety by @Szotasz
- fix(scaffold): clearer error when Claude Code CLI returns no output by @Szotasz
- fix(tmux): unset $TMUX in channels.sh + clearer manual-attach hint by @Szotasz
- fix(invites): persist tokens in sidecar file so pairing survives plug… by @robotidos
- fix(model): Opus 4.8 → 1M-context variant (claude-opus-4-8[1m]) + shell-quote everywhere by @Szotasz
- fix(agents): stabilize channel-less agent startup — plugin isolation, identity & dashboard tunnel by @kovesdan
- fix(channel-setup): validate Discord channelId before hardRestartMarveenChannels ( fast-follow) by @Szotasz
- fix(install-windows): UTF-8 BOM + CRLF for PowerShell 5.1 compatibility by @Szotasz
- fix(telegram): prevent sub-agents from stealing the Telegram poller + heartbeat answers direct messages by @kleinheinczg
- fix(dashboard): show agent display names instead of internal ids in kanban assignee UI by @kovesdan
- fix: channel-path Enter auto-recovery + robust scheduler pending-retry alert by @kleinheinczg
- fix(scheduler): persist scheduleLastRun so a restart doesn't re-fire a just-run task by @kleinheinczg
- fix(channel-reconnect): target Reconnect/Enable instead of blind Down+Enter by @Szotasz
- fix(channels): reap orphan plugin pollers on agent start/stop and main launch by @Szotasz
- fix(agent-scaffold): use BOT_NAME / MAIN_AGENT_ID in stranger-sender block (Tanfield install bug) by @Szotasz
- fix(channel-monitor): reap orphans + dismiss resume-modal + bump grace in stage-3 by @Szotasz
- fix(channel-monitor): log Telegram 409 Conflict explicitly on down-detect (Szabi req) by @Szotasz
- fix(channel-monitor): bump RESUME_GRACE_MS 150s -> 240s for large-context resume by @Szotasz
- fix(channels): post-init /mcp unlock for Claude Code 2.1.159 plugin race by @Szotasz
- fix(channels): tighten post-init unlock — pgrep + ✗ Failed pane check by @Szotasz
- fix(channels): reset keep-alive watchdog baseline on session init by @Szotasz
- fix(channels): in-process plugin-unlock probe for JS respawn paths by @Szotasz
- fix(channels): widen post-respawn cold-start grace + gate on any-respawn by @Szotasz
- fix(channels): Esc+Esc after unlock so pane returns to idle prompt by @Szotasz
- fix(heartbeat): isolate sub-agent cwd from Marveen plugin config by @Szotasz
- fix(channels): stage-1 reconnect picks Enable when plugin status is disabled by @Szotasz
- fix(channels): skip keepalive respawn when channel plugin is alive by @Szotasz
- fix(channels): stuck-tool-call watchdog for the Worked-for-Ns TUI freeze by @Szotasz
- fix(heartbeat): disable channel plugins at project scope ( follow-up) by @Szotasz
- fix(heartbeat): isolate sub-agent via CLAUDE_CONFIG_DIR ( failed in prod) by @Szotasz
- fix(heartbeat): inject CLAUDE_CODE_OAUTH_TOKEN from macOS Keychain ( regression) by @Szotasz
- fix(heartbeat): copy ~/.claude.json + dashboard-hide sentinel ( regression) by @Szotasz
- fix(dashboard): restore GET /api/agents/activity route (regressed by) by @kleinheinczg
- fix(google-api): mtime-invalidate cachedTokens (Calendar re-auth survival) by @Szotasz
- fix(message-router): channel-inbound delivery for coordinator backfill (framing-fix) by @Szotasz
- fix(dashboard): surface configured MCP servers + remove dead /api/tasks route by @kleinheinczg
- fix(dashboard): wire up 4 audit decision-items (main-agent skills, migrate dropdown, status per-service, schedule advanced opts) by @kleinheinczg
- fix(kanban): save comments reliably + show running card number by @kleinheinczg
- fix(dashboard): wire per-agent skills, MCP catalog install-state + 4 more UI controls to backend reality by @kleinheinczg
- fix(stuck-tool-call-watcher): post-respawn grace before hard-restart by @Szotasz
- fix(runAgent): never write AUP-blocked / errored results as content by @Szotasz
- fix(channels): stop 409 token churn -- coordinator 409-cooldown + detached-claude reap by @Szotasz

### Changed

- security: harden dashboard against CSRF and skill path traversal by @Szotasz
- security: bearer token auth on dashboard /api/* routes by @Szotasz
- security: lock token .env files to mode 0600 by @Szotasz
- security: delimit untrusted content in agent prompts (prompt injection defence) by @Szotasz
- security: harden FTS5 sanitizer + strip personal path from .mcp.json by @Szotasz
- Sync install-linux.sh with upstream install.sh by @gezabenko-ai
- Route agent messages to the main agent via MAIN_CHANNELS_SESSION by @zollak
- Auto-sanitize connector names and surface the rewrite in the toast by @zollak
- Harden Telegram plugin monitor against false-positive 'down' alerts by @zollak
- backup.sh: warn that archives contain sensitive tokens by @koorbela
- agentDir: route through safeJoin for defense-in-depth by @koorbela
- router: check markMessageDelivered/Failed return values by @koorbela
- db: debug-log embedding generation failures by @koorbela
- writeScheduledTask: atomic writes for SKILL.md and task-config.json by @koorbela
- schedules: validate cron shape at the API boundary by @koorbela
- prompt safety: wrap scheduler task.prompt + inline UNTRUSTED_PREAMBLE in router by @koorbela
- handleMarveenDown: honour a real 60s memory-save window before hard restart by @koorbela
- extend atomicWriteFileSync coverage to remaining state files by @koorbela
- developer-junior: allow curl so inter-agent replies don't deadlock by @koorbela
- prompt-safety: add wrapTrustedPeer + cross-tag scrubbing by @koorbela
- TeamConfig: add optional trustFrom + sanitize self/unknown with warnings by @koorbela
- team-trust: add isTrustedPeer pure-logic helper with DI by @koorbela
- router: wrap trusted peers as <trusted-peer>, untrusted as <untrusted> by @koorbela
- dashboard UI: trustFrom multi-select + warnings toast by @koorbela
- Surface runAgent errors instead of returning fallback strings by @zollak
- updater: preflight branch + clean-tree checks, surface failures in UI by @koorbela
- skills: list plugin skills, drop per-agent assign UI, add global create + import by @koorbela
- connectors: make built-in Computer Use / Chrome rows actually clickable by @koorbela
- startup: zombie-proof dashboard lock + graceful shutdown by @koorbela
- scheduler: persistent busy-retry queue, never abandons by @koorbela
- refactor(web): extract pure helpers from web.ts into src/web/ by @Szotasz
- refactor(web): move MIME table to http-helpers where it belongs by @Szotasz
- refactor(web): extract agent-config, team, telegram, scaffold helpers by @Szotasz
- refactor(web): extract tmux session lifecycle into agent-process by @Szotasz
- refactor(web): extract message router and main-agent constants by @Szotasz
- refactor(web): extract update checker by @Szotasz
- refactor(web): extract MCP list cache by @Szotasz
- refactor(web): extract schedule runner by @Szotasz
- refactor(web): extract Telegram plugin health monitor by @Szotasz
- refactor(web): split route handlers into src/web/routes/ by @Szotasz
- Revert PR (heartbeat csendesítés) — gyanítjuk hogy a 6 perces re-handshake recovery-t okozza by @Szotasz
- pane-state: add stuck-input + truncated-preamble detectors by @koorbela
- kanban: add project column migration + schema entry by @koorbela
- scaffold: rewrite agent field to MAIN_AGENT_ID when seeding default tasks by @koorbela
- chore(seed-skills): sanitize PII and agent names by @Szotasz
- docs(skill): update-flow lessons (stop.sh launchd unload + OOM) by @Szotasz
- docs: funkció-dokumentáció pilot (index + heartbeat/autonómia) by @Szotasz
- docs: memória + kanban + ügynök-flotta lapok by @Szotasz
- docs: maradék funkció-lapok (skill-factory, channels, printing-press, Skool, connectors, dream-engine, bg-tasks) by @Szotasz
- docs: marketing-polish a 🎯 szekciókra (11 funkció-lap) by @Szotasz
- docs: add ATTRIBUTIONS.md for bundled and adapted work by @Szotasz
- docs: translate ATTRIBUTIONS.md to Hungarian by @Szotasz
- docs(avatar): bot profile pic setup guide + BotFather instructions by @Szotasz
- docs(attributions): credit Mark Kashef for the Claude Code agent concept by @Szotasz
- refactor(channels): remove dev-channels flag, document managed-settings.json gate by @DeliLevente99
- pane-state: detect wedged thinking-block API error, stop injecting + alert by @koorbela
- chore(mcp-catalog): restore Playwright entry in committed catalog ( follow-up) by @Szotasz
- watchdog: defer agent auto-restart during process startup grace by @koorbela
- dashboard: read live agent model from the agent's own config dir by @koorbela
