import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARD_RESTART_VERIFY_MS, paneRunsClaude, scheduleHardRestartVerify } from '../web/hard-restart-verify.js'

// CHANNELSDUP1023 follow-up (b): a successful hard restart is measured once more, a few
// minutes later -- is claude running in the main pane?
describe('paneRunsClaude', () => {
  it('a pane that is not dead, with a claude the liveness finds', () => {
    expect(paneRunsClaude(false, 21657)).toBe(true)
  })
  it('a dead pane, an unreadable pane, or no claude: not running', () => {
    expect(paneRunsClaude(true, 21657)).toBe(false)
    expect(paneRunsClaude(null, 21657)).toBe(false)
    expect(paneRunsClaude(false, null)).toBe(false)
  })
})

describe('scheduleHardRestartVerify', () => {
  afterEach(() => { vi.useRealTimers() })
  it('alerts once, after the delay, when claude is not running', () => {
    vi.useFakeTimers()
    const onNoClaude = vi.fn()
    scheduleHardRestartVerify(() => false, onNoClaude)
    vi.advanceTimersByTime(HARD_RESTART_VERIFY_MS - 1)
    expect(onNoClaude).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onNoClaude).toHaveBeenCalledTimes(1)
  })
  it('stays quiet when claude runs', () => {
    vi.useFakeTimers()
    const onNoClaude = vi.fn()
    scheduleHardRestartVerify(() => true, onNoClaude)
    vi.advanceTimersByTime(HARD_RESTART_VERIFY_MS)
    expect(onNoClaude).not.toHaveBeenCalled()
  })
  it('a newer restart replaces the pending check: only the latest one is judged', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    scheduleHardRestartVerify(() => false, first)
    vi.advanceTimersByTime(60_000)
    scheduleHardRestartVerify(() => false, second)
    vi.advanceTimersByTime(HARD_RESTART_VERIFY_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('wiring in channel-monitor.ts', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const start = src.indexOf('export function hardRestartMarveenChannels')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  it('every success path of the hard restart schedules the check, right after its own stamp', () => {
    expect(body.match(/verifyHardRestartLater\(\)/g)?.length).toBe(3)
    expect(body.match(/noteOwnHardRestartStamp\(marveenLastHardRestart\)[^\n]*\n\s*verifyHardRestartLater\(\)/g)?.length).toBe(3)
  })
  it('the check probes the pane with the liveness detection and, when claude is gone, logs an error and alerts the owner unconditionally', () => {
    const a = src.indexOf('function verifyHardRestartLater')
    const helper = src.slice(a, src.indexOf('\n}\n', a))
    expect(helper).toContain('() => paneRunsClaude(mainPaneDead(), getClaudePidForSession(MAIN_CHANNELS_SESSION)),')
    // The onNoClaude callback cut out up to its OWN closing brace, line by line (Dani's #2204
    // review: a lazy regex let an `if (false)` in front of the alert pass).
    const head = '    () => {\n'
    const cb = helper.slice(helper.indexOf(head) + head.length, helper.indexOf('\n    },\n'))
    const lines = cb.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^logger\.error\(/)
    // Owner-action alert (Szotasz/marveen#2353 review): a verification
    // failure is never a self-heal, so it must stay off the gated path.
    expect(lines.some((l) => /^sendOwnerActionAlert\('main-hard-restart-no-claude', /.test(l))).toBe(true)
    expect(lines.some((l) => /^sendRoutineAlert\(/.test(l))).toBe(false)
  })
})
