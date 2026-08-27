# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.

API changes are labelled **[API]** so they can be found at a glance.
Generate/update [Unreleased]: `npm run changelog`
Extract a version for release: `npm run release-notes -- <version>`

## [Unreleased]

### Changed

- **[API]** `POST /api/agents`, `GET/PUT/DELETE /api/agents/:name`, `GET/PUT /api/agents/:name/voice-config`, `GET/PUT /api/agents/:name/avatar`, `GET /api/agents/export-all`, `GET /api/agents/:name/export`, `POST /api/agents/import`: `error` values normalised to snake_case tokens; `"Agent not found"` -> `"not_found"` + `field: "name"`; `"Agent already exists"` -> `"conflict"` + `hint`; `"Name is required"` / `"Description is required"` / `"profile is required"` -> `"required"` + `field` + `hint`; `"No avatar specified"` / `"No file uploaded"` / `"No bundle uploaded"` -> `"required"` + `field` + `hint`; `"Invalid avatar name"` -> `"invalid_value"` + `field: "name"` + `hint`; `"Avatar not found"` -> `"not_found"` + `field: "avatar"`; `"No agents to export"` -> `"not_found"` + `hint`; `"Export failed"` -> `"internal_error"`; `"invalid JSON"` -> `"parse_error"` + `hint`; `"Main agent configuration is read-only..."` -> `"forbidden"` + `hint`; `"memoryIsolation is not applicable..."` / `"No model-profile map..."` / `"main agent plan is managed..."` / `"The main agent cannot be exported..."` -> `"not_supported"` + `hint`; interpolated template literals also covered: `` `Unknown profile: ${x}` `` -> `"invalid_value"` + `field: "profile"` + `hint`; `` `modelProfile must be one of ...` `` -> `"invalid_value"` + `field: "modelProfile"` + `hint`; `` `Ismeretlen Claude plan id: ${x}` `` -> `"invalid_value"` + `field: "claudePlan"` + `hint`; `` `Model-profile map is unusable: ${x}` `` -> `"internal_error"` + `hint`
- **[API]** `POST /api/agents/:name/start`: `"Agent is already running"` -> `"conflict"` (+ `hint`); applies to both local and remote agent start paths (BA atomic couplings commit)
- **[API]** `GET/POST/PUT/DELETE /api/schedules`, `/api/schedules/:name`, `/api/schedules/:name/toggle`, `/api/schedules/:name/run`, `/api/schedules/:name/runs`, `DELETE /api/schedules/pending/:id`, `POST /api/schedules/expand-questions`, `POST /api/schedules/expand-prompt`: error values normalised to snake_case tokens; `"Name is required"` / `"Prompt is required"` / `"Schedule is required"` -> `"required"` + `field` + `hint`; `"Prompt too large (...)"` -> `"limit_exceeded"` + `field: "prompt"` + `hint`; `"Invalid cron expression"` -> `"invalid_value"` + `field: "schedule"` + `hint`; `"Invalid id"` -> `"invalid_value"` + `field: "id"` + `hint`; `"Schedule already exists"` -> `"conflict"` + `hint`; `"Schedule not found"` / `"Pending retry not found"` -> `"not_found"` + `hint`; `"Failed to generate questions"` / `"Failed to expand prompt"` -> `"internal_error"` + `hint`
- **[API]** `GET/POST/PUT/DELETE /api/memories`, `/api/memories/:id`, `/api/memories/search`, `/api/memories/export`, `/api/memories/backfill`, `/api/memories/resort`, `/api/memories/links/maintain`, `/api/memories/import`, `/api/memories/:id/detail`: error values normalised to snake_case tokens; `"Content is required"` -> `"required"` + `field: "content"` + `hint`; `"Content rejected by security filter"` -> `"forbidden"` + `hint`; `"Invalid category ..."` -> `"invalid_value"` + `field: "category"` + `hint`; `"No chunks to import"` -> `"required"` + `field: "chunks"` + `hint`; `"agent_id required"` / `"agent_id and memory_id required"` -> `"required"` + `field` + `hint`; `"from must be <= to"` -> `"invalid_value"` + `field: "from"` + `hint`; `"Memory not found"` -> `"not_found"`; `"Backfill failed"` / `"Resort failed"` / `"Link maintenance failed"` -> `"internal_error"` + `hint`
- **[API]** `GET/POST/PUT/DELETE /api/import/sources`, `/api/import/sources/:id/sync`, `/api/import/sources/:id/memories`: error values normalised to snake_case tokens; `"type must be local | gdrive | sharepoint"` -> `"invalid_value"` + `field: "type"` + `hint`; `"path is required"` -> `"required"` + `field: "path"` + `hint`; `"interval_hours must be one of: ..."` -> `"invalid_value"` + `field: "interval_hours"` + `hint`; `"Not found"` -> `"not_found"`
- **[API]** `GET/POST /api/skills`, `/api/skills/local`, `/api/skills/export`, `/api/skills/:name`, `/api/skills/:name/assign`, `/api/skills/import`, `GET/POST/DELETE /api/agents/:name/skills`, `/api/agents/:name/skills/:skillName`, `/api/agents/:name/skills/import`: error values normalised to snake_case tokens; `"Skill not found"` -> `"not_found"`; `"No user skills directory"` -> `"not_found"`; `"Skill name is required"` / `"Skill description is required"` / `"No file uploaded"` / `"content is required"` -> `"required"` + `field`; `"Invalid skill name"` / `"Invalid skill file: path traversal detected"` / `"Invalid skill file: symlink entries rejected"` / `"No valid skill (SKILL.md) found in archive"` / `"Invalid skill path"` -> `"invalid_value"` + `field`; `"Skill already exists"` (including interpolated `` `Skill already exists: ${name}. Delete it first...` ``) -> `"conflict"` + `hint`; `"Export failed"` / `"Failed to generate skill"` / `"Failed to extract .skill file"` -> `"internal_error"` + `hint`; `"Plugin skills cannot be edited"` -> `"forbidden"` + `hint`; `"Invalid agent name"` -> `"invalid_value"` + `field: "name"`; `"Agent not found"` -> `"not_found"`; `"Invalid agent or skill name"` -> `"invalid_value"`
- **[API]** `GET/POST/PUT/DELETE /api/connectors`, `/api/connectors/:name`, `/api/connectors/:name/assign`, `/api/connectors/test`, `/api/mcp-catalog`, `/api/mcp-catalog/:id/install`, `/api/mcp-catalog/:id/uninstall`, `GET/POST/DELETE /api/vault`, `/api/vault/bindings`, `/api/vault/bindings/sync`, `/api/vault/ssh-servers`, `/api/vault/ssh-keys`: error values normalised to snake_case tokens; `"Connector not found"` / `"Connector not found in any config"` / `"Item not found in catalog"` / `"Binding not found"` / `"Not found"` -> `"not_found"` + `hint`; `"URL is required"` / `"Name is required"` / `"URL (http/sse) or command (stdio) required"` / `"id and value required"` / `"vaultSecretId and envVar required"` -> `"required"` + `field`/`hint`; `"Name must contain at least one letter, number, hyphen, or underscore"` / `"Remote item has no URL"` -> `"invalid_value"` + `field` + `hint`; `"No targets found for this server"` -> `"not_found"` + `hint`; `"Failed to load catalog"` -> `"internal_error"` + `hint`; note: three catch-block lines using \`err.message || 'Failed to ...'\` are intentionally excluded (tracked separately for data-leak review)
- **[API]** `GET/POST /api/voice/directive`, `/api/voice/modality`, `/api/voice/modality/set`, `/api/voice/stt`, `/api/voice/tts`, `/api/voice/status`: error values normalised to snake_case tokens; `"Invalid agent"` / `"Invalid agent_id"` / `"Invalid chat_id"` / `"Invalid file_id"` / `"Invalid state_dir"` / `"modality must be voice or text"` / `` `Unknown or missing voice model: ${voiceModel}` `` -> `"invalid_value"` + `field` + `hint`; `"agent and chat required"` / `"text required"` -> `"required"` + `field`/`hint`; `"Invalid JSON"` -> `"parse_error"` + `hint`; `"Voice toolkit not installed"` -> `"not_supported"` + `hint`; `"STT failed"` / `"TTS failed"` (+ `detail: result.stderr`) -> `"internal_error"` + `hint`; `detail` field preserved on TTS error; dynamic voice model name kept in `hint`, not in `error`
- **[API]** `GET/POST/PUT/DELETE /api/kanban`, `/api/kanban/:id`, `/api/kanban/:id/archive`, `/api/kanban/:id/unarchive`, `/api/kanban/:id/parent`, `/api/kanban/:id/labels`, `/api/kanban/:id/labels/:labelId`, `/api/kanban/:id/subtasks`, `/api/kanban/comments`, `/api/kanban/comments/:id`, `/api/kanban/labels`, `/api/kanban/labels/:id`: error values normalised to snake_case tokens; Hungarian string literals replaced: `"Kártya nem található"` -> `"not_found"`; `"Szülő kártya nem található"` -> `"not_found"`; `"Kártya nem találhato vagy nincs archiválva"` -> `"not_found"`; `"Szülő kártya már maximális mélységen van (depth 2)"` -> `"limit_exceeded"` + `field: "parent_id"`; `"Címke neve kötelező"` -> `"required"` + `field: "name"`; `"Címke nem található"` -> `"not_found"`; `"labelId mező kötelező"` -> `"required"` + `field: "labelId"`; `"A kártyán nincs ilyen címke"` -> `"not_found"`; `"Szerző és tartalom kötelező"` -> `"required"`; `"A kártya már rendelkezik subtask-okkal"` -> `"conflict"`; `"Subtask lista kötelező"` -> `"required"` + `field: "subtasks"`; `PATCH /api/kanban/:id/parent` HTTP status code now derived from structured `code` field (`"not_found"` -> 404, others -> 400) instead of string inspection of the error message; `reparentKanbanCard` in `db.ts` returns typed `{ ok: false; code: "not_found" | "invalid" | "limit_exceeded"; hint: string }` union
- **[API]** `POST /api/auth/login`: `error` value normalised to snake_case token; `"Invalid credentials"` -> `"unauthorized"` (+ `hint`); `"Too many attempts"` -> `"limit_exceeded"`; `"Invalid JSON"` -> `"parse_error"`
- **[API]** `GET /api/auth/sessions`, `POST /api/auth/logout-all`: `"Session required"` -> `"unauthorized"` (+ `hint`)
- **[API]** `POST /api/auth/password`: `"User not found"` -> `"not_found"` + `field: "user"`; `"Invalid password"` / PasswordPolicyError -> `"invalid_value"` + `field: "password"` + `hint`; `"Forbidden for this credential type"` -> `"forbidden"` (+ `hint`)
- **[API]** `GET/DELETE /api/auth/users`, `POST /api/auth/users`: `"Invalid username (...)"` -> `"invalid_value"` + `field: "username"` + `hint`; `"User already exists"` -> `"conflict"`; `"User not found"` -> `"not_found"` + `field: "user"`; `"Forbidden for this credential type"` -> `"forbidden"` (+ `hint`)
- **[API]** `GET/POST /api/auth/device-keys`, `DELETE /api/auth/device-keys/:id`: `"Invalid device name (...)"` -> `"invalid_value"` + `field: "name"` + `hint`; `"Invalid expires_in_days (...)"` -> `"invalid_value"` + `field: "expires_in_days"` + `hint`; `"install_id must be a UUID v4"` -> `"invalid_value"` + `field: "install_id"` + `hint`; `"Device key not found"` -> `"not_found"` + `field: "device_key"`; `"Forbidden for this credential type"` -> `"forbidden"` (+ `hint`)
- **[API]** `GET/POST/PUT/DELETE /api/agents/:name/channels`, `/api/agents/:name/channels/:provider`, `/api/agents/:name/channels/:provider/pending`, `/api/agents/:name/channels/:provider/approve`, `/api/agents/:name/channels/:provider/invites`, `/api/agents/:name/channels/:provider/smoke-test`, `POST /api/agents/:name/channel/reconnect`, `GET/POST/DELETE /api/agents/:name/channel/connections`, `GET/POST/DELETE /api/agents/:name/channel/allow`: error values normalised to snake_case tokens; `"Agent not found"` -> `"not_found"` + `hint`; `"botToken is required"` -> `"required"` + `field: "botToken"`; `"Code is required"` -> `"required"` + `field: "code"`; `"Google Chat: saKeyPath, projectId, subscription és owner kötelező"` -> `"required"` + `hint`; `` `${provider} not configured for this agent` `` -> `"not_found"` + `field: "provider"` + `hint`; `` `This bot token is already used by agent "${dupeOwner}"...` `` -> `"conflict"` + `field: "botToken"` + `hint`; `"Invalid or expired code"` -> `"not_found"` + `hint`; `"Invite not found"` -> `"not_found"` + `hint`; `"Request not found"` / `"Request not found or already resolved"` -> `"not_found"` + `hint`; `"Agent is not running"` -> `"invalid_value"` + `field: "agent"` + `hint`; `"Auth flow indítása sikertelen"` -> `"internal_error"` + `hint`; `"Auth URL nem jelent meg 12 masodpercen belul..."` -> `"timeout"` + `hint`; `"SLACK_SMOKE_TEST_ALLOWED=true nincs beállítva..."` -> `"forbidden"` + `hint`; `"Nem Slack provider"` -> `"invalid_value"` + `field: "provider"` + `hint`; `"Smoke-test script nem található"` -> `"not_found"` + `hint`; `"managed-settings-missing"` -> `"managed_settings_missing"` (frontend consumer at `web/modules/agents.js:2849` renamed in the same commit)
- **[API]** `POST /api/federation/enabled`, `POST /api/federation/routing-mode`, `POST /api/federation/peers`, `PATCH/DELETE /api/federation/peers/:id`, `GET /api/federation/peers/:id/inbound-token`, `POST /api/federation/peers/:id/rotate-inbound-token`, `POST /api/federation/remove`: error values normalised to snake_case tokens; `"invalid peer id"` -> `"invalid_value"` + `field: "id"` (4 sites); `"Unknown peer"` -> `"not_found"` (4 sites); `"Body must be a JSON object"` -> `"invalid_value"` + `hint` (2 sites); `"invalid shareCapabilitySummaries (boolean)"` -> `"invalid_value"` + `field: "shareCapabilitySummaries"` (2 sites); `` `invalid abandonWindowMinutes (...)` `` -> `"invalid_value"` + `field: "abandonWindowMinutes"` (2 sites); `"federation.json failed validation -- federation stays disabled..."` -> `"conflict"`; `"federation.json unreadable -- routing mode not persisted"` -> `"conflict"`; `` `invalid mode (...)` `` -> `"invalid_value"` + `field: "mode"`; `"peer id equals own systemId"` -> `"invalid_value"` + `field: "id"`; `` `peer '${id}' already exists` `` -> `"conflict"`; `"invalid baseUrl (...)"` / `"invalid baseUrl"` -> `"invalid_value"` + `field: "baseUrl"`; `` `invalid outboundToken (min ...)` `` -> `"invalid_value"` + `field: "outboundToken"`; `` `Invalid peer: ${v}` `` / `` `Invalid peer update: ${v}` `` / `` `Invalid config after removal: ${v}` `` / `` `Invalid config after rotation: ${v}` `` -> `"invalid_value"` + `hint`; security note: no error path leaks an inbound token value, fragment, or existence -- token is returned only on successful mint/reveal/rotate; external interface note: same as B7a (federation disabled by default)
- **[API]** `GET/POST/DELETE /api/vault/ssh-servers`, `GET/POST/DELETE /api/vault/ssh-keys`, `GET/POST/DELETE /api/admin/tokens`, `POST /api/admin/tokens/:id/rotate`, `DELETE /api/admin/tokens/:id/revoke`, `GET/POST/PUT /api/security`, `GET/POST/PATCH /api/approvals`, `GET/PATCH /api/approvals/:id`: error values normalised to snake_case tokens; `"name, host and user are required"` -> `"required"` + `hint`; `"Could not derive a valid id from the name"` -> `"invalid_value"` + `field: "name"` + `hint`; `` `Server with id "${id}" already exists` `` -> `"conflict"` + `hint`; `"Failed to create server"` / `"Failed to update server"` -> `"internal_error"` + `hint`; `` `Server "${id}" not found` `` (3 sites) -> `"not_found"` + `hint`; `` `SSH key "${data.sshKeyId}" not found` `` -> `"not_found"` + `field: "sshKeyId"` + `hint`; `"No key assigned to this server"` / `"Assigned key not found"` -> `"not_found"` + `hint`; `"label and username are required"` / `"label, username and privateKey are required"` -> `"required"` + `hint`; `` `Key "${id}" not found` `` (3 sites) -> `"not_found"` + `hint`; `"invalid body"` (2 sites) -> `"parse_error"` + `hint`; `"name is required"` -> `"required"` + `field: "name"` + `hint`; `` `role must be one of: ...` `` -> `"invalid_value"` + `field: "role"` + `hint`; `"failed to create token"` -> `"internal_error"` + `hint`; `"token not found"` (2 sites) -> `"not_found"` + `hint`; `"token already revoked"` (2 sites) -> `"conflict"` + `hint`; `"failed to rotate token"` -> `"internal_error"` + `hint`; `"Forbidden for this credential type"` -> `"forbidden"` + `hint`; `"Invalid JSON"` -> `"parse_error"` + `hint`; `"key_line is required (...)"` -> `"required"` + `field: "key_line"` + `hint`; `"Invalid device name (...)"` -> `"invalid_value"` + `field: "name"` + `hint`; `"Invalid ssh_port (1-65535)"` -> `"invalid_value"` + `field: "ssh_port"` + `hint`; `"Enrollment failed"` -> `"internal_error"` + `hint`; `"Invalid JSON"` (2 sites in approvals) -> `"parse_error"` + `hint`; `"agent_id is required"` / `"category is required"` / `"action_description is required"` / `"resolved_by is required"` -> `"required"` + `field` + `hint`; `"action_payload must be a string (JSON) if provided"` -> `"invalid_value"` + `field: "action_payload"` + `hint`; `"Not found"` (2 sites) -> `"not_found"` + `hint`; `"status must be approved, rejected, or timeout"` -> `"invalid_value"` + `field: "status"` + `hint`; `"The requesting agent cannot approve its own request"` -> `"forbidden"` + `hint`; `` `Already resolved as ${existing.status}` `` -> `"conflict"` + `hint`; security note: no error path in vault-ssh-keys or admin/tokens leaks a key value, token value, or private key material; oracle protection: token/key existence and validity errors are indistinguishable; three `err.message`-based catch-block lines are intentionally excluded (tracked separately for data-leak review)
- **[API]** `GET /api/federation/manifest`, `POST /api/federation/inbox`, `GET /api/federation/peers` (read), `GET /api/federation/status`, `GET /api/federation/directory`, `POST /api/federation/refresh`, `POST /api/federation/apply`, `PUT /api/federation/peers`: error values normalised to snake_case tokens; `"Federation disabled"` -> `"forbidden"` + `hint`; `"Body must be a JSON object"` -> `"invalid_value"` + `hint`; `"Invalid JSON"` (both inline and via shared readJsonBody helper) -> `"parse_error"` + `hint`; `"from must be a valid ..."` -> `"invalid_value"` + `field: "from"` + `hint`; `"from system equals this system"` -> `"invalid_value"` + `field: "from"` + `hint`; `"from system does not match..."` / `"from system is not a configured peer"` -> `"forbidden"` + `hint`; `"to must be a local (unqualified) agent id"` -> `"forbidden"` + `field: "to"` + `hint`; `"invalid to"` -> `"invalid_value"` + `field: "to"` + `hint`; `` `Unknown recipient agent '${p.to}'` `` -> `"not_found"` + `field: "to"` + `hint`; `"content is required"` -> `"required"` + `field: "content"` + `hint`; `"invalid ref"` -> `"invalid_value"` + `field: "ref"` + `hint`; `` `Request body too large (max ${INBOX_MAX_BODY_BYTES} bytes)` `` / `` `Request body too large (max ${err.limit} bytes)` `` -> `"limit_exceeded"` + `hint`; `"federation.json failed validation -- fix or remove..."` -> `"conflict"` + `hint`; `` `Invalid federation config: ${validated}` `` -> `"invalid_value"` + `hint`; `r.error || "Restart failed"` -> `"internal_error"` + `hint`; note: these endpoints are EXTERNAL INTERFACE (federated peers see the error format); federation is currently disabled by default (no FEDERATION_ENABLED in .env), so this is the last no-consumer moment -- future peers will already see snake_case tokens
- **[API]** `Error` schema `example` updated: `{ error: "agent_id is required" }` -> `{ error: "required", field: "agent_id" }`; `error.description` updated to reflect snake_case token contract

### Added

- `scripts/skill-migrate-placeholders.py` dry-run and apply output now reports both the number of unique change types and the total occurrence count separately (e.g. "9 changes, 15 occurrences across 5 files"); `migrate_file` returns `(unique_changes, occurrence_count)` tuple; 3 new tests in `TestOccurrenceCount` covering single-line double-occurrence, multi-line, and baseline single-occurrence cases
- `Error` schema in `docs/openapi.yaml` extended with two optional fields: `hint` (human-readable debugging note, present when the server has extra context) and `field` (name of the invalid input field, present on validation errors); both were already returned by several endpoints but were not part of the documented contract; SDK regenerated
- `docs/openapi.yaml` extended with `/admin/tenants` (POST, GET, PATCH) and `/admin/partner-senders` (POST, GET, DELETE) paths and `Tenant` / `PartnerSender` component schemas; SDK regenerated (15 schemas, 102 operations)
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

### Changed

- `PUT /api/agents/:name`, `PUT /api/agents/:name/auto-restart`, and `PUT /api/agents/:name/context-guard` 400 response bodies: `error` is now a stable snake_case machine token (`unsupported_field` or `invalid_body`); replaced bespoke `rejected` + `writable`/`known` arrays with the system-wide `field` + `hint` pattern; `field` holds the first rejected key, `hint` carries the human-readable explanation including the full rejected list and known alternatives; callers that parsed `rejected` mechanically must migrate to `hint` text (the dashboard did not read either field)
- `POST /api/messages`, `PUT /api/messages/:id`, and `GET /api/messages` (unknown-param guard) error responses: `error` is now a stable snake_case machine token (`missing_required_fields`, `sender_reserved`, `federated_sender_not_allowed`, `sender_not_in_allowlist`, `unknown_sender`, `invalid_federated_address`, `federation_disabled`, `federation_self_reference`, `unknown_federation_peer`, `invalid_recipient_format`, `message_not_found`, `unknown_query_parameter`); human-readable explanation moved to `hint`; status codes and trigger conditions are unchanged

### Fixed

- Model-fallback: `modelUnavailableStreak` is now reset to 0 when a pane is unreadable (`capturePane` returns null), so two model-unavailable detections only count as consecutive if no null-pane sweep occurred between them; previously the streak was frozen and could add up across non-consecutive sweeps, triggering a spurious model switch
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
