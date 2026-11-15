// The last block of the hardcoded toasts in app.js: the skill import, the schedule save, the catalog
// install and uninstall, the connector save, the memory import, the migration scan and run, the
// autonomy level, the agent login, the voice settings, the auth URL copy, the .mcp.json save and the
// terminal input toasts. They were Hungarian strings ("Hiba: …", "Hangbeállítás mentve", "URL masolva"),
// or English ones on the terminal, so the dashboard showed them in one language whatever it was set to.
// After the earlier blocks (#2754, #2771, #2792) no toast in app.js is a string literal any more; the
// file-wide checks below keep it that way. The real handlers run here against the real t(). The skill
// import's own fallback ('Import hiba', when the server sends no error) followed in a review follow-up.
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

const T_SRC = (() => {
  const i = APP.indexOf('window.t = function t(')
  const end = APP.indexOf('\n  }\n', i)
  return APP.slice(APP.indexOf('function t(', i), end + 4)
})()
type T = (k: string, p?: Record<string, unknown>) => string
function makeT(lang: 'hu' | 'en'): T {
  const window = { _lang: lang, _i18n: I18N, _brandTokens: { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' } }
  return new Function('window', 'localStorage', `return ${T_SRC}`)(window, { getItem: () => null }) as T
}

// From `anchor` (where `opener` starts) up to the matching closing brace of the body.
function block(anchor: string, opener: string): string {
  const i = APP.indexOf(anchor)
  if (i < 0) return ''
  const start = APP.indexOf(opener, i)
  let depth = 0
  const body = opener.endsWith('=> {') ? start + opener.length - 1 : APP.indexOf(') {', start) + 2
  for (let j = body; j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1)
  }
  return ''
}
const arrow = (anchor: string) => block(anchor, 'async () => {')
const fn = (name: string) => block(`\nasync function ${name}(`, 'async function')

const ERROR_SITES = {
  importSkill: arrow("document.getElementById('importSkillBtn').addEventListener('click', "),
  saveSchedule: arrow("saveScheduleBtn.addEventListener('click', "),
  catalogInstall: arrow("document.getElementById('catalogInstallBtn').addEventListener('click', "),
  catalogUninstall: fn('catalogUninstall'),
  saveConnector: arrow("document.getElementById('saveConnectorBtn').addEventListener('click', "),
  migrateScan: arrow("document.getElementById('migrateScanBtn').addEventListener('click', "),
  migrateRun: arrow("document.getElementById('migrateRunBtn').addEventListener('click', "),
}
const VOICE_SAVE = arrow("document.getElementById('saveVoiceConfigBtn').addEventListener('click', ")
const AUTONOMY = fn('setAutonomyLevel')
const LOGIN = fn('handleAgentLogin')
const MEM_IMPORT = arrow("memImportSaveBtn.addEventListener('click', ")
const TERMINAL_TOGGLE = (() => {
  const i = APP.indexOf("document.getElementById('terminalInputToggle')?.addEventListener('change', (e) => {")
  return i < 0 ? '' : APP.slice(i, APP.indexOf('\n})\n', i) + 3)
})()

describe('no toast in app.js is a hardcoded string any more', () => {
  it('no showToast() gets a string literal (a template must start with a t() call)', () => {
    const calls = APP.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /showToast\(\s*(['"]|`(?!\$\{t\())/.test(l))
    expect(calls).toEqual([])
  })

  it('no showToast() or thrown error falls back to a Hungarian literal', () => {
    const hits = APP.split('\n').map((l, i) => [i + 1, l.trim()] as const)
      .filter(([, l]) => /showToast\(|throw new Error\(/.test(l))
      // A Hungarian word anywhere in the literal, not only at its start ('Import hiba' got past that).
      .filter(([, l]) => /'[^']*[áéíóöőúüű][^']*'|'[^']*\b(Hiba|Ismeretlen|Sikertelen)\b[^']*'/i.test(l))
    expect(hits).toEqual([])
  })

  it('the seven error toasts use the "<common.error>: <message>" pattern', () => {
    for (const [name, src] of Object.entries(ERROR_SITES)) {
      expect(src, name).toContain("showToast(`${t('common.error')}: ${err.message}`)")
      expect(src, name).not.toContain('Hiba')
    }
  })

  it('the six fallbacks without a server error read "<error>: <failed>"', () => {
    expect(ERROR_SITES.importSkill).toContain("throw new Error(err.error || t('common.failed'))")
    const save = ERROR_SITES.saveSchedule
    expect(save.match(/throw new Error\(err\.error \|\| t\('common\.failed'\)\)/g)).toHaveLength(2)
    expect(ERROR_SITES.saveConnector).toContain("throw new Error(err.error || t('common.failed'))")
    expect(ERROR_SITES.migrateScan).toContain("throw new Error(data.error || t('common.failed'))")
    expect(ERROR_SITES.migrateRun).toContain("throw new Error(data.error || t('common.failed'))")
  })
})

describe('the new keys, in both languages', () => {
  it.each([
    ['agents.mcp_json_saved', '.mcp.json mentve', '.mcp.json saved'],
    ['agents.voice.saved', 'Hangbeállítás mentve', 'Voice settings saved'],
    ['agents.voice.install_error', 'Hiba a telepítés során', 'Error while installing'],
    ['terminal.input_off', 'A terminálbevitel ki van kapcsolva. Előbb kapcsold be a fejléc kapcsolójával.', 'Terminal input is off. Enable it with the header toggle first.'],
    ['terminal.input_enabled', 'Terminálbevitel bekapcsolva (naplózva)', 'Terminal input enabled (audit-logged)'],
    ['terminal.input_disabled', 'Terminálbevitel kikapcsolva', 'Terminal input disabled'],
    ['terminal.input_toggle_failed', 'Nem sikerült átállítani a terminálbevitelt', 'Could not change terminal input state'],
  ])('%s', (key, hu, en) => {
    expect(makeT('hu')(key)).toBe(hu)
    expect(makeT('en')(key)).toBe(en)
  })
})

describe('the handlers speak the dashboard language', () => {
  it.each(['hu', 'en'] as const)('the voice settings: saved, and the error (%s)', async (lang) => {
    const t = makeT(lang)
    async function run(fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const handler = new Function('currentAgent', 'document', 'fetch', 'readActionReply', 'refusalReason', 'showToast', 't', `return ${VOICE_SAVE}`)(
        { name: 'anna' },
        { querySelector: () => ({ value: 'voice' }), getElementById: () => ({ value: 'tiny' }) },
        fetchImpl, async () => ({ ok: true, body: {} }), () => '', (m: string) => { toasts.push(m) }, t,
      ) as () => Promise<void>
      await handler()
      return toasts
    }
    expect(await run(async () => ({ ok: true }))).toEqual([t('agents.voice.saved')])
    expect(await run(async () => { throw new Error('net') })).toEqual([t('common.error_save')])
  })

  it.each([
    ['hu', 'Hiba: Sikertelen'],
    ['en', 'Error: Failed'],
  ] as const)('the skill import refused without a server error (%s)', async (lang, want) => {
    async function run(reply: Record<string, unknown>) {
      const toasts: string[] = []
      const part = { hidden: false }
      const btn = { disabled: false, querySelector: () => part }
      const handler = new Function('skillModalScope', 'skillFile', 'currentAgent', 'document', 'FormData', 'fetch', 'agentApiName', 'showToast', 't', 'closeModal', 'skillModalOverlay', 'loadGlobalSkills', 'loadSkills', `return ${ERROR_SITES.importSkill}`)(
        'global', { name: 'x.zip' }, null, { getElementById: () => btn }, class { append() {} },
        async () => ({ ok: false, json: async () => reply }), () => 'anna', (m: string) => { toasts.push(m) }, makeT(lang),
        () => {}, null, () => {}, () => {},
      ) as () => Promise<void>
      await handler()
      expect(btn.disabled).toBe(false)
      return toasts
    }
    expect(await run({})).toEqual([want])
    // A server error text still goes through as it is.
    expect(await run({ error: 'bad zip' })).toEqual([want.replace(/: .*/, ': bad zip')])
  })

  it.each(['hu', 'en'] as const)('the autonomy level: a refusal without a server error (%s)', async (lang) => {
    const t = makeT(lang)
    const toasts: string[] = []
    const handler = new Function('fetch', 'showToast', 't', 'document', `return ${AUTONOMY}`)(
      async () => ({ ok: false, json: async () => ({}) }), (m: string) => { toasts.push(m) }, t, { getElementById: () => null },
    ) as (k: string, l: string) => Promise<void>
    await handler('k', 'auto')
    expect(toasts).toEqual([t('common.error_save')])
  })

  it.each([
    ['hu', 'Hiba: boom'],
    ['en', 'Error: boom'],
  ] as const)('the agent login failure (%s)', async (lang, want) => {
    const toasts: string[] = []
    const btn = { dataset: {} as Record<string, string>, disabled: false, textContent: 'Login' }
    const handler = new Function('fetch', 'showToast', 't', 'readActionReply', 'refusalReason', 'loadAgents', `return ${LOGIN}`)(
      async () => { throw new Error('boom') }, (m: string) => { toasts.push(m) }, makeT(lang), async () => ({}), () => '', () => {},
    ) as (n: string, b: unknown) => Promise<void>
    await handler('anna', btn)
    expect(toasts).toEqual([want])
    expect(btn.textContent).toBe('Login')
  })

  it.each([
    ['hu', 'Hiba: Ismeretlen'],
    ['en', 'Error: Unknown'],
  ] as const)('the memory import refused without a server error (%s)', async (lang, want) => {
    expect(MEM_IMPORT).toContain("showToast(`${t('common.error')}: ${data.error || t('common.unknown')}`)")
    const t = makeT(lang)
    // Without a server error the toast is the two keys joined, as the line above builds it.
    expect(`${t('common.error')}: ${t('common.unknown')}`).toBe(want)
  })

  it.each(['hu', 'en'] as const)('the terminal input switch: enabled, disabled, and the failure (%s)', async (lang) => {
    const t = makeT(lang)
    async function flip(desired: boolean, reply: { enabled: boolean } | 'throw') {
      const toasts: string[] = []
      let listener: ((e: { target: { checked: boolean } }) => void) | null = null
      const state = { enabled: !desired }
      const register = new Function('document', 'fetch', 'readActionReply', 'refusalReason', 'showToast', 't', 'syncTerminalInputToggleUI', 'terminalInputEnabled',
        `${TERMINAL_TOGGLE}`,
      )
      let done: () => void = () => {}
      const settled = new Promise<void>((r) => { done = r })
      register(
        { getElementById: () => ({ addEventListener: (_: string, fn: typeof listener) => { listener = fn } }) },
        async () => { if (reply === 'throw') throw new Error('net'); return { ok: true } },
        async () => ({ ok: true, body: reply === 'throw' ? {} : reply }),
        () => '', (m: string) => { toasts.push(m); done() }, t, () => {}, state.enabled,
      )
      listener!({ target: { checked: desired } })
      await settled
      return toasts
    }
    expect(await flip(true, { enabled: true })).toEqual([t('terminal.input_enabled')])
    expect(await flip(false, { enabled: false })).toEqual([t('terminal.input_disabled')])
    expect(await flip(true, 'throw')).toEqual([t('terminal.input_toggle_failed')])
  })

  it('the terminal keystroke with the input off says so through its key', () => {
    const i = APP.indexOf('if (!terminalInputEnabled) {')
    expect(APP.slice(i, i + 400)).toContain("showToast(t('terminal.input_off'))")
  })

  it('the auth URL copy, the .mcp.json save and the voice install error use their keys', () => {
    expect(APP).toContain("navigator.clipboard.writeText(url).then(() => showToast(t('common.toast.copied')))")
    const mcp = APP.slice(APP.indexOf("document.getElementById('saveMcpJsonBtn')"))
    expect(mcp.slice(0, mcp.indexOf('\n})\n'))).toContain("showToast(t('agents.mcp_json_saved'))")
    expect(APP).toContain("showToast(t('agents.voice.install_error'))")
  })
})
