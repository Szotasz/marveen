import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchdRestartTookEffect } from '../web/channel-monitor.js'

const MONITOR_PATH = join(__dirname, '../web/channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

// Measured 2026-09-04 on the jarvis install: the context guard's saturation net
// fired four times in one morning, each time logging "Hard restart: launchctl
// reload" and announcing a restart, while the main pane's claude process kept
// the same pid for 34 hours. `launchctl print gui/501/com.jarvis.channels`
// showed `runs = 0` -- the job had never been spawned since registration, so
// `unload` had nothing to stop. launchctl's exit code says the COMMAND ran, not
// that the session restarted.
describe('hardRestartMarveenChannels: launchd reload is verified by effect, not exit code', () => {
  describe('launchdRestartTookEffect', () => {
    it('is true only for an observed, different pid', () => {
      expect(launchdRestartTookEffect(6476, 70123)).toBe(true)
    })

    it('is false when the pid is unchanged (the measured no-op)', () => {
      expect(launchdRestartTookEffect(6476, 6476)).toBe(false)
    })

    it('is false when either reading is missing -- an unreadable pane is not proof of a restart', () => {
      expect(launchdRestartTookEffect(null, 70123)).toBe(false)
      expect(launchdRestartTookEffect(6476, null)).toBe(false)
      expect(launchdRestartTookEffect(null, null)).toBe(false)
    })
  })

  const fnStart = src.indexOf('export function hardRestartMarveenChannels')
  expect(fnStart, 'hardRestartMarveenChannels not found').toBeGreaterThan(0)
  const fnEnd = src.indexOf('\n// Escalate a main channel input', fnStart)
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)

  it('reads the pane pid BEFORE the launchctl calls', () => {
    const beforeIdx = fnBody.indexOf('const pidBefore = mainPaneClaudePid()')
    const unloadIdx = fnBody.indexOf("'unload'")
    expect(beforeIdx, 'pre-call pid reading missing').toBeGreaterThan(0)
    expect(beforeIdx).toBeLessThan(unloadIdx)
  })

  it('does not report success straight from the launchctl exit code', () => {
    const loadIdx = fnBody.indexOf("'load'")
    const okIdx = fnBody.indexOf('return { ok: true }')
    const effectIdx = fnBody.indexOf('launchdRestartTookEffect(pidBefore, pidAfter)')
    expect(effectIdx, 'effect check missing').toBeGreaterThan(loadIdx)
    expect(effectIdx).toBeLessThan(okIdx)
  })

  it('falls through to the respawn-pane path when the pid did not change', () => {
    // No `return` between the failed effect check and the respawn-pane call:
    // the whole point is that a no-effect reload must not end the function.
    const noEffectIdx = fnBody.indexOf('falling through to respawn-pane')
    const respawnIdx = fnBody.indexOf('respawnMarveenSessionFresh()')
    expect(noEffectIdx, 'no-effect log line missing').toBeGreaterThan(0)
    expect(respawnIdx).toBeGreaterThan(noEffectIdx)
    expect(fnBody.slice(noEffectIdx, respawnIdx)).not.toMatch(/return \{ ok: true \}/)
  })

  it('keeps the "plist absent" warning for the plist-absent case only', () => {
    // The fall-through path now also reaches that line; claiming the plist is
    // absent there would be false.
    const warnIdx = fnBody.indexOf('launchd channels plist absent')
    expect(warnIdx).toBeGreaterThan(0)
    const guard = fnBody.slice(Math.max(0, warnIdx - 200), warnIdx)
    expect(guard).toMatch(/!existsSync\(MAIN_CHANNELS_PLIST\)/)
  })
})
