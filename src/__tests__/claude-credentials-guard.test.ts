import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The guard reads HOME (~/.claude) and STORE_DIR at module-eval time via
// config/os, so we drive it through a temp HOME + a controllable env flag and
// only assert the PURE, side-effect-scoped behaviour we can isolate:
// looksLikeSetupToken (structural), the enabled flag, and the platform gate.
import { looksLikeSetupToken, credentialsGuardEnabled } from '../web/claude-credentials-guard.js'

describe('looksLikeSetupToken', () => {
  it('accepts a well-formed setup-token', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80))).toBe(true)
  })
  it('rejects a truncated token (the ~80-byte failure mode)', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(10))).toBe(false)
  })
  it('rejects the wrong prefix (e.g. a credentials JSON blob or api key)', () => {
    expect(looksLikeSetupToken('sk-ant-api03-' + 'A'.repeat(80))).toBe(false)
    expect(looksLikeSetupToken('{"claudeAiOauth":{}}')).toBe(false)
    expect(looksLikeSetupToken('')).toBe(false)
  })
  it('rejects a token with a stray newline / whitespace', () => {
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80) + '\n')).toBe(false)
    expect(looksLikeSetupToken('  sk-ant-oat01-' + 'A'.repeat(80))).toBe(false)
  })
})

describe('credentialsGuardEnabled', () => {
  const prev = process.env['CLAUDE_CREDENTIALS_GUARD']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAUDE_CREDENTIALS_GUARD']
    else process.env['CLAUDE_CREDENTIALS_GUARD'] = prev
  })
  it('is OFF by default (flag unset)', () => {
    delete process.env['CLAUDE_CREDENTIALS_GUARD']
    expect(credentialsGuardEnabled()).toBe(false)
  })
  it('is OFF for any value other than exactly "1"', () => {
    process.env['CLAUDE_CREDENTIALS_GUARD'] = 'true'
    expect(credentialsGuardEnabled()).toBe(false)
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '0'
    expect(credentialsGuardEnabled()).toBe(false)
  })
  it('is ON only for "1"', () => {
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    expect(credentialsGuardEnabled()).toBe(true)
  })
})

describe('renameSharedCredentialsIfSafe (flag/platform gates, no fs mutation)', () => {
  const prev = process.env['CLAUDE_CREDENTIALS_GUARD']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAUDE_CREDENTIALS_GUARD']
    else process.env['CLAUDE_CREDENTIALS_GUARD'] = prev
    vi.resetModules()
  })

  it('returns "disabled" and never touches fs when the flag is off', async () => {
    delete process.env['CLAUDE_CREDENTIALS_GUARD']
    const { renameSharedCredentialsIfSafe } = await import('../web/claude-credentials-guard.js')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('disabled')
  })

  it('returns "not-linux" on macOS even with the flag on (never renames)', async () => {
    // PLATFORM resolves from process.platform at import; on the CI/dev mac this
    // is 'macos'. Guard the assertion to the host so the test is deterministic.
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    const { renameSharedCredentialsIfSafe } = await import('../web/claude-credentials-guard.js')
    const r = renameSharedCredentialsIfSafe('/nonexistent/claude')
    if (process.platform === 'darwin') {
      expect(r).toBe('not-linux')
    } else {
      // On Linux CI: no fleet token / no credentials.json in the test HOME, so
      // it must resolve to a SAFE non-renaming outcome, never 'renamed'.
      expect(['no-credentials', 'already-renamed', 'token-invalid']).toContain(r)
    }
  })
})

// 2026-07-16 review blocker 1: the sk-ant-oat01 prefix ALONE does not
// discriminate a long-lived setup-token from a rotating browser-login access
// token (both can carry it). Promotion must be longevity-gated, or the boot
// sync would flip healthy rotating-login installs into env-token mode and
// self-inflict the bootcamp incident when the token rotates.
describe('isPromotableSetupCredential', () => {
  const NOW = 1_784_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  it('promotes the bootcamp shape: oat01 + ~1-year expiry (refreshToken presence is irrelevant)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 365 * DAY }, NOW)).toBe(true)
  })

  it('REJECTS a rotating-family oat01 with short expiry (hours/days)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 8 * 60 * 60 * 1000 }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 30 * DAY }, NOW)).toBe(false)
  })

  it('rejects at exactly the boundary minus one, accepts at the 90-day boundary', async () => {
    const { isPromotableSetupCredential, MIN_PROMOTABLE_LIFETIME_MS } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS }, NOW)).toBe(true)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS - 1 }, NOW)).toBe(false)
  })

  it('rejects a non-setup-token prefix and a missing/absent expiresAt (conservative)', async () => {
    const { isPromotableSetupCredential } = await import('../web/claude-credentials-guard.js')
    expect(isPromotableSetupCredential({ accessToken: 'sk-ant-sid01-' + 'A'.repeat(80), expiresAt: NOW + 365 * DAY }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({}, NOW)).toBe(false)
  })
})

// 2026-07-16 live-verify FAIL on the reference VPS: `claude auth status` exits
// 0 for a garbage token (it reports the auth SOURCE, it does not validate).
// The real validator is a `claude -p` probe; this classifier turns its outcome
// into ok / auth-rejected / inconclusive so callers never treat a network
// flake as a dead credential.
describe('classifyAuthProbe', () => {
  it('ok: ran clean and answered OK', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'OK' })).toBe('ok')
  })

  it('auth-rejected: the live bug-3 signature (401 Invalid bearer token)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({
      ran: true, exitedNonZero: true,
      output: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    })).toBe('auth-rejected')
  })

  it('auth-rejected: invalid API key variant', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'Invalid API key' })).toBe('auth-rejected')
  })

  it('inconclusive: nonzero exit WITHOUT an auth signature (network flake) must not kill a credential', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'fetch failed: ETIMEDOUT' })).toBe('inconclusive')
  })

  it('inconclusive: the probe never ran (binary missing)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: false, exitedNonZero: true, output: '' })).toBe('inconclusive')
  })

  it('inconclusive: clean exit with an unexpected answer (no OK)', async () => {
    const { classifyAuthProbe } = await import('../web/claude-credentials-guard.js')
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'I cannot comply' })).toBe('inconclusive')
  })
})
