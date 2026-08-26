import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  chatIdFromAccessConfig,
  taskInjectionRank,
  decideScheduledResubmitAction,
  runPreCheck,
} from '../web/schedule-runner.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Contract tests for the daily-batch-agent "never runs" fix.
//
// Root cause: a daily batch agent has no 24/7 tmux session. When its cron
// fired (e.g. a `0 2 * * *` digest), attemptFireTask found the target session
// missing and returned 'missing' -- a silent skip. The task was enabled and
// scheduled but could never fire.
//
// Fix: when the session is missing, START the agent and return a new 'starting'
// state. The caller enqueues a retry that delivers the prompt on a later tick
// once Claude has booted. Crucially this retry must bypass skipIfBusy -- the
// whole point was to wake the agent for its scheduled run, so a skipIfBusy=true
// task must NOT drop the delivery.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner auto-starts a stopped agent for its scheduled task', () => {
  it('attemptFireTask can return a distinct "starting" state', () => {
    // The return union must carry 'starting' so the caller can tell an
    // auto-start apart from a genuine busy session.
    const sig = SRC.slice(SRC.indexOf('function attemptFireTask'))
    expect(sig.slice(0, 200)).toMatch(/'starting'/)
  })

  it('the missing-session branch auto-starts the agent instead of skipping', () => {
    // Locate the (host-aware) missing-session guard and assert it now launches the agent.
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    expect(guardIdx).toBeGreaterThan(0)
    // Window covering the missing-session block (comment + code, before the
    // real busy-check). Must launch the agent and return the 'starting' state.
    const missingBlock = SRC.slice(guardIdx, guardIdx + 1800)
    expect(missingBlock).toMatch(/startAgentProcess\(agentName\)/)
    expect(missingBlock).toMatch(/return 'starting'/)
  })

  it('the cron loop enqueues a retry for "starting" WITHOUT the skipIfBusy gate', () => {
    // Find where the cron loop handles a 'starting' result. That branch must
    // insert a pending retry, and must NOT be guarded by task.skipIfBusy
    // (otherwise a skipIfBusy=true daily digest would auto-start the agent and
    // then drop the delivery -- the original bug). Target the cron-loop's
    // standalone branch specifically (runScheduledTaskNow also references
    // 'starting', but in an `|| result === 'busy'` form).
    const startingIdx = SRC.indexOf("if (result === 'starting') {")
    expect(startingIdx).toBeGreaterThan(0)
    // Slice the starting-branch up to the next else-if / busy handling.
    const busyHandlingIdx = SRC.indexOf("result === 'busy'", startingIdx)
    expect(busyHandlingIdx).toBeGreaterThan(startingIdx)
    const startingBranch = SRC.slice(startingIdx, busyHandlingIdx)
    expect(startingBranch).toMatch(/insertPendingTaskRetryIfNew/)
    // Not gated by the skipIfBusy flag (the code form `task.skipIfBusy`); a
    // mention in an explanatory comment is fine.
    expect(startingBranch).not.toMatch(/task\.skipIfBusy/)
  })

  it('documents WHY (daily batch agent), not just what', () => {
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    const rationale = SRC.slice(guardIdx, guardIdx + 900)
    expect(rationale).toMatch(/auto-start|batch agent|digest/i)
    expect(rationale).toMatch(/skipIfBusy/i)
  })
})

// Security regression test (2026-06-08).
//
// The schedule-runner used to inject a coercive "keep-alive" preamble into
// heartbeat prompts for every agent whose name was not literally `heartbeat`
// (so the jarvis-driven heartbeats -- kanban-audit, memoria-heartbeat -- all
// got it). The preamble sat OUTSIDE the wrapUntrusted() envelope and demanded
// a mandatory no-op tool call while forbidding use of Telegram: the runner
// poisoning its own trusted channel, a prompt injection we shipped ourselves.
//
// It is removed. The runner must never again prepend an operational directive
// to a heartbeat prompt; the agent's CLAUDE.md + the task SKILL.md drive
// behaviour. These tests lock that in.

describe('schedule-runner heartbeat prefix is injection-free', () => {
  it('keeps the [Heartbeat: ${task.name}] tag (resubmit-marker matches)', () => {
    // The downstream resubmit-retry code matches `[Heartbeat: ${task.name}]`,
    // so the tag itself must stay.
    expect(SRC).toMatch(/\[Heartbeat: \$\{task\.name\}\]/)
  })

  it('contains NO keep-alive / Telegram-keepalive injection strings anywhere', () => {
    expect(SRC).not.toMatch(/KOTELEZO ELSO TEENDO MIELOTT BARMIT IRSZ/)
    expect(SRC).not.toMatch(/Telegram-bun MCP-stdio-pipe keep-alive/)
    expect(SRC).not.toMatch(/NE Telegram-tool-t/)
    expect(SRC).not.toMatch(/marveen-keepalive\.log/)
    expect(SRC).not.toMatch(/kotelezo no-op tool-call/)
  })

  it('does not branch the heartbeat prefix by agentName (one clean prefix)', () => {
    const heartbeatBlockStart = SRC.indexOf("if (task.type === 'heartbeat')")
    expect(heartbeatBlockStart).toBeGreaterThan(0)
    const outerElseMarker = SRC.indexOf('[Utemezett feladat:', heartbeatBlockStart)
    expect(outerElseMarker).toBeGreaterThan(heartbeatBlockStart)
    const heartbeatBlock = SRC.slice(heartbeatBlockStart, outerElseMarker)
    // No inner agentName branch deciding whether to inject a directive.
    expect(heartbeatBlock).not.toMatch(/agentName === 'heartbeat'/)
  })

  it('documents the security rationale at the branch (why, not just what)', () => {
    expect(SRC).toMatch(/SECURITY|inject|poison|wrapUntrusted/i)
  })
})

// Regression guard for 2026-07-27 (Zara report, Marveen diagnosis): the
// scheduled-task prompt prefix carried a "chat_id: 0" sentinel from a
// pre-plugin channel implementation. The official Telegram plugin rejects it
// (assertAllowedChat: "0" is never allowlisted), so every non-heartbeat
// scheduled task threw at delivery. The fix resolves the agent's own bound
// chat from its channel access.json at prompt-build time.

describe('chatIdFromAccessConfig (pure core)', () => {
  it('returns the first DM allowlist entry', () => {
    expect(chatIdFromAccessConfig({ allowFrom: ['1268077055'], groups: {} })).toBe('1268077055')
    expect(chatIdFromAccessConfig({ allowFrom: ['111', '222'] })).toBe('111')
  })

  it('accepts numeric entries and trims strings', () => {
    expect(chatIdFromAccessConfig({ allowFrom: [1268077055] })).toBe('1268077055')
    expect(chatIdFromAccessConfig({ allowFrom: [' 42 '] })).toBe('42')
  })

  it('falls back to the first allowed group when no DM entry exists', () => {
    expect(chatIdFromAccessConfig({ allowFrom: [], groups: { '-100123': {} } })).toBe('-100123')
  })

  it('returns null for missing/empty/corrupt bindings (config gap, not a default)', () => {
    expect(chatIdFromAccessConfig(null)).toBeNull()
    expect(chatIdFromAccessConfig('nope')).toBeNull()
    expect(chatIdFromAccessConfig({})).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [], groups: {} })).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [''] })).toBeNull()
  })
})

describe('schedule-runner source contract (sentinel removed)', () => {
  it('no prompt prefix carries the dead chat_id: 0 sentinel anymore', () => {
    expect(SRC).not.toMatch(/chat_id:\s*0[,)]/)
  })

  it('the no-binding branch omits the Telegram instruction instead of guessing a chat', () => {
    expect(SRC).toContain('prompt omits the Telegram delivery instruction')
    expect(SRC).toMatch(/prefix = `\[Utemezett feladat: \$\{task\.name\}\] `/)
  })

  it('resolution reads the same access.json the plugin enforces', () => {
    expect(SRC).toContain("channelStateDir('telegram'")
    expect(SRC).toContain('chatIdFromAccessConfig')
  })

  it('multi-entry allowlists produce an ambiguity warn (heuristic made visible)', () => {
    // Behaviour stays first-entry; the warn exists so a reordered allowlist
    // (2+ entries: zara/iris) cannot silently redirect task results.
    expect(SRC).toContain('bound-chat resolution is ambiguous')
    expect(SRC).toMatch(/candidates > 1/)
  })
})

// Same-minute injection starvation (2026-07-20 incident): several tasks due in
// one scan window are fired sequentially, and a single injection takes seconds
// to a minute (readiness double-sample, waitForIdle gate, chunked typing).
// listScheduledTasks() returns directory order, so at 07:30 the alphabetical
// alkuszoktatas-feedback-figyelo heartbeat was injected before the
// reggeli-napindito morning briefing every day. Fix: order due tasks by
// injection priority (forceSend > plain task > heartbeat) before firing.
//
// The companion delivery bug (2026-07-17): forceSend bypassed EVERY busy state,
// including context saturation -- the prompt was typed into a 100%-context
// session that could never act on it, and the context-guard's rescue restart
// discarded the queued input. A silent drop wearing a "fired" log line.
// Fix: forceSend defers ONLY on saturation, via the pending-retry queue.

describe('taskInjectionRank: forceSend outranks tasks outranks heartbeats', () => {
  it('ranks forceSend first regardless of type', () => {
    expect(taskInjectionRank({ forceSend: true, type: 'task' })).toBe(0)
    expect(taskInjectionRank({ forceSend: true, type: 'heartbeat' })).toBe(0)
  })

  it('ranks plain tasks before heartbeats', () => {
    expect(taskInjectionRank({ forceSend: false, type: 'task' })).toBeLessThan(
      taskInjectionRank({ forceSend: false, type: 'heartbeat' }),
    )
    expect(taskInjectionRank({ type: 'command' })).toBeLessThan(
      taskInjectionRank({ type: 'heartbeat' }),
    )
  })

  it('reproduces the 07-20 ordering: napindito (forceSend) beats the feedback heartbeat', () => {
    const due = [
      { name: 'alkuszoktatas-feedback-figyelo', forceSend: undefined, type: 'heartbeat' },
      { name: 'reggeli-napindito', forceSend: true, type: 'task' },
      { name: 'reggeli-penzugyi-riasztasok', forceSend: undefined, type: 'task' },
    ] as const
    const ordered = [...due].sort((a, b) => taskInjectionRank(a) - taskInjectionRank(b))
    expect(ordered.map(t => t.name)).toEqual([
      'reggeli-napindito',
      'reggeli-penzugyi-riasztasok',
      'alkuszoktatas-feedback-figyelo',
    ])
  })

  it('the cron loop actually applies the rank ordering', () => {
    // The task list must be rank-sorted before the fire loop iterates it.
    const sortIdx = SRC.indexOf('tasks.sort((a, b) => taskInjectionRank(a) - taskInjectionRank(b))')
    const loopIdx = SRC.indexOf('for (const task of tasks)')
    expect(sortIdx).toBeGreaterThan(0)
    expect(loopIdx).toBeGreaterThan(sortIdx)
  })
})

describe('forceSend defers on context saturation instead of injecting', () => {
  it('checks paneShowsContextSaturation inside the forceSend branch and returns busy', () => {
    const idx = SRC.indexOf('if (task.forceSend) {')
    expect(idx).toBeGreaterThan(0)
    const branch = SRC.slice(idx, idx + 1800)
    expect(branch).toMatch(/paneShowsContextSaturation/)
    expect(branch).toMatch(/return 'busy'/)
  })

  it('the skipIfBusy drop exempts forceSend so the deferral queues a retry', () => {
    // A forceSend 'busy' comes only from the saturation deferral; dropping it
    // on skipIfBusy would recreate the silent loss the deferral exists to fix.
    expect(SRC).toMatch(/task\.skipIfBusy && !task\.forceSend/)
  })
})

// A scheduled prompt's closing Enter is occasionally swallowed by the Claude
// TUI in raw mode, leaving the prompt parked in the input box. A parked box
// reads 'typing' (not idle), so isSessionReadyForPrompt() stays false and every
// subsequent scheduled task is deferred -- the session pins itself busy for
// hours on one stranded prompt (2026-07-01: 3223 deferrals, 0/96 heartbeats
// fired in 24h). The old resubmit only pressed bare Enter and gave up after 5;
// a persistently swallowed Enter never recovered. The escalation ladder now
// escalates to a real clear + re-inject.

describe('decideScheduledResubmitAction: post-send resubmit escalation ladder', () => {
  it('does nothing when the prompt is not parked (already submitted)', () => {
    expect(decideScheduledResubmitAction(0, false)).toBe('none')
    expect(decideScheduledResubmitAction(3, false)).toBe('none')
  })

  it('tries a cheap bare Enter for the first two attempts', () => {
    expect(decideScheduledResubmitAction(0, true)).toBe('enter')
    expect(decideScheduledResubmitAction(1, true)).toBe('enter')
  })

  it('escalates to clear + re-inject once bare Enter keeps failing', () => {
    expect(decideScheduledResubmitAction(2, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(3, true)).toBe('reinject')
    expect(decideScheduledResubmitAction(5, true)).toBe('reinject')
  })

  it('gives up at the hard cap so a truly wedged box does not spin forever', () => {
    expect(decideScheduledResubmitAction(6, true)).toBe('giveup')
    expect(decideScheduledResubmitAction(10, true)).toBe('giveup')
  })

  it('never gives up while the box is empty, regardless of attempt count', () => {
    expect(decideScheduledResubmitAction(6, false)).toBe('none')
  })
})

describe('schedule-runner: resubmit wiring uses the real clear + re-inject', () => {
  it('imports the verified parked-input clear routine', () => {
    expect(SRC).toMatch(/clearStaleParkedInput/)
  })

  it('re-injects the full prompt with the idle gate off (box is typing, not idle)', () => {
    expect(SRC).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: false \}\)/)
  })

  it('routes the resubmit action through the pure decision function', () => {
    expect(SRC).toMatch(/decideScheduledResubmitAction\(attempt, stuck\)/)
  })
})

describe('schedule-runner: resubmit probe+act is a recover-mode critical section (TASKTAIL805)', () => {
  it('takes the pane send lane in recover mode around the whole probe+act step', () => {
    // recover, not deliver: acting on a pane mid-delivery is exactly the
    // truncation+duplication bug this exists to prevent, so fail-closed.
    expect(SRC).toMatch(/withSessionSendLock\(session, host, 'recover'/)
  })

  it('skips fail-closed when the lane is busy and retries the SAME attempt', () => {
    // A skip is not an escalation: the pane was never measured, so the attempt
    // counter must not advance (else a busy lane walks the ladder to giveup
    // without a single real probe).
    expect(SRC).toMatch(/resubmit\(attempt, laneBusySkips \+ 1\)/)
  })

  it('bounds the lane-busy skip chain and logs both the skip and the give-up', () => {
    expect(SRC).toMatch(/RESUBMIT_LANE_BUSY_MAX_SKIPS/)
    expect(SRC).toMatch(/resubmit skipped: a delivery is in flight/)
    expect(SRC).toMatch(/lane stayed busy past the skip budget/)
  })

  it('captures the pane INSIDE the critical section, not before it', () => {
    // The measurement must be atomic with the keystroke: a pane sampled outside
    // the lock can change before the Enter/clear lands.
    const lockIdx = SRC.indexOf("withSessionSendLock(session, host, 'recover'")
    const captureIdx = SRC.indexOf('const pane = capturePane(session, host)', SRC.indexOf('const resubmit'))
    expect(lockIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(lockIdx)
  })
})

describe('schedule-runner: resubmit dead ends are compensated, never silent', () => {
  it("the 'giveup' exit enqueues a pending retry (the run-log already says 'fired')", () => {
    // attemptFireTask records 'fired' + stamps scheduleLastRun BEFORE the
    // detached resubmit chain runs; a giveup without compensation is a run-log
    // row that says 'fired' for a task that never ran.
    const giveupIdx = SRC.indexOf('still stuck after Enter + re-inject retries -- giving up')
    expect(giveupIdx).toBeGreaterThan(-1)
    const after = SRC.slice(giveupIdx, giveupIdx + 1200)
    expect(after).toMatch(/insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'giveup'\)/)
  })

  it('the lane-busy-exhausted exit enqueues a pending retry too', () => {
    // Exhausting the skip budget exits with NO measurement ever taken -- the
    // prompt may be parked and nothing would ever look again.
    const busyIdx = SRC.indexOf('lane stayed busy past the skip budget')
    expect(busyIdx).toBeGreaterThan(-1)
    const after = SRC.slice(busyIdx, busyIdx + 800)
    expect(after).toMatch(/insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'lane-busy'\)/)
  })
})

// Tests for the heartbeat pre-check mechanism (#234).
//
// Pre-check scripts run before the LLM is invoked. If the script outputs
// "SKIP", the LLM is not called this tick (token cost ~0 for empty heartbeats).
// If the script outputs a non-empty string, it is prepended to the prompt as
// context. If the script exits non-zero or is missing, the LLM runs anyway
// (fail-open).

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: 'test-task',
    description: 'test',
    prompt: 'Do something.',
    schedule: '0 * * * *',
    agent: 'jarvis',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    ...overrides,
  }
}

function withScript(content: string, ext = '.sh'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-'))
  const file = join(dir, `pre-check${ext}`)
  writeFileSync(file, content, { mode: 0o755 })
  return { dir, file }
}

describe('runPreCheck', () => {
  it('returns skip=false when task has no preCheck configured', () => {
    const result = runPreCheck(makeTask())
    expect(result.skip).toBe(false)
    expect(result.prefix).toBeUndefined()
  })

  it('returns skip=true when script outputs SKIP', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "SKIP"\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(true)
      expect(result.prefix).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns skip=false with prefix when script outputs actionable text', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "3 actionable cards found"\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
      expect(result.prefix).toBe('3 actionable cards found')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns skip=false with no prefix when script outputs nothing', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\nexit 0\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
      expect(result.prefix).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('fails open (skip=false) when script exits non-zero', () => {
    const { file, dir } = withScript('#!/usr/bin/env bash\necho "error"\nexit 1\n')
    try {
      const result = runPreCheck(makeTask({ preCheck: file }))
      expect(result.skip).toBe(false)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('fails open (skip=false) when script path does not exist', () => {
    const result = runPreCheck(makeTask({ preCheck: '/nonexistent/path/pre-check.sh' }))
    expect(result.skip).toBe(false)
  })
})

describe('schedule-runner pre-check integration (source-level)', () => {
  it('exports runPreCheck function', () => {
    expect(SRC).toMatch(/export function runPreCheck/)
  })

  it('calls runPreCheck in the cron loop before attemptFireTask', () => {
    const cronLoopIdx = SRC.indexOf('for (const task of tasks)')
    expect(cronLoopIdx).toBeGreaterThan(0)
    const cronLoop = SRC.slice(cronLoopIdx)
    const preCheckIdx = cronLoop.indexOf('runPreCheck(task)')
    const fireIdx = cronLoop.indexOf('attemptFireTask(task,')
    expect(preCheckIdx).toBeGreaterThan(0)
    expect(preCheckIdx).toBeLessThan(fireIdx)
  })

  it('calls runPreCheck in the pending-retry loop before attemptFireTask', () => {
    const retryLoopIdx = SRC.indexOf('for (const row of pendingRows)')
    expect(retryLoopIdx).toBeGreaterThan(0)
    const retryLoop = SRC.slice(retryLoopIdx, SRC.indexOf('for (const task of tasks)'))
    expect(retryLoop).toMatch(/runPreCheck\(taskDef\)/)
    expect(retryLoop).toMatch(/attemptFireTask\(taskDef,/)
  })

  it('passes preCheckPrefix to attemptFireTask in the cron loop', () => {
    expect(SRC).toMatch(/attemptFireTask\(task, agentName, now, cronPc\.prefix, lateCatchUpMs\)/)
  })

  it('skips and records the run when pre-check returns skip in cron loop', () => {
    const cronLoopIdx = SRC.indexOf('for (const task of tasks)')
    const afterCronPc = SRC.slice(cronLoopIdx)
    // The cronPc.skip branch must set the lastRun guard and append a skipped run
    const skipBlock = afterCronPc.slice(afterCronPc.indexOf('if (cronPc.skip)'), afterCronPc.indexOf('for (const agentName of targetAgents) {'))
    expect(skipBlock).toMatch(/cronPc\.skip/)
    expect(skipBlock).toMatch(/scheduleLastRun\.set/)
    // appendTaskRun is inside the targetAgents loop within the skip block
    expect(afterCronPc.slice(
      afterCronPc.indexOf('if (cronPc.skip)'),
      afterCronPc.indexOf('if (pendingKeys.has(key))'),
    )).toMatch(/appendTaskRun/)
  })

  it('uses fail-open semantics (no SKIP on non-zero exit, no throw on missing file)', () => {
    const preCheckFn = SRC.slice(SRC.indexOf('export function runPreCheck'))
    const fnBody = preCheckFn.slice(0, preCheckFn.indexOf('\nexport function'))
    // Non-zero exit returns { skip: false }
    expect(fnBody).toMatch(/r\.status !== 0/)
    expect(fnBody).toMatch(/running LLM anyway/)
    // Missing file returns { skip: false }
    expect(fnBody).toMatch(/not found, running LLM anyway/)
  })
})
