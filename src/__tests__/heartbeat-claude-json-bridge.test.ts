import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the 2026-06-02 14:27 hb-fire regression (#252 follow-up):
//   - Sub-agent ran without 'Not logged in' (Claude API auth fine), but
//     Gmail OAuth was gone and Calendar fell back to the wrong default
//     account because user-level project-scope MCPs live in ~/.claude.json
//     under projects[<cwd>], which the symlink loop missed (HOME root, one
//     level UP from ~/.claude/).
//   - Fix: copy ~/.claude.json into the isolated config dir and duplicate
//     projects[PROJECT_ROOT] under projects[HEARTBEAT_AGENT_CWD].
//   - Plus: dashboard-hide sentinel so the heartbeat-worker dir doesn't
//     pollute the agent list (Szabi 14:31 ask).

const HB_SRC = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')
const CFG_SRC = readFileSync(join(__dirname, '../web/agent-config.ts'), 'utf-8')

describe('heartbeat ~/.claude.json bridge (2026-06-02 14:27 regression fix)', () => {
  it('reads the real ~/.claude.json from HOME (not from CLAUDE_CONFIG_DIR)', () => {
    expect(HB_SRC).toMatch(/homedir\(\),\s*'\.claude\.json'/)
  })

  it('writes the parsed JSON into HEARTBEAT_CONFIG_DIR/.claude.json with mode 0600', () => {
    expect(HB_SRC).toMatch(/HEARTBEAT_CONFIG_DIR.*\.claude\.json/s)
    // The auth-equivalent file must have the same 0600 mode as
    // .credentials.json -- a world-readable .claude.json with the
    // oauthAccount key would leak the user id.
    const start = HB_SRC.indexOf('heartbeatClaudeJsonPath')
    expect(start).toBeGreaterThan(0)
    // The next writeFileSync that targets heartbeatClaudeJsonPath must
    // pass mode 0o600. Slice from the first `writeFileSync(heartbeatClaudeJsonPath`
    // to the end of that call and look for 0o600 anywhere inside.
    const writeIdx = HB_SRC.indexOf('writeFileSync(heartbeatClaudeJsonPath', start)
    expect(writeIdx).toBeGreaterThan(0)
    const callEnd = HB_SRC.indexOf('})', writeIdx)
    expect(callEnd).toBeGreaterThan(writeIdx)
    const callBody = HB_SRC.slice(writeIdx, callEnd + 2)
    expect(callBody).toMatch(/0o600/)
  })

  it('duplicates projects[PROJECT_ROOT] into projects[HEARTBEAT_AGENT_CWD]', () => {
    // The Claude Code TUI keys project-scope MCPs by absolute cwd. The
    // heartbeat sub-agent runs in agents/heartbeat-worker, so an empty
    // entry there means no MCPs visible. Duplicating the PROJECT_ROOT
    // entry under the new key lets the sub-agent inherit Marveen's
    // Gmail + Calendar MCPs without any other change.
    expect(HB_SRC).toMatch(/projects\[PROJECT_ROOT\]/)
    expect(HB_SRC).toMatch(/projects\[HEARTBEAT_AGENT_CWD\]/)
  })

  it('refuses to clobber an existing projects[HEARTBEAT_AGENT_CWD] entry', () => {
    // If a prior tick wrote a curated entry we should not stomp it.
    // Guard with `!projects[HEARTBEAT_AGENT_CWD]` (only set when absent).
    expect(HB_SRC).toMatch(/!\s*projects\[HEARTBEAT_AGENT_CWD\]/)
  })

  it('failure to copy ~/.claude.json is non-fatal (warn, do not abort)', () => {
    // The auth path is still good (CLAUDE_CONFIG_DIR + .credentials.json),
    // so a parse error on ~/.claude.json must not break the heartbeat.
    // Warn and continue.
    const idx = HB_SRC.indexOf('failed to materialise .claude.json')
    expect(idx).toBeGreaterThan(0)
    const window = HB_SRC.slice(Math.max(0, idx - 200), idx)
    expect(window).toMatch(/catch/)
  })
})

describe('dashboard-hide sentinel (Szabi 2026-06-02 14:31 ask)', () => {
  it('agent-config exports HIDDEN_AGENT_SENTINEL', () => {
    expect(CFG_SRC).toMatch(/export const HIDDEN_AGENT_SENTINEL = '\.hidden-from-dashboard'/)
  })

  it('listAgentNames filters out directories containing the sentinel', () => {
    expect(CFG_SRC).toMatch(/HIDDEN_AGENT_SENTINEL/)
    expect(CFG_SRC).toMatch(/existsSync\(join\(AGENTS_BASE_DIR,\s*f,\s*HIDDEN_AGENT_SENTINEL\)\)/)
  })

  it('heartbeat ensures the sentinel exists in agents/heartbeat-worker/', () => {
    expect(HB_SRC).toMatch(/sentinelPath\s*=\s*join\(HEARTBEAT_AGENT_CWD,\s*'\.hidden-from-dashboard'\)/)
    expect(HB_SRC).toMatch(/writeFileSync\(sentinelPath/)
  })

  it('sentinel write is idempotent (skip if already present)', () => {
    const idx = HB_SRC.indexOf('sentinelPath')
    expect(idx).toBeGreaterThan(0)
    const window = HB_SRC.slice(idx, idx + 400)
    expect(window).toMatch(/!existsSync\(sentinelPath\)/)
  })
})
