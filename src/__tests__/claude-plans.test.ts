import { describe, it, expect } from 'vitest'
import { resolveClaudePlans } from '../web/claude-plans.js'

const HOME = '/home/op'

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '~/.claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

describe('resolveClaudePlans', () => {
  it('parses a valid registry and expands ~ against homeDir', () => {
    const plans = resolveClaudePlans(JSON.stringify([plan()]), HOME)
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      id: 'pro',
      label: 'Personal PRO',
      configDir: '/home/op/.claude-pro',
      planType: 'personal',
      channelsAllowed: true,
    })
  })

  it('returns [] for non-array or unparseable JSON', () => {
    expect(resolveClaudePlans('not json', HOME)).toEqual([])
    expect(resolveClaudePlans('{}', HOME)).toEqual([])
    expect(resolveClaudePlans('null', HOME)).toEqual([])
  })

  it('drops entries with a missing/blank/bad-charset id', () => {
    const raw = JSON.stringify([
      plan({ id: '' }),
      plan({ id: 'a b' }),        // space not allowed
      plan({ id: 'ok', label: 'Keep' }),
    ])
    const plans = resolveClaudePlans(raw, HOME)
    expect(plans.map(p => p.id)).toEqual(['ok'])
  })

  it('drops entries with invalid planType or non-boolean channelsAllowed', () => {
    const raw = JSON.stringify([
      plan({ id: 'a', planType: 'enterprise' }),
      plan({ id: 'b', channelsAllowed: 'yes' }),
      plan({ id: 'c' }),
    ])
    expect(resolveClaudePlans(raw, HOME).map(p => p.id)).toEqual(['c'])
  })

  it('rejects a configDir that would break the launcher (traversal / bad char)', () => {
    const raw = JSON.stringify([
      plan({ id: 'trav', configDir: '~/../../etc' }),
      plan({ id: 'space', configDir: '/opt/my plans' }),
      plan({ id: 'good', configDir: '/var/lib/claude-x' }),
    ])
    expect(resolveClaudePlans(raw, HOME).map(p => p.id)).toEqual(['good'])
  })

  it('dedupes by id, first occurrence wins', () => {
    const raw = JSON.stringify([
      plan({ id: 'dup', label: 'First' }),
      plan({ id: 'dup', label: 'Second' }),
    ])
    const plans = resolveClaudePlans(raw, HOME)
    expect(plans).toHaveLength(1)
    expect(plans[0].label).toBe('First')
  })

  it('keeps optional drift hints when present, omits when absent', () => {
    const raw = JSON.stringify([
      plan({ id: 'team', planType: 'team', channelsAllowed: false, expectedOrgType: 'company', expectedEmail: 'x@corp.com' }),
      plan({ id: 'bare' }),
    ])
    const [team, bare] = resolveClaudePlans(raw, HOME)
    expect(team.expectedOrgType).toBe('company')
    expect(team.expectedEmail).toBe('x@corp.com')
    expect(bare.expectedOrgType).toBeUndefined()
    expect(bare.expectedEmail).toBeUndefined()
  })
})
