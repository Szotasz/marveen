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
  removeEmailApprovalGate, failClosedGateRun, EMAIL_APPROVAL_COMMAND,
} from '../web/agent-scaffold.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { EMAIL_APPROVAL_GATE_COMMAND } from '../../scripts/email-send-gate.mjs'
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

describe('approval command drift (send gate vs scaffold)', () => {
  it('keeps the send gate command byte-identical to the scaffold command', () => {
    expect(EMAIL_APPROVAL_COMMAND).toBe(EMAIL_APPROVAL_GATE_COMMAND)
  })

  it('writes the exact send gate command into every injected approval hook', () => {
    const settings = {}
    injectEmailApprovalGate(settings)
    const hooks = entries(settings).flatMap(e => (e as { hooks: { command: string }[] }).hooks)
    expect(hooks.length).toBeGreaterThan(0)
    for (const hook of hooks) expect(hook.command).toBe(EMAIL_APPROVAL_GATE_COMMAND)
  })
})

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
    // CONTENTBIND (card f2ccb0bb, round 3): scripts hold {path, sha256} objects --
    // the old plain-string shape, a relative path, a bad digest or a duplicate
    // path all fail closed here, exactly as in both gate validators.
    const validScript = { path: '/absolute/path/to/runner.ext', sha256: 'a'.repeat(64) }
    for (const scripts of [
      ['/absolute/path/to/runner.ext'],              // old plain-string shape no longer grants
      [{ ...validScript, path: 'relative.ext' }],    // relative path
      [{ ...validScript, sha256: 'z'.repeat(64) }],  // non-hex digest
      [{ ...validScript, sha256: 'a'.repeat(63) }],  // not 64 hex chars
      [{ ...validScript, sha256: 'A'.repeat(64) }],  // uppercase hex
      [validScript, { ...validScript, sha256: 'b'.repeat(64) }], // duplicate path
    ]) {
      configFile.content = JSON.stringify({ agents: { [agentName]: { ...entry, scripts } } })
      expect(readAgentSendExceptions(agentName), JSON.stringify(scripts)).toBeNull()
    }
  })

  it('validates optional readFiles', () => {
    for (const extra of [{}, { readFiles: [] }, { readFiles: ['/a', '/b'] }]) {
      const grant = { ...entry, ...extra }
      configFile.content = JSON.stringify({ agents: { [agentName]: grant } })
      expect(readAgentSendExceptions(agentName)).toEqual(grant)
    }
    for (const readFiles of [['relative'], ['/a', '/a'], [1], '/a', [''], '/']) {
      configFile.content = JSON.stringify({ agents: { [agentName]: { ...entry, readFiles } } })
      expect(readAgentSendExceptions(agentName)).toBeNull()
    }
  })

  // REPEATENVELOPE (card f2ccb0bb, round 2): the mjs argument parser returns
  // only the FIRST value of a repeatable flag, so an entry that makes an
  // envelope flag (--to/--cc/--subject/--body-file) repeatable would let
  // recipient verification and the envelope hash see only the first recipient.
  // The entry is invalid in ALL THREE validators; this one (TS) must drop it
  // through the same null path as any other shape-invalid entry.
  it('rejects entries that make an envelope flag repeatable, keeping clean entries', () => {
    // The dangerous shape MOVES the envelope flag from valueArgs to
    // repeatableArgs (no duplicate): without the fix the entry validates and
    // the mjs parser then returns only the first value of the flag.
    const flagRepeatable = (flag: string) => ({
      ...entry,
      valueArgs: entry.valueArgs.filter(f => f !== flag),
      repeatableArgs: [...entry.repeatableArgs, flag],
    })
    for (const flag of ['--to', '--cc', '--subject', '--body-file']) {
      configFile.content = JSON.stringify({ agents: { [agentName]: flagRepeatable(flag) } })
      expect(readAgentSendExceptions(agentName), flag).toBeNull()
    }
    // Without those flags the entry still validates (the corpus entry repeats
    // only --attach, which is not an envelope flag).
    configFile.content = JSON.stringify({ agents: { [agentName]: entry } })
    expect(readAgentSendExceptions(agentName)).toEqual(entry)
  })

  it('rejects gate-reserved flags in every flag list, keeping clean entries', () => {
    for (const flag of ['--envelope-sha256', '--bcc', '--reply-to', '--from', '--sender', '--return-path']) {
      for (const list of ['valueArgs', 'repeatableArgs', 'booleanArgs'] as const) {
        configFile.content = JSON.stringify({ agents: {
          [agentName]: { ...entry, [list]: [...entry[list], flag] },
        } })
        expect(readAgentSendExceptions(agentName), `${list} ${flag}`).toBeNull()
      }
    }
    configFile.content = JSON.stringify({ agents: { [agentName]: entry } })
    expect(readAgentSendExceptions(agentName)).toEqual(entry)
  })
})

// EXACTAPPROVALREMOVE (card f2ccb0bb, round 2): removeEmailApprovalGate used to
// substring-filter and remove the WHOLE PreToolUse entry, so sibling hooks in
// the same entry and innocent mentions elsewhere were lost. Only hook objects
// whose command is EXACTLY EMAIL_APPROVAL_COMMAND may go; a matcher whose hooks
// array becomes empty drops out, and everything else survives.
describe('approval-gate removal is exact-command', () => {
  // EMAIL_APPROVAL_COMMAND is module-private; rebuild it with the same exported
  // builder the scaffold itself composes it from.
  const approvalCommand = failClosedGateRun(
    'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/email-approval-gate.py"', 'email-approval-gate.py', 10,
  )
  const approvalHook = { type: 'command', command: approvalCommand, timeout: 10 }
  const siblingHook = { type: 'command', command: 'echo sibling', timeout: 5 }
  const exactApprovalHooks = (settings: Record<string, unknown>) =>
    entries(settings)
      .flatMap((e) => (Array.isArray((e as { hooks?: unknown[] }).hooks) ? (e as { hooks: unknown[] }).hooks : []))
      .filter((h) => (h as { command?: unknown }).command === approvalCommand)

  it('removes only the exact approval hooks; siblings and lookalikes survive, emptied matchers drop', () => {
    const shared = { matcher: 'Bash', hooks: [approvalHook, siblingHook] }
    const lookalike = { matcher: '.*send_email.*', hooks: [{ type: 'command', command: `${approvalCommand} --stale`, timeout: 10 }] }
    const emptied = { matcher: '.*manage_email.*', hooks: [approvalHook] }
    const settings = { hooks: { PreToolUse: [unrelated, shared, lookalike, emptied] } }
    removeEmailApprovalGate(settings)
    expect(entries(settings)).toEqual([
      unrelated,
      { matcher: 'Bash', hooks: [siblingHook] }, // the sibling hook survived the removal
      lookalike, // a command that merely mentions the gate is not the gate
      // the matcher whose hooks array became empty dropped out entirely
    ])
  })

  it('is idempotent and leaves a file without the gate untouched', () => {
    const settings = { hooks: { PreToolUse: [unrelated] } }
    removeEmailApprovalGate(settings)
    removeEmailApprovalGate(settings)
    expect(entries(settings)).toEqual([unrelated])
  })

  it('repair counting uses the same exact-command match: a mixed entry is not stale wiring', () => {
    // One matcher entry carries the exact approval hook PLUS a sibling hook.
    // Its exact hooks already match the expected wiring, so the repair pass
    // must leave it alone -- the pre-fix substring comparison read that entry
    // as stale approval wiring and the repair deleted the sibling with it.
    const settings = { hooks: { PreToolUse: [unrelated] } }
    injectEmailApprovalGate(settings)
    ;(entries(settings)[1] as { hooks: unknown[] }).hooks.push(siblingHook)
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    writeFileSync(agentSettingsPath(agentName), JSON.stringify(settings))
    // First call still repairs: the email-send gate itself is missing here.
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(true)
    // The mixed entry survives intact (not treated as stale approval wiring).
    expect(entries(readSettings())).toContainEqual({ matcher: 'Bash', hooks: [approvalHook, siblingHook] })
    expect(approvalEntries(readSettings())).toHaveLength(7)
    // Converged: nothing left to do while the grant stands.
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(false)
    // Revocation removes the exact hook only; the sibling hook survives in place.
    expect(ensureGovernanceGateCommands(agentName, profile, () => null)).toBe(true)
    expect(entries(readSettings())).toContainEqual({ matcher: 'Bash', hooks: [siblingHook] })
    expect(approvalEntries(readSettings())).toHaveLength(0)
    expect(ensureGovernanceGateCommands(agentName, profile, () => null)).toBe(false)
  })

  it('repair counts a lookalike command as missing wiring and adds the exact one beside it', () => {
    const lookalike = { matcher: 'Bash', hooks: [{ type: 'command', command: `${approvalCommand} --stale`, timeout: 10 }] }
    const settings = { hooks: { PreToolUse: [unrelated, lookalike] } }
    writeFileSync(agentSettingsPath(agentName), JSON.stringify(settings))
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(true)
    // Seven EXACT approval hooks are wired now; the substring-mentioning
    // lookalike is not one of them and must survive beside them.
    expect(exactApprovalHooks(readSettings())).toHaveLength(7)
    expect(entries(readSettings())).toContainEqual(lookalike)
    expect(ensureGovernanceGateCommands(agentName, profile, () => entry)).toBe(false)
  })
})
