#!/usr/bin/env -S npx tsx
// Heartbeat entry point for Claude plan rotation (PR2c, design 6.6).
//
// Intended caller: a `heartbeat`-type scheduled task (see the project
// CLAUDE.md "Ütemezett feladatok" section), e.g. every 10 minutes:
//
//   npx tsx scripts/claude-plan-rotate-check.ts
//
// Usage source (2026-09-26 fix): when the main agent's active plan is a
// token-mode plan in effect, its usage comes from a live probe with THAT
// plan's token on every tick (one minimal API call on the active plan);
// usage-collect.py reads the host login, a different account, and is only
// used for a configDir-mode or unassigned active plan. The two are never
// mixed (src/claude-plan-rotate-check-run.ts).
//
// Design 6.6 lists four heartbeat steps: (1) run usage-collect.py --json,
// (2) feed it to the decision logic, (3) update the state side-car, (4) if
// the decision is "rotate", call POST /api/claude-plans/rotate AND send the
// Telegram signal. This script does (1)-(3) (via decideAndRecord in
// src/claude-plan-rotate-heartbeat.ts, unit-tested there) and prints a
// single structured line for (4) instead of doing it itself, for the same
// reason design 6.4 requires: the Telegram signal MUST go through the c3po
// `reply` tool, which only an agent turn has access to -- a plain node
// script cannot call it. So the scheduled task's prompt is expected to (the
// task itself, `claude-plan-rotate-check`, is seeded automatically while
// CLAUDE_ROTATION_ENABLED=1 -- see src/web/claude-rotation-heartbeat.ts, whose
// buildRotationHeartbeatPrompt implements exactly this list):
//   1. run this script;
//   2. if it printed a ROTATE line: send the Telegram signal via `reply`
//      FIRST (design 6.4/1's ordering requirement), THEN
//      POST /api/claude-plans/rotate with { targetPlanId };
//   3. if it printed a NO_ALTERNATIVE line: send the Telegram signal (design
//      6.4/2) and do nothing else;
//   4. if it printed a FLEET_ROTATE / FLEET_SKIPPED / FLEET_FAILED line
//      (opt-in CLAUDE_ROTATION_FLEET; the fleet leg of the previous
//      rotation, printed once): relay it via `reply` -- restarted= / failed=
//      name the sub-agents, and a non-empty failed= needs the operator;
//   5. if it printed nothing: stay silent.
// The owner signal's route (ROTSLACK1111): with an owner Slack target set
// in Settings, the prompt sends every signal through scripts/notify.sh,
// the owner route of the other scheduled tasks; without one, the channel reply
// to the owner's chat id as above (claude-rotation-heartbeat.ts).
// This mirrors the fleet's existing OPEN_QUESTION heartbeat pattern
// (scripts/hooks/ledger-live-drain.py) rather than inventing a new one.
//
// Sub-agents (SUBPLANTOKEN1110 2nd PR, src/claude-plan-subagent-rotation.ts):
// a local, running sub-agent on a TOKEN plan is measured and decided per agent
// with the same thresholds, BEFORE the main agent's part, and its lines are
// printed first:
//   SUBAGENT_ROTATE agent=<name> target=<PLAN_ID> ... -- the prompt POSTs
//     /api/claude-plans/rotate {agentId, targetPlanId} FIRST (a sub-agent
//     restart does not end the main session), THEN signals with the answer's
//     launchAuth;
//   SUBAGENT_NO_ALTERNATIVE agent=<name> ... -- a signal only, once a window.
// They are never named ROTATE: an older, unedited prompt runs every ROTATE line
// against the MAIN agent, and it ignores these (claude-rotation-heartbeat.ts
// upgrades an unedited one; an edited one keeps ignoring them).
import { runRotateCheck } from '../src/claude-plan-rotate-check-run.js'

await runRotateCheck()
