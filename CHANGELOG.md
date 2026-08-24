# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.

API changes are labelled **[API]** so they can be found at a glance.
Generate/update [Unreleased]: `npm run changelog`
Extract a version for release: `npm run release-notes -- <version>`

## [Unreleased]

### Added

- **[API]** RouteContext gains optional `role` and `tenantId` fields (non-breaking additive extension; set by the top-level RBAC gate for downstream route handlers)
- **[API]** CI breaking-change detection for docs/openapi.yaml via oasdiff (PRs fail if a breaking change is introduced without approval)
- **[API]** URL-level versioning with /api/v1/* canonical paths
- **[API]** add custom OpenAPI->TypeScript SDK generator
- **[API]** add operationId to all 95 operations
- **[API]** add OpenAPI 3.1 spec for all API endpoints

### Fixed

- widen flaky 1s margin in heartbeat-hot-memory-count test
- call tlRebuildAtTime(t1) on natural playback end
- sort edges by weight desc before 250-cap; align static threshold to 0.75
- add 'import' tier to TL_TIERS and TL_LIMB_ANGLES
- regenerate package-lock.json for npm ci consistency
- **[API]** remove leftover openapi-typescript devDependency

### Documentation

- add fork-diff entries for deploy-readiness subtasks 1-4
- expand SECURITY.md with guidelines for CSS modularization, OpenAPI/SDK contract, CI gates, 12-factor secret management, and API versioning/deprecation (HU+EN)

## [1.33.0] - 2026-08-18

### Added

- Bridge: service-port allowlist enforced in permitopen, managed server-side
- Hooks: persist the outgoing-copy gate (script + hook wiring survive checkout)
- Hooks: missing name-rules file now causes email fail-closed, telegram loud systemMessage
- Channels: launchd port of the idle-path keepalive probe
- Channels: redacted pane diagnostics on stage-1 reconnect failures
- Updates: show the running version in the Updates page header
- Context-guard: idle-flush tier for heavy sessions that have gone quiet
- Egress-gate: payload-field recording and quarantine tier
- Telegram: enforce reply-tool with a Stop hook and directive
- Alerts: report wedge recoveries and long channel outages to the owner

### Fixed

- Schedule-runner: a parked prompt fragment deferred every scheduled task forever
- Update: Node pin never resolved on macOS, so the build used the wrong major
- Stuck-tool-call-watcher: arriving message must not open gate on stale evidence
- Kanban: an agent picking up its own card got the task dispatched back at it
- Agents: stop the tmux session on delete so no orphan ghost returns
- Vault: store the SSH import key with the newline it was validated with
- Kanban: self-heal updated_at on raw SQL status writes
- Context-restart-gate: completion reports are not dispatched work
- Agents: isolated settings.json lost keys the shared file never mentions
- Model-fallback: add 'session limit' variant to USAGE_LIMIT_RX
- Slack: expose hasSlack in agent summary so the dashboard shows sub-agent Slack config
- Ledger: keep voice/video_note attachment identity so a respawned session can still transcribe

## [1.32.1] - 2026-08-11

### Fixed

- Onboarding: the auth check trusts a running authenticated fleet, not just storage
- Self-pace-gate: stop quoted prose from faking a command position

### Documentation

- Onboarding: spell out that the running-fleet auth leg is presence-only, not validity

## [1.32.0] - 2026-08-09

### Added

- Scaffold: teach every agent the deferred-MCP ToolSearch protocol
- Context-restart-gate: proactive /clear gate with fail-closed live-work detection
- Support-mail: split login mailbox from outgoing From address

### Fixed

- Heartbeat: teach the scaffold the deferred-MCP ToolSearch protocol
- Router: session-stuck escalation and working-session silence
- Hooks: capture Telegram message_id in outbound ledger entries
- Scheduler: a pending retry survives a missing target session
- Scheduler: both resubmit dead ends enqueue the never-abandon pending retry
- Install: report zstd version in the dependency check summary
- Heartbeat: remove the unfalsifiable warnings metric
- Heartbeat: the hot-memory metric ships as a ready-made query, not prose

## [1.31.0] - 2026-08-07

### Added

- Install: probe the entered Telegram bot token and speak the findings
- Channels: reject a busy Telegram bot token at save time with a human remedy

### Fixed

- Respawn: every respawn path resolves the main model through the one three-layer resolver
- Model-suggest: the top-tier recommendation is the distribution default, never a 4.8 literal
- Install: the not-started remedy now works on an unregistered launchd unit
- Guard: disk-space reaper was a silent no-op on macOS; repair two shell tests

### Documentation

- Model-suggest: correct the measured before-figures in both comments

## [1.30.0] - 2026-08-04

### Added

- **[API]** Skill usage stats endpoint and LRU sort in the dashboard
- Fleet Blackboard: shared status API and Overview widget
- Web: lazy-load JS modules on first navigation

### Fixed

- Web: lazy-load regression fixes (boot-crash, overlay-on-all-async)
- DB: reduce SQLite page cache and mmap size
- i18n: add missing KANBAN_WIP_TESTING description key in hu/en
