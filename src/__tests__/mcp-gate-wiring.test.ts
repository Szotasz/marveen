// MCPWRITEGATE1104 wiring: both path gates fire on every MCP tool, with ANCHORED matchers (a matcher with `.` is an
// unanchored regex: code.claude.com/docs/en/hooks, "Matcher patterns"); an agent carrying an older self-pace matcher
// is repaired at the dashboard-restart pass (paceStale), not only at its next spawn; the sub-agent deny floor carries
// the filesystem MCP server and gitnexus's rename.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureGovernanceGateCommands,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  DB_WRITE_GATE_MATCHER,
  SELF_PACE_GATE_MATCHER,
  FLEET_BASELINE_DENY,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

const TEST_AGENT = 'mcp-gate-wiring-probe'
const agentRoot = () => join(AGENTS_BASE_DIR, TEST_AGENT)
function cleanup(): void {
  const root = agentRoot()
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${root}`)
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) throw new Error(`refusing: ${root} looks live`)
  rmSync(root, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

// As Claude Code evaluates it: a matcher with a character outside [A-Za-z0-9_ ,|-] is a JS regex, unanchored.
const fires = (matcher: string, tool: string) => new RegExp(matcher).test(tool)

describe('the matchers', () => {
  it.each([[DB_WRITE_GATE_MATCHER], [SELF_PACE_GATE_MATCHER]])('%s fires on the file tools and every MCP tool', (m) => {
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__Filesystem__write_file',
      'mcp__plugin_telegram_telegram__reply', 'mcp__server-gmail-autoauth-mcp__download_attachment']) {
      expect(fires(m, t)).toBe(true)
    }
  })
  it.each([[DB_WRITE_GATE_MATCHER], [SELF_PACE_GATE_MATCHER]])('%s is anchored: no TodoWrite, BashOutput, Read, a name merely containing mcp__', (m) => {
    for (const t of ['TodoWrite', 'BashOutput', 'KillBash', 'Read', 'WebFetch', 'xmcp__a__b']) expect(fires(m, t)).toBe(false)
  })
  it('the self-pace matcher keeps its own scheduling tools', () => {
    for (const t of ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) expect(fires(SELF_PACE_GATE_MATCHER, t)).toBe(true)
  })
})

describe('a sub-agent\'s settings', () => {
  const render = () => {
    mkdirSync(join(agentRoot(), '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('default'))
    return JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8'))
  }
  const entry = (s: { hooks: { PreToolUse: Array<{ matcher: string }> } }, script: string) =>
    s.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes(script))
  it('carry both gates under the new matchers, and the deny floor\'s two MCP rules', () => {
    const s = render()
    expect(entry(s, 'self-pace-gate.mjs').map((e) => e.matcher)).toEqual([SELF_PACE_GATE_MATCHER])
    expect(entry(s, 'db-write-gate.mjs').map((e) => e.matcher)).toEqual([DB_WRITE_GATE_MATCHER])
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['mcp__Filesystem', 'mcp__gitnexus__rename']))
    expect(FLEET_BASELINE_DENY).toEqual(expect.arrayContaining(['mcp__Filesystem', 'mcp__gitnexus__rename']))
  })
  it('an older self-pace matcher is stale: the dashboard-restart pass replaces it in place (paceStale)', () => {
    render()
    const path = agentSettingsPath(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } }
    for (const e of s.hooks.PreToolUse) {
      if (JSON.stringify(e).includes('self-pace-gate.mjs')) e.matcher = 'ScheduleWakeup|CronCreate|CronDelete|CronList|RemoteTrigger|Bash|Write|Edit|NotebookEdit'
    }
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    const after = JSON.parse(readFileSync(path, 'utf-8'))
    expect(entry(after, 'self-pace-gate.mjs').map((e) => e.matcher)).toEqual([SELF_PACE_GATE_MATCHER])
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false) // no churn on the next pass
  })
})
