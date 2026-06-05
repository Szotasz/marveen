import { describe, it, expect } from 'vitest'
import { validateDiscordChannelId } from '../web/routes/agents.js'

describe('validateDiscordChannelId', () => {
  it('accepts a 17-digit snowflake', () => {
    expect(validateDiscordChannelId('12345678901234567').ok).toBe(true)
  })
  it('accepts an 18-digit snowflake (most common today)', () => {
    expect(validateDiscordChannelId('123456789012345678').ok).toBe(true)
  })
  it('accepts a 20-digit snowflake (upper bound)', () => {
    expect(validateDiscordChannelId('12345678901234567890').ok).toBe(true)
  })
  it('trims leading and trailing whitespace before validating', () => {
    expect(validateDiscordChannelId('  123456789012345678  ').ok).toBe(true)
  })
  it('rejects undefined', () => {
    const r = validateDiscordChannelId(undefined)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/required.*snowflake/)
  })
  it('rejects an empty string', () => {
    expect(validateDiscordChannelId('').ok).toBe(false)
  })
  it('rejects a whitespace-only string', () => {
    expect(validateDiscordChannelId('   ').ok).toBe(false)
  })
  it('rejects an alphanumeric channel name (e.g. #general)', () => {
    expect(validateDiscordChannelId('general').ok).toBe(false)
    expect(validateDiscordChannelId('#general').ok).toBe(false)
  })
  it('rejects a value with non-digit characters mixed in', () => {
    expect(validateDiscordChannelId('1234567890123456a').ok).toBe(false)
    expect(validateDiscordChannelId('12345-67890-12345').ok).toBe(false)
  })
  it('rejects a value too short (16 digits)', () => {
    expect(validateDiscordChannelId('1234567890123456').ok).toBe(false)
  })
  it('rejects a value too long (21 digits)', () => {
    expect(validateDiscordChannelId('123456789012345678901').ok).toBe(false)
  })
  it('rejects a signed numeric value', () => {
    expect(validateDiscordChannelId('-123456789012345678').ok).toBe(false)
    expect(validateDiscordChannelId('+123456789012345678').ok).toBe(false)
  })
})
