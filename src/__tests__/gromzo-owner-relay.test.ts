// GROMZONOPROVIDER1108: on a gromzo install an owner alert has no bot token and no chat id; it goes to the MAIN agent,
// which relays it over Gromzo (the owner DM). Without a registered relay (a process that never opens the database)
// it is skipped with a log line, never a silent success.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, CHANNEL_PROVIDER: 'gromzo' as const, CHANNEL_TOKEN: '', CHANNEL_CHAT_ID: '', ALERT_CHAT_ID: '' }
})

const { notifyChannel, setOwnerRelaySink, setOwnerRelayLang } = await import('../notify.js')

describe('owner alerts on a gromzo install go through the main agent', () => {
  beforeEach(() => { setOwnerRelaySink(null); setOwnerRelayLang(() => 'hu') })

  it('relayed: the main agent gets the alert with the relay instruction, verbatim, and the send reports true', async () => {
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    expect(await notifyChannel('the backup failed')).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^\[owner-alert\] /)
    expect(seen[0]).toContain('a Gromzón')
    expect(seen[0].endsWith('the backup failed')).toBe(true)
  })

  it('no relay registered: false (skipped), never a silent success', async () => {
    expect(await notifyChannel('x')).toBe(false)
  })

  it('a relay that throws: false', async () => {
    setOwnerRelaySink(() => { throw new Error('db down') })
    expect(await notifyChannel('x')).toBe(false)
  })

  it('an English install gets the English relay instruction (Dani 73584 (2))', async () => {
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    setOwnerRelayLang(() => 'en')
    expect(await notifyChannel('the nightly job failed')).toBe(true)
    expect(seen[0]).toMatch(/^\[owner-alert\] An alert for the owner\. Send it to them over Gromzo/)
    expect(seen[0].endsWith('the nightly job failed')).toBe(true)
  })
})
