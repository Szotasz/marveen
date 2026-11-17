import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// after node:os / node:path / node:url on purpose: importing node:fs runs the
// vi.mock factory below, which closes over those -- an earlier position fails
// with "Cannot access ... before initialization"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import corpus from './fixtures/agent-send-exception-cases.json' with { type: 'json' }

const file = vi.hoisted(() => ({ content: '{invalid json', unreadable: false }))
// SENDAPPROVALBIND (card f2ccb0bb round 2): the agent-side settings file the
// gate must consult before honoring a SEND-mode exception. `null` = the file is
// missing; anything else is served verbatim (possibly invalid JSON).
const agentSettings = vi.hoisted(() => ({ content: null as string | null }))
// ~/.claude/settings.json, served only while a test targets the MAIN_AGENT_ID
// branch of the same lookup (`null` = missing).
const homeSettings = vi.hoisted(() => ({ content: null as string | null }))
// The install's .env, served for the MAIN_AGENT_ID lookup (empty = no main id).
const envFile = vi.hoisted(() => ({ content: '' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts')
  const agentSettingsPath = (name: string) => join(root, '..', 'agents', name, '.claude', 'settings.json')
  const homeSettingsPath = join(homedir(), '.claude', 'settings.json')
  const rootEnv = join(root, '..', '.env')
  const serve = (content: string | null) => {
    if (content === null) throw new Error('ENOENT: no such file')
    return content
  }
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('/store/agent-send-exceptions.json')) {
      if (file.unreadable) throw new Error('unreadable')
      return file.content
    }
    if (String(args[0]) === agentSettingsPath(corpus.agentName)) return serve(agentSettings.content)
    if (String(args[0]) === homeSettingsPath) return serve(homeSettings.content)
    if (String(args[0]) === rootEnv) return envFile.content
    return fs.readFileSync(...args)
  } }
})
// @ts-expect-error -- plain .mjs hook script, no types
import { agentScriptException, gateDecision, readAgentSendExceptions, validAgentSendException } from '../../scripts/email-send-gate.mjs'
// Namespace import: the unbound-binding deny builder arrives with the fix, and a
// named import of a missing export would break the whole file at link time.
// @ts-expect-error -- plain .mjs hook script, no types
import * as sendGate from '../../scripts/email-send-gate.mjs'

const { agentName } = corpus
// SCRIPTBIND (card f2ccb0bb, round 3): the grant binds the script CONTENT. The
// corpus entry carries the SHAPE only (a placeholder path and sha256); the tests
// bind it to a real temp script and compute the expected sha256 from the exact
// bytes written at setup -- never a hardcoded digest of a nonexistent file.
const scriptDir = mkdtempSync(join(tmpdir(), 'agent-send-exception-'))
const scriptFile = join(scriptDir, 'runner.ext')
const scriptBody = '#!/usr/bin/env node\nconsole.log("sanctioned runner")\n'
writeFileSync(scriptFile, scriptBody)
const scriptSha = createHash('sha256').update(scriptBody).digest('hex')
afterAll(() => { rmSync(scriptDir, { recursive: true, force: true }) })
const bind = (cmd: string) => cmd.replaceAll('/absolute/path/to/runner.ext', scriptFile)
const entry = { ...corpus.entry, scripts: [{ path: scriptFile, sha256: scriptSha }] }
const cases = corpus.cases.map(c => ({ ...c, command: bind(c.command) }))
const config = { agents: { [agentName]: entry } }
const command = cases[0].command
const verify = (address: string) => ['verified@example.invalid', 'copy@example.invalid'].includes(address)
const decide = (cmd = command, agent: string | null = agentName, cfg: unknown = config) =>
  gateDecision('Bash', { command: cmd }, verify, process.cwd(), agent, () => cfg)
// A settings file with the approval-gate PreToolUse hook bound, as the scaffold
// writes it at spawn time when the grant exists.
const boundSettings = JSON.stringify({ hooks: { PreToolUse: [
  { matcher: '.*send_email.*', hooks: [{ type: 'command', command: 'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/email-approval-gate.py"', timeout: 10 }] },
] } })
// The grant existed at spawn time, so the scaffold bound the gate.
agentSettings.content = boundSettings

describe('named-script exception', () => {
  it('preserves the script-send denial without an agent identity', () => {
    expect(decide(command, null)).toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('allows the exact send with verified recipients', () => {
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
    expect(agentScriptException(command, agentName, config)).toEqual({
      script: entry.scripts[0].path, mode: 'send', to: 'verified@example.invalid', cc: 'copy@example.invalid',
      subject: 'Example subject', bodyFile: '/absolute/path/to/body.txt', attach: ['/absolute/path/to/attachment.bin'],
    })
  })
  it('allows a draft with verified recipients', () => {
    expect(decide(command.replace(' send ', ' draft '))).toEqual({ deny: false, kind: 'script-exception' })
  })
  it('denies an unverified draft recipient', () => {
    expect(decide(command.replace(' send ', ' draft ').replace('verified@', 'unknown@')))
      .toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  it('checks cc as well as to', () => {
    expect(decide(command.replace('copy@', 'unknown@'))).toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  it('denies an unparseable recipient', () => {
    expect(decide(command.replace('verified@example.invalid', 'invalid@')))
      .toMatchObject({ deny: true, kind: 'unparseable-recipient' })
  })
  for (const c of cases.filter(c => !c.match && !c.name.startsWith('innocent'))) {
    it(`falls through to the existing deny: ${c.name}`, () => {
      expect(decide(c.command).deny).toBe(true)
    })
  }
  it('denies an identity with no entry', () => {
    expect(decide(command, '<other-agent>')).toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('denies a send under a draft-only grant', () => {
    expect(decide(command, agentName, { agents: { [agentName]: { ...entry, modes: ['draft'] } } }))
      .toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('denies an entry with a relative script path', () => {
    expect(decide(command, agentName, { agents: { [agentName]: { ...entry, scripts: [{ path: 'runner.ext', sha256: scriptSha }] } } }))
      .toMatchObject({ deny: true, kind: 'script-send' })
  })
  it('treats invalid JSON and unreadable config as no exceptions', () => {
    file.content = '{invalid json'
    expect(readAgentSendExceptions()).toEqual({})
    expect(decide(command, agentName, readAgentSendExceptions())).toMatchObject({ deny: true, kind: 'script-send' })
    file.unreadable = true
    expect(readAgentSendExceptions()).toEqual({})
    file.unreadable = false
  })
  it('skips only invalid entries', () => {
    file.content = JSON.stringify({ agents: { [agentName]: entry, '<invalid-agent>': { ...entry, unexpected: true } } })
    expect(readAgentSendExceptions()).toEqual(config)
  })
})

describe('parser conformance (also read by email-approval-gate-script-exception.test.py)', () => {
  for (const c of cases) it(c.name, () => {
    expect(Boolean(agentScriptException(c.command, agentName, config))).toBe(c.match)
  })
})

// SENDAPPROVALBIND (card f2ccb0bb, round 2): the mjs reads the exception config
// live, but the scaffold binds the enabling PreToolUse py hook into the agent's
// settings file only at spawn time, and only if a grant existed then. A grant
// added AFTER spawn is seen by this gate while the py approval gate is still
// unbound -- so before a SEND-mode pass the binding must be verified on the
// same settings path the scaffold writes (agentSettingsPath), fail-closed.
describe('send exception requires the bound approval gate (SEND mode only)', () => {
  afterEach(() => {
    agentSettings.content = boundSettings
    homeSettings.content = null
    envFile.content = ''
    file.content = '{invalid json'
  })

  it('denies the send while the gate hook is not bound: missing, unreadable, or hook-less settings', () => {
    agentSettings.content = null // no settings file at all (grant postdates the spawn)
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
    agentSettings.content = '{invalid json' // unreadable settings
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
    agentSettings.content = JSON.stringify({ hooks: { PreToolUse: [
      { matcher: '.*send_email.*', hooks: [{ type: 'command', command: 'echo unrelated' }] }, // no approval hook
    ] } })
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
    agentSettings.content = JSON.stringify({}) // readable file, no hooks key
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
  })

  it('names the remedy: the agent must be restarted so the scaffold binds the gate', () => {
    const msg = sendGate.buildApprovalGateUnboundMsg()
    expect(msg).toContain('email-approval-gate.py')
    expect(msg.toLowerCase()).toContain('ujra kell inditani') // "must be restarted"
    expect(msg.toLowerCase()).toContain('respawn')
  })

  it('allows the send again once the hook is bound', () => {
    agentSettings.content = null
    expect(decide().deny).toBe(true)
    agentSettings.content = boundSettings
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
  })

  it('a hook elsewhere in the file does not satisfy the binding: only PreToolUse counts', () => {
    agentSettings.content = JSON.stringify({ hooks: { PostToolUse: [
      { matcher: '.*send_email.*', hooks: [{ type: 'command', command: 'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/email-approval-gate.py"' }] },
    ] } })
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
  })

  it('drafts are untouched by the binding check', () => {
    for (const content of [null, '{invalid json', boundSettings]) {
      agentSettings.content = content
      expect(decide(command.replace(' send ', ' draft '))).toEqual({ deny: false, kind: 'script-exception' })
    }
  })

  it('an unbound gate still verifies recipients first on no other path: the deny is the binding one', () => {
    agentSettings.content = null
    // The binding deny wins even for an unverified recipient: without the py
    // gate bound, no approval-level enforcement exists at all, so the call must
    // not slip through to a narrower wording.
    expect(decide(command.replace('verified@', 'unknown@'))).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
  })

  it('MAIN_AGENT_ID resolves the home settings file, same fail-closed rule', () => {
    envFile.content = `MAIN_AGENT_ID=${agentName}\n`
    agentSettings.content = boundSettings // the agents/<name> file is NOT consulted for the main id
    homeSettings.content = null
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
    homeSettings.content = boundSettings
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
  })
})

// REPEATENVELOPE (card f2ccb0bb, round 2): the mjs argument parser returns only
// the FIRST value of a repeatable flag, so an entry that makes an envelope flag
// repeatable would let recipient verification (and the py envelope hash) see
// only the first recipient. Such an entry is invalid in ALL THREE validators
// (mjs, py, TS) and drops exactly like any other shape-invalid entry.
describe('repeatable envelope flags invalidate the exception entry', () => {
  // The dangerous shape MOVES the envelope flag from valueArgs to
  // repeatableArgs (no duplicate): the entry otherwise validates today, and
  // the parser then returns only the first value of the flag.
  const flagRepeatable = (flag: string, extra: string[] = []) => ({
    ...entry,
    valueArgs: entry.valueArgs.filter(f => f !== flag),
    repeatableArgs: [...extra, flag],
  })
  for (const flag of ['--to', '--cc', '--subject', '--body-file']) {
    it(`repeatable '${flag}' is invalid`, () => {
      expect(validAgentSendException(flagRepeatable(flag))).toBe(false)
      // also invalid alongside a legitimate repeatable flag
      expect(validAgentSendException(flagRepeatable(flag, entry.repeatableArgs))).toBe(false)
    })
  }
  it('an entry without those repeatable flags still validates', () => {
    expect(validAgentSendException(entry)).toBe(true)
    expect(validAgentSendException({ ...entry, repeatableArgs: [] })).toBe(true)
  })
  it('the reader drops the invalid entry and keeps valid siblings', () => {
    file.content = JSON.stringify({ agents: { [agentName]: flagRepeatable('--to'), '<other-agent>': entry } })
    expect(readAgentSendExceptions()).toEqual({ agents: { '<other-agent>': entry } })
    // and the named agent falls back to the ordinary script-send deny
    expect(decide(command, agentName, readAgentSendExceptions())).toMatchObject({ deny: true, kind: 'script-send' })
  })
})

// SCRIPTBIND (card f2ccb0bb, round 3): the grant binds the script CONTENT, not only
// its path. On every invocation the matcher reads the entry script's raw bytes and
// compares the sha256 to the granted value; a missing or unreadable file, or any byte
// change since the grant, means the invocation does not qualify (fail-closed: it
// falls back to the ordinary script-send deny, because the addressed run names a
// script the gate can no longer vouch for).
describe('the grant binds the script content (sha256, checked per invocation)', () => {
  afterEach(() => {
    writeFileSync(scriptFile, scriptBody)
    file.content = '{invalid json'
  })
  const withScripts = (scripts: unknown) => ({ agents: { [agentName]: { ...entry, scripts } } })
  // case[0] with the granted path swapped: every red command below keeps the
  // sanctioned shape, so only the content binding can fail it
  const commandAt = (granted: string) => corpus.cases[0].command.replaceAll('/absolute/path/to/runner.ext', granted)

  it('(a) script content changed after the grant -> no exception', () => {
    expect(agentScriptException(command, agentName, config)).not.toBeNull()
    writeFileSync(scriptFile, '#!/usr/bin/env node\nconsole.log("tampered runner")\n')
    expect(agentScriptException(command, agentName, config)).toBeNull()
    expect(decide()).toMatchObject({ deny: true, kind: 'script-send' })
    // the check is per invocation: restoring the bytes restores the exception
    writeFileSync(scriptFile, scriptBody)
    expect(agentScriptException(command, agentName, config)).not.toBeNull()
  })

  it('(b) a missing script file -> no exception', () => {
    const gone = join(scriptDir, 'gone.ext')
    const cfg = withScripts([{ path: gone, sha256: scriptSha }])
    expect(agentScriptException(commandAt(gone), agentName, cfg)).toBeNull()
    expect(decide(commandAt(gone), agentName, cfg)).toMatchObject({ deny: true, kind: 'script-send' })
  })

  it('(b) an unreadable script (a directory at the granted path) -> no exception', () => {
    const dir = join(scriptDir, 'as-a-directory')
    mkdirSync(dir)
    const cfg = withScripts([{ path: dir, sha256: scriptSha }])
    expect(agentScriptException(commandAt(dir), agentName, cfg)).toBeNull()
    expect(decide(commandAt(dir), agentName, cfg)).toMatchObject({ deny: true, kind: 'script-send' })
  })

  it('(c) a wrong granted sha256 (valid hex, wrong value) -> no exception', () => {
    const cfg = withScripts([{ path: scriptFile, sha256: 'f'.repeat(64) }])
    expect(agentScriptException(command, agentName, cfg)).toBeNull()
    expect(decide(command, agentName, cfg)).toMatchObject({ deny: true, kind: 'script-send' })
  })

  it('the entry itself stays valid in every red case above: the file, not the config, fails it', () => {
    expect(validAgentSendException(withScripts([{ path: join(scriptDir, 'gone.ext'), sha256: scriptSha }]).agents[agentName])).toBe(true)
    expect(validAgentSendException(withScripts([{ path: scriptFile, sha256: 'f'.repeat(64) }]).agents[agentName])).toBe(true)
  })

  it('scripts entries must be {path, sha256} objects: nonempty, no duplicate paths, absolute, 64 lowercase hex', () => {
    expect(validAgentSendException(entry)).toBe(true)
    expect(validAgentSendException(withScripts([]).agents[agentName])).toBe(false)
    expect(validAgentSendException(withScripts([{ path: scriptFile, sha256: scriptSha }, { path: scriptFile, sha256: '0'.repeat(64) }]).agents[agentName])).toBe(false)
    expect(validAgentSendException(withScripts([{ path: 'runner.ext', sha256: scriptSha }]).agents[agentName])).toBe(false)
    expect(validAgentSendException(withScripts([{ path: scriptFile, sha256: '0A'.repeat(32) }]).agents[agentName])).toBe(false) // uppercase hex
    expect(validAgentSendException(withScripts([{ path: scriptFile, sha256: 'abcd' }]).agents[agentName])).toBe(false)
    expect(validAgentSendException(withScripts([{ path: scriptFile, sha256: scriptSha, extra: true }]).agents[agentName])).toBe(false)
    expect(validAgentSendException(withScripts(['runner.ext']).agents[agentName])).toBe(false) // the old shape: strings
    expect(validAgentSendException(withScripts([{ path: scriptFile }]).agents[agentName])).toBe(false)
    // the reader drops a shape-invalid scripts entry and keeps valid siblings
    file.content = JSON.stringify({ agents: { [agentName]: withScripts(['runner.ext']).agents[agentName], '<other-agent>': entry } })
    expect(readAgentSendExceptions()).toEqual({ agents: { '<other-agent>': entry } })
  })
})
