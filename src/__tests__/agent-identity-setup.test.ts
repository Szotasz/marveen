import { describe, it, expect } from 'vitest'
import { identitySlashCommands } from '../web/agent-process.js'

// Locks the identity slash commands sent on every Claude Code session
// (re)start -- both the normal startup and the channel-monitor recovery
// respawns route through scheduleIdentitySetup, which uses these. Only `/name`
// is sent now; `/remote-control` was dropped (the operator no longer uses it).
describe('identitySlashCommands', () => {
  it('returns just /name with the display name', () => {
    expect(identitySlashCommands('Zoé')).toEqual(['/name Zoé'])
  })

  it('does not send /remote-control', () => {
    expect(identitySlashCommands('Mr. Wolf').some((c) => c.includes('/remote-control'))).toBe(false)
  })
})
