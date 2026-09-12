#!/usr/bin/env -S npx tsx
// Heartbeat entry point for Claude plan rotation (PR2c, design 6.6).
//
// Intended caller: a `heartbeat`-type scheduled task (see the project
// CLAUDE.md "Ütemezett feladatok" section), e.g. every 10 minutes:
//
//   npx tsx scripts/claude-plan-rotate-check.ts
//
// Design 6.6 lists four heartbeat steps: (1) run usage-collect.py --json,
// (2) feed it to the decision logic, (3) update the state side-car, (4) if
// the decision is "rotate", call POST /api/claude-plans/rotate AND send the
// Telegram signal. This script does (1)-(3) (via decideAndRecord in
// src/claude-plan-rotate-heartbeat.ts, unit-tested there) and prints a
// single structured line for (4) instead of doing it itself, for the same
// reason design 6.4 requires: the Telegram signal MUST go through the c3po
// `reply` tool, which only an agent turn has access to -- a plain node
// script cannot call it. So the scheduled task's prompt (authored by the
// operator, same as every other heartbeat in this fleet) is expected to:
//   1. run this script;
//   2. if it printed a ROTATE line: send the Telegram signal via `reply`
//      FIRST (design 6.4/1's ordering requirement), THEN
//      POST /api/claude-plans/rotate with { targetPlanId };
//   3. if it printed a NO_ALTERNATIVE line: send the Telegram signal (design
//      6.4/2) and do nothing else;
//   4. if it printed nothing: stay silent.
// This mirrors the fleet's existing OPEN_QUESTION heartbeat pattern
// (scripts/hooks/ledger-live-drain.py) rather than inventing a new one.
//
// Scope note (flagged in the PR description): this wires the MAIN channels
// agent only. Design decision #1 (2026-09-12) says sub-agents should
// eventually rotate too and sized the state schema for it
// (activePlanByAgent, already keyed per agent) -- but looping this script
// over every sub-agent, each with its own restart semantics
// (writeAgentClaudePlan + restartAgentProcess instead of
// hardRestartMarveenChannels), is deferred as a fast follow-up rather than
// bundled into the riskiest PR in this series.
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideAndRecord } from '../src/claude-plan-rotate-heartbeat.js'
import { readClaudePlans } from '../src/web/claude-plans.js'
import { readClaudePlansState, writeClaudePlansState } from '../src/web/claude-plans-state.js'
import { getEffectiveSettingValue } from '../src/settings-store.js'
import { MAIN_AGENT_ID } from '../src/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

function settingIsOn(key: string): boolean {
  try { return String(getEffectiveSettingValue(key)) === '1' } catch { return false }
}

function main(): void {
  let raw: unknown
  try {
    const out = execFileSync('python3', [join(PROJECT_ROOT, 'scripts', 'usage-collect.py'), '--json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    })
    raw = JSON.parse(out)
  } catch (err) {
    // Fail open and silent on stdout (no action taken), loud on stderr (shows
    // up in the scheduled task's failure log) -- mirrors quota-snapshot.ts's
    // "everything degrades to null" rule.
    console.error('claude-plan-rotate-check: usage-collect.py failed:', err instanceof Error ? err.message : err)
    return
  }

  if (!settingIsOn('CLAUDE_ROTATION_ENABLED') || !settingIsOn('MAIN_AGENT_ISOLATED_CONFIG')) return

  const result = decideAndRecord({
    agentId: MAIN_AGENT_ID,
    plans: readClaudePlans(),
    state: readClaudePlansState(),
    usageCollectRaw: raw,
    nowMs: Date.now(),
  })

  if (result.nextState) writeClaudePlansState(result.nextState)
  if (result.printLine) console.log(result.printLine)
}

main()
