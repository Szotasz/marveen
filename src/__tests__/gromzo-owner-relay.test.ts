// GROMZONOPROVIDER1108: on a gromzo install an owner alert has no bot token and no chat id; it goes to the MAIN agent,
// which relays it over Gromzo (the owner DM). Without a registered relay (a process that never opens the database)
// it is skipped with a log line, never a silent success.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = vi.hoisted(() => ({ dir: '' }))

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  STORE.dir = mk(j(td(), 'gz-relay-store-'))
  return { ...a, CHANNEL_PROVIDER: 'gromzo' as const, CHANNEL_TOKEN: '', CHANNEL_CHAT_ID: '', ALERT_CHAT_ID: '', STORE_DIR: STORE.dir }
})

const { notifyChannel, setOwnerRelaySink, setOwnerRelayLang, setGromzoPendingCheck, flushGromzoPendingOwnerAlerts, GROMZO_PENDING_ALERTS_FILE } = await import('../notify.js')

describe('owner alerts on a gromzo install go through the main agent', () => {
  beforeEach(() => { setOwnerRelaySink(null); setOwnerRelayLang(() => 'hu'); setGromzoPendingCheck(() => false) })

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

  it('PENDING (Samu 73588): the alert is kept durably (0600), not relayed to a main agent that has no Gromzo channel yet', async () => {
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    setGromzoPendingCheck(() => true)
    expect(await notifyChannel('kept one')).toBe(true)
    expect(await notifyChannel('kept two')).toBe(true)
    expect(seen).toEqual([])
    const f = join(STORE.dir, GROMZO_PENDING_ALERTS_FILE)
    const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text)
    expect(lines).toEqual(['kept one', 'kept two'])
    // still pending: a flush hands out nothing
    expect(flushGromzoPendingOwnerAlerts()).toBe(0)
    // live: the kept alerts go to the main agent, in order, and the file is gone
    setGromzoPendingCheck(() => false)
    expect(flushGromzoPendingOwnerAlerts()).toBe(2)
    expect(seen.map((t) => t.slice(-8))).toEqual(['kept one', 'kept two'])
    expect(existsSync(f)).toBe(false)
    expect(flushGromzoPendingOwnerAlerts()).toBe(0)
  })

  it('the channel-monitor sweep flushes once the gromzo main session is live', () => {
    const cm = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')
    expect(cm).toMatch(/if \(t\.isMarveen && t\.provider === 'gromzo'\) \{\n\s+try \{ flushGromzoPendingOwnerAlerts\(\) \}/)
  })
})
