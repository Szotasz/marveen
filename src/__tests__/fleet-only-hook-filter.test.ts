import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// FLEET-ONLY GATES (2026-09-03): templates/settings.json.template seeds
// live-branch-switch-gate.py so a NEWLY scaffolded sub-agent gets the gate its six
// live siblings already had (measured gap: template 8 hooks, slarti 9).
//
// The trap this filter closes: agentSettingsPath(MAIN_AGENT_ID) resolves to the
// user-global ~/.claude/settings.json, and src/web.ts calls ensureAgentHooks() for
// MAIN_AGENT_ID on every boot. Without the filter the template entry would register
// a PreToolUse(Bash) hook in front of EVERY Claude Code session on the owner's
// machine, in projects unrelated to this repo. The gate's own rationale is per-agent:
// the main agent's transcripts held ten branch creations, all in worktrees (zero real
// cases); both real incidents were a sub-agent's.
//
// The load-bearing assertion is the ASYMMETRY -- same template, two targets, present
// for one and absent for the other. Asserting only "the main agent lacks it" would
// also pass if the gate reached nobody, which is the state this change came from.

let SANDBOX = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})

const { ensureAgentHooks, agentSettingsPath, isFleetOnlyHookCommand } =
  await import('../web/agent-scaffold.js')
const { MAIN_AGENT_ID } = await import('../config.js')

const ROOT = join(__dirname, '..', '..')
const GATE = 'live-branch-switch-gate.py'
const SUB = 'fleetonlyprobe'
const SUB_DIR = join(ROOT, 'agents', SUB)

function hookCommands(path: string): string[] {
  const d = JSON.parse(readFileSync(path, 'utf-8')) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>
  }
  return Object.values(d.hooks ?? {}).flatMap((entries) =>
    entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? '')),
  )
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'fleetonly-'))
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  mkdirSync(join(SUB_DIR, '.claude'), { recursive: true })
})

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  rmSync(SUB_DIR, { recursive: true, force: true })
})

describe('fleet-only hook filter', () => {
  it('classifies only the listed scripts, anchored on the hooks directory', () => {
    expect(isFleetOnlyHookCommand(`python3 /x/scripts/hooks/${GATE}`)).toBe(true)
    expect(isFleetOnlyHookCommand(
      `bash -c '[ -f /x/scripts/hooks/${GATE} ] && exec python3 /x/scripts/hooks/${GATE}; exit 0'`,
    )).toBe(true)
    // A narrow exception, not a new default: every other template hook is unaffected.
    expect(isFleetOnlyHookCommand('python3 /x/scripts/hooks/provenance-gate.py')).toBe(false)
    expect(isFleetOnlyHookCommand('python3 /x/scripts/hooks/taskstate-replay.py')).toBe(false)
    // Anchored, so a same-named script elsewhere is not silently suppressed.
    expect(isFleetOnlyHookCommand(`python3 /x/tools/${GATE}`)).toBe(false)
  })

  it('seeds the gate for a sub-agent but NOT for the main agent (same template)', () => {
    // Main agent: settings.json absent -> the "seed from template" branch.
    const mainPath = agentSettingsPath(MAIN_AGENT_ID)
    expect(mainPath.startsWith(join(SANDBOX, 'home'))).toBe(true)
    ensureAgentHooks(MAIN_AGENT_ID)
    expect(existsSync(mainPath)).toBe(true)
    const mainCmds = hookCommands(mainPath)
    expect(mainCmds.some((c) => c.includes(GATE))).toBe(false)
    // Positive control on the same file: the shared template hooks DID arrive,
    // so the absence above is the filter, not an empty write.
    expect(mainCmds.some((c) => c.includes('clear-capture.py'))).toBe(true)

    // Sub-agent, same template, same call: the gate must be there.
    ensureAgentHooks(SUB)
    const subCmds = hookCommands(agentSettingsPath(SUB))
    expect(subCmds.some((c) => c.includes(GATE))).toBe(true)
  })

  it('does not add the gate to the main agent on the wholesale-add path either', () => {
    // The template's PreToolUse block did not exist before this change, so an
    // existing settings file with OTHER events is exactly how a fleet-only gate
    // would slip in: "event entirely missing -> add it wholesale".
    const mainPath = agentSettingsPath(MAIN_AGENT_ID)
    writeFileSync(mainPath, JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'clear', hooks: [{ type: 'command', command: 'true' }] }] },
    }, null, 2))
    ensureAgentHooks(MAIN_AGENT_ID)
    const cmds = hookCommands(mainPath)
    expect(cmds.some((c) => c.includes(GATE))).toBe(false)
    expect(cmds).toContain('true')            // pre-existing hook preserved
    expect(cmds.length).toBeGreaterThan(1)    // and the merge really ran
  })
})
