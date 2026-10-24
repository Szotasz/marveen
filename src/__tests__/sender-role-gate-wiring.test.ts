/**
 * The sender-role gate (scripts/hooks/sender-role-gate.py) on a sub-agent, opt-in per agent through the
 * `senderRoleGate` key of its agent-config.json. Same method as credential-gate-wiring.test.ts: the FINAL
 * settings file after a re-render is asserted, not the inject function alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  injectSenderRoleGate,
  removeSenderRoleGate,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate } from '../web/profiles.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

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

const ON = { senderRoleGate: { riskyTools: ['Bash'], roles: [] } }

describe('sender-role gate wiring', () => {
  it('is absent without the key, and with an empty riskyTools list', () => {
    expect(gateEntries(render(undefined))).toHaveLength(0)
    expect(gateEntries(render({ model: 'x' }))).toHaveLength(0)
    expect(gateEntries(render({ senderRoleGate: { riskyTools: [] } }))).toHaveLength(0)
  })

  it('is wired once, on every tool, with the agent name as its --agent', () => {
    const entries = gateEntries(render(ON))
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('*')
    expect(entries[0].hooks).toHaveLength(1)
    expect(entries[0].hooks[0].command).toContain(`--agent ${TEST_AGENT}`)
  })

  it('stays a single entry across re-renders, and leaves when the key goes', () => {
    render(ON)
    expect(gateEntries(render(ON, false))).toHaveLength(1)
    expect(gateEntries(render({ model: 'x' }, false))).toHaveLength(0)
  })

  it('a malformed value still wires the hook (it fails closed itself)', () => {
    expect(gateEntries(render({ senderRoleGate: 'yes' }))).toHaveLength(1)
  })
})

describe('injectSenderRoleGate / removeSenderRoleGate', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /x/other-gate.py' }] }

  it('keeps an unrelated entry first and adds exactly one gate entry', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    injectSenderRoleGate(s, 'a')
    injectSenderRoleGate(s, 'a')
    const pre = (s.hooks as { PreToolUse: Entry[] }).PreToolUse
    expect(pre).toHaveLength(2)
    expect(pre[0]).toEqual(other)
    expect(JSON.stringify(pre[1])).toContain('sender-role-gate.py')
  })

  it('remove drops only the gate entry, and creates nothing on an empty object', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: [other] } }
    injectSenderRoleGate(s, 'a')
    removeSenderRoleGate(s)
    expect((s.hooks as { PreToolUse: Entry[] }).PreToolUse).toEqual([other])
    const empty: Record<string, unknown> = {}
    removeSenderRoleGate(empty)
    expect(empty).toEqual({})
  })
})
