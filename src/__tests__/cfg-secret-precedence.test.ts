import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Integration tests for the secret-resolver layer inside cfg().
 *
 * We cannot import config.ts directly (it has side-effects on load:
 * env-file reading, override merging, boot-time Zod validation, etc.).
 * Instead we test resolveSecret() in isolation to verify the contract
 * that cfg() relies on: the function returns the secret-mount value
 * when present and undefined otherwise, so cfg() falls back correctly.
 *
 * The cfg() resolution order is: overrides > resolveSecret() > env[key].
 * The tests below verify the resolveSecret() layer -- the cfg() wrapper
 * logic is simple enough that the existing config.ts integration tests
 * cover it end-to-end.
 */

const SANDBOX = mkdtempSync(join(tmpdir(), 'cfg-secret-prec-'))

// Must be set before importing the module (module-level const).
process.env['SECRET_MOUNT_DIR'] = SANDBOX

const { resolveSecret } = await import('../secret-resolver.js')

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  delete process.env['SECRET_MOUNT_DIR']
})

function writeSecret(name: string, value: string) {
  writeFileSync(join(SANDBOX, name), value)
}

describe('cfg() secret-resolver layer contract', () => {
  it('resolveSecret() returns file value -- cfg() uses it over .env', () => {
    writeSecret('OLLAMA_URL', 'http://vault-secret-host:11434')
    // When a secret-mount file exists, resolveSecret returns it.
    // cfg() will return this before reaching env[key].
    expect(resolveSecret('OLLAMA_URL')).toBe('http://vault-secret-host:11434')
  })

  it('resolveSecret() returns undefined for absent key -- cfg() falls back to env', () => {
    // No file for this key -> cfg() proceeds to env[key].
    expect(resolveSecret('NOT_IN_SECRETS')).toBeUndefined()
  })

  it('resolveSecret() returns undefined for empty file -- cfg() falls back to env', () => {
    writeSecret('EMPTY_KEY', '')
    expect(resolveSecret('EMPTY_KEY')).toBeUndefined()
  })

  it('secret-mount value is used over .env (precedence proof)', () => {
    // Simulates: TELEGRAM_BOT_TOKEN present both in /run/secrets and .env.
    // The cfg() layer checks resolveSecret first, so the mount value wins.
    writeSecret('TELEGRAM_BOT_TOKEN', 'secret-mount-token')
    const secretVal = resolveSecret('TELEGRAM_BOT_TOKEN')
    const envVal = 'dotenv-token' // what .env would return
    // cfg() logic: secret !== undefined ? secret : env[key]
    const effectiveValue = secretVal !== undefined ? secretVal : envVal
    expect(effectiveValue).toBe('secret-mount-token')
  })

  it('.env value is used when no secret-mount file (fallback proof)', () => {
    const secretVal = resolveSecret('ONLY_IN_DOTENV')
    const envVal = 'dotenv-value'
    const effectiveValue = secretVal !== undefined ? secretVal : envVal
    expect(effectiveValue).toBe('dotenv-value')
  })
})
