// Outage handling (SPEC.md section 6): ONE owner note when the helper goes
// down and ONE when it comes back, however many calls fail in between. A
// naive "notify on every failure" (or sendRoutineAlert's 30-min cooldown,
// which re-pings a long outage) fails these.
import { describe, it, expect, vi } from 'vitest'
import { evaluateHelperCall, shouldAttemptCall, countSkipped, initialHealth, HELPER_DOWN_RETRY_MS, type HelperHealth } from '../web/helper/health.js'
import { noteProviderCall } from '../web/helper/dispatch.js'

const provider = { id: 'p', label: 'Ollama', baseUrl: 'http://127.0.0.1:1', authHeader: 'none' as const, vaultKey: null }

describe('evaluateHelperCall', () => {
  it('fires down once at the threshold and recover once on the first success', () => {
    let h: HelperHealth | undefined
    const actions: string[] = []
    for (let i = 0; i < 6; i++) { const r = evaluateHelperCall(h, false, 1000 + i); h = r.next; actions.push(r.action) }
    const rec = evaluateHelperCall(h, true, 2000); actions.push(rec.action)
    actions.push(evaluateHelperCall(rec.next, true, 2001).action)
    expect(actions).toEqual(['none', 'down', 'none', 'none', 'none', 'none', 'recover', 'none'])
  })
  it('a single failure followed by success is not an outage', () => {
    const a = evaluateHelperCall(undefined, false, 1)
    expect(a.action).toBe('none')
    expect(evaluateHelperCall(a.next, true, 2).action).toBe('none')
  })
})

describe('shouldAttemptCall', () => {
  it('healthy: always; down: at most once per retry window', () => {
    expect(shouldAttemptCall(undefined, 0)).toBe(true)
    const down: HelperHealth = { ...initialHealth(), downSince: 100, lastAttemptMs: 100, fails: 2 }
    expect(shouldAttemptCall(down, 100 + HELPER_DOWN_RETRY_MS - 1)).toBe(false)
    expect(shouldAttemptCall(down, 100 + HELPER_DOWN_RETRY_MS)).toBe(true)
  })
})

describe('noteProviderCall (owner notification)', () => {
  it('a 20-failure outage sends exactly two owner notes: down, then recover with the skip count', async () => {
    let store: Record<string, HelperHealth> = {}
    const notify = vi.fn(async (_text: string) => ({}))
    const io = { read: () => JSON.parse(JSON.stringify(store)), write: (m: Record<string, HelperHealth>) => { store = m }, notify }
    for (let i = 0; i < 20; i++) {
      await noteProviderCall(provider, false, 1000 + i, io)
      store.p = countSkipped(store.p)
    }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatch(/nem válaszol/)
    await noteProviderCall(provider, true, 5000, io)
    await noteProviderCall(provider, true, 5001, io)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][0]).toMatch(/ismét válaszol.*20/)
    // A second, separate outage is announced again (once).
    await noteProviderCall(provider, false, 6000, io)
    await noteProviderCall(provider, false, 6001, io)
    await noteProviderCall(provider, false, 6002, io)
    expect(notify).toHaveBeenCalledTimes(3)
  })
})
