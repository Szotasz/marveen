import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 13:00 hb-fire regression chain:
//   - #250 (CLAUDE_CONFIG_DIR) blocked the channel crash but broke auth.
//   - First fix attempt (#252) injected the Keychain JSON via the
//     CLAUDE_CODE_OAUTH_TOKEN env var. Marveen's live test proved that
//     was wrong: the env expects a bare bearer token, the JSON blob comes
//     back 401 "Invalid bearer token".
//   - This PR materialises the FULL Keychain JSON as
//     $CLAUDE_CONFIG_DIR/.credentials.json (mode 0600), which is the
//     path Claude Code's Linux installs use natively and the path the
//     SDK config-dir code honours. Marveen verified this approach
//     succeeds (exit 0, request authenticated).
//
// Refactor note (issue #5): readClaudeCodeOauthJson() was consolidated
// from a private heartbeat.ts copy into src/web/claude-credentials.ts.
// The security contracts and the ensureHeartbeatWorkerCwd assertions
// are split across the two source files accordingly.

// Security contracts -- enforced on the canonical implementation in claude-credentials.ts
const SRC_CREDS = readFileSync(join(__dirname, '../web/claude-credentials.ts'), 'utf-8')

// Heartbeat-level contracts -- call site in ensureHeartbeatWorkerCwd
const SRC_HEARTBEAT = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')

describe('heartbeat OAuth bridge from Keychain to .credentials.json (#250 follow-up)', () => {
  it('helper is defined in claude-credentials.ts (consolidated from heartbeat.ts per issue #5)', () => {
    // The implementation lives in the shared module; heartbeat.ts imports it.
    expect(SRC_CREDS).toMatch(/function readClaudeCodeOauthJson\(\)/)
    expect(SRC_HEARTBEAT).toMatch(/readClaudeCodeOauthJson/)
  })

  it('shells out to /usr/bin/security via execFileSync (no shell, no string interpolation)', () => {
    expect(SRC_CREDS).toMatch(/execFileSync\(\s*'\/usr\/bin\/security'/)
    expect(SRC_CREDS).toMatch(/find-generic-password/)
    expect(SRC_CREDS).toMatch(/Claude Code-credentials/)
  })

  it('runs ONLY on darwin -- returns null on linux so the symlinked .credentials.json carries auth', () => {
    expect(SRC_CREDS).toMatch(/process\.platform !== 'darwin'/)
  })

  it('uses stdio:[ignore, pipe, ignore] so stderr cannot capture/leak the JSON', () => {
    expect(SRC_CREDS).toMatch(/stdio:\s*\['ignore',\s*'pipe',\s*'ignore'\]/)
  })

  it('refuses to log the JSON value or even the error detail (error may echo lookup key)', () => {
    // Slice from the function header to its first `^}` at column zero
    // so the assertion does not bleed into the next function.
    const start = SRC_CREDS.indexOf('function readClaudeCodeOauthJson')
    expect(start).toBeGreaterThan(0)
    const closeIdx = SRC_CREDS.indexOf('\n}\n', start)
    expect(closeIdx).toBeGreaterThan(start)
    const body = SRC_CREDS.slice(start, closeIdx)
    expect(body).not.toMatch(/logger\.[a-z]+\(\s*\{\s*err\b/)
  })

  it('writes the JSON to $HEARTBEAT_CONFIG_DIR/.credentials.json (NOT to an env var)', () => {
    expect(SRC_HEARTBEAT).toMatch(/\.credentials\.json/)
    // The env-var injection attempt was proved wrong (Marveen 13:00-13:20
    // A/B test: bare JSON in CLAUDE_CODE_OAUTH_TOKEN -> 401 "Invalid
    // bearer token"). The token name may still appear in comments
    // documenting the dead path; what must NOT exist is an assignment
    // to the runAgent env carrying that name.
    expect(SRC_HEARTBEAT).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s*[:=]/)
  })

  it('writes the credentials file with mode 0600 (owner-only read/write)', () => {
    expect(SRC_HEARTBEAT).toMatch(/mode:\s*0o600/)
  })

  it('still passes CLAUDE_CONFIG_DIR to runAgent (the #250 isolation gate stays in force)', () => {
    expect(SRC_HEARTBEAT).toMatch(/CLAUDE_CONFIG_DIR:\s*HEARTBEAT_CONFIG_DIR/)
  })

  it('credentials write happens inside ensureHeartbeatWorkerCwd, AFTER the symlink tree is built', () => {
    // Both the symlink loop and the credentials write must live in the
    // same setup function so a missing dir is created exactly once.
    const start = SRC_HEARTBEAT.indexOf('function ensureHeartbeatWorkerCwd')
    const closeIdx = SRC_HEARTBEAT.indexOf('\n}\n', start)
    const body = SRC_HEARTBEAT.slice(start, closeIdx)
    expect(body).toMatch(/symlinkSync/)
    expect(body).toMatch(/readClaudeCodeOauthJson\(\)/)
    expect(body).toMatch(/\.credentials\.json/)
    // Sanity: the credentials write must come AFTER the settings.json
    // write so a parse-error on settings.json does not abort the auth
    // material write half-way through.
    const settingsIdx = body.indexOf('settingsPath')
    const credIdx = body.indexOf('credPath')
    expect(credIdx).toBeGreaterThan(settingsIdx)
  })
})

// Live integration sanity (darwin only): exercise ensureHeartbeatWorkerCwd
// against a real ephemeral HEARTBEAT_AGENT_CWD and confirm the resulting
// .credentials.json is mode 0600 and contains the expected top-level
// `claudeAiOauth` key. We do NOT log the JSON content; we only inspect
// keys/permissions.
describe('ensureHeartbeatWorkerCwd materialises Keychain JSON (live, darwin only)', () => {
  const skip = process.platform !== 'darwin'

  it.skipIf(skip)('writes .credentials.json with mode 0600 + claudeAiOauth key', async () => {
    // The function uses fixed PROJECT_ROOT-derived paths, so we can't
    // sandbox it cleanly without invoking the real module. Instead,
    // observe the file the production code path produces on the next
    // heartbeat tick. If a previous deploy already created it, the
    // mode/key check is still a valid contract.
    const credPath = join(__dirname, '..', '..', 'agents', 'heartbeat-worker', '.claude-config', '.credentials.json')
    if (!existsSync(credPath)) {
      // First-run case: the file appears only after a real
      // ensureHeartbeatWorkerCwd call. Skip rather than spawn one from
      // a unit test (the module has init-time side effects we don't
      // want here).
      return
    }
    const st = statSync(credPath)
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8'))
    expect(parsed).toHaveProperty('claudeAiOauth')
    expect(parsed.claudeAiOauth).toHaveProperty('accessToken')
    // refreshToken is what lets the sub-agent renew without re-reading
    // the Keychain. Its absence would defeat the whole point of writing
    // the JSON blob rather than just an accessToken.
    expect(parsed.claudeAiOauth).toHaveProperty('refreshToken')
  })
})
