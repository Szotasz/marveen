/**
 * The sender-role gate (scripts/hooks/sender-role-gate.py) on a sub-agent, opt-in per agent through the
 * `senderRoleGate` key of its agent-config.json. Same method as credential-gate-wiring.test.ts: the FINAL
 * settings file after a re-render is asserted, not the inject function alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsSenderRoleGate,
  injectSenderRoleGate,
  removeSenderRoleGate,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'

const TEST_AGENT = 'sender-role-gate-probe'
const agentRoot = (n: string) => join(AGENTS_BASE_DIR, n)
const configPath = join(agentRoot(TEST_AGENT), 'agent-config.json')

function cleanup(): void {
  const root = agentRoot(TEST_AGENT)
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) {
    throw new Error(`refusing: ${root} is outside the agents base dir`)
  }
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${root} looks like a live agent, not a test checkout`)
  }
  rmSync(root, { recursive: true, force: true })
}

beforeEach(cleanup)
afterEach(cleanup)

function render(config: unknown | undefined, fresh = true): string {
  if (fresh) cleanup()
  mkdirSync(join(agentRoot(TEST_AGENT), '.claude'), { recursive: true })
  if (config === undefined) rmSync(configPath, { force: true })
  else writeFileSync(configPath, JSON.stringify(config))
  writeAgentSettingsFromProfile(TEST_AGENT, loadProfileTemplate('default'))
  return readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')
}

type Entry = { matcher?: string; hooks: Array<{ command: string }> }
const gateEntries = (s: string) =>
  ((JSON.parse(s) as { hooks?: { PreToolUse?: Entry[] } }).hooks?.PreToolUse ?? [])
    .filter((e) => JSON.stringify(e).includes('sender-role-gate.py'))

const ON = { senderRoleGate: { riskyTools: ['Bash'], roles: [{ channel: 'telegram', sender: '111111', role: 'owner' }] } }

function policyOf(command: string): unknown {
  const m = / --policy ([A-Za-z0-9_-]+)/.exec(command)
  if (!m) throw new Error(`no --policy in: ${command}`)
  return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf-8'))
}

describe('sender-role gate wiring', () => {
  it('is absent without the key, and with an empty riskyTools list', () => {
    expect(gateEntries(render(undefined))).toHaveLength(0)
    expect(gateEntries(render({ model: 'x' }))).toHaveLength(0)
    expect(gateEntries(render({ senderRoleGate: { riskyTools: [] } }))).toHaveLength(0)
  })

  it('is wired once, on every tool, carrying the table read at spawn as its --policy', () => {
    const entries = gateEntries(render(ON))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('*')
    expect(entries[0].hooks).toHaveLength(1)
    expect(policyOf(entries[0].hooks[0].command)).toEqual(ON.senderRoleGate)
  })

  it('an edit to agent-config.json after the spawn does not change the wired table', () => {
    const wired = gateEntries(render(ON))[0].hooks[0].command
    writeFileSync(configPath, JSON.stringify({ senderRoleGate: { riskyTools: [] } }))
    const now = JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')) as { hooks: { PreToolUse: Entry[] } }
    expect(now.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('sender-role-gate.py'))[0].hooks[0].command).toBe(wired)
  })

  it('stays a single entry across re-renders, and leaves when the key goes', () => {
    render(ON)
    expect(gateEntries(render(ON, false))).toHaveLength(1)
    expect(gateEntries(render({ model: 'x' }, false))).toHaveLength(0)
  })

  it('a malformed value still wires the hook (it fails closed itself)', () => {
    const entries = gateEntries(render({ senderRoleGate: 'yes' }))
    expect(entries).toHaveLength(1)
    expect(policyOf(entries[0].hooks[0].command)).toBe('yes')
  })
})

describe('agentGetsSenderRoleGate', () => {
  // The main agent is never rendered here: its settings path is the owner's live file.
  it('is for sub-agents only', () => {
    expect(agentGetsSenderRoleGate(MAIN_AGENT_ID)).toBe(false)
    expect(agentGetsSenderRoleGate(TEST_AGENT)).toBe(true)
  })
})

describe('injectSenderRoleGate / removeSenderRoleGate', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "/x/audit-sender-role-gate.py"' }] }

  it('keeps an unrelated entry first and adds exactly one gate entry', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    injectSenderRoleGate(s, 'e30')
    injectSenderRoleGate(s, 'e30')
    const pre = (s.hooks as { PreToolUse: Entry[] }).PreToolUse
    expect(pre).toHaveLength(2)
    expect(pre[0]).toEqual(other)
    expect(JSON.stringify(pre[1])).toContain('sender-role-gate.py')
  })

  it('remove drops only the gate entry, and creates nothing on an empty object', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    injectSenderRoleGate(s, 'e30')
    removeSenderRoleGate(s)
    expect((s.hooks as { PreToolUse: Entry[] }).PreToolUse).toEqual([other])
    const empty: Record<string, unknown> = {}
    removeSenderRoleGate(empty)
    expect(empty).toEqual({})
  })
})
