/**
 * Install-local extra hook entries (store/extra-hooks.json) in a sub-agent's
 * generated settings.json, asserted on the FINAL file (same method as
 * credential-gate-wiring.test.ts).
 *
 * The properties this suite exists for:
 *   - no file / a blank file / an empty list renders a settings.json that is
 *     byte-identical to a scaffold that has never heard of extras;
 *   - a valid entry is APPENDED after the built-in gates of its event, and
 *     removing the entry minus nothing else gives back the no-extras bytes;
 *   - an invalid file adds nothing and leaves every built-in gate in place;
 *   - the startup migration adds, updates and removes extras on an existing
 *     agent, and never touches the main agent;
 *   - hook-load-watch probes an extra like any other PreToolUse command, and
 *     boot-hook-prune keeps it while its script exists.
 *
 * Only modules that exist without this change are imported, so the file runs
 * against a base without the feature and shows which cases are new.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as scaffold from '../web/agent-scaffold.js'
import { writeAgentSettingsFromProfile, agentSettingsPath, GATE_FAIL_CLOSED_TAG } from '../web/agent-scaffold.js'
import { loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'
import { logger } from '../logger.js'

const TEST_AGENT = 'extra-hooks-probe'
const MARK = ': extra-hook;'
const agentRoot = join(AGENTS_BASE_DIR, TEST_AGENT)
const settingsPath = () => agentSettingsPath(TEST_AGENT)
const configPath = join(agentRoot, 'extra-hooks.json')
const missingConfig = join(agentRoot, 'no-such-extra-hooks.json')
// Extras live in <root>/local-hooks/ only; the probe files carry the test's name
// and are removed again (the directory too, if this suite created it).
const hooksDir = join(PROJECT_ROOT, 'local-hooks')
const gateRel = `local-hooks/${TEST_AGENT}-post-gate.py`
const logRel = `local-hooks/${TEST_AGENT}-action-log.py`
let createdHooksDir = false

// Through the namespace: a base without the feature has no such export.
const ensureExtra = (name: string, path?: string): boolean =>
  (scaffold as unknown as { ensureExtraHookEntries: (n: string, p?: string) => boolean }).ensureExtraHookEntries(name, path)

function cleanup(): void {
  for (const rel of [gateRel, logRel]) rmSync(join(PROJECT_ROOT, rel), { force: true })
  if (createdHooksDir && existsSync(hooksDir) && readdirSync(hooksDir).length === 0) rmSync(hooksDir, { recursive: true })
  if (!existsSync(agentRoot)) return
  if (!agentRoot.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${agentRoot}`)
  if (existsSync(join(agentRoot, 'CLAUDE.md')) || existsSync(join(agentRoot, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${agentRoot} looks like a live agent, not a test checkout`)
  }
  rmSync(agentRoot, { recursive: true, force: true })
}

function writeScripts(): void {
  if (!existsSync(hooksDir)) { mkdirSync(hooksDir); createdHooksDir = true }
  writeFileSync(join(PROJECT_ROOT, gateRel), 'import sys\nsys.stdin.read()\nsys.exit(0)\n')
  writeFileSync(join(PROJECT_ROOT, logRel), 'import sys\nsys.stdin.read()\n')
}

beforeEach(() => { cleanup(); mkdirSync(join(agentRoot, '.claude'), { recursive: true }); writeScripts() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const BASE: ProfileTemplate = loadProfileTemplate('default')

function render(extrasPath = missingConfig, fresh = true): string {
  if (fresh && existsSync(settingsPath())) rmSync(settingsPath())
  writeAgentSettingsFromProfile(TEST_AGENT, BASE, extrasPath)
  return readFileSync(settingsPath(), 'utf-8')
}

function config(entries: unknown): string {
  writeFileSync(configPath, JSON.stringify({ entries }))
  return configPath
}

const GATE = { event: 'PreToolUse', matcher: 'Bash', script: gateRel, timeout: 120, failClosed: true }
const LOG = { event: 'PostToolUse', matcher: 'Bash', script: logRel, failClosed: false }

type Group = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }
type Settings = { hooks: Record<string, Group[]> }
const parse = (s: string) => JSON.parse(s) as Settings
const isExtra = (g: Group) => g.hooks.every((h) => h.command.startsWith(MARK))
const extras = (s: string) => Object.entries(parse(s).hooks).flatMap(([ev, gs]) => gs.filter(isExtra).map((g) => ({ ev, g })))
function withoutExtras(s: string): string {
  const o = parse(s)
  for (const ev of Object.keys(o.hooks)) {
    o.hooks[ev] = o.hooks[ev].filter((g) => !isExtra(g))
    if (o.hooks[ev].length === 0) delete o.hooks[ev]
  }
  return JSON.stringify(o, null, 2)
}

describe('absent, blank or empty: byte-identical to a render without extras', () => {
  it('no file, a blank file and {"entries": []} render the same bytes, with no marked entry', () => {
    const absent = render(missingConfig)
    writeFileSync(configPath, '  \n')
    const blank = render(configPath)
    const empty = render(config([]))
    expect(blank).toBe(absent)
    expect(empty).toBe(absent)
    expect(absent).not.toContain(MARK)
  })

  it('the startup migration leaves an agent without extras byte-identical', () => {
    const before = render(missingConfig)
    expect(ensureExtra(TEST_AGENT, missingConfig)).toBe(false)
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before)
  })
})

describe('a valid entry is appended after the built-ins and changes nothing else', () => {
  it('a fail-closed PreToolUse gate lands LAST in PreToolUse, wrapped like the built-in gates', () => {
    const off = parse(render(missingConfig))
    const on = parse(render(config([GATE])))
    const ptu = on.hooks.PreToolUse
    expect(ptu.slice(0, -1)).toEqual(off.hooks.PreToolUse)
    const last = ptu[ptu.length - 1]
    expect(last.matcher).toBe('Bash')
    expect(last.hooks[0].timeout).toBe(120)
    const cmd = last.hooks[0].command
    expect(cmd.startsWith(MARK)).toBe(true)
    expect(cmd).toContain('command -v python3')
    expect(cmd).toContain(GATE_FAIL_CLOSED_TAG)
    expect(cmd).toContain('timeout -k 1 118 ')
    expect(cmd).toContain(`"${join(PROJECT_ROOT, gateRel)}"`)
  })

  it('a non-gate entry is a plain call on its own event, no fail-closed tail', () => {
    const on = render(config([LOG]))
    const found = extras(on)
    expect(found).toHaveLength(1)
    expect(found[0].ev).toBe('PostToolUse')
    expect(found[0].g.hooks[0].command).toBe(`${MARK} python3 "${join(PROJECT_ROOT, logRel)}"`)
    expect(found[0].g.hooks[0].timeout).toBe(10)
  })

  it('ON minus the extras equals OFF, byte for byte', () => {
    const off = render(missingConfig)
    const on = render(config([GATE, LOG]))
    expect(withoutExtras(on)).toBe(off)
  })

  it('a re-render keeps exactly one copy of each extra', () => {
    render(config([GATE, LOG]))
    expect(extras(render(configPath, false))).toHaveLength(2)
  })
})

describe('an invalid file never breaks or weakens the built-in hooks', () => {
  it('a file that is not JSON adds nothing, logs at error level, and the built-ins are intact', () => {
    const spy = vi.spyOn(logger, 'error')
    const off = render(missingConfig)
    writeFileSync(configPath, '{ "entries": [ broken')
    expect(render(configPath)).toBe(off)
    expect(spy).toHaveBeenCalled()
    expect(JSON.stringify(spy.mock.calls)).toContain('extra-hooks.json')
  })

  it('an invalid entry is skipped on its own; the valid one is still applied', () => {
    const spy = vi.spyOn(logger, 'error')
    const on = render(config([{ ...GATE, script: '/tmp/x.py' }, LOG]))
    expect(extras(on)).toHaveLength(1)
    expect(extras(on)[0].ev).toBe('PostToolUse')
    expect(JSON.stringify(spy.mock.calls)).toContain('entries[0]')
  })

  it("a script in a sub-agent's own directory is refused (that agent could rewrite it)", () => {
    const off = render(missingConfig)
    writeFileSync(join(agentRoot, 'own.py'), 'import sys\nsys.exit(0)\n')
    expect(render(config([{ ...LOG, script: `agents/${TEST_AGENT}/own.py` }]))).toBe(off)
  })

  it('an entry naming a shipped hook script is refused, so the built-in gate keeps its single entry', () => {
    const off = render(missingConfig)
    const on = render(config([{ ...GATE, script: 'scripts/hooks/egress-gate.mjs', failClosed: false }]))
    expect(on).toBe(off)
    expect(parse(on).hooks.PreToolUse.filter((g) => JSON.stringify(g).includes('egress-gate.mjs'))).toHaveLength(1)
  })
})

describe('the startup migration on an existing sub-agent', () => {
  it('adds the extras, is a no-op on a second pass, and removes them when the file is emptied', () => {
    const before = render(missingConfig)
    config([GATE, LOG])
    expect(ensureExtra(TEST_AGENT, configPath)).toBe(true)
    expect(extras(readFileSync(settingsPath(), 'utf-8'))).toHaveLength(2)
    expect(ensureExtra(TEST_AGENT, configPath)).toBe(false)
    config([])
    expect(ensureExtra(TEST_AGENT, configPath)).toBe(true)
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before)
  })

  it('moves an extra back behind a built-in gate that a backfill re-appended after it', () => {
    render(config([GATE]))
    const s = parse(readFileSync(settingsPath(), 'utf-8'))
    const ptu = s.hooks.PreToolUse
    const extra = ptu.pop() as Group
    ptu.splice(0, 0, extra) // simulate: the extra now sits BEFORE the built-ins
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
    expect(ensureExtra(TEST_AGENT, configPath)).toBe(true)
    const after = parse(readFileSync(settingsPath(), 'utf-8')).hooks.PreToolUse
    expect(isExtra(after[after.length - 1])).toBe(true)
    expect(after.filter(isExtra)).toHaveLength(1)
  })

  it('never writes the main agent', () => {
    config([GATE])
    expect(ensureExtra(MAIN_AGENT_ID, configPath)).toBe(false)
  })
})

describe('the out-of-process watchers treat an extra like any other hook', () => {
  function fixtureRoot(agentSettings: string): string {
    const root = mkdtempSync(join(tmpdir(), 'extra-hooks-watch-'))
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{}')
    mkdirSync(join(root, 'agents', 'agent-a', '.claude'), { recursive: true })
    writeFileSync(join(root, 'agents', 'agent-a', '.claude', 'settings.json'), agentSettings)
    return root
  }

  it('hook-load-watch probes a fail-closed extra: OK when it loads, a finding when it is broken', () => {
    const on = render(config([GATE]))
    const root = fixtureRoot(on)
    try {
      const run = () => spawnSync('python3', [join(PROJECT_ROOT, 'scripts', 'hook-load-watch.py'), '--check'], {
        env: { ...process.env, HOOK_LOAD_WATCH_ROOT: root, HOOK_LOAD_WATCH_STATE_DIR: root }, encoding: 'utf-8', timeout: 120_000,
      })
      const ok = run()
      const line = (ok.stdout + ok.stderr).split('\n').find((l) => l.includes('post-gate.py')) ?? ''
      expect(line).toMatch(/^.*OK\s/)
      writeFileSync(join(PROJECT_ROOT, gateRel), 'def broken(:\n')
      const bad = run()
      expect(bad.status).toBe(1)
      const badLine = (bad.stdout + bad.stderr).split('\n').find((l) => l.includes('post-gate.py')) ?? ''
      expect(badLine).toContain('CLOSED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('boot-hook-prune keeps an extra whose script exists and prunes it once the script is gone', () => {
    const on = render(config([LOG]))
    const root = fixtureRoot(on)
    const home = mkdtempSync(join(tmpdir(), 'extra-hooks-home-'))
    try {
      const prune = () => spawnSync('python3', [join(PROJECT_ROOT, 'scripts', 'boot-hook-prune.py')], {
        env: { ...process.env, HOME: home, INSTALL_DIR: root }, encoding: 'utf-8',
      })
      const agentFile = join(root, 'agents', 'agent-a', '.claude', 'settings.json')
      prune()
      expect(readFileSync(agentFile, 'utf-8')).toBe(on)
      rmSync(join(PROJECT_ROOT, logRel))
      prune()
      expect(readFileSync(agentFile, 'utf-8')).not.toContain('action-log.py')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
