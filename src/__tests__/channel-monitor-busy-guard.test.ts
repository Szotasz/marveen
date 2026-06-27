// Guards the busy-check that protects an actively-generating agent from being
// hard-restarted (stop+start) when its channel plugin reads "down".
//
// Root cause this defends (Reni-reported): the channel-monitor tick would
// stopAgentProcess + startAgentProcess an agent the moment hasChannelPluginAlive
// returned false, with no regard for whether the agent was mid-turn. That kills
// the agent's in-flight work and its --continue context ("restarted me during
// development"). The fix defers the destructive restart while the pane reads
// 'busy'. The restart loop is not exported as a unit, so -- matching the
// existing source-assertion convention in this dir -- we assert the guard's
// presence AND that it sits BEFORE the destructive stopAgentProcess call.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')

describe('channel-monitor: busy-guard before destructive auto-restart', () => {
  const src = readFileSync(MONITOR_PATH, 'utf-8')

  // Anchor on the auto-restart warning that immediately precedes the hard
  // restart (the only stop+start in the down-agent path).
  const restartLogIdx = src.indexOf("'Agent channel plugin down -- auto-restarting'")
  const stopIdx = src.indexOf('stopAgentProcess(t.agentName!)')

  it('the down-agent hard-restart path still exists', () => {
    expect(restartLogIdx, 'auto-restart log line not found').toBeGreaterThan(0)
    expect(stopIdx, 'stopAgentProcess call not found').toBeGreaterThan(0)
  })

  it('a busy-check defers the restart and sits BEFORE the stop+start', () => {
    // The guard slice: window between the per-tick stagger check and the
    // destructive restart. Look just before the auto-restart log line.
    const windowStart = Math.max(0, restartLogIdx - 1200)
    const guardWindow = src.slice(windowStart, restartLogIdx)

    // It must bail on 'busy'. The pane is captured once higher up (downPaneState
    // = detectPaneState(...)) and reused here, so the busy check reads the
    // cached state rather than re-capturing.
    expect(guardWindow, 'busy-guard missing before hard restart').toMatch(
      /downPaneState\s*===\s*'busy'/,
    )
    expect(guardWindow, 'busy-guard must continue (defer) rather than fall through').toMatch(
      /busy[\s\S]*?continue/i,
    )
    // Ordering: the guard must precede the destructive stopAgentProcess.
    expect(restartLogIdx).toBeLessThan(stopIdx)
  })

  it('the pane state powering the busy-guard is read via detectPaneState', () => {
    // The single capture+classify that both the fast-retry decision and the
    // busy-guard reuse.
    expect(src).toMatch(/const downPaneState = detectPaneState\(/)
  })
})
