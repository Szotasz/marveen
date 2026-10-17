/**
 * The validator and the merge of install-local extra hook entries
 * (src/web/extra-hook-entries.ts), on fake builders and a throwaway project
 * root. The wiring into the generated settings is extra-hook-entries-wiring.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import {
  EXTRA_HOOK_MARK, applyExtraHookEntries, isExtraHookGroup, loadExtraHookEntries, parseExtraHookEntries,
  type ExtraHookDeps, type ExtraHookEntry,
} from '../web/extra-hook-entries.js'

let root: string
let outside: string
let deps: ExtraHookDeps

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'extra-hooks-root-'))
  outside = mkdtempSync(join(tmpdir(), 'extra-hooks-outside-'))
  mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(root, 'local-hooks'), { recursive: true })
  for (const f of ['egress-gate.mjs', 'destructive-gate.py']) writeFileSync(join(root, 'scripts', 'hooks', f), '')
  writeFileSync(join(root, 'scripts', 'self-pace-gate.mjs'), '')
  mkdirSync(join(root, 'scripts', 'lib'))
  writeFileSync(join(root, 'scripts', 'lib', 'local.py'), '')
  for (const f of ['gate.py', 'log.mjs', 'tool.sh']) writeFileSync(join(root, 'local-hooks', f), '')
  writeFileSync(join(outside, 'evil.py'), '')
  deps = {
    projectRoot: root,
    shippedScriptsDir: join(root, 'scripts'),
    nodeBin: '/opt/node/bin/node',
    nodeGateCommand: (p, t) => `NODEGATE(${p},${t})`,
    pythonGateCommand: (p, t) => `PYGATE(${p},${t})`,
    isUnsafe: (c) => c.includes('/unsafe/'),
  }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const ok = { event: 'PreToolUse', matcher: 'Bash', script: 'local-hooks/gate.py', failClosed: true }
const one = (e: Record<string, unknown>) => parseExtraHookEntries({ entries: [e] }, deps)

describe('rendering', () => {
  it('a fail-closed .py entry uses the python gate builder behind the marker', () => {
    const r = one({ ...ok, timeout: 30 })
    expect(r.errors).toEqual([])
    expect(r.entries).toEqual([{
      event: 'PreToolUse', matcher: 'Bash', timeout: 30,
      command: `${EXTRA_HOOK_MARK} PYGATE(${join(root, 'local-hooks', 'gate.py')},30)`,
    }])
  })

  it('a fail-closed .mjs entry uses the node gate builder; the default timeout is 10', () => {
    const r = one({ ...ok, script: 'local-hooks/log.mjs' })
    expect(r.entries[0].command).toBe(`${EXTRA_HOOK_MARK} NODEGATE(${join(root, 'local-hooks', 'log.mjs')},10)`)
    expect(r.entries[0].timeout).toBe(10)
  })

  it('a non-fail-closed entry is a plain interpreter call; matcher is optional', () => {
    const py = one({ event: 'Stop', script: 'local-hooks/gate.py', failClosed: false })
    expect(py.entries[0]).toEqual({ event: 'Stop', timeout: 10, command: `${EXTRA_HOOK_MARK} python3 "${join(root, 'local-hooks', 'gate.py')}"` })
    const js = one({ event: 'PostToolUse', script: 'local-hooks/log.mjs', failClosed: false })
    expect(js.entries[0].command).toBe(`${EXTRA_HOOK_MARK} "/opt/node/bin/node" "${join(root, 'local-hooks', 'log.mjs')}"`)
  })
})

describe('validation: every rejection names the entry and adds nothing', () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an absolute path', { ...ok, script: join(root ?? '/x', 'local', 'gate.py') }, /plain relative path/],
    ['a .. segment', { ...ok, script: 'local-hooks/../local/gate.py' }, /plain relative path/],
    ['shell metacharacters', { ...ok, script: 'local-hooks/$(id).py' }, /plain relative path/],
    ['a space', { ...ok, script: 'local-hooks/a b.py' }, /plain relative path/],
    ['an unsupported extension', { ...ok, script: 'local-hooks/tool.sh' }, /\.py, \.mjs or \.js/],
    ['a missing file', { ...ok, script: 'local-hooks/nope.py' }, /does not exist/],
    ['a shipped hook script', { ...ok, script: 'scripts/hooks/destructive-gate.py' }, /shipped script name destructive-gate\.py/],
    ['any file under scripts/', { ...ok, script: 'scripts/lib/local.py' }, /must live in local-hooks\//],
    ["a script in an agent's own directory (the agent can write it)", { ...ok, script: 'agents/agent-a/x.py' }, /must live in local-hooks\//],
    ['a name that contains a shipped hook file name', { ...ok, script: 'local-hooks/my-egress-gate.mjs' }, /shipped script name egress-gate\.mjs/],
    ['a name that contains a gate living in scripts/', { ...ok, script: 'local-hooks/x-self-pace-gate.mjs' }, /shipped script name self-pace-gate\.mjs/],
    ['a matcher that contains a shipped hook file name', { ...ok, matcher: 'Bash|egress-gate.mjs' }, /shipped script name/],
    ['an unknown key', { ...ok, failclosed: true }, /unknown key/],
    ['failClosed missing', { event: 'PreToolUse', script: 'local-hooks/gate.py' }, /failClosed must be set/],
    ['failClosed outside PreToolUse', { ...ok, event: 'UserPromptSubmit' }, /only allowed on PreToolUse/],
    ['an unknown event', { ...ok, event: 'PreToolUsee' }, /event must be one of/],
    ['a scope this version does not wire', { ...ok, scope: 'main' }, /scope must be "subagents"/],
    ['a timeout out of range', { ...ok, timeout: 0 }, /timeout must be/],
    ['a fractional timeout', { ...ok, timeout: 1.5 }, /timeout must be/],
    ['an invalid regular expression', { ...ok, matcher: '(' }, /not a valid regular expression/],
    ['an empty matcher', { ...ok, matcher: '' }, /matcher must be/],
  ]
  for (const [label, entry, why] of bad) {
    it(label, () => {
      const r = one(entry)
      expect(r.entries).toEqual([])
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatch(/^entries\[0\]: /)
      expect(r.errors[0]).toMatch(why)
    })
  }

  it('a symlink that leaves the project root is refused', () => {
    symlinkSync(join(outside, 'evil.py'), join(root, 'local-hooks', 'link.py'))
    const r = one({ ...ok, script: 'local-hooks/link.py' })
    expect(r.entries).toEqual([])
    expect(r.errors[0]).toMatch(/resolves outside local-hooks\//)
  })

  it('a symlink from local-hooks/ into an agent directory is refused', () => {
    mkdirSync(join(root, 'agents', 'agent-a'), { recursive: true })
    writeFileSync(join(root, 'agents', 'agent-a', 'x.py'), '')
    symlinkSync(join(root, 'agents', 'agent-a', 'x.py'), join(root, 'local-hooks', 'via-link.py'))
    const r = one({ ...ok, script: 'local-hooks/via-link.py' })
    expect(r.entries).toEqual([])
    expect(r.errors[0]).toMatch(/resolves outside local-hooks\//)
  })

  it('a local-hooks/ directory that is itself a symlink into an agent directory is refused', () => {
    rmSync(join(root, 'local-hooks'), { recursive: true })
    mkdirSync(join(root, 'agents', 'agent-a'), { recursive: true })
    writeFileSync(join(root, 'agents', 'agent-a', 'gate.py'), '')
    symlinkSync(join(root, 'agents', 'agent-a'), join(root, 'local-hooks'))
    const r = one(ok)
    expect(r.entries).toEqual([])
    expect(r.errors[0]).toMatch(/resolves outside local-hooks\//)
  })

  it('the registration guard of the built-in gates is applied to the rendered command', () => {
    mkdirSync(join(root, 'local-hooks', 'unsafe'))
    writeFileSync(join(root, 'local-hooks', 'unsafe', 'g.py'), '')
    const r = one({ ...ok, script: 'local-hooks/unsafe/g.py' })
    expect(r.entries).toEqual([])
    expect(r.errors[0]).toMatch(/registration guard/)
  })

  it('one bad entry does not take the good ones with it', () => {
    const r = parseExtraHookEntries({ entries: [{ ...ok, event: 'X' }, ok] }, deps)
    expect(r.entries).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/^entries\[0\]/)
  })

  it('a file of the wrong shape adds nothing', () => {
    for (const raw of [null, [], 'x', { entries: {} }, { hooks: [ok] }]) {
      const r = parseExtraHookEntries(raw, deps)
      expect(r.entries).toEqual([])
      expect(r.errors).toHaveLength(1)
    }
  })
})

describe('loading the file', () => {
  it('missing or blank: no entries and no error', () => {
    expect(loadExtraHookEntries(join(root, 'none.json'), deps)).toEqual({ entries: [], errors: [] })
    writeFileSync(join(root, 'blank.json'), '\n  \n')
    expect(loadExtraHookEntries(join(root, 'blank.json'), deps)).toEqual({ entries: [], errors: [] })
  })

  it('not JSON: no entries, one error', () => {
    writeFileSync(join(root, 'bad.json'), '{ entries: ')
    const r = loadExtraHookEntries(join(root, 'bad.json'), deps)
    expect(r.entries).toEqual([])
    expect(r.errors[0]).toMatch(/not valid JSON/)
  })
})

describe('merging into a settings object', () => {
  const builtin = () => ({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'GATE-A', timeout: 10 }] },
        { matcher: 'WebFetch', hooks: [{ type: 'command', command: 'GATE-B', timeout: 10 }] },
      ],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'UPS', timeout: 10 }] }],
    },
  })
  const e = (event: string, command: string, matcher?: string): ExtraHookEntry =>
    ({ event, command: `${EXTRA_HOOK_MARK} ${command}`, timeout: 10, ...(matcher ? { matcher } : {}) })

  it('no entries and no earlier extras: unchanged, not even re-serialized differently', () => {
    const s = builtin()
    const before = JSON.stringify(s, null, 2)
    expect(applyExtraHookEntries(s, [])).toBe(false)
    expect(JSON.stringify(s, null, 2)).toBe(before)
    const bare: Record<string, unknown> = { permissions: {} }
    expect(applyExtraHookEntries(bare, [])).toBe(false)
    expect('hooks' in bare).toBe(false)
  })

  it('appends after the built-ins of the same event and keeps the built-ins in order', () => {
    const s = builtin()
    expect(applyExtraHookEntries(s, [e('PreToolUse', 'X1', 'Bash'), e('Notification', 'X2')])).toBe(true)
    const ptu = s.hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>
    expect(ptu.map((g) => g.hooks[0].command)).toEqual(['GATE-A', 'GATE-B', `${EXTRA_HOOK_MARK} X1`])
    expect((s.hooks as Record<string, unknown>).Notification).toEqual([{ hooks: [{ type: 'command', command: `${EXTRA_HOOK_MARK} X2`, timeout: 10 }] }])
  })

  it('is idempotent, and an extra moved in front of a built-in goes back to the end', () => {
    const s = builtin()
    applyExtraHookEntries(s, [e('PreToolUse', 'X1', 'Bash')])
    expect(applyExtraHookEntries(s, [e('PreToolUse', 'X1', 'Bash')])).toBe(false)
    const ptu = s.hooks.PreToolUse
    ptu.unshift(ptu.pop()!)
    expect(applyExtraHookEntries(s, [e('PreToolUse', 'X1', 'Bash')])).toBe(true)
    const after = s.hooks.PreToolUse
    expect(after.map((g) => g.hooks[0].command)).toEqual(['GATE-A', 'GATE-B', `${EXTRA_HOOK_MARK} X1`])
  })

  it('removing the entries removes only marked groups and gives back the original bytes', () => {
    const s = builtin()
    const original = JSON.stringify(s, null, 2)
    applyExtraHookEntries(s, [e('PreToolUse', 'X1', 'Bash'), e('Notification', 'X2')])
    expect(applyExtraHookEntries(s, [])).toBe(true)
    expect(JSON.stringify(s, null, 2)).toBe(original)
  })

  it('a group is ours only when EVERY handler carries the marker', () => {
    expect(isExtraHookGroup({ hooks: [{ command: `${EXTRA_HOOK_MARK} a` }] })).toBe(true)
    expect(isExtraHookGroup({ hooks: [{ command: `${EXTRA_HOOK_MARK} a` }, { command: 'GATE-A' }] })).toBe(false)
    expect(isExtraHookGroup({ hooks: [{ command: `x ${EXTRA_HOOK_MARK}` }] })).toBe(false)
    expect(isExtraHookGroup({ hooks: [] })).toBe(false)
    expect(isExtraHookGroup({})).toBe(false)
  })

  it('an event value that is not an array is never overwritten', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: { odd: true } } }
    expect(applyExtraHookEntries(s, [e('PreToolUse', 'X1')])).toBe(false)
    expect(s.hooks).toEqual({ PreToolUse: { odd: true } })
  })

  it('a hooks value that is not an object is left alone', () => {
    const s: Record<string, unknown> = { hooks: ['odd'] }
    expect(applyExtraHookEntries(s, [e('PreToolUse', 'X1')])).toBe(false)
    expect(s.hooks).toEqual(['odd'])
  })
})

describe('a sub-agent cannot write the extras file or the scripts it names (self-pace gate)', () => {
  const decide = (tool: string, input: Record<string, unknown>) =>
    gateDecision(tool, input, { allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd: root })

  it.each(['Write', 'Edit', 'MultiEdit'])('%s on store/extra-hooks.json is denied', (tool) => {
    expect(decide(tool, { file_path: join(root, 'store', 'extra-hooks.json'), content: '{}' }).deny).toBe(true)
    expect(decide(tool, { file_path: 'store/extra-hooks.json', content: '{}' }).deny).toBe(true)
  })

  it('Write into local-hooks/ is denied, by relative, absolute and symlinked path', () => {
    expect(decide('Write', { file_path: 'local-hooks/new.py', content: 'x' }).deny).toBe(true)
    expect(decide('Write', { file_path: join(root, 'local-hooks', 'gate.py'), content: 'x' }).deny).toBe(true)
    symlinkSync(join(root, 'local-hooks', 'gate.py'), join(root, 'innocent.py'))
    expect(decide('Edit', { file_path: join(root, 'innocent.py') }).deny).toBe(true)
  })

  it.each([
    "echo '{}' > store/extra-hooks.json",
    'cp /x/e.json store/extra-hooks.json',
    "python3 -c \"open('store/extra-hooks.json','w').write('{}')\"",
    'cp /x/evil.py local-hooks/gate.py',
    "echo 'import os' > local-hooks/gate.py",
    'cd local-hooks && touch x.py',
    'ln -s /x/evil.py local-hooks/evil.py',
  ])('Bash write is denied: %s', (command) => {
    expect(decide('Bash', { command }).deny).toBe(true)
  })

  it.each([
    'cat store/extra-hooks.json',
    'ls local-hooks/',
    'grep -n failClosed store/extra-hooks.json',
    'echo x > notes.txt',
    'cp a.py agents-local/b.py',
  ])('a read, or an unrelated write, is allowed: %s', (command) => {
    expect(decide('Bash', { command }).deny).toBe(false)
  })

  it('another file in store/ and a file outside local-hooks/ are not affected', () => {
    expect(decide('Write', { file_path: join(root, 'store', 'other.json'), content: '{}' }).deny).toBe(false)
    expect(decide('Write', { file_path: join(root, 'notes', 'x.py'), content: '' }).deny).toBe(false)
  })
})
