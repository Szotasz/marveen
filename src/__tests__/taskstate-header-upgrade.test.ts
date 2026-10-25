import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import {
  agentSettingsPath,
  ensureAgentHooks,
  upgradeTaskStateHeaderInHookPrompts,
} from '../web/agent-scaffold.js'

// The PreCompact hook's task-state curl now sends
// X-Agent-Id: SAJAT_NEVED, so the agent's own record replays as its own. The
// add pass in ensureAgentHooks dedupes on COMMAND strings and never rewrites a
// `type: "agent"` PROMPT, so an agent scaffolded before the change would keep
// the header-less curl forever -- and every record it wrote would replay with
// the "not demonstrably yours, verify first" framing. This pass inserts the
// header in place, the same way upgradeForeignRootInHookPrompts re-anchors paths.

const HEADER = " -H 'X-Agent-Id: SAJAT_NEVED'"

function templatePreCompactPrompt(): string {
  const tpl = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')) as
    { hooks: { PreCompact: Array<{ hooks: Array<{ prompt?: string }> }> } }
  const prompt = tpl.hooks.PreCompact.flatMap((e) => e.hooks).find((h) => typeof h.prompt === 'string')?.prompt
  if (!prompt) throw new Error('template has no PreCompact prompt')
  return prompt
}

function oldPrompt(): string {
  const current = templatePreCompactPrompt()
  const old = current.replace(HEADER, '')
  // Precondition: the template carries the header exactly once, so "old" is
  // the prompt an agent scaffolded before this change has today.
  expect(old).not.toBe(current)
  expect(old.includes("X-Agent-Id")).toBe(false)
  return old
}

describe('upgradeTaskStateHeaderInHookPrompts', () => {
  it('inserts the header into a pre-change PreCompact prompt, byte-identical to the template', () => {
    const hooks: Record<string, unknown> = { PreCompact: [{ hooks: [{ type: 'agent', prompt: oldPrompt(), timeout: 180 }] }] }
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(true)
    const h = (hooks.PreCompact as Array<{ hooks: Array<{ prompt: string; timeout: number }> }>)[0].hooks[0]
    expect(h.prompt).toBe(templatePreCompactPrompt())
    expect(h.timeout).toBe(180)
  })

  it('is idempotent: a second pass changes nothing', () => {
    const hooks: Record<string, unknown> = { PreCompact: [{ hooks: [{ type: 'agent', prompt: oldPrompt() }] }] }
    upgradeTaskStateHeaderInHookPrompts(hooks)
    const after = JSON.stringify(hooks)
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(false)
    expect(JSON.stringify(hooks)).toBe(after)
  })

  it('upgrades every old curl in a prompt, and only the ones still missing the header', () => {
    const ANCHOR = "/api/agent-taskstate/SAJAT_NEVED -H 'Content-Type: application/json'"
    const two = `first: curl ${ANCHOR} -d '{}'\nsecond: curl ${ANCHOR} -d '{}'`
    const mixed = `first: curl ${ANCHOR}${HEADER} -d '{}'\nsecond: curl ${ANCHOR} -d '{}'`
    const hooks: Record<string, unknown> = { PreCompact: [{ hooks: [{ type: 'agent', prompt: two }, { type: 'agent', prompt: mixed }] }] }
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(true)
    const [p1, p2] = (hooks.PreCompact as Array<{ hooks: Array<{ prompt: string }> }>)[0].hooks.map((h) => h.prompt)
    const want = `first: curl ${ANCHOR}${HEADER} -d '{}'\nsecond: curl ${ANCHOR}${HEADER} -d '{}'`
    expect(p1).toBe(want)
    expect(p2).toBe(want)
  })

  it('leaves the current template prompt alone (no second header)', () => {
    const hooks: Record<string, unknown> = { PreCompact: [{ hooks: [{ type: 'agent', prompt: templatePreCompactPrompt() }] }] }
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(false)
    const p = (hooks.PreCompact as Array<{ hooks: Array<{ prompt: string }> }>)[0].hooks[0].prompt
    expect(p.split("X-Agent-Id: SAJAT_NEVED").length - 1).toBe(1)
  })

  it('leaves an operator-customised prompt without the exact template curl untouched', () => {
    const custom = "curl -s -X POST http://localhost:3420/api/agent-taskstate/bob -H 'Content-Type: application/json' -d '{}'"
    const hooks: Record<string, unknown> = { PreCompact: [{ hooks: [{ type: 'agent', prompt: custom }] }] }
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(false)
    expect((hooks.PreCompact as Array<{ hooks: Array<{ prompt: string }> }>)[0].hooks[0].prompt).toBe(custom)
  })

  it('never touches command hooks, and skips malformed event values', () => {
    const cmd = "curl /api/agent-taskstate/SAJAT_NEVED -H 'Content-Type: application/json'"
    const hooks: Record<string, unknown> = {
      PreToolUse: [{ hooks: [{ type: 'command', command: cmd }] }],
      Stop: 'not-an-array',
      Notification: [{}],
    }
    expect(upgradeTaskStateHeaderInHookPrompts(hooks)).toBe(false)
    expect((hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command).toBe(cmd)
  })
})

describe('ensureAgentHooks upgrades an existing agent', () => {
  const NAME = 'tsheader-probe'
  const dir = join(PROJECT_ROOT, 'agents', NAME)
  const settings = agentSettingsPath(NAME)
  let root = ''

  beforeEach(() => {
    if (existsSync(join(dir, 'HANDOFF.md'))) {
      throw new Error(`refusing: agents/${NAME} looks like a live agent`)
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, '.claude'), { recursive: true })
    root = mkdtempSync(join(tmpdir(), 'tsheader-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('a settings file scaffolded before the change gets the header on the next pass', () => {
    writeFileSync(settings, JSON.stringify({
      hooks: { PreCompact: [{ hooks: [{ type: 'agent', prompt: oldPrompt(), timeout: 180 }] }] },
    }, null, 2))
    // Both cross-scope paths point into the temp dir: the operator's real
    // ~/.claude is never read.
    expect(ensureAgentHooks(NAME, { user: join(root, 'user.json'), project: join(root, 'project.json') })).toBe(true)
    const parsed = JSON.parse(readFileSync(settings, 'utf-8')) as
      { hooks: { PreCompact: Array<{ hooks: Array<{ prompt?: string }> }> } }
    const prompts = parsed.hooks.PreCompact.flatMap((e) => e.hooks).map((h) => h.prompt ?? '').filter(Boolean)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("/api/agent-taskstate/SAJAT_NEVED -H 'Content-Type: application/json' -H 'X-Agent-Id: SAJAT_NEVED'")
  })
})
