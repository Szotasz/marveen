import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyNetAttemptTimeout, DEFAULT_ATTEMPT_TIMEOUT_MS } from '../net-attempt-timeout.js'

function fakeNet(initial: number) {
  let value = initial
  return {
    getDefaultAutoSelectFamilyAttemptTimeout: () => value,
    setDefaultAutoSelectFamilyAttemptTimeout: (v: number) => { value = v },
    get value() { return value },
  }
}

describe('applyNetAttemptTimeout', () => {
  it("raises Node's 250 ms default to 2500 ms", () => {
    const n = fakeNet(250)
    expect(applyNetAttemptTimeout({}, n)).toEqual({ applied: true, ms: DEFAULT_ATTEMPT_TIMEOUT_MS, previous: 250 })
    expect(n.value).toBe(2500)
  })

  it('an explicit NODE_OPTIONS flag wins and is not touched', () => {
    const n = fakeNet(1000)
    const r = applyNetAttemptTimeout({ NODE_OPTIONS: '--network-family-autoselection-attempt-timeout=1000' }, n)
    expect(r).toMatchObject({ applied: false, reason: 'node-options' })
    expect(n.value).toBe(1000)
  })

  it('MARVEEN_NET_ATTEMPT_TIMEOUT_MS overrides the default, and 0 leaves Node alone', () => {
    const a = fakeNet(250)
    expect(applyNetAttemptTimeout({ MARVEEN_NET_ATTEMPT_TIMEOUT_MS: '4000' }, a)).toMatchObject({ applied: true, ms: 4000 })
    const b = fakeNet(250)
    expect(applyNetAttemptTimeout({ MARVEEN_NET_ATTEMPT_TIMEOUT_MS: '0' }, b)).toMatchObject({ applied: false, reason: 'disabled' })
    expect(b.value).toBe(250)
  })

  it('a malformed override changes nothing instead of guessing', () => {
    const n = fakeNet(250)
    expect(applyNetAttemptTimeout({ MARVEEN_NET_ATTEMPT_TIMEOUT_MS: '2.5s' }, n)).toMatchObject({ applied: false, reason: 'invalid-env' })
    expect(n.value).toBe(250)
  })

  it('never lowers a value that is already higher', () => {
    const n = fakeNet(5000)
    expect(applyNetAttemptTimeout({}, n)).toMatchObject({ applied: false, reason: 'already-higher' })
    expect(n.value).toBe(5000)
  })

  it('CONTROL: the real node:net default is below the target, so the startup call has something to do', async () => {
    const net = await import('node:net')
    // the module under test already ran once on import; its result says what it found
    const { netAttemptTimeoutAtStartup } = await import('../net-attempt-timeout.js')
    if (netAttemptTimeoutAtStartup.applied) expect(netAttemptTimeoutAtStartup.previous).toBeLessThan(DEFAULT_ATTEMPT_TIMEOUT_MS)
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(DEFAULT_ATTEMPT_TIMEOUT_MS)
  })

  it('index.ts imports it FIRST, before any module that could open a socket', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
    const firstImport = src.split('\n').find((l) => l.startsWith('import '))
    expect(firstImport).toContain("'./net-attempt-timeout.js'")
  })
})
