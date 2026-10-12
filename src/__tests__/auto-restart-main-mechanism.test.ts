import { describe, it, expect } from 'vitest'
import { mainRestartMechanism } from '../auto-restart.js'

// Regression for a restart that never ran, on every non-macOS host.
//
// performRestart() exec'd `/bin/launchctl kickstart` for the main agent
// unconditionally. On Linux that binary does not exist, so the call threw
// ENOENT on every due slot; the throw left lastRestart unset, so the runner
// re-tried on the next tick, and the next -- 248 warn lines in one morning on
// a real install (2026-07-26), and the main agent's scheduled restart had NEVER
// fired on that host since the feature shipped.
//
// The reason it stayed hidden for so long is the shape of the failure, not its
// size: auto-restart was enabled in the dashboard, the daily time was correct,
// the sub-agents (a different code path) restarted normally, and the only
// symptom was a log line nobody reads. Everything a human would check said OK.
//
// The predicate is deliberately the launchctl BINARY rather than
// process.platform. The defect was never "wrong operating system" -- it was
// "the binary this code invokes is absent here". Asking whether the binary
// exists answers the question the code actually depends on, and it keeps
// working for anything launchd-less that is nonetheless not Linux.
describe('mainRestartMechanism', () => {
  it('uses launchd when launchctl is present (macOS: unchanged behaviour)', () => {
    expect(mainRestartMechanism(true)).toBe('launchd')
  })

  it('falls back to a tmux respawn when launchctl is absent (Linux)', () => {
    expect(mainRestartMechanism(false)).toBe('tmux-respawn')
  })

  it('never returns launchd without launchctl -- the ENOENT loop this fixes', () => {
    expect(mainRestartMechanism(false)).not.toBe('launchd')
  })
})
