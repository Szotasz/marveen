<!-- Design for the local helper (LOCALHELPER1026). Client-identifying details removed. -->
# Local-model routing for background work ("helper", design C)

Status: draft spec, 2026-10-26. Target: upstream PR to Szotasz/marveen `develop`.
Grounded in the develop checkout at 779c89a2. `file:line` = that checkout. UNKNOWN = not verified.

## 1. Problem

Every self-wake of an agent is a full Claude Code turn on the agent's own model and context.
On the remote a production fleet fleet (31 agents, all Opus) this tripled the burn 10-21..10-23.
Measured 2026-10-26, read-only :
- Fleet turns/weekday: ~40-47k (10-13..16) -> 53-70k (10-19..23). Per-turn cost flat: cache_read
 ~490-530k tokens/turn (~0.5M context), cache hit 98.2-99.0%, model opus ~99% all days.
 So the rise is MORE turns, not costlier ones.
- Monitor-event wake-ups/day: 343-510 (10-12..16) -> 634 / 937 / 1503 / 1071 / 1494 (10-21..25).
 Top source: one agent's "watched cards new comments" monitor, 976 wakes since 10-23 06:20Z.
- Feedback loop: quota exhausted -> fleet token swap + restart -> wake message -> another ~500k turn.
 Fleet restarts/day 146-357 -> 762 on 10-23.
- The killed watcher list is mostly regex-on-comment
 pollers (`komment_figyelo.py <deadline> <status> <card> <author> <regex>`), timers
 (`ebreszto.py <ts>`), and "live HEAD" checks. Most of the predicate is deterministic.

## 2. Decisions (owner, 2026-10-26, chat; verbatim list)

- Goal: stop burning shared Claude subscription quota on cheap background work.
- Existing: custom model providers let a WHOLE agent run on an Anthropic-compatible endpoint incl. local Ollama.
- Design "C": the UI is per-task selection; behind it a dedicated local "helper" session (an agent running on
 the local provider). On each custom provider the owner can TICK which task types that endpoint may handle.
 Task types and defaults for a new local provider:
 (1) watching/waiting (card comment, message, release, HEAD; reports only on an event) DEFAULT ON,
 (2) one-shot wake-ups DEFAULT ON,
 (3) quiet heartbeats (e.g. memoria-heartbeat, kanban-audit; mostly end in "nothing to do") DEFAULT ON,
 (4) key/quota rotation decision DEFAULT ON,
 (5) inbound message pre-triage DEFAULT OFF,
 (6) daily log / summaries DEFAULT OFF.
- Capability boundary: the local model only DECIDES and NOTIFIES (escalates to an Opus agent via the
 inter-agent message API with a compact payload); never writes code, never fixes production, never
 sends external messages.
- Fallback when the local endpoint is down: configurable per tick; default only (4) falls through to an
 Opus agent; the others are skipped, and the owner is notified ONCE (not per failure).
- Upstream the production fleet key rotation (untracked scripts/infra-ops/token-fleet-rotation.py,
 token-main-rotation.py, systemd timers).
- Rollout: upstream PR; enable FIRST on a production fleet (ollama 0.33.3, qwen3:14b), behind a separate go,
 first with ONE agent's watchers.
- Fleet rule already on a production fleet (an owner rule): Opus agents must not start watchers; the helper
 is the sanctioned place for watching.

## 3. What exists today (measured in code)

Custom providers
- Store: `store/custom-providers.json`, def = `{id,label,baseUrl,authHeader,vaultKey}`
 (src/web/custom-providers.ts:8, :12-18). Validation: http only for localhost/127.x (:106-108).
- POST /api/custom-providers rebuilds the def field by field (src/web/routes/custom-providers.ts:44-50),
 so any new field is DROPPED unless added there explicitly.
- UI: Settings > Provider-ok tab, web/app.js:16864 (list), :17017 (save).
- Agent binding: `agent-config.json` `customProvider` (src/web/agent-config.ts:870-885). Launch env:
 `buildCustomProviderLaunchEnv` (src/web/agent-process.ts:1531-1567) and `resolveProviderEnv`
 custom branch (:1694-1716) export ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL. A bare ollama tag goes
 to the `ollama` branch with `AGENT_LOCAL_BASE_URL` (:1755-1764; src/config.ts:686, falls back to
 OLLAMA_URL, default `http://localhost:11434`, src/config.ts:511). Pinned by
 src/__tests__/agent-provider-env.test.ts and src/__tests__/agent-local-base-url.test.ts.
- Main agent equivalent: scripts/main-agent-custom-provider.mjs:200.

Scheduled tasks
- Files: `~/.claude/scheduled-tasks/<name>/{SKILL.md,task-config.json}` (src/web/scheduled-tasks-io.ts:13).
 `ScheduledTask` (:75-205): `agent`, `type: 'task'|'heartbeat'|'command'` (:83), `skipIfBusy`,
 `targetSession` (:107), `preCheck` with SKIP protocol (:114-120), `once` (:176).
- Runner tick is 15 s (src/web/schedule-runner.ts:3037; CLAUDE.md's "60 s" is stale), started at :3051/:3817.
- `type:'command'` runs `bash -lc`, no LLM, no tmux (:3539-3548, src/web/command-task.ts).
- LLM tasks: target = `agent` or `all` (:1644-1651); session = `targetSession` or `agent-<name>` /
 main channels session (:1761-1777); injected by tmux keystrokes via `sendPromptToSession` (:2158).
 Alternative delivery: the worksource queue directory (src/web/worksource-queue.ts:1-22, gate
 `shouldQueueScheduledToWorksource` :1844-1863).
- Server-authored tasks must be registered or the runner ignores them
 (src/web/claude-rotation-heartbeat.ts:113-114, `registerServerCreatedTask`).
- Quota class: command=free, heartbeat=background, else owner-facing (src/web/schedule-runner.ts:1347-1351).

Precedent for a dedicated cheap session
- Hidden channel-less `heartbeat` agent (src/config.ts:306; src/web/heartbeat-agent-scaffold.ts):
 own dir, `model: claude-haiku-4-5` (:80), channel plugins force-disabled in settings.json (:303-309),
 `.hidden-from-dashboard`, reports to the main agent by inter-agent message (:14-21). The helper
 copies this pattern.

Rotation
- Decision is ALREADY deterministic code: `decideRotationAction` (src/claude-plan-rotation.ts:248),
 driven by `runRotateCheck` (src/claude-plan-rotate-check-run.ts:98) printing ROTATE / NO_ALTERNATIVE /
 FLEET_* lines. The seeded heartbeat `claude-plan-rotate-check` (*/10, src/web/claude-rotation-heartbeat.ts:25-26)
 spends a main-agent LLM turn only to parse that stdout and curl POST /api/claude-plans/rotate
 (src/web/routes/claude-plans.ts:236). Fleet leg: `performFleetRotation` (src/claude-plan-fleet-rotation.ts:146).
- The production fleet instead runs untracked Python under systemd timers (description, not source:
 . Source not readable from here.

Messages
- POST /api/messages `{from,to,content,...}` (src/web/routes/messages.ts:176-182); `from:"system"`
 rejected (:254-260). Owner notify with cooldown: `sendRoutineAlert` (src/web/routine-alert.ts:16, :47).

Monitor tool: Claude Code's built-in `Monitor` is not repo code; the repo has no handle on it. UNKNOWN
whether a hook can block it (a PreToolUse matcher on the tool name is plausible, not tested).

Ollama + Claude Code tool loop: NOT established in this repo. No test or doc exercises a tool-using
Claude Code session against Ollama's /v1/messages; the `ollama` branch only sets env. UNKNOWN for
qwen3:14b. Per-turn system prompt + tool schemas of Claude Code are large; a 14B model at that
context is expected (tip, unmeasured) to be slow on CPU/GPU and unreliable at multi-step tool use.

## 4. Architecture

### 4.1 Components
1. **Watch engine (dashboard-side, deterministic, no LLM).** New `src/web/helper/watch-engine.ts`,
 ticked by the schedule runner. Evaluates watch specs (4.3) with plain code: kanban comment
 regex, message arrival, GitHub release/HEAD sha change, clock time. 95%+ of wakes end here with
 no model call at all. This is the main saving and does not depend on the local model's quality.
2. **Helper runner (local model, decide-only).** New `src/web/helper/runner.ts`: when a watch fires
 with `needsJudgement`, or a type-(3)/(5)/(6) task is due, it makes ONE stateless call to the
 provider: input = task prompt + compact facts (<= 8k tokens), output = strict JSON
 `{"action":"skip"|"escalate","to":"<agent>","summary":"<=600 chars","evidence":[...]}`.
 No tools. The dashboard, not the model, performs the escalation.
3. **Escalation sender**: posts to /api/messages as `from:"helper"` (4.5).
4. **Health/fallback tracker** per provider (section 6).

### 4.2 Helper runtime choice (recommendation)
| Option | For | Against |
|---|---|---|
| A. Claude Code session on ollama (as the decision text says) | reuses agent launch, tmux, hooks | tool loop on 14B UNKNOWN; ~20-30k prompt tokens of CC scaffolding per turn on a local GPU; a model that can call Bash can also write; channel-plugin/bot.pid hazards |
| B. Direct stateless call from the dashboard (recommended) | no tools = boundary enforced by construction; tiny prompt; testable as a pure function; works with the provider's existing baseUrl | new code path; Anthropic /v1/messages compat of ollama 0.33.3 UNKNOWN, so support both `/v1/messages` and native `/api/chat` with `format: json` |
Recommend **B**, with the "helper session" in the UI being a logical identity (`helper` agent id,
own log, own row in the agent list, hidden like `heartbeat`), not a tmux Claude Code process.
Keep A possible later: the helper identity can be bound to a real session if a stronger local model
proves the tool loop (verification step V0).

### 4.3 Data model changes
`CustomProviderDef` (src/web/custom-providers.ts:12) gains, all optional (old files load unchanged):
```json
{ "id":"solar-ollama","label":"Ollama qwen3:14b","baseUrl":"http://127.0.0.1:11434",
 "authHeader":"none","vaultKey":null,
 "helperModel":"qwen3:14b",
 "apiShape":"anthropic|ollama-native",
 "taskTypes": {"watch":true,"wakeup":true,"quiet-heartbeat":true,"rotation":true,"triage":false,"summary":false},
 "fallback": {"watch":"skip","wakeup":"skip","quiet-heartbeat":"skip","rotation":"opus","triage":"skip","summary":"skip"},
 "fallbackAgent":"<main agent id>" }
```
- Defaults above apply when `taskTypes` is absent on a provider whose host is localhost/127.x; a
 remote provider defaults all-off (owner ticks explicitly). `fallback` values: `skip` | `opus`.
- Validator + POST route must copy the new fields (routes/custom-providers.ts:44-50 drops unknowns).
- Exactly one provider may be the active helper (`store/helper-config.json: {providerId, enabled}`);
 if two providers tick the same type, the active one wins (no load balancing in v1).

`ScheduledTask` (src/web/scheduled-tasks-io.ts:75) gains:
- `helperType?: 'watch'|'wakeup'|'quiet-heartbeat'|'rotation'|'triage'|'summary'` - routes the task
 to the helper when the active provider ticks it; otherwise the task runs exactly as today.
- `watch?: { kind:'kanban-comment'|'message'|'gh-release'|'gh-head'|'time', target:string,
 match?:string (regex), until?:ISO, escalateTo:string, needsJudgement?:boolean }` (helperType=watch).
- `writeScheduledTask`'s data type (:511) and `readScheduledTask` (:408) carry them. Registry hash
 already covers task-config.json bytes, so edits re-register normally.

Watches created by agents: new POST /api/helper/watches (agent-authenticated like other routes)
writes a `once`/`until` helper task. This is the sanctioned replacement for agent-spawned watchers
(an owner rule). One-shot wake-ups (type 2) are `watch.kind:'time'` with `once:true`.

### 4.4 Dispatch change in the schedule runner
In the per-task loop, next to the `command` branch (src/web/schedule-runner.ts:3543-3548):
if `task.helperType` and the active helper provider ticks it -> `runHelperTask(task, now)`, record
last-run, `continue` (no tmux, no target session). If not ticked -> unchanged path. If ticked but the
provider is down -> section 6. The quiet heartbeats (memoria-heartbeat, kanban-audit) keep their
`preCheck`; the helper only sees ticks the preCheck did not SKIP.

Rotation (type 4): first convert `claude-plan-rotate-check` to `type:'command'` that runs
`scripts/claude-plan-rotate-check.ts` and acts on ROTATE itself (POST /rotate in code, owner notify
via `sendOwnerMessage`, src/notify.ts:90). The decision needs no model at all
(src/claude-plan-rotation.ts:248). The `rotation` tick then means "helper may phrase/relay the
outcome"; with the endpoint down it falls through to Opus as decided. Open question Q2.

## 5. Escalation protocol

- Sender `from:"helper"`, to = `watch.escalateTo` (default: the task's `agent`). Delivered through the
 normal queue (POST /api/messages), success only on HTTP 200 + `id` (CLAUDE.md agent-msg rule).
- Payload (<= 1200 chars, single line header + body):
 `[HELPER-ESCALATE task=<name> type=<helperType> event=<kind> ref=<card/sha/msgid>] <summary>`
 followed by up to 3 evidence lines (comment id + first 200 chars, sha, timestamp). No raw transcript.
- The receiving Opus agent treats it as data from a lower-trust sender: helper text is model output
 over untrusted inputs (card comments). It gets the same wrapping as other untrusted inbound
 (envelope as for peer messages; UNKNOWN whether `helper` needs a team-trust entry, src/team-trust.ts).
- Dedupe: one escalation per (task, ref); a watch with `until` auto-disables after its first escalation
 unless `repeat:true`.
- Every helper decision (skip or escalate) is appended to `store/helper-runs.jsonl` for audit and for
 the before/after measurement.

## 6. Failure / fallback

- Health probe: `GET <baseUrl>/api/tags` (ollama-native) or a 1-token message, timeout 5 s, cached
 60 s. Down = probe fails, or 2 consecutive call failures/timeouts (30 s), or JSON unparsable twice.
- Per type, `fallback`: `skip` -> record `skipped-helper-down` in task_runs, nothing injected;
 `opus` -> run the task the old way (inject into `fallbackAgent`, or the task's `agent`).
 Watch (deterministic part) keeps running when the model is down; only `needsJudgement` events need
 the model, and those fall back per `watch` (default skip = keep the event queued for the next healthy tick,
 never drop it).
- Owner notify ONCE per outage: state `{downSince, notified}` per provider; first transition to down ->
 one `sendOwnerMessage`; recovery -> one "back" message with the count of skipped runs. Do not reuse
 `sendRoutineAlert`'s 30-min cooldown (src/web/routine-alert.ts:16), which would re-ping on a long outage.
- Model too weak (bad JSON, hallucinated `to`): `to` must be in the agent list, else escalate to
 `fallbackAgent`; 3 malformed outputs in an hour -> treat as down.

## 7. Security

- No write tools by construction (option B): the model returns JSON; the dashboard maps
 `escalate` to exactly one POST /api/messages. No Bash, no MCP, no channel, no email path exists in
 the helper code. Test: the runner module imports nothing from send/email/kanban-write paths.
- Escalation target allowlist: running agents only; never `system`, never a channel id.
- Prompt-injection: card comments are attacker-reachable. Worst case is a wrong/garbage escalation
 to an Opus agent (one turn), never an action. Summary length-capped, control chars stripped.
- Egress: the helper only calls `baseUrl` of the active provider; localhost/127.x enforced for
 default-on types (src/web/custom-providers.ts:106). gh-release/HEAD polling uses the existing
 GitHub token path (UNKNOWN which one on a production fleet) from the dashboard, not from the model.
- If option A is ever used: helper agent settings must deny Write/Edit/Bash-write and disable
 channel plugins (pattern src/web/heartbeat-agent-scaffold.ts:303-309), and run under the egress gate
 (scripts/hooks/egress-gate.mjs).
- Owner rule 465 enforcement: v1 = rule text + POST /api/helper/watches as the alternative;
 v2 = PreToolUse hook denying the `Monitor` tool and `nohup|sleep N && ` patterns for non-helper
 agents (UNKNOWN whether Monitor is matchable; must be measured).

## 8. Key-rotation upstreaming

Integration point: one rotation engine in the repo.
- Main leg: existing POST /api/claude-plans/rotate with `continue:true` (src/web/routes/claude-plans.ts:236-258).
- Fleet leg: `performFleetRotation` (src/claude-plan-fleet-rotation.ts:146) + `writeFleetTokenFile` (:83).
- Trigger: the `command`-type rotate check (4.4), replacing the systemd timers.
STEP NEEDING SOURCE: diff a production fleet's token-fleet-rotation.py / token-main-rotation.py /
token-rotation-automat.py against the above (described behaviours: forced restart of busy agents after
grace, wake message after restart, 409 -> one fresh retry; . Port only
behaviours the repo lacks, as separate PRs, each with a test. The wake-message-after-restart is part of
the measured feedback loop (section 1) and must be reviewed, not copied. Until merged, a production fleet keeps
its timers and the repo heartbeat stays disabled there (two rotators must never run at once).

## 9. Rollout & verification

- V0 (lab, no prod): unit tests for provider fields round-trip (POST keeps them), dispatch branch
 (ticked/unticked/down), fallback-once state machine, JSON-contract parser. Live probe on a production fleet
 ollama 0.33.3: does `/v1/messages` answer? does qwen3:14b return valid JSON for 20 recorded watch
 events (target: >= 19/20 correct skip/escalate vs a human label)? Latency p95 < 30 s.
- PR to Szotasz/marveen develop, feature-flagged `HELPER_ENABLED=0` default.
- Pilot, separate GO: a production fleet, ONE agent (proposal: <agent>, the top waker, 976 wakes
 since 10-23 06:20Z). Convert its watchers to helper watches; an owner rule applies to it.
- Metric (measured from transcripts, dedup by message id + requestId, same method as
 : pilot agent's Opus turns/day and Monitor/task-notification wakes/day,
 7 days before vs 7 days after. Success: Opus turns/day for the pilot -50% or more, with zero missed
 events (every helper-escalated event checked against the card/commit history daily for the week).
- Secondary: helper-runs.jsonl counts (skip vs escalate), outage notifications sent (expect <= 1/outage).
- Expand per agent only after the pilot week passes; quiet heartbeats (type 3) as a second step.

## 10. Open questions

Q1. Ollama 0.33.3 `/v1/messages` support and qwen3:14b JSON reliability: UNKNOWN, measure in V0.
Q2. Rotation (type 4): accept that it becomes deterministic code (no model needed), with the tick
 only governing relay wording? Or keep an LLM in the loop as decided?
Q3. Option B (stateless call, no Claude Code session) instead of a literal helper session: owner OK?
Q4. The production fleet rotation script sources: who exports them (read-only copy) for the diff in section 8?
Q5. Can a hook block the built-in Monitor tool for non-helper agents? UNKNOWN, measure.
Q6. Trust level of `helper` as a sender in team-trust / envelope (src/team-trust.ts not reviewed).
Q7. Pilot agent choice and the before-window (10-19..25 is inflated by the incident; use 10-12..18?).
Q8. Does the fleet's GitHub access on a production fleet allow dashboard-side release/HEAD polling, and with
 which token (must be per-agent per the AUTH rule, never copied)?

## Q1 measured (2026-10-26 ~16:05 CET, a production fleet, read-only probe)
- Ollama 0.33.3 answers Anthropic `/v1/messages` (`x-api-key: none`, `anthropic-version` header) with qwen3:14b; response content = `thinking` + `text` blocks.
- `max_tokens: 200` -> 4/5 EMPTY text (thinking consumed the budget). `max_tokens: 1500` -> valid JSON 10/10, 2.8-5.5 s per call (first call 20 s cold load).
- Accuracy on 5 release-watch cases x2: 8/10. Both misses were the SAME case: "KIADVA az elo CRM-en, Elo HEAD a -> b" classified skip (false negative on a real release).
- Consequence for the design: the deterministic matcher (existing is_release-style regex) is the PRIMARY release detector; the model is only consulted for comments the matcher cannot classify, and a model "skip" never overrides a matcher "release". Budget max_tokens >= 1500 (or disable thinking) and validate JSON strictly; invalid -> fallback path.
