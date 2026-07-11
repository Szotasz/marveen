import { describe, it, expect, vi } from 'vitest'
import { decideClaudeAuthPresent } from '../web/routes/onboarding.js'

type Probes = Parameters<typeof decideClaudeAuthPresent>[0]

// No auth anywhere by default; each case overrides one probe.
function probes(over: Partial<Probes> = {}): Probes {
  return {
    oauthTokenEnv: null,
    apiKeyEnv: null,
    credentialsJson: null,
    platform: 'linux',
    keychainHasCredentials: () => false,
    ...over,
  }
}

describe('decideClaudeAuthPresent', () => {
  it('true when an OAuth token env var is set', () => {
    expect(decideClaudeAuthPresent(probes({ oauthTokenEnv: 'oat-placeholder' }))).toBe(true)
  })

  it('true when an API key env var is set', () => {
    expect(decideClaudeAuthPresent(probes({ apiKeyEnv: 'key-placeholder' }))).toBe(true)
  })

  it('empty-string env values are falsy, treated as no auth', () => {
    expect(decideClaudeAuthPresent(probes({ oauthTokenEnv: '', apiKeyEnv: '' }))).toBe(false)
  })

  it('true when credentials.json carries an OAuth accessToken', () => {
    const json = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
    expect(decideClaudeAuthPresent(probes({ credentialsJson: json }))).toBe(true)
  })

  it('true when credentials.json carries an apiKey', () => {
    expect(decideClaudeAuthPresent(probes({ credentialsJson: JSON.stringify({ apiKey: 'k' }) }))).toBe(true)
  })

  it('false when credentials.json is an empty object', () => {
    expect(decideClaudeAuthPresent(probes({ credentialsJson: '{}' }))).toBe(false)
  })

  it('malformed credentials.json is ignored without throwing', () => {
    expect(decideClaudeAuthPresent(probes({ credentialsJson: 'not-json {' }))).toBe(false)
  })

  it('macOS: true when only the Keychain holds the credential', () => {
    expect(decideClaudeAuthPresent(probes({ platform: 'darwin', keychainHasCredentials: () => true }))).toBe(true)
  })

  it('macOS: false when neither env/file nor Keychain has a credential', () => {
    expect(decideClaudeAuthPresent(probes({ platform: 'darwin', keychainHasCredentials: () => false }))).toBe(false)
  })

  it('non-macOS: the Keychain is never consulted, result is false', () => {
    const keychain = vi.fn(() => true)
    expect(decideClaudeAuthPresent(probes({ platform: 'linux', keychainHasCredentials: keychain }))).toBe(false)
    expect(keychain).not.toHaveBeenCalled()
  })

  it('lazy: an env token short-circuits before the Keychain probe (darwin)', () => {
    const keychain = vi.fn(() => true)
    expect(decideClaudeAuthPresent(probes({ platform: 'darwin', oauthTokenEnv: 'oat', keychainHasCredentials: keychain }))).toBe(true)
    expect(keychain).not.toHaveBeenCalled()
  })

  it('lazy: a file credential short-circuits before the Keychain probe (darwin)', () => {
    const keychain = vi.fn(() => true)
    const json = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
    expect(decideClaudeAuthPresent(probes({ platform: 'darwin', credentialsJson: json, keychainHasCredentials: keychain }))).toBe(true)
    expect(keychain).not.toHaveBeenCalled()
  })

  it('macOS: the Keychain probe runs exactly once when it is the deciding signal', () => {
    const keychain = vi.fn(() => true)
    expect(decideClaudeAuthPresent(probes({ platform: 'darwin', keychainHasCredentials: keychain }))).toBe(true)
    expect(keychain).toHaveBeenCalledTimes(1)
  })
})
