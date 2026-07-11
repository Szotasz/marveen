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
