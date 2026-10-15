import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Measured on a live install: the context guard restarted a worksourceChannel
// sub-agent, and the new session sat on Claude Code's development-channels
// warning for ~10 minutes until a human pressed Enter:
//
//   Please use --channels to run a list of approved channels.
//   Channels: server:worksource
//   ❯ 1. I am using this for local development
//     2. Exit
//   Enter to confirm · Esc to cancel
//
// Nothing in the fleet recognised that panel. Every earlier start got past it
// only because scheduleIdentitySetup's `/rename <name>` ends in Enter, and that
// Enter confirmed whatever the dialog highlighted -- a blind Enter into a
// dialog, which the fleet forbids. The restart that hung was the one start
// whose dashboard process died (systemd restart, +5.7s) before that timer.
//
// These tests drive the real post-spawn door (scheduleIdentitySetup, which
// startAgentProcess -- and therefore restartAgentProcess and the context
// guard -- calls for every new session) against a scripted pane:
// boot -> dialog -> prompt. The pane only leaves the dialog when an Enter
// arrives; what matters is WHICH Enter.
//
// Harness as in janitor-under-send-lane.test.ts: capturePane/runTmux are local
// to agent-process and go through node:child_process execFileSync.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const dialog = (cursorOnDev: boolean) => [
    SEP,
    ' WARNING: Loading development channels',
    '',
    ' --dangerously-load-development-channels is for local channel development only. Do not use this',
    ' option to run channels you have downloaded off the internet.',
    '',
    ' Please use --channels to run a list of approved channels.',
    '',
    ' Channels: server:worksource',
    '',
    cursorOnDev ? ' ❯ 1. I am using this for local development' : '   1. I am using this for local development',
    cursorOnDev ? '   2. Exit' : ' ❯ 2. Exit',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  const PROMPT = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
  return {
    DIALOG_DEV: dialog(true),
    DIALOG_EXIT: dialog(false),
    PROMPT,
    // 'boot' -> blank pane, 'dialog' -> the warning, 'prompt' -> REPL, 'exited' -> TUI quit
    state: 'boot' as 'boot' | 'dialog' | 'prompt' | 'exited',
    cursorOnDev: true,
    // Every send-keys, tagged with what was on screen when it arrived.
    keys: [] as { onScreen: string; args: string[] }[],
  }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (!Array.isArray(args)) return ''
    if (args.includes('capture-pane')) {
      if (h.state === 'dialog') return h.cursorOnDev ? h.DIALOG_DEV : h.DIALOG_EXIT
      if (h.state === 'prompt') return h.PROMPT
      return ''
    }
    if (args.includes('send-keys')) {
      h.keys.push({ onScreen: h.state, args: [...args] })
      // Claude Code's DevChannelsDialog: Enter confirms the highlighted row.
      // "I am using this for local development" -> the REPL comes up;
      // "Exit" -> process exits. Escape exits too (exit(0) in 2.1.280).
      if (h.state === 'dialog') {
        const last = args[args.length - 1]
        if (last === 'Enter') h.state = h.cursorOnDev ? 'prompt' : 'exited'
        if (last === 'Escape') h.state = 'exited'
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { scheduleIdentitySetup, isSessionReadyForPrompt } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'
import { decideGuard, DEFAULT_CONTEXT_GUARD, READY_TIMEOUT_MS, type GuardState } from '../context-guard.js'
import { resumePrompt } from '../web/context-guard-runner.js'
import { detectsFirstRunGate, devChannelsAcceptKeys } from '../pane-state.js'

const SESSION = 'agent-worker-a'
// The dialog renders a few seconds after spawn, before the 8s post-spawn mark.
const DIALOG_AT_MS = 3000

function keysWhileDialogUp() {
  return h.keys.filter(k => k.onScreen === 'dialog')
}

beforeEach(() => {
  vi.useFakeTimers()
  h.state = 'boot'
  h.cursorOnDev = true
  h.keys.length = 0
  __resetSessionSendLocks()
  setTimeout(() => { h.state = 'dialog' }, DIALOG_AT_MS)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the dialog is a recognised first-run gate', () => {
  it('is classified as dev-channels -- which also keeps the router from reading the agent as serving', () => {
    expect(detectsFirstRunGate(h.DIALOG_DEV)).toBe('dev-channels')
    expect(detectsFirstRunGate(h.DIALOG_EXIT)).toBe('dev-channels')
  })

  it('a live prompt that merely QUOTES the option is not the dialog', () => {
    const quoted = [
      '● A startup panel asked: "I am using this for local development" (Loading development channels).',
      h.PROMPT,
    ].join('\n')
    expect(detectsFirstRunGate(quoted)).toBeNull()
  })

  it('confirms only when the highlighted row is the development option', () => {
    expect(devChannelsAcceptKeys(h.DIALOG_DEV)).toEqual(['Enter'])
    // Cursor on "Exit": no navigation, no key.
    expect(devChannelsAcceptKeys(h.DIALOG_EXIT)).toBeNull()
    // Not this dialog at all.
    expect(devChannelsAcceptKeys(h.PROMPT)).toBeNull()
  })
})

describe('post-spawn: the development-channels dialog', () => {
  it('is confirmed by a dedicated Enter, and nothing else is typed into it', async () => {
    void scheduleIdentitySetup(SESSION, 'Worker A')
    await vi.advanceTimersByTimeAsync(60_000)

    const onDialog = keysWhileDialogUp()
    // Exactly one keystroke reached the dialog, and it was a bare Enter with
    // the cursor on "I am using this for local development".
    expect(onDialog.map(k => k.args.slice(3))).toEqual([['Enter']])
    // The /rename (text + Enter) was NOT the thing that cleared the dialog.
    // On the unfixed code this is exactly what happened: '/rename Worker A',
    // 'Enter' typed into the panel, the Enter confirming its default.
    expect(onDialog.some(k => k.args.some(a => a.startsWith('/rename')))).toBe(false)
    expect(h.state).toBe('prompt')
  })

  it('the identity /rename is still sent -- after the dialog, into the prompt', async () => {
    void scheduleIdentitySetup(SESSION, 'Worker A')
    await vi.advanceTimersByTimeAsync(60_000)

    const rename = h.keys.filter(k => k.args.includes('/rename Worker A'))
    expect(rename).toHaveLength(1)
    expect(rename[0]!.onScreen).toBe('prompt')
  })

  it('never sends a key when the highlighted row is not the development option', async () => {
    // A reordered panel (cursor on "Exit"). Enter would quit the TUI, and so
    // would Escape; the only correct move is none.
    h.cursorOnDev = false
    void scheduleIdentitySetup(SESSION, 'Worker A')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(keysWhileDialogUp()).toEqual([])
    expect(h.state).toBe('dialog')
  })
})

describe('context guard: the resume prompt follows the dialog', () => {
  // The guard restarts at sweep T0 and moves to await-ready with a deadline of
  // T0 + READY_TIMEOUT_MS; the sweep at that deadline is its last chance to
  // inject the resume prompt, and it injects only into a READY session. A
  // dialog still up at that sweep = "ready timeout -- giving up".
  const awaitReady = (t0: number): GuardState => ({
    phase: 'await-ready',
    handoffMtimeAtRequest: null,
    deadlineMs: t0 + READY_TIMEOUT_MS,
    cooldownUntilMs: 0,
    saturatedStreak: 0,
    staleRefreshCount: 0,
    handoffStaleMinutes: null,
  })

  async function nextSweep(t0: number) {
    // The readiness probe double-captures across a short real delay; the
    // scripted pane is static by now, so real timers are fine here.
    vi.useRealTimers()
    const sessionReady = await isSessionReadyForPrompt(SESSION)
    return decideGuard(awaitReady(t0), {
      nowMs: t0 + READY_TIMEOUT_MS,
      pct: null,
      running: true,
      paneIdle: false,
      paneBusy: false,
      sessionReady,
      handoffMtime: null,
      paneSaturated: false,
      contextTokens: null,
      idleMs: null,
      dailyHandoffDue: false,
      usageLimited: false,
      pendingResumeExpiresAtMs: null,
    }, DEFAULT_CONTEXT_GUARD)
  }

  it('dialog answered post-spawn -> the next sweep injects the resume prompt', async () => {
    const t0 = Date.now()
    void scheduleIdentitySetup(SESSION, 'Worker A')
    await vi.advanceTimersByTimeAsync(60_000)

    const decision = await nextSweep(t0)
    expect(decision.action).toBe('inject-resume')
    // ...and the prompt it injects points the fresh session at its handoff.
    expect(resumePrompt('worker-a', '/x/HANDOFF.md', true, null)).toContain('/x/HANDOFF.md')
  })

  it('dialog left up -> the sweep gives up on the resume (the measured failure shape)', async () => {
    // Reference case, no post-spawn door at all: what the successor dashboard
    // saw after the one that spawned the agent was restarted.
    const t0 = Date.now()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.state).toBe('dialog')

    const decision = await nextSweep(t0)
    expect(decision.action).toBe('none')
    expect(decision.reason).toMatch(/ready timeout/)
  })
})

describe('wiring (source-level)', () => {
  const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
  const CHANNEL_MONITOR = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')

  it('every start door (start, restart, context guard) reaches scheduleIdentitySetup after the spawn', () => {
    const start = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function startAgentProcess('))
    const spawnAt = start.indexOf("runTmux(startTarget, ['new-session'")
    const identityAt = start.indexOf('scheduleIdentitySetup(session')
    expect(spawnAt).toBeGreaterThan(0)
    expect(identityAt).toBeGreaterThan(spawnAt)
    const restart = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function restartAgentProcess('))
    expect(restart.slice(0, restart.indexOf('\n}\n'))).toContain('await startAgentProcess(name, willWake ? { ...opts, ownsResume: true } : opts)')
  })

  it('the identity setup answers startup dialogs BEFORE anything else touches the pane', () => {
    const fn = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function scheduleIdentitySetup('))
    const settleAt = fn.indexOf('await settleStartupGates(session, host)')
    expect(settleAt).toBeGreaterThan(0)
    expect(settleAt).toBeLessThan(fn.indexOf('dismissSurveyModalIfPresent(session, host)'))
    expect(settleAt).toBeLessThan(fn.indexOf("runTmux(host, ['send-keys', '-t', exactTmuxTarget(session), cmd, 'Enter']"))
  })

  it('the channel monitor re-checks worksource agents gate-only, so a dashboard restart cannot orphan the dialog', () => {
    // Gate-only: the generic blocking-menu Escape must never reach them --
    // on this dialog Escape quits the TUI.
    expect(CHANNEL_MONITOR).toMatch(/readAgentWorksourceChannel\(a\)[\s\S]{0,200}gateOnly: true/)
    expect(CHANNEL_MONITOR).toMatch(/const inMenu = firstRunGate != null \|\| \(!t\.gateOnly && /)
  })
})
