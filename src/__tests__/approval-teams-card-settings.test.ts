// TEAMSAPPROVECARD1118 (Samu D2, D3): the card switch can only be turned ON with the owner's session, and whose click
// approves (TEAMS_OWNER_AAD_OBJECT_ID) can only be changed with it; the switch is off by default.
import { describe, it, expect } from 'vitest'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const def = (k: string) => SETTINGS_REGISTRY.find((d) => d.key === k)!

describe('the two Teams card settings', () => {
  it('APPROVAL_TEAMS_CARDS: off by default; turning it on loosens, turning it off does not; only on/off', () => {
    const d = def('APPROVAL_TEAMS_CARDS')
    expect(d.default).toBe('off')
    expect(d.loosens!('off', 'on')).toBe(true)
    expect(d.loosens!('off', ' ON ')).toBe(true)
    expect(d.loosens!('on', 'off')).toBe(false)
    expect(d.loosens!('on', 'on')).toBe(false)
    expect(d.validate!('on')).toBeNull()
    expect(d.validate!('off')).toBeNull()
    expect(d.validate!('yes')).not.toBeNull()
  })
  it('TEAMS_OWNER_AAD_OBJECT_ID: empty by default; ANY change loosens; keeping it (any case, spaces) does not', () => {
    const d = def('TEAMS_OWNER_AAD_OBJECT_ID')
    const A = '6f1c2d3e-0000-4000-8000-000000000001'
    expect(d.default).toBe('')
    expect(d.loosens!('', A)).toBe(true)
    expect(d.loosens!(A, '6f1c2d3e-0000-4000-8000-000000000002')).toBe(true)
    expect(d.loosens!(A, '')).toBe(true)
    expect(d.loosens!(A, ` ${A.toUpperCase()} `)).toBe(false)
  })
  it('TEAMS_OWNER_AAD_OBJECT_ID: a GUID or empty, nothing else', () => {
    const v = def('TEAMS_OWNER_AAD_OBJECT_ID').validate!
    expect(v('')).toBeNull()
    expect(v('6f1c2d3e-0000-4000-8000-000000000001')).toBeNull()
    expect(v('6F1C2D3E-0000-4000-8000-000000000001')).toBeNull()
    for (const bad of ['a:1conversation', '29:1abc', '6f1c2d3e', 'not a guid']) expect(v(bad)).not.toBeNull()
  })
})
