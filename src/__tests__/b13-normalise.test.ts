import { describe, it, expect, vi } from 'vitest'
import { validateSettingValue } from '../config-registry.js'

// ---- config-registry: validateSettingValue ----
describe('config-registry validateSettingValue -- B13 error token normalization', () => {
  const boolDef = { key: 'x', type: 'boolean' as const, default: '0', description: '', module: 'test', requiresRestart: false, valueSet: undefined, min: undefined, max: undefined, secret: false }
  const intDef = { key: 'x', type: 'int' as const, default: 0, description: '', module: 'test', requiresRestart: false, valueSet: undefined, min: 1, max: 10, secret: false }
  const colorDef = { key: 'x', type: 'color' as const, default: '#000000', description: '', module: 'test', requiresRestart: false, valueSet: undefined, min: undefined, max: undefined, secret: false }
  const setDef = { key: 'x', type: 'string' as const, default: 'a', description: '', module: 'test', requiresRestart: false, valueSet: ['a', 'b'], min: undefined, max: undefined, secret: false }

  it('returns error=invalid_value (not Hungarian prose) for invalid boolean', () => {
    const r = validateSettingValue(boolDef, 'notabool')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    // mutation guard: if error field is reverted to Hungarian prose this assertion fails
    expect(r.hint).toMatch(/Logikai/)
  })

  it('returns error=invalid_value for int below min', () => {
    const r = validateSettingValue(intDef, 0)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    expect(r.hint).toMatch(/legalább/)
  })

  it('returns error=invalid_value for int above max', () => {
    const r = validateSettingValue(intDef, 11)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    expect(r.hint).toMatch(/legfeljebb/)
  })

  it('returns error=invalid_value for non-integer', () => {
    const r = validateSettingValue(intDef, 'abc')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    expect(r.hint).toMatch(/Egész/)
  })

  it('returns error=invalid_value for invalid color', () => {
    const r = validateSettingValue(colorDef, 'red')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    expect(r.hint).toMatch(/szín/)
  })

  it('returns error=invalid_value for value not in valueSet', () => {
    const r = validateSettingValue(setDef, 'c')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_value')
    expect(r.hint).toMatch(/Megengedett/)
  })
})

// ---- channel-provider: validateToken + checkTelegramTokenBusy ----
import { checkTelegramTokenBusy } from '../channel-provider.js'

describe('checkTelegramTokenBusy -- B13 error token normalization', () => {
  it('returns error=conflict (not Hungarian prose) when webhook is bound', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, result: { url: 'https://example.com/webhook' } }),
      })
    const r = await checkTelegramTokenBusy('tok', mockFetch as unknown as typeof fetch)
    expect(r.busy).toBe(true)
    expect(r.error).toBe('conflict')
    // mutation guard: reverting error field to Hungarian prose fails this
    expect(r.hint).toMatch(/webhookra/)
  })

  it('returns error=conflict when poller returns 409', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, result: { url: '' } }) })
      .mockResolvedValueOnce({ status: 409 })
    const r = await checkTelegramTokenBusy('tok', mockFetch as unknown as typeof fetch)
    expect(r.busy).toBe(true)
    expect(r.error).toBe('conflict')
    expect(r.hint).toMatch(/409/)
  })
})
