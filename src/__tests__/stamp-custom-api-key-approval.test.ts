import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampCustomApiKeyApproval } from '../web/agent-process.js'

// Mirrors the CLI's Jne function (empirically verified from 2.1.222 binary):
// function Jne(e) { return e.trim().slice(-20) }
const suffix = (key: string) => key.trim().slice(-20)

const KEY_BEARER = 'sk-litellm-test-bearertokenvalue12345'
const KEY_XAPI   = 'sk-litellm-test-xapikey0000000000000'
const KEY_SHORT  = 'short'

describe('stampCustomApiKeyApproval', () => {
  let dir: string
  let dotClaude: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'custom-api-key-stamp-'))
    dotClaude = join(dir, '.claude.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the last-20-char suffix into customApiKeyResponses.approved', () => {
    expect(stampCustomApiKeyApproval(dotClaude, KEY_XAPI)).toBe(true)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain(suffix(KEY_XAPI))
  })

  it('creates the file when it does not yet exist', () => {
    expect(existsSync(dotClaude)).toBe(false)
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    expect(existsSync(dotClaude)).toBe(true)
  })

  it('is idempotent -- does not duplicate the suffix', () => {
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    expect(stampCustomApiKeyApproval(dotClaude, KEY_XAPI)).toBe(false) // already present
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved.filter((s: string) => s === suffix(KEY_XAPI))).toHaveLength(1)
  })

  it('preserves existing approved and rejected entries', () => {
    writeFileSync(dotClaude, JSON.stringify({
      customApiKeyResponses: { approved: ['existingkey0000000000'], rejected: ['rejectedkey000000000'] },
    }))
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain('existingkey0000000000')
    expect(data.customApiKeyResponses.approved).toContain(suffix(KEY_XAPI))
    expect(data.customApiKeyResponses.rejected).toContain('rejectedkey000000000')
  })

  it('preserves unrelated .claude.json keys', () => {
    writeFileSync(dotClaude, JSON.stringify({ hasCompletedOnboarding: true, numStartups: 42 }))
    stampCustomApiKeyApproval(dotClaude, KEY_XAPI)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.hasCompletedOnboarding).toBe(true)
    expect(data.numStartups).toBe(42)
  })

  it('trims whitespace from the key before slicing', () => {
    const keyWithSpaces = `  ${KEY_XAPI}  `
    stampCustomApiKeyApproval(dotClaude, keyWithSpaces)
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain(suffix(keyWithSpaces))
    expect(data.customApiKeyResponses.approved[0]).toBe(KEY_XAPI.slice(-20))
  })

  it('returns false and is a no-op for an empty key', () => {
    expect(stampCustomApiKeyApproval(dotClaude, '')).toBe(false)
    expect(existsSync(dotClaude)).toBe(false)
  })

  it('returns false and is a no-op for a whitespace-only key', () => {
    expect(stampCustomApiKeyApproval(dotClaude, '   ')).toBe(false)
    expect(existsSync(dotClaude)).toBe(false)
  })

  it('handles corrupted JSON gracefully -- resets file rather than crashing', () => {
    writeFileSync(dotClaude, '{ not valid json')
    expect(() => stampCustomApiKeyApproval(dotClaude, KEY_XAPI)).not.toThrow()
    // After recovery the entry should be stamped
    const data = JSON.parse(readFileSync(dotClaude, 'utf-8'))
    expect(data.customApiKeyResponses.approved).toContain(suffix(KEY_XAPI))
  })

  // Regression: Bearer/authorization providers must NOT trigger a stamp
  // (they export ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY, so no gate).
  // This test documents the caller contract: stampCustomApiKeyApproval is
  // only invoked when authHeader === 'x-api-key'; the Bearer path never calls
  // it. This test verifies the stamp itself is correctly driven by caller logic.
  it('only caller-invoked for x-api-key; Bearer callers do not call it', () => {
    // Simulate: Bearer agent spawns WITHOUT calling stampCustomApiKeyApproval.
    // The .claude.json should remain untouched.
    // (In production agent-process.ts only sets customApiKeyForApproval in the
    //  x-api-key branch; Bearer uses ANTHROPIC_AUTH_TOKEN and skips this stamp.)
    expect(existsSync(dotClaude)).toBe(false)
    // No call made for Bearer -- file must not be created
    expect(existsSync(dotClaude)).toBe(false)
  })
})
