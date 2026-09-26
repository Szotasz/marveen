import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCommand,
  unregisterCommand,
  clearCommandsForTest,
  parseCommand,
  resolveCommand,
  dispatchCommand,
  commandHelpText,
  renderHelp,
  botCommandList,
  chunkText,
  listCommands,
  setInvalidCustomCommands,
  type CommandContext,
} from '../web/commands.js'
import { registerBuiltinCommands, customCommandsText } from '../web/builtin-commands.js'

function ctx(): CommandContext & { out: string[] } {
  const out: string[] = []
  return { out, ownerId: 1, now: Date.now(), reply: async (t: string) => { out.push(t) } }
}

beforeEach(() => clearCommandsForTest())

describe('parseCommand', () => {
  it('parses name and args, strips @botname, lowercases the name', () => {
    expect(parseCommand('/Runs@MyBot 2  extra')).toEqual({ name: 'runs', args: ['2', 'extra'], raw: '/Runs@MyBot 2  extra' })
  })
  it('non-command text is null', () => {
    expect(parseCommand('szia /status')).toBeNull()
    expect(parseCommand('/')).toBeNull()
  })
})

describe('registry dispatch', () => {
  it('unknown command runs nothing and points to /help (CMD920 test 2)', async () => {
    const c = ctx()
    expect(await dispatchCommand('/nincsilyen', c)).toBe('unknown')
    expect(c.out[0]).toMatch(/Ismeretlen parancs: \/nincsilyen.*\/help/s)
  })

  it('a matcher entry wins over the fallback; a planned one answers "planned" and runs nothing', async () => {
    const ran: string[][] = []
    registerCommand({ name: 'runs', kind: 'read', description: 'futó körök', run: (_c, a) => { ran.push(a) } })
    registerCommand({ name: 'runs', kind: 'write', confirm: true, planned: true, usage: '/runs stop <nonce>', description: 'stop', matches: a => a[0] === 'stop' })
    const c = ctx()
    expect(await dispatchCommand('/runs stop abc', c)).toBe('planned')
    expect(ran).toEqual([])
    expect(c.out[0]).toMatch(/Tervezett, még nem elérhető: \/runs stop <nonce>/)
    expect(await dispatchCommand('/runs 2', c)).toBe('ran')
    expect(ran).toEqual([['2']])
  })

  it('same usage replaces the entry (how the next release turns planned into real)', async () => {
    registerCommand({ name: 'model', kind: 'write', planned: true, usage: '/model back', description: 'x', matches: a => a[0] === 'back' })
    let ran = false
    registerCommand({ name: 'model', kind: 'write', usage: '/model back', description: 'x', matches: a => a[0] === 'back', run: () => { ran = true } })
    expect(listCommands().filter(e => e.usage === '/model back')).toHaveLength(1)
    expect(await dispatchCommand('/model back', ctx())).toBe('ran')
    expect(ran).toBe(true)
    expect(unregisterCommand('/model back')).toBe(true)
    expect(resolveCommand('model', ['back'])).toBeNull()
  })

  it('a throwing command is reported, not swallowed', async () => {
    registerCommand({ name: 'boom', kind: 'read', description: 'x', run: () => { throw new Error('kaput') } })
    const c = ctx()
    expect(await dispatchCommand('/boom', c)).toBe('error')
    expect(c.out[0]).toMatch(/kaput/)
  })

  it('rejects an invalid name and a non-planned entry without run()', () => {
    expect(() => registerCommand({ name: 'Bad-Name', kind: 'read', description: 'x', run: () => {} })).toThrow()
    expect(() => registerCommand({ name: 'ok', kind: 'read', description: 'x' })).toThrow()
  })
})

describe('/help generated from the registry (CMD920 test 3)', () => {
  beforeEach(() => registerBuiltinCommands())

  it('every registered builtin appears in /help, planned writes marked "tervezett"', () => {
    const help = renderHelp()
    for (const e of listCommands()) {
      expect(help).toContain(e.usage ?? `/${e.name}`)
    }
    for (const e of listCommands().filter(x => x.planned)) {
      expect(help).toContain(`${e.usage ?? `/${e.name}`}: ${e.description} (tervezett)`)
    }
    // every CMD920 3.2 read command is there
    for (const name of ['help', 'status', 'queue', 'runs', 'jobs', 'approvals', 'model', 'context', 'usage', 'board', 'commands']) {
      expect(listCommands().some(e => e.name === name && e.kind === 'read' && !e.planned)).toBe(true)
    }
    // the nonce writes are planned, in the "megerősítéssel" section
    const confirmSection = help.split('MODOSÍT, megerősítéssel')[1].split('SAJÁT')[0]
    expect(confirmSection).toContain('/runs stop <nonce>')
    expect(confirmSection).toContain('/jobs <név> on|off|run|skip <nonce>')
    expect(confirmSection).toContain('/approvals <n> approve|reject|renew <nonce>')
  })

  it('owner-facing text carries no dash: /help and /commands lines are "name: description" (review #1529, point 4)', () => {
    registerCommand({ name: 'reggel', kind: 'write', source: 'custom', description: 'reggeli összefoglaló', run: () => {} })
    for (const text of [renderHelp(), customCommandsText()]) {
      expect(text).not.toMatch(/—| -- /)
    }
  })

  it('a custom command registered later shows up under SAJÁT', () => {
    registerCommand({ name: 'reggel', kind: 'write', source: 'custom', description: 'reggeli összefoglaló', run: () => {} })
    expect(renderHelp().split('SAJÁT')[1]).toContain('/reggel: reggeli összefoglaló')
  })

  it('the bot menu lists runnable names once, planned-only names left out', () => {
    const menu = botCommandList()
    const names = menu.map(m => m.command)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('status')
    expect(names).not.toContain('new')
    expect(names).not.toContain('clear')
    for (const m of menu) {
      expect(m.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/)
      expect(m.description.length).toBeGreaterThan(0)
      expect(m.description.length).toBeLessThanOrEqual(256)
    }
    // the menu shows the read description of /model, not a planned write's
    expect(menu.find(m => m.command === 'model')?.description).toMatch(/mi fut most/)
  })

  it('A2: the /model and /context writes are real (not planned); the nonce writes stay planned', () => {
    for (const usage of ['/model [<választás>] [<low|medium|high|max>] [<idő>|keep]', '/model default', '/context clear']) {
      const e = listCommands().find(x => x.usage === usage)
      expect(e?.planned).toBeFalsy()
      expect(typeof e?.run).toBe('function')
    }
    expect(resolveCommand('model', ['opus', '30m'])?.usage).toBe('/model [<választás>] [<low|medium|high|max>] [<idő>|keep]')
    // one line, order-free: model and/or effort and/or time (ELSOKOR922 Phase 7)
    expect(resolveCommand('model', ['opus', 'low', '4m'])?.usage).toBe('/model [<választás>] [<low|medium|high|max>] [<idő>|keep]')
    expect(resolveCommand('model', ['low', '5m'])?.usage).toBe('/model [<választás>] [<low|medium|high|max>] [<idő>|keep]')
    expect(resolveCommand('model', ['default'])?.usage).toBe('/model default')
    expect(resolveCommand('model', ['back'])?.usage).toBe('/model default')
    expect(resolveCommand('model', [])?.kind).toBe('read')
    expect(resolveCommand('context', ['clear'])?.usage).toBe('/context clear')
    for (const usage of ['/runs stop <nonce>', '/jobs <név> on|off|run|skip <nonce>', '/approvals <n> approve|reject|renew <nonce>']) {
      expect(listCommands().find(x => x.usage === usage)?.planned).toBe(true)
    }
    // /new and /clear are shipped as default CUSTOM commands, not builtins
    expect(listCommands().some(e => e.name === 'new' || e.name === 'clear')).toBe(false)
  })

  it('/board is read-only: no write entry is registered for it (CMD920 test 21)', async () => {
    expect(listCommands().filter(e => e.name === 'board').every(e => e.kind === 'read')).toBe(true)
    const c = ctx()
    expect(await dispatchCommand('/board abc status done', c)).toBe('ran')
    expect(c.out[0]).toMatch(/csak olvas/)
  })

  it('/commands lists custom commands and the invalid ones with their reason', () => {
    expect(customCommandsText()).toMatch(/Saját parancsok:\nnincs/)
    setInvalidCustomCommands([{ name: 'rossz', reason: 'ismeretlen akció: foo' }])
    expect(customCommandsText()).toContain('/rossz: ismeretlen akció: foo')
  })
})

describe('chunkText', () => {
  it('keeps short text whole and splits long text on line boundaries', () => {
    expect(chunkText('abc')).toEqual(['abc'])
    const long = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(50, '.')).join('\n')
    const parts = chunkText(long, 1000)
    expect(parts.every(p => p.length <= 1000)).toBe(true)
    expect(parts.join('\n')).toBe(long)
  })
  it('hard-cuts a single line longer than the limit', () => {
    const parts = chunkText('x'.repeat(2500), 1000)
    expect(parts.map(p => p.length)).toEqual([1000, 1000, 500])
  })

  // Owner request 2026-09-24: every command answers `?`.
  it('/<name> ? : own help when the command has one, the registry lines otherwise; unknown names are left alone', async () => {
    clearCommandsForTest()
    registerBuiltinCommands()
    registerCommand({ name: 'sajat', kind: 'write', source: 'custom', description: 'a saját [actions]', run: async () => {} })
    const c = ctx()
    expect(await dispatchCommand('/board ?', c)).toBe('ran')
    expect(c.out[0]).toMatch(/^\/board: a kanban tábla/)
    const u = ctx()
    await dispatchCommand('/usage ?', u)
    expect(u.out[0]).toMatch(/^\/usage\n\/usage \[<nap>\]: /)
    const m = ctx()
    await dispatchCommand('/model ?', m)
    expect(m.out[0]).toMatch(/^\/model: melyik modell fut/) // not a model switch to "?"
    const k = ctx()
    await dispatchCommand('/sajat ?', k)
    expect(k.out[0]).toMatch(/^\/sajat\n\/sajat: a saját \[actions\]\n\nSaját parancs/)
    expect(commandHelpText('nincsilyen')).toBeNull()
    const h = ctx()
    await dispatchCommand('/help ?', h)
    expect(h.out[0]).toBe(renderHelp()) // the help of /help is /help
    const f = ctx()
    await dispatchCommand('/board w ?', f)
    expect(f.out[0]).toMatch(/^\/board: a kanban tábla/) // not a filter for an assignee "?"
    const mo = ctx()
    await dispatchCommand('/model opus ?', mo)
    expect(mo.out[0]).toMatch(/^\/model: melyik modell fut/)
    expect(renderHelp()).toMatch(/^Minden parancs után \?: részletes súgó példákkal, pl\. \/board \?\n\n/)
  })
})

