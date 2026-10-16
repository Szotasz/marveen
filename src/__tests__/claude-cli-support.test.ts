/**
 * PICKERCLIKAPU923: which Claude model ids the INSTALLED CLI can launch.
 * Pure module, so the table and the two branches (measured / unmeasured)
 * are pinned without a binary.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClaudeVersion, compareVersions, baseModelId, isModelUnsupportedByCli, claudeSupportForCli, launchableDefaultModel, CLAUDE_MODEL_MIN_CLI } from '../claude-cli-support.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL, DISTRIBUTION_DEFAULT_FALLBACK_MODEL } from '../config-registry.js'

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
    // on 2.1.280 only Sonnet 5.5 (measured good from 2.1.283) and Haiku 5.5 (from 2.1.284) are still unsupported
    expect(claudeSupportForCli('2.1.280').unsupported.map((u) => u.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(claudeSupportForCli('2.1.283').unsupported.map((u) => u.id)).toEqual(['claude-haiku-5-5'])
    expect(claudeSupportForCli('2.1.284').unsupported).toEqual([])
  })
  it('Sonnet 5.5 needs 2.1.283, the lowest version measured to launch it (SONNET55SELECTOR928)', () => {
    expect(isModelUnsupportedByCli('claude-sonnet-5-5', '2.1.282')).toBe(true)
    expect(isModelUnsupportedByCli('claude-sonnet-5-5', '2.1.283')).toBe(false)
    expect(isModelUnsupportedByCli('claude-sonnet-5', '2.1.110')).toBe(false)
  })
  it('Haiku 5.5 needs 2.1.284, the lowest version measured to launch it (HAIKU55SELECTOR1008)', () => {
    expect(isModelUnsupportedByCli('claude-haiku-5-5', '2.1.283')).toBe(true)
    expect(isModelUnsupportedByCli('claude-haiku-5-5', '2.1.284')).toBe(false)
    expect(isModelUnsupportedByCli('claude-haiku-5-5', '2.1.110')).toBe(true)
    // Haiku 4.5 carries no constraint: the bare 'haiku' alias still lands on a model the customer pin runs
    expect(isModelUnsupportedByCli('claude-haiku-4-5-20251001', '2.1.110')).toBe(false)
    expect(CLAUDE_MODEL_MIN_CLI['claude-haiku-5-5'].minCli).toBe('2.1.284')
  })
  it('UNMEASURED version filters NOTHING (fail-open), and says it is unmeasured', () => {
    const s = claudeSupportForCli(null)
    expect(s.measured).toBe(false)
    expect(s.unsupported).toEqual([])
    expect(isModelUnsupportedByCli('claude-opus-5-5', null)).toBe(false)
  })
  it('measured 2.1.110 lists exactly the four table entries with their minimums', () => {
    const s = claudeSupportForCli('2.1.110')
    expect(s.measured).toBe(true)
    expect(s.unsupported.map((u) => u.id).sort()).toEqual(['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  })
  it('every table entry names its measurement, so the next reader can re-measure', () => {
    for (const [id, req] of Object.entries(CLAUDE_MODEL_MIN_CLI)) {
      expect(req.measured, id).toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(req.minCli, id).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

// DEFAULTCLIGUARD927 (Szotasz review of #1609): the DEFAULT path consults the
// same table. A model-less launch on a CLI measured too old for the shipped
// default gets the previous tier; an unmeasured CLI changes nothing.
describe('launchableDefaultModel (DEFAULTCLIGUARD927)', () => {
  it('the AVX-less pin 2.1.110 falls back to claude-opus-5[1m], naming what it replaced', () => {
    expect(launchableDefaultModel('claude-opus-5-5[1m]', 'claude-opus-5[1m]', '2.1.110')).toEqual({
      model: 'claude-opus-5[1m]', replaced: 'claude-opus-5-5[1m]', minCli: '2.1.280',
    })
  })
  it('2.1.278 (the other measured-bad point) falls back too', () => {
    expect(launchableDefaultModel('claude-opus-5-5[1m]', 'claude-opus-5[1m]', '2.1.278').model).toBe('claude-opus-5[1m]')
  })
  it('2.1.280 gets claude-opus-5-5[1m] (positive control)', () => {
    expect(launchableDefaultModel('claude-opus-5-5[1m]', 'claude-opus-5[1m]', '2.1.280')).toEqual({
      model: 'claude-opus-5-5[1m]', replaced: null, minCli: null,
    })
  })
  it('an UNMEASURED version keeps the default (fail-open, same rule as the picker)', () => {
    expect(launchableDefaultModel('claude-opus-5-5[1m]', 'claude-opus-5[1m]', null).model).toBe('claude-opus-5-5[1m]')
  })
  it('the SHIPPED fallback is launchable by the oldest pinned CLI, read from channels.sh (not a literal)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const pin = /^CLAUDE_PIN="([^"]+)"/m.exec(readFileSync(join(root, 'scripts', 'channels.sh'), 'utf-8'))?.[1] ?? null
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    expect(isModelUnsupportedByCli(DISTRIBUTION_DEFAULT_FALLBACK_MODEL, pin)).toBe(false)
    expect(DISTRIBUTION_DEFAULT_FALLBACK_MODEL).not.toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })
})
