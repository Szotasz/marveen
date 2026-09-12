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

  // Token-mode (2026-09-12): a plan can carry a vault tokenSecretId instead of
  // a configDir, so the operator never has to run an interactive
  // `claude setup-token` ON the target host -- see ClaudePlan.tokenSecretId.
  describe('token-mode plans', () => {
    function tokenPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
      const { configDir: _drop, ...rest } = plan()
      return { ...rest, tokenSecretId: 'claude-plan-token-pro', ...over }
    }

    it('accepts a plan with tokenSecretId and no configDir', () => {
      const plans = resolveClaudePlans(JSON.stringify([tokenPlan()]), HOME)
      expect(plans).toHaveLength(1)
      expect(plans[0]).toMatchObject({ id: 'pro', tokenSecretId: 'claude-plan-token-pro' })
      expect(plans[0].configDir).toBeUndefined()
    })

    it('rejects a plan with BOTH configDir and tokenSecretId', () => {
      const raw = JSON.stringify([plan({ id: 'both', tokenSecretId: 'claude-plan-token-both' })])
      expect(resolveClaudePlans(raw, HOME)).toEqual([])
    })

    it('rejects a plan with NEITHER configDir nor tokenSecretId', () => {
      const { configDir: _drop, ...rest } = plan({ id: 'neither' })
      expect(resolveClaudePlans(JSON.stringify([rest]), HOME)).toEqual([])
    })

    it('rejects a tokenSecretId outside the safe charset (it doubles as a shell-interpolated vault id)', () => {
      const raw = JSON.stringify([tokenPlan({ id: 'bad', tokenSecretId: "claude-plan-token-'; rm -rf" })])
      expect(resolveClaudePlans(raw, HOME)).toEqual([])
    })
  })
})
