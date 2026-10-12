import { describe, it, expect } from 'vitest'
import { identitySlashCommands } from '../web/agent-process.js'

// Locks the identity slash commands sent on every Claude Code session
// (re)start -- both the normal startup and the channel-monitor recovery
// respawns route through scheduleIdentitySetup, which uses these. Only `/rename`
// is sent now; `/remote-control` was dropped (the operator no longer uses it).
//
// The `/name` case below is not a style assertion. `/name` is not a Claude Code
// command -- the CLI answers "Unknown command: /name. Did you mean /rename?" and
// leaves the rejected line PARKED in the input box, where it lands only when the
// current turn ends. A parked input line makes the router read the session as
// busy, so inter-agent messages stop being delivered and the channel goes quiet
// with no error. The previous version of this test asserted `/name`, which is
// why CI stayed green while no session was ever renamed.
describe('identitySlashCommands', () => {
  it('returns just /rename with the display name', () => {
    expect(identitySlashCommands('Zoé')).toEqual(['/rename Zoé'])
  })

  it('never sends /name -- there is no such Claude Code command', () => {
    expect(identitySlashCommands('Zoé').some((c) => c.startsWith('/name'))).toBe(false)
  })

  it('does not send /remote-control', () => {
    expect(identitySlashCommands('Mr. Wolf').some((c) => c.includes('/remote-control'))).toBe(false)
  })
})
