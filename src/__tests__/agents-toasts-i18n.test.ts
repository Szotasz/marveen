// The Agents page's toasts come from the language files: the agent wizard, the start, stop and
// main restart buttons, the single and the fleet export, and the import; so do the labels of the
// export and import buttons. They used to be Hungarian strings in app.js and index.html, so an
// English dashboard showed them in Hungarian.
// The real handlers run here against the real t() and both language files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU_SRC = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN_SRC = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const I18N = (() => {
  const window: { _i18n?: Record<string, Record<string, string>> } = {}
  new Function('window', `${HU_SRC}\n${EN_SRC}`)(window)
  return window._i18n!
})()

// The real t() from the top of app.js, with the language picked per call.
const T_SRC = (() => {
  const i = APP.indexOf('window.t = function t(')
  const end = APP.indexOf('\n  }\n', i)
  return APP.slice(APP.indexOf('function t(', i), end + 4)
})()
function makeT(lang: 'hu' | 'en') {
  const window = { _lang: lang, _i18n: I18N, _brandTokens: { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' } }
  return new Function('window', 'localStorage', `return ${T_SRC}`)(window, { getItem: () => null }) as (k: string, p?: Record<string, unknown>) => string
}

// The handler (an async arrow) that follows `anchor`, up to its matching closing brace.
function arrowAfter(anchor: string): string {
  const i = APP.indexOf(anchor)
  if (i < 0) return ''
  const start = APP.indexOf('async () => {', i)
  let depth = 0
  for (let j = APP.indexOf('{', start); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1)
  }
  return ''
}

const WIZARD_NEXT = arrowAfter("document.getElementById('wizardNextBtn').addEventListener('click', ")
const WIZARD_CREATE = arrowAfter("document.getElementById('wizardCreateBtn').addEventListener('click', ")
const RESTART_MAIN = arrowAfter("document.getElementById('marveenRestartBtn').addEventListener('click', ")
const START = arrowAfter("document.getElementById('agentStartBtn').addEventListener('click', ")
const STOP = arrowAfter("document.getElementById('agentStopBtn').addEventListener('click', ")
const EXPORT_ONE = arrowAfter("document.getElementById('exportAgentBtn').onclick = ")
const EXPORT_ALL = arrowAfter("exportAllAgentsBtn.addEventListener('click', ")
const IMPORT = arrowAfter("importAgentFile.addEventListener('change', ")
const HANDLERS = { WIZARD_NEXT, WIZARD_CREATE, RESTART_MAIN, START, STOP, EXPORT_ONE, EXPORT_ALL, IMPORT }

const btn = () => {
  const part = { hidden: false }
  return { disabled: false, textContent: '', querySelector: () => part }
}

describe('the Agents page toasts come from the language files', () => {
  it('the handlers were found, and none of them holds a Hungarian string any more', () => {
    for (const [name, src] of Object.entries(HANDLERS)) {
      expect(src, name).not.toBe('')
      const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code, name).not.toMatch(/[áéíóöőúüű]/i)
      expect(code, name).not.toMatch(/'Hiba|`Hiba|Ismeretlen|Ugynok|exportálva|importálva/)
    }
  })

  it('an error is shown as "<common.error>: <message>" at all five places', () => {
    for (const src of [WIZARD_NEXT, WIZARD_CREATE, RESTART_MAIN, START, STOP]) {
      expect(src).toContain("showToast(`${t('common.error')}: ${err.message}`)")
    }
  })

  it.each([
    ['hu', 'Hiba: boom'],
    ['en', 'Error: boom'],
  ] as const)('a failed start says so in the dashboard language (%s)', async (lang, want) => {
    const toasts: string[] = []
    const handler = new Function('currentAgent', 'document', 'fetch', 't', 'showToast', 'updateProcessControl', 'loadAgents', `return ${START}`)(
      { name: 'anna' }, { getElementById: btn },
      async () => { throw new Error('boom') },
      makeT(lang), (m: string) => { toasts.push(m) }, () => {}, () => {},
    ) as () => Promise<void>
    await handler()
    expect(toasts).toEqual([want])
  })

  describe('the wizard', () => {
    async function create(lang: 'hu' | 'en', res: { ok: boolean; data: Record<string, unknown> }) {
      const toasts: string[] = []
      const field = { value: '' }
      const handler = new Function(
        'wizardCreatedName', 'wizardTextsLoaded', 'agentName', 'document', 'fetch', 't', 'showToast', 'closeModal', 'agentWizardOverlay',
        'loadAgents', 'openAgentDetail', 'switchAgentTab', `return ${WIZARD_CREATE}`,
      )(
        'anna', true, field, { getElementById: (id: string) => (id === 'wizardCreateBtn' ? btn() : field) },
        async () => ({ ok: res.ok, json: async () => res.data }),
        makeT(lang), (m: string) => { toasts.push(m) }, () => {}, {}, async () => {}, async () => {}, () => {},
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('says the agent was created and its channel is to be connected, in both languages', async () => {
      expect(await create('hu', { ok: true, data: {} })).toEqual(['Ügynök létrehozva. Kösd be a csatornáját a párosításhoz.'])
      expect(await create('en', { ok: true, data: {} })).toEqual(['Agent created. Connect its channel to pair it.'])
    })

    it('a failure without a server error falls back to "unknown" in the dashboard language', async () => {
      expect(await create('hu', { ok: false, data: {} })).toEqual(['Hiba: Ismeretlen'])
      expect(await create('en', { ok: false, data: {} })).toEqual(['Error: Unknown'])
      expect(await create('en', { ok: false, data: { error: 'Name taken' } })).toEqual(['Error: Name taken'])
    })
  })

  // #2845: Back from step 3 then Next sent a second POST /api/agents (409, or a second agent after a rename), and any
  // error after a successful create threw the operator back to step 1.
  describe('the wizard Next after the agent exists', () => {
    function wizard(fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>) {
      const els: Record<string, { value: string; textContent: string; focus(): void }> = {}
      const el = (id: string) => (els[id] ??= { value: id === 'agentProfile' ? 'default' : '', textContent: '', focus() {} })
      const toasts: string[] = []
      const posts: string[] = []
      const f = async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'POST' && url === '/api/agents') posts.push(JSON.parse(init.body!).name)
        return fetchImpl(url, init)
      }
      const w = new Function(
        'agentName', 'agentDesc', 'agentModel', 'document', 'fetch', 't', 'showToast', 'updateWizardUI',
        'renderWizardPendingBanner', 'setTimeout', 'FormData', 'selectedAvatarFile', 'selectedAvatar',
        `let wizardStep = 1, wizardCreatedName = '', wizardTextsLoaded = false, wizardPersonalityPending = null, generatedClaudeMd = '', generatedSoulMd = ''
        return { next: ${WIZARD_NEXT}, back() { wizardStep = 1 }, state: () => ({ wizardStep, wizardCreatedName }) }`,
      )(
        el('agentName'), el('agentDesc'), { value: 'inherit' }, { getElementById: el }, f, makeT('en'),
        (m: string) => { toasts.push(m) }, () => {}, () => {}, (fn: () => void) => fn(), class {}, null, null,
      ) as { next(): Promise<void>; back(): void; state(): { wizardStep: number; wizardCreatedName: string } }
      el('agentName').value = 'anna'
      el('agentDesc').value = 'does things'
      return { w, el, toasts, posts }
    }
    const created = async (url: string) => (url === '/api/agents'
      ? { ok: true, json: async () => ({ name: 'anna' }) }
      : { ok: true, json: async () => ({ claudeMd: '# a', soulMd: 's' }) })

    it('Back then Next goes to step 3 without a second POST, also after a rename', async () => {
      const { w, el, toasts, posts } = wizard(created)
      await w.next()
      expect(w.state()).toEqual({ wizardStep: 3, wizardCreatedName: 'anna' })
      w.back()
      el('agentName').value = 'bella'
      await w.next()
      expect(posts).toEqual(['anna'])
      expect(w.state()).toEqual({ wizardStep: 3, wizardCreatedName: 'anna' })
      expect(toasts.at(-1)).toBe('The agent already exists (anna). Changes on the first step are not applied; you continue with the existing agent.')
    })

    it('a failed POST goes back to step 1; an error after the create does not', async () => {
      const failed = wizard(async () => ({ ok: false, json: async () => ({ error: 'boom' }) }))
      await failed.w.next()
      expect(failed.w.state()).toEqual({ wizardStep: 1, wizardCreatedName: '' })
      expect(failed.toasts).toEqual(['Error: boom'])

      const later = wizard(async (url) => { if (url === '/api/agents') return created(url); throw new Error('net') })
      await later.w.next()
      expect(later.w.state()).toEqual({ wizardStep: 3, wizardCreatedName: 'anna' })
      expect(later.toasts).toEqual(['Error: net'])
      expect(later.posts).toEqual(['anna'])
    })

    it('Create leaves out a text that never loaded and is still empty, so the generated file stays', async () => {
      const bodies: string[] = []
      const field = { value: '' }
      const run = (loaded: boolean) => (new Function(
        'wizardCreatedName', 'wizardTextsLoaded', 'agentName', 'document', 'fetch', 't', 'showToast', 'closeModal', 'agentWizardOverlay',
        'loadAgents', 'openAgentDetail', 'switchAgentTab', `return ${WIZARD_CREATE}`,
      )(
        'anna', loaded, field, { getElementById: (id: string) => (id === 'wizardCreateBtn' ? btn() : id === 'wizardSoulMd' ? { value: 'typed' } : field) },
        async (_u: string, init: { body: string }) => { bodies.push(init.body); return { ok: true, json: async () => ({}) } },
        makeT('en'), () => {}, () => {}, {}, async () => {}, async () => {}, () => {},
      ) as () => Promise<void>)()
      await run(false)
      await run(true)
      expect(bodies).toEqual([JSON.stringify({ soulMd: 'typed' }), JSON.stringify({ claudeMd: '', soulMd: 'typed' })])
    })

    it('the new toast is in both language files', () => {
      expect(makeT('hu')('agents.wizard.already_created', { name: 'anna' })).toContain('anna')
      expect(I18N.hu['agents.wizard.already_created']).toBeTruthy()
      expect(I18N.en['agents.wizard.already_created']).toBeTruthy()
    })
  })

  describe('the exports', () => {
    async function run(src: string, lang: 'hu' | 'en', withSecrets: boolean, fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const fake = { href: '', download: '', click() {}, remove() {} }
      const handler = new Function('askAgentExport', 't', 'currentAgent', 'fetch', 'showToast', 'URL', 'document', `return ${src}`)(
        async () => ({ withSecrets }), makeT(lang), { name: 'anna' }, fetchImpl,
        (m: string) => { toasts.push(m) }, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        { createElement: () => fake, body: { appendChild: () => {} } },
      ) as () => Promise<void>
      await handler()
      return toasts
    }
    const ok = async () => ({ ok: true, blob: async () => ({}) })
    const throws = async () => { throw new Error('net') }
    const refused = (data: Record<string, unknown>) => async () => ({ ok: false, json: async () => data })

    it.each([
      ['one agent', () => EXPORT_ONE, 'Ügynök exportálva', 'Agent exported'],
      ['the fleet', () => EXPORT_ALL, 'Flotta exportálva', 'Fleet exported'],
    ])('%s: done, done with secrets, and the error, in both languages', async (_n, src, hu, en) => {
      expect(await run(src(), 'hu', false, ok)).toEqual([hu])
      expect(await run(src(), 'hu', true, ok)).toEqual([`${hu} (titkokkal)`])
      expect(await run(src(), 'en', false, ok)).toEqual([en])
      expect(await run(src(), 'en', true, ok)).toEqual([`${en} (with secrets)`])
      expect(await run(src(), 'hu', false, throws)).toEqual(['Hiba az exportálás során'])
      expect(await run(src(), 'en', false, throws)).toEqual(['Error while exporting'])
      expect(await run(src(), 'en', false, refused({}))).toEqual(['Error while exporting'])
      // The server's own error still wins over the generic text.
      expect(await run(src(), 'en', false, refused({ error: 'Agent not found' }))).toEqual(['Agent not found'])
    })
  })

  it('the export and import buttons are labelled from the language files too', () => {
    const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
    const t = { hu: makeT('hu'), en: makeT('en') }
    for (const [id, key, hu, en] of [
      ['exportAllAgentsBtn', 'agents.page.export_all_btn', 'Összes exportálása', 'Export all'],
      ['importAgentBtn', 'agents.page.import_btn', 'Ügynök importálása', 'Import agent'],
      ['exportAgentBtn', 'agents.export.confirm_ok', 'Exportálás', 'Export'],
    ]) {
      const tag = new RegExp(`<button [^>]*id="${id}"[^>]*>`).exec(HTML)?.[0] ?? ''
      expect(tag, id).toContain(`data-i18n="${key}"`)
      expect(t.hu(key), id).toBe(hu)
      expect(t.en(key), id).toBe(en)
    }
  })

  describe('the import', () => {
    async function run(lang: 'hu' | 'en', reply: { status: number; data: Record<string, unknown> } | 'throw') {
      const toasts: string[] = []
      class FakeForm { append() {} }
      const handler = new Function('importAgentFile', 'FormData', 'fetch', 'confirmDialog', 't', 'showToast', 'loadAgents', `return ${IMPORT}`)(
        { files: [{ name: 'b.tar.gz' }], value: 'b.tar.gz' }, FakeForm,
        async () => {
          if (reply === 'throw') throw new Error('net')
          return { status: reply.status, ok: reply.status < 300, json: async () => reply.data }
        },
        async () => false, makeT(lang), (m: string) => { toasts.push(m) }, () => {},
      ) as () => Promise<void>
      await handler()
      return toasts
    }

    it('one agent: the name, then "with secrets" and "overwritten" when they apply', async () => {
      const plain = { status: 200, data: { ok: true, kind: 'agent', name: 'anna' } }
      const full = { status: 200, data: { ok: true, kind: 'agent', name: 'anna', includedSecrets: true, overwritten: true } }
      expect(await run('hu', plain)).toEqual(['Ügynök importálva: anna'])
      expect(await run('hu', full)).toEqual(['Ügynök importálva: anna (titkokkal) (felülírva)'])
      expect(await run('en', plain)).toEqual(['Agent imported: anna'])
      expect(await run('en', full)).toEqual(['Agent imported: anna (with secrets) (overwritten)'])
    })

    it('a fleet: the count, then "with secrets" and the skipped count when they apply', async () => {
      const fleet = (extra: Record<string, unknown>) => ({ status: 200, data: { ok: true, kind: 'fleet', imported: [{ name: 'a' }, { name: 'b' }], skipped: [], ...extra } })
      expect(await run('hu', fleet({}))).toEqual(['Flotta importálva: 2 ügynök'])
      expect(await run('hu', fleet({ includedSecrets: true, skipped: [{ name: 'x!', reason: 'invalid name' }] }))).toEqual(['Flotta importálva: 2 ügynök (titkokkal) (1 kihagyva)'])
      expect(await run('en', fleet({}))).toEqual(['Fleet imported: 2 agent(s)'])
      // Review of #2754: a one-agent bundle read "1 agents" in English.
      expect(await run('en', fleet({ imported: [{ name: 'a' }] }))).toEqual(['Fleet imported: 1 agent(s)'])
      expect(await run('hu', fleet({ imported: [{ name: 'a' }] }))).toEqual(['Flotta importálva: 1 ügynök'])
      expect(await run('en', fleet({ includedSecrets: true, skipped: [{ name: 'x!', reason: 'invalid name' }] }))).toEqual(['Fleet imported: 2 agent(s) (with secrets) (1 skipped)'])
    })

    it('the error, in both languages; the server error still wins', async () => {
      expect(await run('hu', 'throw')).toEqual(['Hiba az importálás során'])
      expect(await run('en', 'throw')).toEqual(['Error while importing'])
      expect(await run('en', { status: 400, data: {} })).toEqual(['Error while importing'])
      expect(await run('en', { status: 400, data: { error: 'Not a bundle' } })).toEqual(['Not a bundle'])
    })
  })
})
