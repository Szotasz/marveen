#!/usr/bin/env node
// Context-restart gate doctor: prints, for every agent in the fleet, exactly
// what the gate sweep sees and what it would decide RIGHT NOW. Read-only --
// it never sends /clear and never writes gate state.
//
// It goes through the runner's own gatherGateInputs()/diagnoseAgent(), so this
// is the real decision path, not a re-implementation that can drift.
//
// Usage:  node scripts/context-restart-gate-doctor.mjs [--json]
//
// Exit code 0 always: this is a diagnostic, not a check that can "fail".
// Read the COVERAGE section -- an agent listed there is one the gate cannot
// help, which is how a session quietly grows to half a million tokens.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const DIST = join(ROOT, 'dist')

if (!existsSync(join(DIST, 'web', 'context-restart-gate-runner.js'))) {
  console.error('dist/ is not built. Run: npm run build')
  process.exit(1)
}

// The gate's live-work check queries agent_messages. Inside the dashboard the
// handle is already open; in this standalone process it is not, and an
// unopened handle makes every dispatched-stats query throw -- which the gate
// counts fail-closed as "1 pending message". Without this the doctor would
// report a blocking reason that does not exist in the real sweep. Same
// idempotent open scripts/dashboard-user.ts uses against the running fleet.
const { initDatabase } = await import(join(DIST, 'db.js'))
initDatabase()

const { diagnoseAgent } = await import(join(DIST, 'web', 'context-restart-gate-runner.js'))
const { listAgentNames } = await import(join(DIST, 'web', 'agent-config.js'))
const { hasOwnGateConfig } = await import(join(DIST, 'web', 'context-restart-gate-store.js'))
const { MAIN_AGENT_ID } = await import(join(DIST, 'config.js'))

const asJson = process.argv.includes('--json')
const now = Date.now()

const roster = [...new Set([MAIN_AGENT_ID, ...listAgentNames()])]

// Every tmux session that looks like an agent session, so we can spot sessions
// nobody sweeps (worker panes, hand-started sessions, renamed agents).
function tmuxSessions() {
  try {
    return execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf-8', timeout: 3000 })
      .split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return [] }
}

const results = roster.map(name => {
  const d = diagnoseAgent(name, now)
  return {
    agent: name,
    session: d.session,
    ownConfig: hasOwnGateConfig(name),
    enabled: d.cfg.enabled,
    thresholdTokens: d.cfg.thresholdTokens,
    contextTokens: d.inputs.contextTokens,
    paneState: d.inputs.paneState,
    paneUsageLimited: d.inputs.paneUsageLimited,
    msSinceTranscriptWrite: d.inputs.msSinceTranscriptWrite,
    transcriptQuietMs: d.cfg.transcriptQuietMs,
    hardGuardPhase: d.inputs.hardGuardPhase,
    pendingOutbound: d.inputs.pendingOutboundCount,
    hasChildProcesses: d.inputs.hasChildProcesses,
    hasOpenQuestion: d.inputs.hasOpenQuestion,
    hasLiveTaskState: d.inputs.hasLiveTaskState,
    dispatchedStatsFailed: d.dispatchedStatsFailed,
    action: d.decision.action,
    reason: d.decision.reason,
    liveWorkChildArgs: d.liveWorkChildArgs,
    lastClearAt: d.runState.lastClearAt,
    firstBlockedAt: d.runState.firstBlockedAt,
  }
})

const sessions = tmuxSessions()
const swept = new Set(results.map(r => r.session))
const unswept = sessions.filter(s => !swept.has(s))

if (asJson) {
  console.log(JSON.stringify({ now, results, sessions, unswept }, null, 2))
  process.exit(0)
}

const pct = (t, thr) => (t === null ? '  ?  ' : `${String(Math.round((t / thr) * 100)).padStart(4)}%`)
const num = t => (t === null ? 'unmeasurable' : t.toLocaleString('en-US'))
const ago = ms => (ms === null ? 'never' : `${Math.round((now - ms) / 60000)} min ago`)

console.log('CONTEXT-RESTART GATE DOCTOR   ' + new Date(now).toISOString())
console.log('='.repeat(78))
for (const r of results) {
  const mark = r.action === 'allow' ? 'CLEAR' : r.action === 'block-alert' ? 'ALERT' : 'block'
  console.log(`\n${r.agent}  (${r.session})   -> ${mark}`)
  console.log(`  reason        : ${r.reason}`)
  console.log(`  config        : ${r.enabled ? 'enabled' : 'DISABLED'} @ ${num(r.thresholdTokens)} tokens` +
    `${r.ownConfig ? '' : '  [inherited _default]'}`)
  console.log(`  context       : ${num(r.contextTokens)}  (${pct(r.contextTokens, r.thresholdTokens)} of threshold)`)
  console.log(`  pane          : ${r.paneState}${r.paneUsageLimited ? ' + USAGE-LIMITED' : ''}   hard-guard: ${r.hardGuardPhase}`)
  console.log(`  transcript    : ${r.msSinceTranscriptWrite === null ? 'unreadable' : Math.round(r.msSinceTranscriptWrite / 1000) + 's since last write'}` +
    `  (quiet window ${Math.round(r.transcriptQuietMs / 1000)}s)`)
  console.log(`  live work     : children=${r.hasChildProcesses}  pendingOut=${r.pendingOutbound}` +
    `  openQuestion=${r.hasOpenQuestion}  taskState=${r.hasLiveTaskState}` +
    `${r.dispatchedStatsFailed ? '  [DB QUERY FAILED -> counted as pending]' : ''}`)
  if (r.liveWorkChildArgs.length > 0) {
    for (const a of r.liveWorkChildArgs.slice(0, 5)) console.log(`      child: ${a}`)
  }
  console.log(`  last /clear   : ${ago(r.lastClearAt)}   blocked since: ${ago(r.firstBlockedAt)}`)
}

console.log('\n' + '='.repeat(78))
console.log('COVERAGE')
const noOwn = results.filter(r => !r.ownConfig)
const off = results.filter(r => !r.enabled)
console.log(`  swept agents        : ${results.length} (${results.map(r => r.agent).join(', ')})`)
console.log(`  gate disabled       : ${off.length ? off.map(r => r.agent).join(', ') : 'none'}`)
console.log(`  inheriting _default : ${noOwn.length ? noOwn.map(r => r.agent).join(', ') : 'none'}`)
console.log(`  tmux sessions with NO sweep: ${unswept.length ? unswept.join(', ') : 'none'}`)
if (unswept.length) {
  console.log('    (these grow context with no gate watching them -- worker panes are')
  console.log('     expected here; an agent session in this list is a hole.)')
}
