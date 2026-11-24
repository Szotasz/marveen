// WORKERLOGOUTWARN1121: the "worker will run logged-out" warning must not fire when the worker has the fleet
// setup-token (it is launched with CLAUDE_CODE_OAUTH_TOKEN from store/.claude-oauth-token), and must still fire
// when the Keychain is the worker's only auth source.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => { throw new Error('security: item not found') }),
}))

const realPlatform = process.platform
beforeEach(() => {
  warn.mockClear()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})
afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }) })

describe('readClaudeCodeOauthJson: the logged-out warning', () => {
  it('warns on a Keychain miss by default (the Keychain is the only auth source)', async () => {
    const { readClaudeCodeOauthJson } = await import('../web/claude-credentials.js')
    expect(readClaudeCodeOauthJson()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/logged-out/)
  })

  it('stays quiet on a miss when the caller has another auth source (warnOnMiss: false)', async () => {
    const { readClaudeCodeOauthJson } = await import('../web/claude-credentials.js')
    expect(readClaudeCodeOauthJson({ warnOnMiss: false })).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('seedWorkerCredentials passes the fleet-token state', () => {
  it('asks for the warning only when there is no fleet token', () => {
    const src = readFileSync(join(__dirname, '../web/agent-worker.ts'), 'utf8')
    expect(src).toMatch(/readClaudeCodeOauthJson\(\{ warnOnMiss: !hasFleetOauthToken\(\) \}\)/)
  })
})
