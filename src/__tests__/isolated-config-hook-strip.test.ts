// #1305 (ISSUE1305HOOKSCOPE): hooks never ride the isolated-config clone.
//
// provisionIsolatedConfigDir copies ~/.claude/settings.json into every agent's
// .claude-config. Before this fix the copy carried the user-global `hooks`
// block, so every isolated dir held a second, derived copy of the fleet hooks:
// each gate fired twice per prompt (measured 2026-09-04), and the user-global
// file looked load-bearing when it was not -- hooks load from the PROJECT
// scope (tracked .claude/settings.json) by cwd, regardless of
// CLAUDE_CONFIG_DIR.
//
// Two directions are pinned:
//   - the shared file's hooks are stripped from the clone;
//   - an isolated dir that ALREADY carries old derived hooks does not get
//     them back through the target-only-key inheritance on re-provision
//     (the inheritance block runs after the strip, so without its own
//     'hooks' exclusion it would resurrect them every start).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIsolatedChannelConfigDir } from '../web/agent-process.js'
import { PROJECT_ROOT } from '../config.js'

const PROBE = 'hookstrip-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
const isolatedSettings = join(probeDir, '.claude-config', 'settings.json')

let fakeHome: string
let realHome: string | undefined

const SHARED = {
  enabledPlugins: { 'telegram@claude-plugins-official': true },
  statusLine: { type: 'command', command: 'echo shared' },
  hooks: {
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'python3 /abs/scripts/hooks/provenance-gate.py' }] },
    ],
  },
}

function readIsolated(): Record<string, unknown> {
  return JSON.parse(readFileSync(isolatedSettings, 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  realHome = process.env.HOME
  fakeHome = mkdtempSync(join(tmpdir(), 'hookstrip-'))
  process.env.HOME = fakeHome
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify(SHARED))

  if (existsSync(join(probeDir, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  }
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(probeDir, { recursive: true })
})

afterEach(() => {
  process.env.HOME = realHome
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(probeDir, { recursive: true, force: true })
})

describe('#1305: isolated-config clone strips hooks', () => {
  it('the shared hooks block does not reach the clone (other keys do)', () => {
    const cfg = ensureIsolatedChannelConfigDir(PROBE, null)
    expect(cfg).not.toBeNull()
    const settings = readIsolated()
    expect(settings.hooks).toBeUndefined()
    // Control: the copy itself still works -- shared keys arrive.
    expect(settings.statusLine).toEqual(SHARED.statusLine)
    expect(settings.enabledPlugins).toBeDefined()
  })

  it('old derived hooks in an existing isolated dir are not inherited back', () => {
    mkdirSync(join(probeDir, '.claude-config'), { recursive: true })
    writeFileSync(isolatedSettings, JSON.stringify({
      hooks: SHARED.hooks, // the pre-#1305 derived copy
      agentOnlyKey: 'must-survive',
    }))
    ensureIsolatedChannelConfigDir(PROBE, null)
    const settings = readIsolated()
    expect(settings.hooks).toBeUndefined()
    // Control: target-only inheritance itself still works for other keys --
    // the strip is surgical, not a veto on the merge.
    expect(settings.agentOnlyKey).toBe('must-survive')
  })

  it('stays hook-free on a second provision (idempotent)', () => {
    ensureIsolatedChannelConfigDir(PROBE, null)
    ensureIsolatedChannelConfigDir(PROBE, null)
    expect(readIsolated().hooks).toBeUndefined()
  })
})
