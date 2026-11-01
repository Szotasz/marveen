// #2200 review: ensureAgentHooks added missing hooks but never replaced an
// existing agent hook prompt, so agents scaffolded before the skill-propose
// change kept the old PreCompact prompt (mkdir -p ~/.claude/skills/...) next to
// the new instructions. A prompt that is still a stock prompt an earlier
// template shipped becomes the current one; a prompt someone edited stays.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentHooks, upgradeRetiredHookPrompts, upgradePreCompactRecipesToHelper, readRetiredHookPrompts, resolveTemplatePlaceholders, upgradeTaskStateHeaderInHookPrompts } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

type Hooks = Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>
const load = (file: string) => JSON.parse(resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', file), 'utf-8')))
const agentPrompt = (hooks: Hooks | undefined, event: string): unknown =>
  (hooks?.[event] ?? []).flatMap((e) => e.hooks ?? []).find((h) => h.type === 'agent')?.prompt
const TPL = load('settings.json.template') as { hooks: Hooks }
const RETIRED = load('retired-hook-prompts.json') as { PreCompact: string[] }
const CURRENT = agentPrompt(TPL.hooks, 'PreCompact') as string
// Newest first: the prompt before SKILL_QUARANTINE (SKILLAPPROVALOFF1101), the one before PR-C, the review-era one.
const PRE_SWITCH = RETIRED.PreCompact[0]!
const PRE_PRC = RETIRED.PreCompact[1]!
const REVIEW_ERA = RETIRED.PreCompact[2]!
const QUARANTINE_OLD = 'A gazda jóváhagyásáig karanténban vár; ha a név már él, cserejavaslat lesz, és jóváhagyáskor a régi változat mentésre kerül.'
const QUARANTINE_NEW = 'Hogy azonnal élesedik (a scan és az audit akkor is lefut), vagy a gazda jóváhagyásáig karanténban vár, azt a SKILL_QUARANTINE kapcsoló dönti el, a válasz live mezője megmondja; ha a név már él, cserejavaslat lesz, és élesedéskor a régi változat mentésre kerül.'
const fixture = (f: string) => readFileSync(join(PROJECT_ROOT, 'src', '__tests__', 'fixtures', f), 'utf-8')
// What upgradePreCompactRecipesToHelper alone makes of a prompt.
const afterHelperPass = (prompt: string): string => {
  const hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt }] }] }
  upgradePreCompactRecipesToHelper(hooks)
  return hooks.PreCompact[0].hooks[0].prompt
}

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

  it('a retired entry the #2338 pass already rewrote still migrates', () => {
    // The ~/ClaudeClaw-era prompt (b8e4ff8e6) as #2338's pass leaves it: its curl lines are
    // helper lines, the rest is the old prompt, so it equals no entry as shipped.
    const b8 = fixture('precompact-prompt-b8e4ff8e6.txt')
    const rewritten = afterHelperPass(b8)
    expect(rewritten).not.toBe(b8)
    expect(RETIRED.PreCompact).not.toContain(rewritten)
    const existing: Hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: rewritten, timeout: 180 }] }] }
    expect(upgradeRetiredHookPrompts(existing, TPL.hooks, RETIRED)).toBe(true)
    expect(existing.PreCompact[0].hooks![0].prompt).toBe(CURRENT)
  })

  it('an edited prompt stays edited after the #2338 pass rewrote it', () => {
    const edited = `${afterHelperPass(fixture('precompact-prompt-b8e4ff8e6.txt'))}\nmy own line`
    const existing: Hooks = { PreCompact: [{ hooks: [{ type: 'agent', prompt: edited }] }] }
    expect(upgradeRetiredHookPrompts(existing, TPL.hooks, RETIRED)).toBe(false)
    expect(existing.PreCompact[0].hooks![0].prompt).toBe(edited)
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

  // SKILLAPPROVALOFF1101: the quarantine became a switch, so the prompt no longer says every proposal waits.
  it('its newest entry is the prompt before SKILL_QUARANTINE: the same text but the one quarantine sentence', () => {
    expect(PRE_SWITCH).toContain(QUARANTINE_OLD)
    expect(CURRENT).not.toContain(QUARANTINE_OLD)
    expect(CURRENT).toContain(QUARANTINE_NEW)
    expect(PRE_SWITCH.replace(QUARANTINE_OLD, QUARANTINE_NEW)).toBe(CURRENT)
    // and the PR-C line pass of the entry before it gives exactly the prompt before the switch
    expect(afterHelperPass(PRE_PRC)).toBe(PRE_SWITCH)
  })

  it('its entry before that is the prompt before PR-C (one shared api-payload.txt), then the one the review found', () => {
    // VOICETOKENLEAK1101 PR-C: the #2434-era stock prompt, retired when the payload files went per kind
    expect(PRE_PRC).toContain('api-payload.txt')
    expect(CURRENT).not.toContain('api-payload.txt')
    // exactly the template prompt before PR-C: PR-C's line pass makes it the current one, and it is not the older
    // review-era prompt (which still told to mkdir in the global skill folder)
    expect(PRE_PRC).not.toBe(CURRENT)
    expect(afterHelperPass(PRE_PRC)).toBe(PRE_SWITCH)
    expect(PRE_PRC).not.toContain('mkdir -p ~/.claude/skills/')
    expect(REVIEW_ERA).toContain('mkdir -p ~/.claude/skills/')
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

  it('holds the prompt #2340 shipped, so an agent #2340 rewrote still migrates', () => {
    const raw = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'retired-hook-prompts.json'), 'utf-8')) as { PreCompact: string[] }
    expect(raw.PreCompact).toContain(fixture('precompact-prompt-2340.txt'))
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

  // Dani 65499/1, Samu 65501: a prompt someone rewrote by hand is not replaced; only the exact shipped lines move on.
  it('a prompt written by hand, with no shipped line in it, stays byte for byte', () => {
    const own = 'A saját PreCompact szövegem.\n\nMentsd, amit fontosnak tartasz, a saját fájljaidból:\n  bash /x/marveen-api.sh memory-save SAJAT_NEVED warm "k" sajat-memoria.txt'
    write(own)
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(own)
  })

  it('a partly edited prompt: a customised line stays verbatim, only the exact old shipped lines move on', () => {
    const lines = PRE_PRC.split('\n')
    const memAt = lines.findIndex((l) => l.includes('memory-save SAJAT_NEVED warm') && l.includes('api-payload.txt'))
    expect(memAt).toBeGreaterThan(-1)
    const custom = lines[memAt]!.replace('"kulcsszo1, kulcsszo2"', '"sajat, kulcsszo"')
    lines[memAt] = custom
    const edited = lines.join('\n')
    write(edited)
    ensureAgentHooks(PROBE, scopes())
    const out = read() as string
    expect(out).not.toBe(CURRENT)
    expect(out.split('\n')).toContain(custom) // the operator's own line, untouched (still api-payload.txt)
    expect(out).toContain('daily-log SAJAT_NEVED api-naplo.txt') // an exact shipped line moved on
    expect(out.split('\n').length).toBe(lines.length)
  })

  // Dani 65499/2, Samu 65501: the rest of the agent's settings.json stays as it was, and the file reads back as JSON.
  it('the other fields of the hook and of settings.json stay as they were, and the file is valid JSON', () => {
    const before = {
      model: 'keep-me',
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(sudo:*)'] },
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [
          { type: 'command', command: 'echo before-the-prompt', timeout: 7 },
          { type: 'agent', prompt: PRE_PRC, timeout: 180 },
          { type: 'command', command: 'echo after-the-prompt' },
        ] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo my-stop-hook' }] }],
      },
    }
    writeFileSync(settings, JSON.stringify(before, null, 2))
    ensureAgentHooks(PROBE, scopes())
    const after = JSON.parse(readFileSync(settings, 'utf-8'))
    expect(after.model).toBe('keep-me')
    expect(after.permissions.allow).toEqual(before.permissions.allow)
    const entry = after.hooks.PreCompact[0]
    expect(entry.matcher).toBe('auto')
    expect(entry.hooks[0]).toEqual(before.hooks.PreCompact[0].hooks[0])
    expect(entry.hooks[1]).toEqual({ type: 'agent', prompt: CURRENT, timeout: 180 })
    expect(entry.hooks[2]).toEqual(before.hooks.PreCompact[0].hooks[2])
    // what was there in Stop is still there, first and unchanged (the template may add its own after it)
    expect(after.hooks.Stop[0]).toEqual(before.hooks.Stop[0])
  })

  it('an agent on the prompt before the switch (SKILLAPPROVALOFF1101) gets the current one in one start', () => {
    write(PRE_SWITCH)
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
  })

  it('an agent still on the previous stock prompt gets the current one', () => {
    write(PRE_PRC)
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

  it('an edited prompt is not replaced: the operator line stays, only the exact shipped lines move on', () => {
    const edited = `${PRE_PRC}\nmy own line, written by the operator`
    write(edited)
    ensureAgentHooks(PROBE, scopes())
    // the line pass (upgradePreCompactRecipesToHelper) still turns its exact api-payload.txt lines into the per-kind
    // ones (PR-C); the retired-list pass does not take it to the template prompt
    expect(read()).toBe(afterHelperPass(edited))
    expect(read()).toContain('my own line, written by the operator')
    expect(read()).not.toContain('api-payload.txt')
  })

  // VOICETOKENLEAK1101 PR-C (Samu 65492): the stock prompt with one shared api-payload.txt becomes the template prompt
  // (per-kind files) word for word, in one start.
  it('the stock prompt before PR-C (one shared api-payload.txt) reaches the template prompt in one start', () => {
    expect(PRE_PRC).toContain('api-payload.txt')
    write(PRE_PRC)
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
    expect(read()).not.toContain('api-payload.txt')
  })

  it('the last shipped curl prompt reaches the template prompt in one start', () => {
    write(resolveTemplatePlaceholders(fixture('precompact-prompt-pre2338.txt')))
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
  })

  it('the b8e4ff8e6 prompt, already rewritten by the #2338 pass, reaches the template prompt', () => {
    write(afterHelperPass(fixture('precompact-prompt-b8e4ff8e6.txt')))
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
  })

  it('a prompt the helper pass turns into a retired one converges in the same start', () => {
    // The last curl prompt with the ~/ClaudeClaw token path: no retired entry as it is, but
    // the helper pass makes it the prompt #2340 shipped. Without the second retired-list pass
    // after the helper pass it would stop there until the next start.
    const pre = fixture('precompact-prompt-pre2338.txt')
    expect(pre).toContain('{{PROJECT_ROOT}}/store/.dashboard-token')
    const old = resolveTemplatePlaceholders(pre.split('{{PROJECT_ROOT}}/store/.dashboard-token').join('~/ClaudeClaw/store/.dashboard-token'))
    expect(RETIRED.PreCompact).not.toContain(old)
    expect(RETIRED.PreCompact.map(afterHelperPass)).not.toContain(old)
    expect(afterHelperPass(old)).toBe(afterHelperPass(resolveTemplatePlaceholders(fixture('precompact-prompt-2340.txt'))))
    write(old)
    ensureAgentHooks(PROBE, scopes())
    expect(read()).toBe(CURRENT)
  })
})
