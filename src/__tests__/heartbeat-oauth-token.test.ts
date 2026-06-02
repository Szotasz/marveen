import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 13:00 hb-fire regression:
//   ✓ #250 prevented the channel-crash (no 409, no plugin-down).
//   ✗ But the sub-agent exited 13:00:00.838 with "Not logged in" because
//     macOS stores the OAuth in the Keychain, not in ~/.claude/, so the
//     symlink loop never copied it into CLAUDE_CONFIG_DIR.
//
// Fix: read the token from the Keychain via `security find-generic-password`
// and inject it as CLAUDE_CODE_OAUTH_TOKEN into the sub-agent env. The
// Claude Code binary honours that env as a config-dir login-bypass.

const SRC = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')

describe('heartbeat OAuth token injection from Keychain (#250 regression fix)', () => {
  it('declares a readClaudeCodeOauthToken helper', () => {
    expect(SRC).toMatch(/function readClaudeCodeOauthToken\(\)/)
  })

  it('shells out to /usr/bin/security via execFileSync (no shell, no string interpolation)', () => {
    // SECURITY: a shell-quoted command could log a fragment of the token
    // on a syntax error, or surface it in a ps listing. execFileSync with
    // a fixed argv keeps the token strictly in the parent process memory.
    expect(SRC).toMatch(/execFileSync\(\s*'\/usr\/bin\/security'/)
    expect(SRC).toMatch(/find-generic-password/)
    expect(SRC).toMatch(/Claude Code-credentials/)
  })

  it('runs ONLY on darwin -- returns null on linux so the symlinked .credentials.json carries auth', () => {
    expect(SRC).toMatch(/process\.platform !== 'darwin'/)
  })

  it('uses stdio:[ignore, pipe, ignore] so stderr cannot capture/leak the token', () => {
    expect(SRC).toMatch(/stdio:\s*\['ignore',\s*'pipe',\s*'ignore'\]/)
  })

  it('refuses to log the token value or even the error detail (error may echo lookup key)', () => {
    // The readClaudeCodeOauthToken function must NOT pass `err` to logger.*
    // -- that risks the token-fragment regression noted by Marveen.
    // Slice from the function header to its closing `^}` (first line that
    // is just `}` at column zero after the start) so the next function in
    // the file does not contaminate this assertion.
    const start = SRC.indexOf('function readClaudeCodeOauthToken')
    expect(start).toBeGreaterThan(0)
    const closeIdx = SRC.indexOf('\n}\n', start)
    expect(closeIdx).toBeGreaterThan(start)
    const body = SRC.slice(start, closeIdx)
    expect(body).not.toMatch(/logger\.[a-z]+\(\s*\{\s*err\b/)
  })

  it('injects CLAUDE_CODE_OAUTH_TOKEN into the runAgent env (alongside CLAUDE_CONFIG_DIR)', () => {
    expect(SRC).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    // The token must be set ONLY when readClaudeCodeOauthToken returned
    // truthy -- otherwise we are clobbering a value the caller might rely
    // on (and on Linux there is no token to set).
    expect(SRC).toMatch(/if\s*\(\s*oauthToken\s*\)/)
  })

  it('still passes CLAUDE_CONFIG_DIR (the #250 fix must remain in force)', () => {
    expect(SRC).toMatch(/CLAUDE_CONFIG_DIR:\s*HEARTBEAT_CONFIG_DIR/)
  })

  it('passes the env to runAgent as the 6th positional argument', () => {
    // runAgent signature: (message, sessionId?, onTyping?, allowTools, cwd, env)
    // The env object must be the 6th arg, not merged into another structure.
    expect(SRC).toMatch(/runAgent\(prompt,\s*undefined,\s*undefined,\s*false,\s*HEARTBEAT_AGENT_CWD,\s*subAgentEnv\)/)
  })
})
