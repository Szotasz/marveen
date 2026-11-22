import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// after node:os / node:path / node:url on purpose: importing node:fs runs the
// vi.mock factory below, which closes over those -- an earlier position fails
// with "Cannot access ... before initialization"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import corpus from './fixtures/agent-send-exception-cases.json' with { type: 'json' }

import loaderCorpus from './fixtures/agent-send-exception-loader-cases.json' with { type: 'json' }

const accessProbe = vi.hoisted(() => ({ mode: 'stub', writablePath: null as string | null, errorCode: 'EACCES' }))
afterEach(() => { accessProbe.mode = 'stub'; accessProbe.writablePath = null; accessProbe.errorCode = 'EACCES' })
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
  return { ...fs, accessSync: (...args: Parameters<typeof fs.accessSync>) => {
    if (accessProbe.mode === 'real') return fs.accessSync(...args)
    if (String(args[0]) === accessProbe.writablePath) return
    throw Object.assign(new Error('permission probe'), { code: accessProbe.errorCode })
  }, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
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
import { scriptSourceLoadsOnlyBuiltins, scriptPathWritable, agentScriptException, gateDecision, readAgentSendExceptions, validAgentSendException, nodePermissionVersionOk, probeNodeVersion, resolveNodeInterpreter, setNodeVersionProbeOverride } from '../../scripts/email-send-gate.mjs'
// Namespace import: the unbound-binding deny builder arrives with the fix, and a
// named import of a missing export would break the whole file at link time.
// @ts-expect-error -- plain .mjs hook script, no types
import * as sendGate from '../../scripts/email-send-gate.mjs'

// The send exception is disabled on macOS (the Node permission model was not measured there), so every
// positive expectation is bound to the platform; the darwin branch is asserted by stubbing the platform.
const SEND_EXCEPTION_PLATFORM = process.platform !== 'darwin'
const itPositive = SEND_EXCEPTION_PLATFORM ? it : it.skip

const { EMAIL_APPROVAL_GATE_COMMAND } = sendGate
const { agentName } = corpus
// SCRIPTBIND (card f2ccb0bb, round 3): the grant binds the script CONTENT. The
// corpus entry carries the SHAPE only (a placeholder path and sha256); the tests
// bind it to a real temp script and compute the expected sha256 from the exact
// bytes written at setup -- never a hardcoded digest of a nonexistent file.
const scriptDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-send-exception-')))
const scriptFile = join(scriptDir, 'runner.ext')
const scriptBody = '#!/usr/bin/env node\nconsole.log("sanctioned runner")\n'
writeFileSync(scriptFile, scriptBody)
const scriptSha = createHash('sha256').update(scriptBody).digest('hex')
afterAll(() => { rmSync(scriptDir, { recursive: true, force: true }) })
const bind = (cmd: string) => cmd.replaceAll('/absolute/path/to/runner.ext', scriptFile)
beforeEach(() => { setNodeVersionProbeOverride(() => 'v22.22.2') })
afterEach(() => { setNodeVersionProbeOverride(null) })
const entry = { ...corpus.entry, readFiles: ['/absolute/path/to/extra.json'], scripts: [{ path: scriptFile, sha256: scriptSha }] }
const cases = corpus.cases.map(c => ({ ...c, command: bind(c.command) }))
const config = { agents: { [agentName]: entry } }
const withScripts = (scripts: unknown) => ({ agents: { [agentName]: { ...entry, scripts } } })
const command = cases[0].command
const draftCommand = cases.find(c => c.name === 'draft')!.command
const verify = (address: string) => ['verified@example.invalid', 'copy@example.invalid'].includes(address)
const decide = (cmd = command, agent: string | null = agentName, cfg: unknown = config) =>
  gateDecision('Bash', { command: cmd }, verify, process.cwd(), agent, () => cfg)
// A settings file with the approval-gate PreToolUse hook bound, as the scaffold
// writes it at spawn time when the grant exists.
const boundSettings = JSON.stringify({ hooks: { PreToolUse: [
  { matcher: '.*send_email.*', hooks: [{ type: 'command', command: EMAIL_APPROVAL_GATE_COMMAND, timeout: 10 }] },
] } })
// The grant existed at spawn time, so the scaffold bound the gate.
agentSettings.content = boundSettings

describe('named-script exception', () => {
  it('preserves the script-send denial without an agent identity', () => {
    expect(decide(command, null)).toMatchObject({ deny: true, kind: 'script-send' })
  })
  itPositive('allows the exact send with verified recipients', () => {
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
    expect(agentScriptException(command, agentName, config)).toEqual({
      script: entry.scripts[0].path, mode: 'send', envelopeSha256: 'a'.repeat(64), to: 'verified@example.invalid', cc: 'copy@example.invalid',
      subject: 'Example subject', bodyFile: '/absolute/path/to/body.txt', attach: ['/absolute/path/to/attachment.bin'],
    })
  })
  itPositive('allows a draft with verified recipients', () => {
    expect(decide(draftCommand)).toEqual({ deny: false, kind: 'script-exception' })
  })
  itPositive('denies an unverified draft recipient', () => {
    expect(decide(draftCommand.replace('verified@', 'unknown@')))
      .toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  itPositive('checks cc as well as to', () => {
    expect(decide(command.replace('copy@', 'unknown@'))).toMatchObject({ deny: true, kind: 'unverified-recipient' })
  })
  itPositive('denies an unparseable recipient', () => {
    expect(decide(command.replace('verified@example.invalid', 'invalid@')))
      .toMatchObject({ deny: true, kind: 'unparseable-recipient' })
  })
  // B2 (card f2ccb0bb R4): an interpreter outside the exact allowlist leaves the
  // command without an exception. The matcher-level deny is pinned case by case in
  // the parser conformance block below; at the gate level the property that matters
  // is that none of them can pass AS the exception. R5 (maintainer decision) closed the
  // nodejs-basename gap: the ordinary Bash analysis recognizes `nodejs`, so EVERY red
  // interpreter case now falls back to the ordinary script-send deny, node- and
  // nodejs-basename alike.
  const interpreterRed = cases.filter(c => !c.match && c.name.startsWith('interpreter '))
  // 'shape-negative missing interpreter' starts with `--permission`, which no shell runs as a node script, so the
  // ordinary analysis rightly sees no send; the parser conformance block still asserts it gets no exception.
  for (const c of cases.filter(c => !c.match && !c.name.startsWith('innocent') && !c.name.startsWith('interpreter ')
    && c.name !== 'shape-negative missing interpreter')) {
    it(`falls through to the existing deny: ${c.name}`, () => {
      expect(decide(c.command).deny).toBe(true)
    })
  }
  it('an interpreter outside the allowlist never passes as the exception', () => {
    for (const c of interpreterRed) {
      expect(decide(c.command)).not.toEqual({ deny: false, kind: 'script-exception' })
    }
  })
  it('every interpreter outside the allowlist falls back to the ordinary script-send deny (R5)', () => {
    // R5 review (both legs): a bare loop passes vacuously if the corpus loses its
    // interpreter cases, and the R4->R5 rewrite dropped the old named-existence
    // assertion. Pin the list non-empty and the known red names, then deny each.
    expect(interpreterRed.map(c => c.name)).toEqual(expect.arrayContaining([
      'interpreter /tmp/x/node',
      'interpreter /absolute/path/to/node',
      'interpreter /absolute/path/to/nodejs',
      'interpreter /usr/bin/nodejs',
      'interpreter /usr/local/bin/nodejs',
    ]))
    expect(interpreterRed.length).toBeGreaterThanOrEqual(5)
    for (const c of interpreterRed) {
      expect(decide(c.command)).toMatchObject({ deny: true, kind: 'script-send' })
    }
  })
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
  it('every negative send case carries one well-formed digest, so it fails for its own reason', () => {
    for (const c of cases.filter(c => !c.match && c.command.split(/\s+/).includes('send')
      && !c.name.includes('envelope digest'))) {
      expect(c.command.match(/--envelope-sha256 [0-9a-f]{64}(?![0-9a-f])/g)).toHaveLength(1)
    }
  })
  it('all existing cases retain a permission prefix and their required read list', () => {
    for (const c of cases.filter(c => !c.name.startsWith('shape-negative '))) {
      // Prefix wrappers, unknown interpreters and malformed quoting keep their own failure reason.
      const m = c.command.match(/(?:^| )([^ ]+) --permission ((?:--allow-fs-read=\S+ )+)(\S+)/)!
      expect(m, c.name).not.toBeNull()
      const reads = m[2].trim().split(' ').map(v => v.slice('--allow-fs-read='.length))
      const script = bind(m[3].replaceAll("'", '')) // a quote-concatenated token is only bound once de-quoted
      const required = [script, ...Array.from(c.command.matchAll(/--(?:body-file|attach) (\S+)/g), m =>
        m[1].startsWith('/') ? m[1] : `/absolute/path/to/${m[1]}`)]
      expect(new Set(reads.filter(p => !entry.readFiles.includes(p))), c.name).toEqual(new Set(required))
      expect(reads.length, c.name).toBe(new Set(reads).size)
    }
  })
  for (const c of cases) it(c.name, () => {
    expect(Boolean(agentScriptException(c.command, agentName, config))).toBe(c.match && SEND_EXCEPTION_PLATFORM)
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

  itPositive('denies the send while the gate hook is not bound: missing, unreadable, or hook-less settings', () => {
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

  itPositive('allows the send again once the hook is bound', () => {
    agentSettings.content = null
    expect(decide().deny).toBe(true)
    agentSettings.content = boundSettings
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
  })

  itPositive('a hook elsewhere in the file does not satisfy the binding: only PreToolUse counts', () => {
    agentSettings.content = JSON.stringify({ hooks: { PostToolUse: [
      { matcher: '.*send_email.*', hooks: [{ type: 'command', command: EMAIL_APPROVAL_GATE_COMMAND }] },
    ] } })
    expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
  })

  itPositive('a command that only mentions the gate is not the binding', () => {
    for (const command of [
      `${EMAIL_APPROVAL_GATE_COMMAND} --stale`,
      'echo email-approval-gate.py',
      'python3 -I -S "$CLAUDE_PROJECT_DIR/scripts/hooks/email-approval-gate.py"',
    ]) {
      agentSettings.content = JSON.stringify({ hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] },
      ] } })
      expect(decide()).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
    }
  })

  itPositive('the exact hook next to sibling hooks in the same entry is bound', () => {
    agentSettings.content = JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [
        { type: 'command', command: 'echo sibling' },
        { type: 'command', command: EMAIL_APPROVAL_GATE_COMMAND, timeout: 10 },
      ] },
    ] } })
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
  })

  itPositive('a lookalike entry does not hide an exact entry', () => {
    agentSettings.content = JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${EMAIL_APPROVAL_GATE_COMMAND} --stale`, timeout: 10 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: EMAIL_APPROVAL_GATE_COMMAND, timeout: 10 }] },
    ] } })
    expect(decide()).toEqual({ deny: false, kind: 'script-exception' })
  })

  itPositive('drafts are untouched by the binding check', () => {
    for (const content of [null, '{invalid json', boundSettings]) {
      agentSettings.content = content
      expect(decide(draftCommand)).toEqual({ deny: false, kind: 'script-exception' })
    }
  })

  itPositive('an unbound gate still verifies recipients first on no other path: the deny is the binding one', () => {
    agentSettings.content = null
    // The binding deny wins even for an unverified recipient: without the py
    // gate bound, no approval-level enforcement exists at all, so the call must
    // not slip through to a narrower wording.
    expect(decide(command.replace('verified@', 'unknown@'))).toMatchObject({ deny: true, kind: 'approval-gate-unbound' })
  })

  itPositive('MAIN_AGENT_ID resolves the home settings file, same fail-closed rule', () => {
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

describe('gate-reserved flags invalidate the exception entry', () => {
  for (const flag of ['--bcc', '--reply-to', '--from', '--sender', '--return-path', '--envelope-sha256']) {
    for (const list of ['valueArgs', 'repeatableArgs', 'booleanArgs'] as const) {
      it(`${list} containing '${flag}' is invalid`, () => {
        expect(validAgentSendException({ ...entry, [list]: [...entry[list], flag] })).toBe(false)
      })
    }
  }
  it('the clean entry still validates', () => {
    expect(validAgentSendException(entry)).toBe(true)
  })
  it('the reader drops the invalid entry and keeps valid siblings', () => {
    file.content = JSON.stringify({ agents: {
      [agentName]: { ...entry, valueArgs: [...entry.valueArgs, '--bcc'] }, '<other-agent>': entry,
    } })
    expect(readAgentSendExceptions()).toEqual({ agents: { '<other-agent>': entry } })
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
  // case[0] with the granted path swapped: every red command below keeps the
  // sanctioned shape, so only the content binding can fail it
  const commandAt = (granted: string) => corpus.cases[0].command.replaceAll('/absolute/path/to/runner.ext', granted)

  itPositive('(a) script content changed after the grant -> no exception', () => {
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
    // B1 (card f2ccb0bb R4): the other four keys valid but NO scripts key -- the py
    // twin raised KeyError on this shape (entry["scripts"]), which took the whole
    // hook down on every gated command; here, as in the fixed py validator, the
    // entry is simply invalid.
    expect(validAgentSendException({ modes: entry.modes, valueArgs: entry.valueArgs, repeatableArgs: entry.repeatableArgs, booleanArgs: entry.booleanArgs })).toBe(false)
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


describe('loader scan shared corpus', () => {
  for (const c of loaderCorpus.cases) it(c.name, () => {
    expect(scriptSourceLoadsOnlyBuiltins(Buffer.from(c.source, 'utf8'))).toBe(c.allowed)
  })
  it('rejects invalid UTF-8', () => {
    expect(scriptSourceLoadsOnlyBuiltins(Uint8Array.from([0xff, 0xfe]))).toBe(false)
  })
})

describe('script path writability', () => {
  it('finds a real writable temp file', () => {
    accessProbe.mode = 'real'
    expect(scriptPathWritable(scriptFile)).toBe(true)
  })
  it('checks root itself exactly once', () => {
    accessProbe.mode = 'real'
    let writable = true
    try { accessSync('/', constants.W_OK) } catch { writable = false }
    expect(scriptPathWritable('/')).toBe(writable)
  })
  it.skipIf(process.getuid?.() === 0)('accepts an unwritable system path on Linux', () => {
    accessProbe.mode = 'real'
    expect(scriptPathWritable(realpathSync('/usr/bin/env'))).toBe(false)
  })
  if (process.getuid?.() === 0) console.log('SKIP: unwritable system path check runs as root')
  it('fails closed on an unknown permission probe error', () => {
    accessProbe.errorCode = 'ENOENT'
    expect(scriptPathWritable(scriptFile)).toBe(true)
    expect(agentScriptException(command, agentName, config)).toBeNull()
  })
  it('treats EACCES, EPERM and EROFS as unwritable and fails closed on any other probe error', () => {
    for (const [code, expected] of [
      ['EACCES', false], ['EPERM', false], ['EROFS', false],
      ['ENOENT', true], ['EIO', true], ['ELOOP', true],
    ] as const) {
      accessProbe.errorCode = code
      expect(scriptPathWritable(scriptFile)).toBe(expected)
    }
  })
  itPositive('a root runner never gets the exception', () => {
    accessProbe.mode = 'stub'
    accessProbe.writablePath = null
    accessProbe.errorCode = 'EACCES'
    const geteuid = vi.spyOn(process, 'geteuid').mockReturnValue(1000)
    try {
      expect(scriptPathWritable(scriptFile)).toBe(false)
      expect(agentScriptException(command, agentName, config)).not.toBeNull()
      geteuid.mockReturnValue(0)
      expect(scriptPathWritable(scriptFile)).toBe(true)
      expect(agentScriptException(command, agentName, config)).toBeNull()
    } finally {
      geteuid.mockRestore()
    }
  })
  itPositive('refuses a symlinked path even when nothing is writable', () => {
    const targetParent = mkdtempSync(join(tmpdir(), 'agent-send-target-'))
    const target = join(targetParent, 'real')
    const linkDir = mkdtempSync(join(tmpdir(), 'agent-send-link-'))
    try {
      mkdirSync(target)
      writeFileSync(join(target, 'runner.ext'), scriptBody)
      symlinkSync(target, join(linkDir, 'via'))
      const viaPath = join(linkDir, 'via', 'runner.ext')
      const viaConfig = withScripts([{ path: viaPath, sha256: scriptSha }])
      const viaCommand = command.replaceAll(scriptFile, viaPath)
      expect(viaCommand).not.toBe(command)
      accessProbe.mode = 'stub'
      // positive control: nothing writable -> the real path grant matches
      const realPath = join(realpathSync(target), 'runner.ext')
      expect(agentScriptException(command.replaceAll(scriptFile, realPath), agentName,
        withScripts([{ path: realPath, sha256: scriptSha }]))).not.toBeNull()
      expect(scriptPathWritable(viaPath)).toBe(true)
      expect(agentScriptException(viaCommand, agentName, viaConfig)).toBeNull()
    } finally {
      rmSync(linkDir, { recursive: true, force: true })
      rmSync(targetParent, { recursive: true, force: true })
    }
  })
  it('fails closed when the real path cannot be resolved', () => {
    accessProbe.mode = 'stub'
    expect(scriptPathWritable(join(scriptDir, 'missing-dir', 'x.ext'))).toBe(true)
  })
  for (const path of [scriptFile, scriptDir]) it(`refuses writable path component: ${path}`, () => {
    accessProbe.writablePath = path
    expect(agentScriptException(command, agentName, config)).toBeNull()
  })
})

describe('loader and reserved envelope digest enforcement', () => {
  it('refuses hash-matching content that loads a local module', () => {
    const source = "require('./lib.js');"
    try {
      writeFileSync(scriptFile, source)
      const unsafe = { agents: { [agentName]: { ...entry, scripts: [{ path: scriptFile,
        sha256: createHash('sha256').update(source).digest('hex') }] } } }
      expect(agentScriptException(command, agentName, unsafe)).toBeNull()
    } finally { writeFileSync(scriptFile, scriptBody) }
  })
  for (const list of ['valueArgs', 'repeatableArgs', 'booleanArgs'] as const) {
    it(`rejects the reserved flag in ${list}`, () => {
      expect(validAgentSendException({ ...entry, [list]: [...entry[list], '--envelope-sha256'] })).toBe(false)
    })
  }
  itPositive('returns the valid send digest and keeps drafts unbound', () => {
    expect(agentScriptException(command, agentName, config).envelopeSha256).toBe('a'.repeat(64))
    expect(agentScriptException(draftCommand, agentName, config)).not.toHaveProperty('envelopeSha256')
  })
})

describe('Node permission runtime and optional readFiles', () => {
  itPositive('accepts only regular or missing read grants', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-send-read-grants-')))
    try {
      const body = join(dir, 'body.txt')
      const attachment = join(dir, 'attachment.bin')
      const extra = join(dir, 'extra.json')
      const directoryLink = join(dir, 'directory-link')
      const fileLink = join(dir, 'file-link')
      writeFileSync(body, 'Example body')
      writeFileSync(attachment, 'Example attachment')
      writeFileSync(extra, '{}')
      symlinkSync(dir, directoryLink)
      symlinkSync(body, fileLink)
      mkdirSync(join(dir, 'sub', 'sub2'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'body.txt'), 'Subdirectory body')
      symlinkSync(join(dir, 'sub', 'sub2'), join(dir, 'sublink'))
      const boundDraft = (bodyPath = body, attachmentPath = attachment) => draftCommand
        .replaceAll('/absolute/path/to/body.txt', bodyPath)
        .replaceAll('/absolute/path/to/attachment.bin', attachmentPath)
      expect(agentScriptException(boundDraft(), agentName, config)).not.toBeNull()
      expect(agentScriptException(boundDraft(dir), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft('/'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(body, directoryLink), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(fileLink), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(dir + '/missing-parent/..'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(dir + '/./body.txt'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(dir + '//body.txt'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(body + '/'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(dir + '/sublink/../body.txt'), agentName, config)).toBeNull()
      expect(agentScriptException(boundDraft(join(dir, 'missing.txt')), agentName, config)).not.toBeNull()
      for (const [readFile, accepted] of [[dir, false], [extra, true]] as const) {
        const cfg = { agents: { [agentName]: { ...entry, readFiles: [readFile] } } }
        const cmd = boundDraft().replace(' --permission ', ` --permission --allow-fs-read=${readFile} `)
        expect(Boolean(agentScriptException(cmd, agentName, cfg))).toBe(accepted)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('probes the executable selected by the shell PATH without collapsing symlink parents', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-send-node-path-')))
    const previousPath = process.env.PATH
    accessProbe.mode = 'real'
    try {
      mkdirSync(join(dir, 'bin'))
      mkdirSync(join(dir, 'real', 'bin'), { recursive: true })
      mkdirSync(join(dir, 'real', 'sub'))
      writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\ntouch '${dir}/ran'\necho v22.22.2\n`, { mode: 0o755 })
      writeFileSync(join(dir, 'real', 'bin', 'node'), `#!/bin/sh\ntouch '${dir}/ran'\necho v20.0.0\n`, { mode: 0o755 })
      symlinkSync(join(dir, 'real', 'sub'), join(dir, 'link'))
      for (const [path, resolved] of [
        [`${dir}/bin`, `${dir}/bin/node`],
        [`${dir}/link/../bin`, `${dir}/link/../bin/node`],
        [`relative-dir:${dir}/bin`, null],
        [`:${dir}/bin`, null],
        [`${dir}/nonexistent:${dir}/bin`, `${dir}/bin/node`],
      ] as const) {
        process.env.PATH = path
        expect(resolveNodeInterpreter('node'), path).toBe(resolved)
        expect(probeNodeVersion('node'), path).toBeNull() // a writable temp interpreter is never trusted
      }
      expect(probeNodeVersion(`${dir}/bin/node`)).toBeNull() // an absolute interpreter is held to the same rule
      expect(existsSync(join(dir, 'ran'))).toBe(false) // and is never executed
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a writable node earlier on PATH loses the exception and is never run', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-send-node-planted-')))
    const previousPath = process.env.PATH
    try {
      mkdirSync(join(dir, 'bin'))
      writeFileSync(join(dir, 'bin', 'node'), `#!/bin/sh\ntouch '${dir}/ran'\necho v22.22.2\n`, { mode: 0o755 })
      process.env.PATH = `${dir}/bin:${previousPath ?? '/usr/bin:/bin'}`
      // Real file system first: the planted interpreter really is writable.
      accessProbe.mode = 'real'
      expect(resolveNodeInterpreter('node')).toBe(`${dir}/bin/node`)
      expect(scriptPathWritable(`${dir}/bin/node`)).toBe(true)
      // Then the stub: ONLY the planted node is writable, the granted script is not, so a refusal below
      // can only come from the interpreter check (with the real file system the temp script itself is
      // writable and would hide the result).
      accessProbe.mode = 'stub'
      accessProbe.writablePath = `${dir}/bin/node`
      expect(resolveNodeInterpreter('node')).toBe(`${dir}/bin/node`)
      setNodeVersionProbeOverride(null)
      expect(agentScriptException(command, agentName, config)).toBeNull()
      expect(existsSync(join(dir, 'ran'))).toBe(false)
      // Positive control: the same command with a trusted runtime still gets the exception on Linux.
      setNodeVersionProbeOverride(() => 'v22.22.2')
      expect(Boolean(agentScriptException(command, agentName, config))).toBe(SEND_EXCEPTION_PLATFORM)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
  for (const [version, expected] of [
    ['v22.13.0', true], ['v22.12.9', false], ['v23.5.0', true], ['v23.4.0', false],
    ['v24.0.0', true], ['v21.9.9', false], ['v20.18.0', false], ['22.13.0', false],
    ['v22.13', false], ['', false], ['v22.13.0\nextra', false],
  ] as const) it(`version ${JSON.stringify(version)}`, () => {
    expect(nodePermissionVersionOk(version)).toBe(expected)
  })
  for (const version of ['v22.12.0', null]) it(`refuses runtime ${version}`, () => {
    setNodeVersionProbeOverride(() => version)
    expect(agentScriptException(command, agentName, config)).toBeNull()
  })
  itPositive('probes only after every other check', () => {
    const probe = vi.fn(() => 'v22.22.2')
    setNodeVersionProbeOverride(probe)
    expect(agentScriptException(command + ' --unknown value', agentName, config)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    expect(agentScriptException(command, agentName, config)).not.toBeNull()
    expect(probe).toHaveBeenCalledWith('node')
  })
  it('fails closed on macOS', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(agentScriptException(command, agentName, config)).toBeNull()
      for (const c of cases.filter(c => c.match)) {
        expect(agentScriptException(c.command, agentName, config), c.name).toBeNull()
      }
    } finally { Object.defineProperty(process, 'platform', platform) }
  })
  it('real probe returns the Node version when node is on PATH', async ctx => {
    // accessSync is mocked for the script permission tests; use real fs for this control.
    accessProbe.mode = 'real'
    const resolved = resolveNodeInterpreter('node')
    if (!resolved) { ctx.skip(); return }
    if (scriptPathWritable(resolved)) expect(probeNodeVersion('node')).toBeNull()
    else expect(probeNodeVersion('node')).toMatch(/^v\d+\.\d+\.\d+$/)
  })
  it('validates optional readFiles', () => {
    const { readFiles: _, ...absent } = entry
    expect(validAgentSendException(absent)).toBe(true)
    for (const readFiles of [[], ['/a', '/b']]) expect(validAgentSendException({ ...entry, readFiles })).toBe(true)
    for (const readFiles of [['relative'], ['/a', '/a'], [1], '/a', [''], '/']) {
      expect(validAgentSendException({ ...entry, readFiles })).toBe(false)
    }
  })
})
