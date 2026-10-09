import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// TELEGRAM_TOPICS_ENABLED is read in two languages: the plugin patcher
// (Python, at channel start) and the dashboard (TS: the fallback poller's
// handoff tag). Both must read the same value the same way, or a hand-written
// TELEGRAM_TOPICS_ENABLED=true patches the plugin while the dashboard calls
// the switch off.

let effective: unknown = '0'
vi.mock('../settings-store.js', async (orig) => ({
  ...(await orig<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (key: string) => {
    if (key !== 'TELEGRAM_TOPICS_ENABLED') throw new Error(`Unknown setting key: ${key}`)
    if (effective instanceof Error) throw effective
    return effective
  },
}))

const { SETTING_ON_VALUES, isSettingValueOn, isSettingOn } = await import('../setting-flag.js')
const { buildHandoffContent } = await import('../channel-coordinator.js')

const ROOT = join(__dirname, '..', '..')

describe('isSettingValueOn', () => {
  it('what the Settings page writes: "1" on, "0" off, unset off', () => {
    expect(isSettingValueOn('1')).toBe(true)
    expect(isSettingValueOn('0')).toBe(false)
    expect(isSettingValueOn('')).toBe(false)
    expect(isSettingValueOn(undefined)).toBe(false)
  })

  it('a hand-written .env value: every value src/config.ts reads as on', () => {
    for (const v of ['true', 'TRUE', 'Yes', ' on ', 1]) expect(isSettingValueOn(v), String(v)).toBe(true)
    for (const v of ['false', 'no', 'off', '2', 'enabled']) expect(isSettingValueOn(v), v).toBe(false)
  })
})

describe('one set of "on" values across the readers', () => {
  it('the plugin patcher\'s TRUTHY is the same set', () => {
    const py = readFileSync(join(ROOT, 'scripts', 'patch-telegram-plugin.py'), 'utf-8')
    const tuple = py.match(/^TRUTHY = \(([^)]*)\)/m)?.[1] ?? ''
    expect([...tuple.matchAll(/"([^"]*)"/g)].map(m => m[1])).toEqual([...SETTING_ON_VALUES])
  })

  it('src/config.ts reads its boolean flags with the same set', () => {
    const cfg = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf-8')
    const sets = [...cfg.matchAll(/\[('1', 'true', [^\]]*)\]\.includes/g)].map(m => m[1])
    expect(sets.length).toBeGreaterThan(0)
    for (const s of sets) expect(s).toBe(SETTING_ON_VALUES.map(v => `'${v}'`).join(', '))
  })
})

describe('isSettingOn and the fallback poller\'s handoff tag', () => {
  const ev = { kind: 'message', chat_id: 42, user_id: 42, username: 'owner', message_id: 8, content: 'x', tg_date: 1700000000, meta: { message_thread_id: 12 } }
  afterEach(() => { effective = '0' })

  it('"true" in .env is on for the dashboard too: the handoff tag carries the topic', () => {
    effective = 'true'
    expect(isSettingOn('TELEGRAM_TOPICS_ENABLED')).toBe(true)
    expect(buildHandoffContent(ev)).toContain('message_thread_id="12"')
  })

  it('"1" stays on and "0" stays off, as before', () => {
    effective = '1'
    expect(buildHandoffContent(ev)).toContain('message_thread_id="12"')
    effective = '0'
    expect(buildHandoffContent(ev)).not.toContain('message_thread_id')
  })

  it('an unreadable setting is off', () => {
    effective = new Error('boom')
    expect(isSettingOn('TELEGRAM_TOPICS_ENABLED')).toBe(false)
    expect(isSettingOn('NO_SUCH_KEY')).toBe(false)
  })
})
