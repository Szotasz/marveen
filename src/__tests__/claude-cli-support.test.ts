/**
 * PICKERCLIKAPU923: which Claude model ids the INSTALLED CLI can launch.
 * Pure module, so the table and the two branches (measured / unmeasured)
 * are pinned without a binary.
 */
import { describe, it, expect } from 'vitest'
import { parseClaudeVersion, compareVersions, baseModelId, isModelUnsupportedByCli, claudeSupportForCli, CLAUDE_MODEL_MIN_CLI } from '../claude-cli-support.js'

describe('parseClaudeVersion', () => {
  it('reads the dotted version out of `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.280 (Claude Code)')).toBe('2.1.280')
    expect(parseClaudeVersion('2.1.110 (Claude Code)\n')).toBe('2.1.110')
  })
  it('gives null for empty or numberless output (that is the UNMEASURED branch)', () => {
    expect(parseClaudeVersion('')).toBeNull()
    expect(parseClaudeVersion(null)).toBeNull()
    expect(parseClaudeVersion('Not logged in')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('2.1.110', '2.1.278')).toBeLessThan(0)
    expect(compareVersions('2.1.280', '2.1.278')).toBeGreaterThan(0)
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0)
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0)
  })
})

describe('the table and the gate', () => {
  it('strips the 1M suffix before the lookup', () => {
    expect(baseModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  })
  it('on the customer pin 2.1.110 the two measured-bad models are unsupported, the measured-good ones are not (positive control)', () => {
    expect(isModelUnsupportedByCli('claude-fable-5-1', '2.1.110')).toBe(true)
    expect(isModelUnsupportedByCli('claude-opus-5-5', '2.1.110')).toBe(true)
    expect(isModelUnsupportedByCli('claude-opus-5-5[1m]', '2.1.110')).toBe(true)
    expect(isModelUnsupportedByCli('claude-opus-5', '2.1.110')).toBe(false)
    expect(isModelUnsupportedByCli('claude-sonnet-5', '2.1.110')).toBe(false)
  })
  it('on 2.1.278 Fable 5.1 runs but Opus 5.5 does not; on 2.1.280 both run', () => {
    expect(isModelUnsupportedByCli('claude-fable-5-1', '2.1.278')).toBe(false)
    expect(isModelUnsupportedByCli('claude-opus-5-5', '2.1.278')).toBe(true)
    expect(claudeSupportForCli('2.1.280').unsupported).toEqual([])
  })
  it('UNMEASURED version filters NOTHING (fail-open), and says it is unmeasured', () => {
    const s = claudeSupportForCli(null)
    expect(s.measured).toBe(false)
    expect(s.unsupported).toEqual([])
    expect(isModelUnsupportedByCli('claude-opus-5-5', null)).toBe(false)
  })
  it('measured 2.1.110 lists exactly the two table entries with their minimums', () => {
    const s = claudeSupportForCli('2.1.110')
    expect(s.measured).toBe(true)
    expect(s.unsupported.map((u) => u.id).sort()).toEqual(['claude-fable-5-1', 'claude-opus-5-5'])
  })
  it('every table entry names its measurement, so the next reader can re-measure', () => {
    for (const [id, req] of Object.entries(CLAUDE_MODEL_MIN_CLI)) {
      expect(req.measured, id).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(req.minCli, id).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
