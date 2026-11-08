// GROMZONOPROVIDER1108: on a gromzo install an owner alert has no bot token and no chat id; it goes to the MAIN agent,
// which relays it over Gromzo (the owner DM). Without a registered relay (a process that never opens the database)
// it is skipped with a log line, never a silent success.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = vi.hoisted(() => ({ dir: '' }))
const READY = vi.hoisted(() => ({ v: true }))
vi.mock('../web/main-gromzo-launch.js', async (orig) => {
  const a = await orig<typeof import('../web/main-gromzo-launch.js')>()
  return { ...a, mainGromzoPrimaryReady: () => READY.v }
})

vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  STORE.dir = mk(j(td(), 'gz-relay-store-'))
  return { ...a, CHANNEL_PROVIDER: 'gromzo' as const, CHANNEL_TOKEN: '', CHANNEL_CHAT_ID: '', ALERT_CHAT_ID: '', STORE_DIR: STORE.dir }
})

const { notifyChannel, setOwnerRelaySink, setOwnerRelayLang, setGromzoPendingCheck, setGromzoMainLive, flushGromzoPendingOwnerAlerts, GROMZO_PENDING_ALERTS_FILE } = await import('../notify.js')

describe('owner alerts on a gromzo install go through the main agent', () => {
  beforeEach(() => {
    setOwnerRelaySink(null); setOwnerRelayLang(() => 'hu'); setGromzoPendingCheck(() => false); setGromzoMainLive(false); READY.v = true
    const f = join(STORE.dir, GROMZO_PENDING_ALERTS_FILE)
    for (const x of [f, `${f}.flushing`, `${f}.flushing.done`]) rmSync(x, { force: true })
  })

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
    // live: the kept alerts go to the main agent as ONE message, in order (Dani 73601), and the file is gone
    setGromzoPendingCheck(() => false)
    expect(flushGromzoPendingOwnerAlerts()).toBe(2)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/\(1\/2\) kept one\n\(2\/2\) kept two$/)
    expect(existsSync(f)).toBe(false)
    expect(flushGromzoPendingOwnerAlerts()).toBe(0)
  })

  it('READY but the Gromzo plugin not seen alive (Dani 73601): nothing goes out, the alert is kept; alive -> it goes', async () => {
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    setGromzoPendingCheck(null) // the real check: the sweep's liveness AND mxd ready
    READY.v = true
    setGromzoMainLive(false)
    expect(await notifyChannel('while restarting')).toBe(true)
    expect(flushGromzoPendingOwnerAlerts()).toBe(0)
    expect(seen).toEqual([])
    setGromzoMainLive(true)
    expect(flushGromzoPendingOwnerAlerts()).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].endsWith('while restarting')).toBe(true)
    // alive but no longer ready (unenrolled): kept again
    READY.v = false
    expect(await notifyChannel('unenrolled')).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('a .flushing left by a crash goes first and is not overwritten; the newer pending file waits for the next flush', () => {
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    const f = join(STORE.dir, GROMZO_PENDING_ALERTS_FILE)
    writeFileSync(`${f}.flushing`, JSON.stringify({ at: 'x', text: 'left by a crash' }) + '\n')
    writeFileSync(f, JSON.stringify({ at: 'y', text: 'newer' }) + '\n')
    expect(flushGromzoPendingOwnerAlerts()).toBe(1)
    expect(seen[0].endsWith('left by a crash')).toBe(true)
    expect(flushGromzoPendingOwnerAlerts()).toBe(1)
    expect(seen[1].endsWith('newer')).toBe(true)
    expect(existsSync(f)).toBe(false)
  })

  it('a relay that fails during a flush keeps the alerts for the next sweep', () => {
    const f = join(STORE.dir, GROMZO_PENDING_ALERTS_FILE)
    writeFileSync(f, JSON.stringify({ at: 'x', text: 'must not vanish' }) + '\n')
    setOwnerRelaySink(() => { throw new Error('db down') })
    expect(flushGromzoPendingOwnerAlerts()).toBe(0)
    const seen: string[] = []
    setOwnerRelaySink((t) => { seen.push(t) })
    expect(flushGromzoPendingOwnerAlerts()).toBe(1)
    expect(seen[0].endsWith('must not vanish')).toBe(true)
  })

  it('the channel-monitor sweep flushes only in the ALIVE branch of the gromzo main agent, and marks not-alive otherwise', () => {
    const cm = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')
    expect(cm).toMatch(/if \(liveness === 'alive'\) \{\n\s+if \(t\.isMarveen\) \{\n\s+handleMarveenUp\(\)\n(?:\s+\/\/[^\n]*\n)+\s+if \(t\.provider === 'gromzo'\) \{\n\s+setGromzoMainLive\(true\)\n\s+try \{ flushGromzoPendingOwnerAlerts\(\) \}/)
    expect(cm.match(/flushGromzoPendingOwnerAlerts\(\)/g)?.length).toBe(1)
    // cleared on every not-alive path of the main agent: no claude pid, gromzo-pending, a dead plugin
    expect(cm.match(/setGromzoMainLive\(false\)/g)?.length).toBe(3)
    expect(cm).toMatch(/if \(t\.isMarveen\) \{\n\s+\/\/ GROMZONOPROVIDER1108 \(Dani 73601\): no claude[^\n]*\n\s+if \(t\.provider === 'gromzo'\) setGromzoMainLive\(false\)\n\s+\/\/ The claude pid is gone/)
    expect(cm).toMatch(/if \(t\.isMarveen\) \{\n(?:\s+\/\/[^\n]*\n)\s+if \(t\.provider === 'gromzo'\) setGromzoMainLive\(false\)\n\s+if \(shouldEscalateMarveenDown\(\)\)/)
  })
})
