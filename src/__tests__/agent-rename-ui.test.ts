// AGENTRENAME1125: a sub-agent's display name could only be set when it was created. The detail window now edits it in
// place (a pencil next to the name). The save handler is run here with stubs, not only matched as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const SUBMIT = "document.getElementById('agentRenameForm').addEventListener('submit', "
function submitSrc(): string {
  const i = APP.indexOf(SUBMIT)
  if (i < 0) return ''
  const start = i + SUBMIT.length
  const end = APP.indexOf('\n})\n', start)
  return end < 0 ? '' : APP.slice(start, end + 2)
}
function fnSrc(name: string): string {
  const i = APP.indexOf(`function ${name}(`)
  const end = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || end < 0 ? '' : APP.slice(i, end + 2)
}

type El = { hidden?: boolean; textContent?: string; value?: string; disabled?: boolean; focused?: boolean; alt?: string; img?: El | null }
async function runSave(opts: { agent?: { name: string; displayName?: string } | null; typed: string; status?: number; body?: unknown; throws?: boolean; hasImage?: boolean }) {
  const log: string[] = []
  const img: El | null = opts.hasImage ? { alt: '' } : null
  const els: Record<string, El & Record<string, unknown>> = {
    agentRenameInput: { value: opts.typed, focus() { log.push('focus') } } as any,
    agentRenameSave: { disabled: false },
    agentDetailTitle: { textContent: 'old' },
    agentDetailName: { textContent: 'old' },
    agentDetailAvatar: { textContent: 'O', querySelector: () => img } as any,
    agentRenameForm: { hidden: false },
    agentDetailNameRow: { hidden: true },
    agentRenameBtn: { hidden: false },
  }
  const document = { getElementById: (id: string) => els[id] }
  const state = { currentAgent: opts.agent === undefined ? { name: 'tete', displayName: 'Tete' } : opts.agent }
  const deps: Record<string, unknown> = {
    document,
    mainAgentId: () => 'marveen',
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k),
    fetch: async (url: string, init: { method: string; body: string }) => {
      log.push(`fetch ${init.method} ${url} ${init.body}`)
      if (opts.throws) throw new Error('network')
      return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => opts.body ?? {} }
    },
    showToast: (msg: string, kind?: unknown) => { log.push(`toast ${kind ?? 'neutral'} ${msg}`) },
    loadAgents: () => { log.push('loadAgents') },
    refreshVisibleTeamGraphs: () => { log.push('refreshVisibleTeamGraphs') },
    refusalReason: (r: { status: number }, body: { error?: string }) => body.error || `HTTP ${r.status}`,
  }
  const readActionReply = new Function(`async ${fnSrc('readActionReply')}; return readActionReply`)()
  const resetAgentRename = new Function('document', `${fnSrc('resetAgentRename')}; return resetAgentRename`)(document)
  const names = Object.keys(deps)
  // currentAgent is read and written through a getter/setter so the handler sees the live value.
  const handler = new Function(...names, 'readActionReply', 'resetAgentRename', 'state',
    `with (state) { return ${submitSrc()} }`)(...names.map(n => deps[n]), readActionReply, resetAgentRename, state)
  await handler({ preventDefault() { log.push('preventDefault') } })
  return { log, els, img, state }
}

describe('the markup', () => {
  it('a pencil button next to the name, and an in-place form with save and cancel', () => {
    expect(HTML).toContain('id="agentDetailNameRow"')
    expect(HTML).toMatch(/<button type="button" class="detail-rename-btn" id="agentRenameBtn" hidden[^>]*data-i18n-title="agents\.rename\.btn_title"/)
    expect(HTML).toContain('<form class="detail-rename-form" id="agentRenameForm" hidden>')
    expect(HTML).toContain('id="agentRenameInput" maxlength="200"')
    expect(HTML).toContain('id="agentRenameSave" data-i18n="common.btn.save"')
    expect(HTML).toContain('id="agentRenameCancel" data-i18n="common.btn.cancel"')
  })

  it('each element with its own display keeps [hidden] working', () => {
    for (const c of ['detail-name-row', 'detail-rename-btn', 'detail-rename-form']) expect(CSS).toContain(`.${c}[hidden] { display: none; }`)
  })

  it('both languages have the four texts', () => {
    for (const k of ['agents.rename.btn_title', 'agents.rename.hint', 'agents.rename.saved', 'agents.rename.invalid']) {
      expect(HU, k).toContain(`'${k}'`)
      expect(EN, k).toContain(`'${k}'`)
    }
  })
})

describe('the button is there for a sub-agent only', () => {
  it('a sub-agent\'s detail shows it, the main agent\'s detail hides it (its name is BOT_NAME)', () => {
    const sub = APP.slice(APP.indexOf('async function openAgentDetail('), APP.indexOf('// Settings tab - load Ollama'))
    expect(sub).toContain('resetAgentRename(true)')
    const main = APP.slice(APP.indexOf('async function openMarveenDetail('), APP.indexOf('async function openMarveenDetail(') + 3000)
    expect(main).toContain('resetAgentRename(false)')
  })

  it('resetAgentRename closes the form, shows the name row and sets the button', () => {
    const els: Record<string, { hidden: boolean }> = {
      agentRenameForm: { hidden: false }, agentDetailNameRow: { hidden: true }, agentRenameBtn: { hidden: false },
    }
    new Function('document', `${fnSrc('resetAgentRename')}; resetAgentRename(false)`)({ getElementById: (id: string) => els[id] })
    expect(els).toEqual({ agentRenameForm: { hidden: true }, agentDetailNameRow: { hidden: false }, agentRenameBtn: { hidden: true } })
  })

  it('the pencil opens the form, and the hint names the default an empty save brings back', () => {
    const PENCIL = "document.getElementById('agentRenameBtn').addEventListener('click', "
    const start = APP.indexOf(PENCIL)
    expect(start).toBeGreaterThan(-1)
    const src = APP.slice(start + PENCIL.length, APP.indexOf('\n})\n', start) + 2)
    const els: Record<string, any> = {
      agentRenameInput: { value: '', placeholder: '', focus() {}, select() {} },
      agentRenameHint: { textContent: '' }, agentDetailNameRow: { hidden: false }, agentRenameForm: { hidden: true },
    }
    const handler = new Function('document', 'mainAgentId', 't', 'currentAgent', `return ${src}`)(
      { getElementById: (id: string) => els[id] }, () => 'marveen',
      (k: string, p: Record<string, unknown>) => `${k} ${JSON.stringify(p)}`, { name: 'kutato', displayName: 'Teszt Elek' })
    handler()
    expect(els.agentRenameInput.value).toBe('Teszt Elek')
    expect(els.agentRenameHint.textContent).toBe('agents.rename.hint {"id":"kutato","default":"Kutato"}')
    expect(els.agentRenameForm.hidden).toBe(false)
    expect(els.agentDetailNameRow.hidden).toBe(true)
  })

  it('the button and the toast say display name: the id is not renamed, so they promise no real rename', () => {
    expect(HU).toContain("'agents.rename.btn_title': 'Megjelenített név módosítása'")
    expect(HU).toContain("'agents.rename.saved': 'Megjelenített név mentve: {name}'")
    expect(EN).toContain("'agents.rename.btn_title': 'Change display name'")
    expect(EN).toContain("'agents.rename.saved': 'Display name saved: {name}'")
    expect(HTML).toContain('id="agentRenameBtn" hidden title="Megjelenített név módosítása"')
  })

  it('both languages say what an empty save does, with the {default} placeholder', () => {
    for (const lang of [HU, EN]) expect(lang).toMatch(/'agents\.rename\.hint': '[^'\n]*\{id\}[^'\n]*\{default\}[^'\n]*'/)
  })
})

describe('saving the name', () => {
  it('a new name: PUT {displayName}, the window shows the stored name, green toast, the lists and the graph redrawn', async () => {
    const { log, els, state } = await runSave({ typed: '  Kati ', body: { ok: true, displayName: 'Kati' } })
    expect(log).toEqual([
      'preventDefault',
      'fetch PUT /api/agents/tete {"displayName":"Kati"}',
      'toast success agents.rename.saved {"name":"Kati"}',
      'loadAgents',
      'refreshVisibleTeamGraphs',
    ])
    expect(els.agentDetailTitle.textContent).toBe('Kati')
    expect(els.agentDetailName.textContent).toBe('Kati')
    expect(els.agentDetailAvatar.textContent).toBe('K')
    expect(els.agentRenameForm.hidden).toBe(true)
    expect(els.agentDetailNameRow.hidden).toBe(false)
    expect(state.currentAgent?.displayName).toBe('Kati')
  })

  it('the server\'s cleaned name wins over what was typed; an avatar image only gets the new alt', async () => {
    const { els, img } = await runSave({ typed: 'Kati\tB', body: { ok: true, displayName: 'Kati B' }, hasImage: true })
    expect(els.agentDetailName.textContent).toBe('Kati B')
    expect(img?.alt).toBe('Kati B')
    expect(els.agentDetailAvatar.textContent).toBe('O')
  })

  it('the same name: nothing is sent, the form closes', async () => {
    const { log, els } = await runSave({ typed: ' Tete ' })
    expect(log).toEqual(['preventDefault'])
    expect(els.agentRenameForm.hidden).toBe(true)
  })

  it('a name the server refuses as invalid: the form stays open with the translated reason in red', async () => {
    const { log, els } = await runSave({ typed: '@x', status: 400, body: { error: 'invalid_display_name' } })
    expect(log).toEqual([
      'preventDefault',
      'fetch PUT /api/agents/tete {"displayName":"@x"}',
      'toast error common.not_done {"msg":"agents.rename.invalid"}',
      'focus',
    ])
    expect(els.agentRenameForm.hidden).toBe(false)
    expect(els.agentDetailName.textContent).toBe('old')
  })

  it('another refusal (403, no owner session): the server\'s reason in red, nothing redrawn', async () => {
    const { log } = await runSave({ typed: 'Kati', status: 403, body: { error: 'owner session required' } })
    expect(log.slice(2)).toEqual(['toast error common.not_done {"msg":"owner session required"}', 'focus'])
  })

  it('a network error: the save error in red', async () => {
    const { log } = await runSave({ typed: 'Kati', throws: true })
    expect(log.slice(2)).toEqual(['toast error common.error_save'])
  })

  it('the main agent: nothing is sent', async () => {
    const { log } = await runSave({ agent: { name: 'marveen' }, typed: 'X' })
    expect(log).toEqual(['preventDefault'])
  })

  it('the window moved to another agent meanwhile: only the lists are redrawn, the other agent is not touched', async () => {
    const state = { currentAgent: { name: 'tete', displayName: 'Tete' } as { name: string; displayName?: string } }
    const log: string[] = []
    const els: Record<string, any> = {
      agentRenameInput: { value: 'Kati', focus() {} }, agentRenameSave: { disabled: false },
      agentDetailTitle: { textContent: 'Etet' }, agentDetailName: { textContent: 'Etet' },
      agentDetailAvatar: { textContent: 'E', querySelector: () => null },
      agentRenameForm: { hidden: true }, agentDetailNameRow: { hidden: false }, agentRenameBtn: { hidden: false },
    }
    const document = { getElementById: (id: string) => els[id] }
    const readActionReply = new Function(`async ${fnSrc('readActionReply')}; return readActionReply`)()
    const resetAgentRename = new Function('document', `${fnSrc('resetAgentRename')}; return resetAgentRename`)(document)
    const handler = new Function('document', 'mainAgentId', 't', 'fetch', 'showToast', 'loadAgents', 'refreshVisibleTeamGraphs',
      'refusalReason', 'readActionReply', 'resetAgentRename', 'state', `with (state) { return ${submitSrc()} }`)(
      document, () => 'marveen', (k: string) => k,
      async () => { state.currentAgent = { name: 'etet', displayName: 'Etet' }; return { ok: true, status: 200, json: async () => ({ ok: true, displayName: 'Kati' }) } },
      (m: string, k: string) => log.push(`toast ${k} ${m}`), () => log.push('loadAgents'), () => log.push('refreshVisibleTeamGraphs'),
      () => '', readActionReply, resetAgentRename, state)
    await handler({ preventDefault() {} })
    expect(els.agentDetailName.textContent).toBe('Etet')
    expect(state.currentAgent.displayName).toBe('Etet')
    expect(log).toEqual(['toast success agents.rename.saved', 'loadAgents', 'refreshVisibleTeamGraphs'])
  })
})
