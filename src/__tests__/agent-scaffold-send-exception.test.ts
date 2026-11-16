import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import corpus from './fixtures/agent-send-exception-cases.json' with { type: 'json' }

const configFile = vi.hoisted(() => ({ content: '{invalid json' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('/store/agent-send-exceptions.json')) return configFile.content
    return fs.readFileSync(...args)
  } }
})
const { agentRoot } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return { agentRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'send-exception-scaffold-')) }
})
vi.mock('../web/agent-config.js', async original => ({
  ...(await original<typeof import('../web/agent-config.js')>()),
  agentDir: () => agentRoot,
  readAgentCapabilities: () => [],
}))
import {
  injectEmailSendGate, injectEmailApprovalGate, ensureGovernanceGateCommands,
  readAgentSendExceptions, writeAgentSettingsFromProfile, agentSettingsPath, hookCommand, EMAIL_AGENT_FLAG, EMAIL_THREAD_REPLY_FLAG,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { loadProfileTemplate } from '../web/profiles.js'

const agentName = corpus.agentName.replace(/[<>]/g, '')
const { entry } = corpus
const unrelated = { matcher: 'Read', hooks: [{ type: 'command', command: 'echo unrelated' }] }
const entries = (settings: Record<string, unknown>) => (settings.hooks as { PreToolUse: unknown[] }).PreToolUse
const approvalEntries = (settings: Record<string, unknown>) => entries(settings).filter(e => JSON.stringify(e).includes('email-approval-gate.py'))
const readSettings = () => JSON.parse(readFileSync(agentSettingsPath(agentName), 'utf8'))
const profile = loadProfileTemplate('default')!
afterAll(() => rmSync(agentRoot, { recursive: true, force: true }))

describe('send exception hook wiring', () => {
  it('includes the identity, with the optional thread flag', () => {
    for (const thread of [false, true]) {
      const settings = {}
      injectEmailSendGate(settings, thread, agentName)
      const expected = hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs'), [
        ...(thread ? [EMAIL_THREAD_REPLY_FLAG] : []), EMAIL_AGENT_FLAG, agentName,
      ])
      expect(JSON.stringify(settings)).toContain(JSON.stringify(expected).slice(1, -1))
    }
  })
  it('preserves the no-identity command for legacy callers', () => {
    const settings = {}
    injectEmailSendGate(settings)
    expect(JSON.stringify(settings)).not.toContain('--agent')
  })
  it('mirrors every tracked approval entry exactly and deduplicates', () => {
    const settings = { hooks: { PreToolUse: [unrelated] } }
    injectEmailApprovalGate(settings)
    injectEmailApprovalGate(settings)
    const tracked = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude/settings.json'), 'utf8'))
    expect(approvalEntries(settings)).toEqual(tracked.hooks.PreToolUse.filter((e: unknown) => JSON.stringify(e).includes('email-approval-gate.py')))
    expect(entries(settings)).toContainEqual(unrelated)
  })
  it('rewrites the old command, repairs approval hooks, then removes them on revocation', () => {
    const settings = { hooks: { PreToolUse: [unrelated] } }
    injectEmailSendGate(settings)
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    writeFileSync(agentSettingsPath(agentName), JSON.stringify(settings))
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(true)
    expect(JSON.stringify(readSettings())).toContain('--agent')
    expect(approvalEntries(readSettings())).toHaveLength(7)
    expect(entries(readSettings())).toContainEqual(unrelated)
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(false)
    const broken = readSettings()
    ;(broken.hooks.PreToolUse as unknown[]).splice((broken.hooks.PreToolUse as unknown[]).findIndex(e => JSON.stringify(e).includes('email-approval-gate.py')), 1)
    writeFileSync(agentSettingsPath(agentName), JSON.stringify(broken))
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(true)
    expect(approvalEntries(readSettings())).toHaveLength(7)
    expect(ensureGovernanceGateCommands(agentName, profile, () => null)).toBe(true)
    expect(approvalEntries(readSettings())).toHaveLength(0)
    expect(entries(readSettings())).toContainEqual(unrelated)
    expect(ensureGovernanceGateCommands(agentName, profile, () => null)).toBe(false)
  })
  it('adds and removes approval hooks on respawn from local operator config', () => {
    configFile.content = JSON.stringify({ agents: { [agentName]: entry } })
    writeAgentSettingsFromProfile(agentName, profile, join(agentRoot, 'absent-extra-hooks.json'))
    expect(JSON.stringify(readSettings())).toContain('--agent')
    expect(approvalEntries(readSettings())).toHaveLength(7)
    configFile.content = JSON.stringify({ agents: {} })
    writeAgentSettingsFromProfile(agentName, profile, join(agentRoot, 'absent-extra-hooks.json'))
    expect(approvalEntries(readSettings())).toHaveLength(0)
    expect(entries(readSettings())).toContainEqual(unrelated)
  })
  it('reads only valid local entries, failing closed for invalid siblings and JSON', () => {
    configFile.content = '{invalid json'
    expect(readAgentSendExceptions(agentName)).toBeNull()
    configFile.content = JSON.stringify({ agents: { [agentName]: entry, '<invalid-agent>': { ...entry, extra: true } } })
    expect(readAgentSendExceptions(agentName)).toEqual(entry)
    expect(readAgentSendExceptions('<invalid-agent>')).toBeNull()
    configFile.content = JSON.stringify({ agents: { [agentName]: { ...entry, scripts: ['relative.ext'] } } })
    expect(readAgentSendExceptions(agentName)).toBeNull()
  })
})
