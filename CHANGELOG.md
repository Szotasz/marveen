# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.

API changes are labelled **[API]** so they can be found at a glance.
Generate/update [Unreleased]: `npm run changelog`
Extract a version for release: `npm run release-notes -- <version>`

## [Unreleased]

### Added

- `scripts/skill-migrate-placeholders.py` extended with owner name/email replacement (Passes 4-6): replaces the operator's name and email with `<OWNER>` / `<OWNER_EMAIL>` tokens; resolves owner config from `.env` `OWNER_NAME` / `OWNER_EMAIL` (same binding as `src/config.ts`); Hungarian suffix forms produce `<OWNER>-{suffix}`; exception list covers domains, Python `open()` paths, Google MCP tokens, snake_case slugs, wiki links, and grep patterns; `$HOME/` normalisation for bash paths; `--verify-owner` flag; idempotent on already-migrated files; `OWNER_EMAIL` added to `src/config.ts` and `.env.example`; Passes 3-5 now skip Markdown code fences so executable commands are never corrupted by placeholder substitution
- **[API]** `GET /api/blackboard` now returns a `signal` field per row: `"a"` (agent sent a message recently but the blackboard row was not updated), `"b"` (active row unchanged longer than the configured threshold -- completion signal may have been lost), `"ab"` (both), or `null` (no signal); read-only, no data is modified; thresholds configurable via config-registry keys `BB_SIGNAL_A_MSG_HOURS` (default 2), `BB_SIGNAL_A_BB_HOURS` (default 4), `BB_SIGNAL_B_ACTIVE_HOURS` (default 24); the dashboard blackboard table renders flagged rows with an amber/red badge and a highlighted row
- **[API]** `GET /api/blackboard/history` -- append-only audit trail of fleet blackboard state transitions; supports `agent_id`, `since` (Unix timestamp), and `limit` (max 200) query filters; returns newest-first; no auth required (matches existing `/api/blackboard`)
- migration 0021: `fleet_blackboard_history` table with indexes on `agent_id`, `created_at DESC`, and `status`; 30-day retention via `runDecaySweep()`; written at the API layer on every `POST /api/blackboard` and `PATCH /api/blackboard/:id`
- Schedule runner automatic blackboard writes: `upsertBlackboard` exported from `db.ts`; schedule runner calls `status=active` before injecting each task prompt (with `task_ref` from a matching kanban card if found), and `status=done` when the task completes (pane idle and `sawTurn=true`); a snapshot of the written active row is kept in `taskInflightMap`; done is only written if the current blackboard row still matches the snapshot -- if the agent changed status or summary mid-run the runner leaves it untouched
- **[API]** `POST /api/admin/partner-senders`, `GET /api/admin/partner-senders`, `DELETE /api/admin/partner-senders/:sender_id` -- DB-backed per-tenant partner sender allowlist CRUD (admin:all required); soft-delete via `disabled_at`; 409 guard blocks fleet agent names as sender ids
- **[API]** `POST /api/messages` -- partner-scoped tokens (non-default `tenant_id`) validate `from` against the `partner_senders` allowlist; both accepted and rejected sends are written to `agent_audit_log`; fleet-auth path is unchanged for default-tenant tokens
- migration 0020: `partner_senders` table with composite PK `(sender_id, tenant_id)`, `disabled_at` soft-delete, and indexes on both columns
- **[API]** `POST /api/messages` accepts opt-in external system sender ids via `SYSTEM_SENDER_IDS` env var (comma-separated); `parseSystemSenderIds()` normalises entries with `sanitizeAgentIdent`; empty by default so fresh installs are unchanged
- **[API]** `POST /api/messages` `PUT /api/messages/:id` -- closing a message now sends a reverse `[Eredmény]` completion-report notification to the delegating agent via `shouldNotifyDelegator()` (self-messages, non-addressable senders, and completion-report contents are excluded to avoid ping-pong chains)
- **[API]** `POST/GET /api/v1/admin/tenants`, `PATCH /api/v1/admin/tenants/:id` -- tenant registry CRUD (admin:all required)
- **[API]** `POST/GET /api/v1/admin/users`, `PATCH /api/v1/admin/users/:id` -- dashboard user provisioning with role+tenant validation and audit log (admin:all required)
- migration 0019: `tenants` table DDL with pre-seeded 'default' tenant
- **[Import]** xlsx/xls/docx binary format support in the import crawler: new `extractContent()` helper dispatches to SheetJS CE (xlsx/xls, sheet_to_csv output) and mammoth (docx, plain-text extraction); malformed files are counted as `skippedType` instead of crashing; ZIP-bomb guard caps extracted text at 2 MB before the existing 100 KB content truncation; binary files use a separate 5 MB size limit (vs 500 KB for text files)
- **[API]** RouteContext gains optional `role` and `tenantId` fields (non-breaking additive extension; set by the top-level RBAC gate for downstream route handlers)
- tenant isolation wired into memories, kanban, and messages route handlers: admin role bypasses filter (sees all tenants), scoped callers are restricted to their own tenant_id; saveAgentMemory/createAgentMessage/createKanbanCard accept optional tenantId param (backward-compat, default: 'default')
- enroll dashboard bearer in api_tokens on startup (INSERT OR IGNORE; role=admin, tenant=default, no expiry); resolveApiToken() now resolves it from DB instead of the file-token fallback
- migration 0018: add role + tenant_id to dashboard_users; first-user-wins bootstrap in createDashboardUser (first user gets admin+global, subsequent users get viewer); session AuthResult carries role+tenantId from DB lookup; resolveTenantId returns null for global admin
- **[API]** CI breaking-change detection for docs/openapi.yaml via oasdiff (PRs fail if a breaking change is introduced without approval)
- **[API]** URL-level versioning with /api/v1/* canonical paths
- **[API]** add custom OpenAPI->TypeScript SDK generator
- **[API]** add operationId to all 95 operations
- **[API]** add OpenAPI 3.1 spec for all API endpoints

### Fixed

- fix token management API path matching so `/api/v1/admin/tokens` resolves correctly (handler was comparing against the pre-normalised `/api/v1/` form instead of the normalised `/api/` form that the dispatcher passes to route handlers)
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
