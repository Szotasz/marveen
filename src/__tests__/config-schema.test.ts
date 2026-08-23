import { describe, it, expect, vi } from 'vitest'
import { envSchema, validateEnvConfig } from '../config-schema.js'

// Minimal valid base env for a development install (no tokens required).
const baseEnv: Record<string, unknown> = {
  CHANNEL_PROVIDER: 'telegram',
  TELEGRAM_BOT_TOKEN: 'tok-abc',
  WEB_PORT: '3420',
  OLLAMA_URL: 'http://localhost:11434',
  KANBAN_AGING_WARN_H: '24',
  KANBAN_AGING_CAUTION_H: '72',
  KANBAN_AGING_CRITICAL_H: '168',
  KANBAN_WIP_WARN_PCT: '80',
  HEARTBEAT_START_HOUR: '9',
  HEARTBEAT_END_HOUR: '23',
}

// --- envSchema parse ---

describe('envSchema', () => {
  it('parses a minimal valid env without errors', () => {
    const result = envSchema.safeParse(baseEnv)
    expect(result.success).toBe(true)
  })

  it('accepts all valid CHANNEL_PROVIDER values', () => {
    for (const p of ['telegram', 'slack', 'discord', 'googlechat', 'teams']) {
      const r = envSchema.safeParse({ CHANNEL_PROVIDER: p })
      expect(r.success).toBe(true)
    }
  })

  it('rejects an unknown CHANNEL_PROVIDER', () => {
    const r = envSchema.safeParse({ CHANNEL_PROVIDER: 'whatsapp' })
    expect(r.success).toBe(false)
  })

  it('coerces WEB_PORT from string to number', () => {
    const r = envSchema.safeParse({ WEB_PORT: '3420' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.WEB_PORT).toBe(3420)
  })

  it('rejects WEB_PORT=0 (out of valid range)', () => {
    const r = envSchema.safeParse({ WEB_PORT: '0' })
    expect(r.success).toBe(false)
  })

  it('rejects WEB_PORT=65536 (out of valid range)', () => {
    const r = envSchema.safeParse({ WEB_PORT: '65536' })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed hex color', () => {
    const r = envSchema.safeParse({ KANBAN_AGING_WARN_COLOR: 'red' })
    expect(r.success).toBe(false)
  })

  it('accepts a valid 6-digit hex color', () => {
    const r = envSchema.safeParse({ KANBAN_AGING_WARN_COLOR: '#ff6600' })
    expect(r.success).toBe(true)
  })

  it('rejects HEARTBEAT_START_HOUR > 23', () => {
    const r = envSchema.safeParse({ HEARTBEAT_START_HOUR: '24' })
    expect(r.success).toBe(false)
  })

  it('rejects KANBAN_WIP_WARN_PCT > 100', () => {
    const r = envSchema.safeParse({ KANBAN_WIP_WARN_PCT: '101' })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed OLLAMA_URL', () => {
    const r = envSchema.safeParse({ OLLAMA_URL: 'not-a-url' })
    expect(r.success).toBe(false)
  })

  it('accepts a valid OLLAMA_URL', () => {
    const r = envSchema.safeParse({ OLLAMA_URL: 'http://localhost:11434' })
    expect(r.success).toBe(true)
  })

  it('accepts KANBAN_SWIMLANE_DEFAULT_GROUP enum values', () => {
    for (const v of ['assignee', 'priority', 'none']) {
      const r = envSchema.safeParse({ KANBAN_SWIMLANE_DEFAULT_GROUP: v })
      expect(r.success).toBe(true)
    }
  })

  it('rejects unknown KANBAN_SWIMLANE_DEFAULT_GROUP', () => {
    const r = envSchema.safeParse({ KANBAN_SWIMLANE_DEFAULT_GROUP: 'sprint' })
    expect(r.success).toBe(false)
  })

  it('ignores unknown extra keys (passthrough-tolerant)', () => {
    // z.object strips unknown keys by default and does not error on them
    const r = envSchema.safeParse({ SOME_RANDOM_VAR: 'value' })
    expect(r.success).toBe(true)
  })
})

// --- validateEnvConfig ---

describe('validateEnvConfig', () => {
  it('does not throw for a valid dev env', () => {
    expect(() => validateEnvConfig(baseEnv, false)).not.toThrow()
  })

  it('does not throw for a valid prod env with token present', () => {
    const prodEnv = { ...baseEnv, TELEGRAM_BOT_TOKEN: 'valid-token' }
    expect(() => validateEnvConfig(prodEnv, true)).not.toThrow()
  })

  it('throws in prod when TELEGRAM_BOT_TOKEN is missing (Telegram provider)', () => {
    const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: '' }
    expect(() => validateEnvConfig(env, true)).toThrow('TELEGRAM_BOT_TOKEN')
  })

  it('throws in prod when SLACK_BOT_TOKEN is missing (Slack provider)', () => {
    const env = { ...baseEnv, CHANNEL_PROVIDER: 'slack', SLACK_BOT_TOKEN: '' }
    expect(() => validateEnvConfig(env, true)).toThrow('SLACK_BOT_TOKEN')
  })

  it('does NOT throw in dev when TELEGRAM_BOT_TOKEN is missing', () => {
    const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: '' }
    expect(() => validateEnvConfig(env, false)).not.toThrow()
  })

  it('throws in prod on FATAL field (WEB_PORT out of range)', () => {
    const env = { ...baseEnv, WEB_PORT: '99999' }
    expect(() => validateEnvConfig(env, true)).toThrow('Fatal config validation errors')
  })

  it('warns but does NOT throw in dev on format error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const env = { ...baseEnv, KANBAN_AGING_WARN_COLOR: 'bad-color' }
    expect(() => validateEnvConfig(env, false)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('KANBAN_AGING_WARN_COLOR'))
    warnSpy.mockRestore()
  })

  it('warns but does NOT throw in prod on non-fatal format error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // KANBAN_AGING_WARN_COLOR is not a FATAL_PROD_FIELDS key, so warn only
    const env = { ...baseEnv, KANBAN_AGING_WARN_COLOR: 'not-hex' }
    expect(() => validateEnvConfig(env, true)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('accepts an empty env object without throwing (all fields optional)', () => {
    expect(() => validateEnvConfig({}, false)).not.toThrow()
  })
})
