// #2200 review: ensureAgentHooks added missing hooks but never replaced an
// existing agent hook prompt, so agents scaffolded before the skill-propose
// change kept the old PreCompact prompt (mkdir -p ~/.claude/skills/...) next to
// the new instructions. A prompt that is still a stock prompt an earlier
// template shipped becomes the current one; a prompt someone edited stays.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentHooks, upgradeRetiredHookPrompts, readRetiredHookPrompts, resolveTemplatePlaceholders, upgradeTaskStateHeaderInHookPrompts } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

type Hooks = Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>
const load = (file: string) => JSON.parse(resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', file), 'utf-8')))
const agentPrompt = (hooks: Hooks | undefined, event: string): unknown =>
  (hooks?.[event] ?? []).flatMap((e) => e.hooks ?? []).find((h) => h.type === 'agent')?.prompt
const TPL = load('settings.json.template') as { hooks: Hooks }
const RETIRED = load('retired-hook-prompts.json') as { PreCompact: string[] }
const CURRENT = agentPrompt(TPL.hooks, 'PreCompact') as string

describe('upgradeRetiredHookPrompts', () => {
  const tplHooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: 'NEW', timeout: 180 }] }] }

  it('replaces a stock retired prompt with the current one', () => {
    const existing: Hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: 'OLD-1', timeout: 180 }] }] }
    expect(upgradeRetiredHookPrompts(existing, tplHooks, { PreCompact: ['OLD-2', 'OLD-1'] })).toBe(true)
    expect(existing.PreCompact[0].hooks![0].prompt).toBe('NEW')
    expect(existing.PreCompact[0].hooks![0].timeout).toBe(180)
  })

  it('leaves an edited prompt, a command hook and another event alone', () => {
    // The template has an agent prompt for Stop too, so only the retired list keeps Stop out.
    const tplBoth = { ...tplHooks, Stop: [{ hooks: [{ type: 'agent', prompt: 'NEW-STOP' }] }] }
    const existing: Hooks = {
      PreCompact: [{ hooks: [{ type: 'agent', prompt: 'OLD-1\nmy own line' }, { type: 'command', command: 'OLD-1', prompt: 'OLD-1' }] }],
      Stop: [{ hooks: [{ type: 'agent', prompt: 'OLD-1' }] }],
    }
    const before = JSON.stringify(existing)
    expect(upgradeRetiredHookPrompts(existing, tplBoth, { PreCompact: ['OLD-1'] })).toBe(false)
    expect(JSON.stringify(existing)).toBe(before)
  })

  it('changes nothing when the template has no agent prompt for the event', () => {
    const existing: Hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: 'OLD-1' }] }] }
    const noAgent = { PreCompact: [{ hooks: [{ type: 'command', command: 'x' }] }] }
    expect(upgradeRetiredHookPrompts(existing, noAgent, { PreCompact: ['OLD-1'] })).toBe(false)
    expect(existing.PreCompact[0].hooks![0].prompt).toBe('OLD-1')
  })

  it('is idempotent: the second pass changes nothing', () => {
    const existing: Hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: 'OLD-1' }] }] }
    expect(upgradeRetiredHookPrompts(existing, tplHooks, { PreCompact: ['OLD-1'] })).toBe(true)
    expect(upgradeRetiredHookPrompts(existing, tplHooks, { PreCompact: ['OLD-1'] })).toBe(false)
  })
})

describe('the shipped retired list', () => {
  it('holds earlier stock PreCompact prompts, each once as shipped, and not the current one', () => {
    expect(typeof CURRENT).toBe('string')
    expect(RETIRED.PreCompact.length).toBeGreaterThan(0)
    expect(RETIRED.PreCompact).not.toContain(CURRENT)
    // Once each as shipped. Some resolve to the same text on an install (the name
    // or the port as a placeholder beside the literal default); any one migrates.
    const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'retired-hook-prompts.json'), 'utf-8')) as { PreCompact: string[] }
    expect(new Set(raw.PreCompact).size).toBe(raw.PreCompact.length)
  })

  it('its newest entry is the prompt the review found: the global skill folder instruction', () => {
    expect(RETIRED.PreCompact[0]).toContain('mkdir -p ~/.claude/skills/')
    expect(CURRENT).not.toContain('mkdir -p ~/.claude/skills/')
  })

  it('holds what the X-Agent-Id header pass made of each stock prompt, so an agent it already rewrote still migrates', () => {
    // Unresolved, as shipped: on this install two entries may resolve to the same text.
    const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'retired-hook-prompts.json'), 'utf-8')) as { PreCompact: string[] }
    for (const old of raw.PreCompact) {
      const hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: old }] }] }
      upgradeTaskStateHeaderInHookPrompts(hooks)
      expect(raw.PreCompact).toContain(hooks.PreCompact[0].hooks[0].prompt)
    }
  })
})

describe('readRetiredHookPrompts', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retired-read-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a missing or unreadable file means no migration, never a throw', () => {
    expect(readRetiredHookPrompts(join(dir, 'absent.json'))).toEqual({})
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    expect(readRetiredHookPrompts(join(dir, 'bad.json'))).toEqual({})
    mkdirSync(join(dir, 'a-dir.json'))
    expect(readRetiredHookPrompts(join(dir, 'a-dir.json'))).toEqual({})
  })

  it('keeps only lists of strings', () => {
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ _comment: 'x', PreCompact: ['a', 7, 'b'], Stop: 'no' }))
    expect(readRetiredHookPrompts(join(dir, 'ok.json'))).toEqual({ PreCompact: ['a', 'b'] })
  })
})

describe('ensureAgentHooks migrates a stock PreCompact prompt', () => {
  const PROBE = 'retired-prompt-probe'
  const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
  const settings = join(probeDir, '.claude', 'settings.json')
  let scopeRoot: string
  const scopes = () => ({ user: join(scopeRoot, 'user-settings.json'), project: join(scopeRoot, 'project-settings.json') })
  const write = (prompt: string) => writeFileSync(settings, JSON.stringify({
    hooks: { PreCompact: [{ hooks: [{ type: 'agent', prompt, timeout: 180 }] }] },
  }, null, 2))
  const read = () => agentPrompt(JSON.parse(readFileSync(settings, 'utf-8')).hooks, 'PreCompact')

  // Refuses, before and after each case, to remove a directory that looks like a live agent.
  const cleanup = () => {
    if (!existsSync(probeDir)) return
    if (existsSync(join(probeDir, 'CLAUDE.md')) || existsSync(join(probeDir, 'HANDOFF.md'))) {
      throw new Error(`refusing: agents/${PROBE} looks live`)
    }
    rmSync(probeDir, { recursive: true, force: true })
  }
  beforeEach(() => {
    cleanup()
    mkdirSync(join(probeDir, '.claude'), { recursive: true })
    scopeRoot = mkdtempSync(join(tmpdir(), 'retired-prompt-'))
  })
  afterEach(() => {
    cleanup()
    if (scopeRoot) rmSync(scopeRoot, { recursive: true, force: true })
  })

  it('an agent still on the previous stock prompt gets the current one', () => {
    write(RETIRED.PreCompact[0])
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
  })

  it('every retired stock prompt is migrated', () => {
    for (const old of RETIRED.PreCompact) {
      write(old)
      ensureAgentHooks(PROBE, scopes())
      expect(read()).toBe(CURRENT)
    }
  })

  it('an edited prompt is left as it is', () => {
    const edited = `${RETIRED.PreCompact[0]}\nmy own line, written by the operator`
    write(edited)
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(edited)
  })
})
