import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  substituteTemplatePlaceholders,
  resolveTemplatePlaceholders,
  upgradePreCompactRecipesToHelper,
  upgradeTaskStateHeaderInHookPrompts,
} from '../web/agent-scaffold.js'

// #2338: the PreCompact prompt's save recipes (memory, daily log, task state) were raw
// `curl -X POST ... -H "Authorization: Bearer $(cat <token>)"` lines. A strict profile runs
// under `dontAsk`, where a command substitution never matches the allow-list, and the
// researcher profile denies `curl -X POST` outright, so their pre-compaction save was refused
// without a word. The template now names scripts/marveen-api.sh, and
// upgradePreCompactRecipesToHelper brings an existing agent's prompt along.

type Hooks = { PreCompact: Array<{ hooks: Array<{ type?: string; prompt?: string; command?: string; timeout?: number }> }> }

function templatePrompt(): string {
  const tpl = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')) as { hooks: Hooks }
  const prompt = tpl.hooks.PreCompact.flatMap((e) => e.hooks).find((h) => typeof h.prompt === 'string')?.prompt
  if (!prompt) throw new Error('template has no PreCompact prompt')
  return prompt
}

// The last shipped curl prompt (develop e4149fac9), frozen.
function pre2338Prompt(): string {
  return readFileSync(join(PROJECT_ROOT, 'src', '__tests__', 'fixtures', 'precompact-prompt-pre2338.txt'), 'utf-8')
}

function hooksWith(prompt: string): Record<string, unknown> {
  return { PreCompact: [{ hooks: [{ type: 'agent', prompt, timeout: 180 }] }] }
}
function promptOf(hooks: Record<string, unknown>): string {
  return (hooks as Hooks).PreCompact[0].hooks[0].prompt as string
}

describe('templates/settings.json.template PreCompact prompt (#2338)', () => {
  it('carries no raw curl POST and no token read', () => {
    const p = templatePrompt()
    expect(p).not.toMatch(/curl -s -X POST/)
    expect(p).not.toContain('.dashboard-token')
    expect(p).not.toContain('$(cat')
  })

  it('names the helper for all three saves, each payload from a file', () => {
    const p = templatePrompt()
    const H = 'bash {{PROJECT_ROOT}}/scripts/marveen-api.sh'
    expect(p).toContain(`${H} memory-save SAJAT_NEVED warm "kulcsszo1, kulcsszo2" api-payload.txt`)
    expect(p).toContain(`${H} daily-log SAJAT_NEVED api-payload.txt`)
    expect(p).toContain(`${H} taskstate-save SAJAT_NEVED api-payload.json`)
  })
})

describe('upgradePreCompactRecipesToHelper', () => {
  it('turns the last shipped curl prompt into the current template prompt, byte for byte', () => {
    const hooks = hooksWith(resolveTemplatePlaceholders(pre2338Prompt()))
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(true)
    expect(promptOf(hooks)).toBe(resolveTemplatePlaceholders(templatePrompt()))
    expect((hooks as Hooks).PreCompact[0].hooks[0].timeout).toBe(180)
  })

  it('a prompt from before the X-Agent-Id header: header pass, then this one, ends on the template', () => {
    const noHeader = pre2338Prompt().replace(" -H 'X-Agent-Id: SAJAT_NEVED'", '')
    const hooks = hooksWith(resolveTemplatePlaceholders(noHeader))
    upgradeTaskStateHeaderInHookPrompts(hooks)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(true)
    expect(promptOf(hooks)).toBe(resolveTemplatePlaceholders(templatePrompt()))
  })

  it('the literal-3420 spelling (before the WEB_PORT placeholder) is upgraded on an install on another port', () => {
    // Rendered as an install on 3421 would: there the {{WEB_PORT}} spelling no longer
    // equals the literal-3420 one, so only the explicit old spelling can match it.
    const render = (s: string) => substituteTemplatePlaceholders(s, {
      projectRoot: '/opt/install', mainAgentId: 'agent', botName: 'Bot', ownerName: 'Owner', webPort: 3421,
    })
    const old = render(pre2338Prompt().split('localhost:{{WEB_PORT}}').join('localhost:3420'))
    expect(old).not.toContain('localhost:3421')
    const hooks = hooksWith(old)
    expect(upgradePreCompactRecipesToHelper(hooks, render)).toBe(true)
    expect(promptOf(hooks)).toBe(render(templatePrompt()))
  })

  it('the "A Marveen" intro line (before BOT_NAME) is upgraded on an install with another bot name', () => {
    const render = (s: string) => substituteTemplatePlaceholders(s, {
      projectRoot: '/opt/install', mainAgentId: 'agent', botName: 'Bot', ownerName: 'Owner', webPort: 3420,
    })
    const old = render(pre2338Prompt().replace('A {{BOT_NAME}} /api/* Bearer tokenes.', 'A Marveen /api/* Bearer tokenes.'))
    expect(old).toContain('A Marveen /api/* Bearer tokenes.')
    const hooks = hooksWith(old)
    expect(upgradePreCompactRecipesToHelper(hooks, render)).toBe(true)
    expect(promptOf(hooks)).toBe(render(templatePrompt()))
  })

  it('is idempotent', () => {
    const hooks = hooksWith(resolveTemplatePlaceholders(pre2338Prompt()))
    upgradePreCompactRecipesToHelper(hooks)
    const after = JSON.stringify(hooks)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(false)
    expect(JSON.stringify(hooks)).toBe(after)
  })

  it('all or nothing: an operator-edited curl line leaves the WHOLE prompt as it is', () => {
    // Rewriting the intro and the other lines while one curl recipe stays would hand
    // the agent two contradicting instructions (review #2340).
    const rendered = resolveTemplatePlaceholders(pre2338Prompt())
    const edited = rendered.replace('"category":"warm","keywords":"..."', '"category":"hot","keywords":"sajat"')
    expect(edited).not.toBe(rendered)
    const hooks = hooksWith(edited)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(false)
    expect(promptOf(hooks)).toBe(edited)
  })

  it('all or nothing: an unknown curl save recipe next to shipped lines leaves the prompt untouched', () => {
    const rendered = resolveTemplatePlaceholders(pre2338Prompt())
    const withUnknown = rendered.replace('Használd a curl parancsokat:',
      "Használd a curl parancsokat:\n  curl -X POST http://127.0.0.1:9999/api/daily-log -d @napi.json")
    const hooks = hooksWith(withUnknown)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(false)
    expect(promptOf(hooks)).toBe(withUnknown)
  })

  it('the ~/ClaudeClaw-era prompt (b8e4ff8e6, still on live agents): every recipe line is upgraded, none left as curl', () => {
    // Frozen from the template's history; byte-equal to a live agent's prompt measured on 2026-10-29.
    const old = readFileSync(join(PROJECT_ROOT, 'src', '__tests__', 'fixtures', 'precompact-prompt-b8e4ff8e6.txt'), 'utf-8')
    expect(old).toContain('cat ~/ClaudeClaw/store/.dashboard-token')
    const hooks = hooksWith(old)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(true)
    const p = promptOf(hooks)
    expect(p).not.toMatch(/curl\b.*\/api\//)
    expect(p).not.toContain('.dashboard-token')
    expect(p).not.toContain('Használd a curl parancsokat:')
    expect(p).toContain('/scripts/marveen-api.sh memory-save SAJAT_NEVED warm "kulcsszo1, kulcsszo2" api-payload.txt')
    expect(p).toContain('/scripts/marveen-api.sh daily-log SAJAT_NEVED api-payload.txt')
    expect(p).toContain('Használd a segédet (előtte a mentendő szöveget írd az api-payload.txt fájlba a munkamappádban):')
  })

  it('a curl line inside a longer line (not the exact shipped line) is not touched', () => {
    const rendered = resolveTemplatePlaceholders(pre2338Prompt())
    const memLine = rendered.split('\n').find((l) => l.includes('/api/memories'))!
    const wrapped = `megjegyzés: ${memLine.trim()} -- ezt használom`
    const hooks = hooksWith(wrapped)
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(false)
    expect(promptOf(hooks)).toBe(wrapped)
  })

  it('never touches command hooks, and skips malformed event values', () => {
    const rendered = resolveTemplatePlaceholders(pre2338Prompt())
    const memLine = rendered.split('\n').find((l) => l.includes('/api/memories'))!
    const hooks: Record<string, unknown> = {
      PreToolUse: [{ hooks: [{ type: 'command', command: memLine }] }],
      Stop: 'not-an-array',
      Notification: [{}],
    }
    expect(upgradePreCompactRecipesToHelper(hooks)).toBe(false)
    expect((hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command).toBe(memLine)
  })
})
