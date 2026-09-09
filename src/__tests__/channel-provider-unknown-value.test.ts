import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { resolveProviderType, getProviderType, resetProviderTypeAnnouncements } from '../channel-provider.js'
import { logger } from '../logger.js'

// GH #846: the reporter set CHANNEL_PROVIDER=none believing it meant "no
// channel", and filed a crash against the respawn path. There is no `none`
// provider: the value resolved to telegram, so their main session came up on a
// plugin they had deliberately not configured. The crash they reported is no
// longer reachable; the silent substitution behind it is, and it is the quieter
// of the two failures.
//
// The fallback itself stays -- refusing to start on a typo would turn it into an
// outage. What these tests pin is that it is never silent.

describe('resolveProviderType (pure)', () => {
  it('accepts every provider this build knows', () => {
    for (const t of ['telegram', 'slack', 'discord', 'googlechat', 'teams'] as const) {
      expect(resolveProviderType(t)).toEqual({ type: t, raw: t, unrecognised: false })
    }
  })

  it('treats an unset value as a default, not as a mistake', () => {
    expect(resolveProviderType(undefined)).toEqual({ type: 'telegram', raw: '', unrecognised: false })
    expect(resolveProviderType('')).toEqual({ type: 'telegram', raw: '', unrecognised: false })
    expect(resolveProviderType('   ')).toEqual({ type: 'telegram', raw: '', unrecognised: false })
  })

  it('flags the reported value: "none" is not a provider, it is telegram in disguise', () => {
    expect(resolveProviderType('none')).toEqual({ type: 'telegram', raw: 'none', unrecognised: true })
  })

  it('flags a typo the same way, which is the wider case', () => {
    expect(resolveProviderType('telegran').unrecognised).toBe(true)
    expect(resolveProviderType('Slack').unrecognised).toBe(true)
    expect(resolveProviderType('slack ').unrecognised).toBe(false) // trimmed, still valid
  })

  it('never returns a type outside the known set, whatever it is handed', () => {
    for (const v of ['none', 'telegran', 'MATRIX', '../etc/passwd', '{}']) {
      expect(['telegram', 'slack', 'discord', 'googlechat', 'teams']).toContain(resolveProviderType(v).type)
    }
  })
})

describe('getProviderType announces an unrecognised value', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetProviderTypeAnnouncements()
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  })
  afterEach(() => { warn.mockRestore() })

  it('warns for "none", and names both what was configured and what is used', () => {
    expect(getProviderType('none')).toBe('telegram')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields.configured).toBe('none')
    expect(fields.using).toBe('telegram')
    expect(message).toContain('none')
    expect(message).toContain('telegram')
  })

  it('says it once per distinct value, not once per call', () => {
    getProviderType('none')
    getProviderType('none')
    getProviderType('none')
    expect(warn).toHaveBeenCalledTimes(1)

    getProviderType('telegran')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('stays silent for a value this build understands, and for an unset one', () => {
    getProviderType('slack')
    getProviderType(undefined)
    getProviderType('')
    expect(warn).not.toHaveBeenCalled()
  })
})
