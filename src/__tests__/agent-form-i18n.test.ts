// HOSTINGERI18NFU2: Hungarian text on the new-agent form of an English install, measured on a throwaway English
// instance after #3133. Each block pins one fix.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const HTML = read('../../web/index.html')

const loadDict = (lang: 'hu' | 'en'): Record<string, string> => {
  const sandbox = { window: {} as { _i18n?: Record<string, Record<string, string>> } }
  vm.runInNewContext(read(`../../web/lang/${lang}.js`), sandbox)
  return sandbox.window._i18n![lang]
}
const HU = loadDict('hu')
const EN = loadDict('en')

describe('the "or" divider between the avatar grid and the upload box', () => {
  it('both dividers (create form, edit panel) carry the key, none is raw text', () => {
    const dividers = [...HTML.matchAll(/<div class="avatar-upload-divider">(.*?)<\/div>/g)].map(m => m[1])
    expect(dividers).toHaveLength(2)
    for (const d of dividers) expect(d).toBe('<span data-i18n="agents.wizard.avatar_or">vagy</span>')
  })

  it('reads "or" in English and stays "vagy" in Hungarian', () => {
    expect(EN['agents.wizard.avatar_or']).toBe('or')
    expect(HU['agents.wizard.avatar_or']).toBe('vagy')
  })
})

// The profile select, run from app.js's own source with a minimal DOM: the shipped default template's Hungarian
// text gets the viewer's language, an edited template and an unknown profile keep the server's text.
const APP = read('../../web/app.js')
const slice = (from: string, to: string) => {
  const a = APP.indexOf(from)
  const b = APP.indexOf(to, a)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return APP.slice(a, b)
}
const DEFAULT_TEMPLATE = JSON.parse(read('../../templates/profiles/default.json')) as { id: string; label: string; description: string; permissionMode: string }

type FakeEl = { value: string; textContent: string; dataset: Record<string, string>; selected?: boolean; options?: FakeEl[]; onchange?: () => void }
function renderProfiles(lang: 'hu' | 'en', profiles: unknown[], selected = 'default') {
  const select: FakeEl & { innerHTML: string; appendChild: (o: FakeEl) => void; prepend: (o: FakeEl) => void } = {
    value: '', textContent: '', dataset: {}, options: [],
    set innerHTML(_v: string) { this.options = [] },
    get innerHTML() { return '' },
    appendChild(o: FakeEl) { this.options!.push(o); if (o.selected || this.options!.length === 1) this.value = o.value },
    prepend(o: FakeEl) { this.options!.unshift(o); if (o.selected) this.value = o.value },
  }
  const desc: FakeEl = { value: '', textContent: '', dataset: {} }
  const window = { _i18n: { hu: HU, en: EN }, _lang: lang }
  const t = (key: string, params: Record<string, string> = {}) => {
    const s = window._i18n[window._lang][key] ?? window._i18n.en[key] ?? key
    return s.replace(/\{(\w+)\}/g, (_m: string, k: string) => params[k] ?? `{${k}}`)
  }
  const ctx = {
    window, t, Promise,
    document: { createElement: () => ({ value: '', textContent: '', dataset: {} }) },
    loadProfiles: () => ({ then: (cb: (p: unknown[]) => void) => cb(profiles) }),
  }
  vm.runInNewContext(slice('function profileTextKey(', '// Populate the per-agent Claude subscription plan dropdown') + '\npopulateProfileSelect(select, desc, selected)', { ...ctx, select, desc, selected })
  return { select, desc }
}

describe('the security profile select', () => {
  it('the Hungarian keys hold the shipped default template text exactly (else the match below never holds)', () => {
    expect(HU['agents.profile.default.label']).toBe(DEFAULT_TEMPLATE.label)
    expect(HU['agents.profile.default.description']).toBe(DEFAULT_TEMPLATE.description)
  })

  it('an English viewer sees the default profile in English, keyed for a later language switch', () => {
    const { select, desc } = renderProfiles('en', [DEFAULT_TEMPLATE])
    const opt = select.options!.find(o => o.value === 'default')!
    expect(opt.textContent).toBe('Default (compatibility)')
    expect(opt.dataset.i18n).toBe('agents.profile.default.label')
    expect(desc.textContent).toBe(EN['agents.profile.default.description'])
    expect(desc.dataset.i18n).toBe('agents.profile.default.description')
    expect(/[áéíóöőúüű]/i.test(opt.textContent + desc.textContent)).toBe(false)
  })

  it('a Hungarian viewer sees exactly what the template says', () => {
    const { select, desc } = renderProfiles('hu', [DEFAULT_TEMPLATE])
    expect(select.options!.find(o => o.value === 'default')!.textContent).toBe(DEFAULT_TEMPLATE.label)
    expect(desc.textContent).toBe(DEFAULT_TEMPLATE.description)
  })

  it('an edited template is shown as written, in either language, and carries no key', () => {
    const edited = { ...DEFAULT_TEMPLATE, label: 'Saját alap', description: 'Saját leírás' }
    const { select, desc } = renderProfiles('en', [edited])
    const opt = select.options!.find(o => o.value === 'default')!
    expect(opt.textContent).toBe('Saját alap')
    expect(opt.dataset.i18n).toBeUndefined()
    expect(desc.textContent).toBe('Saját leírás')
    expect(desc.dataset.i18n).toBeUndefined()
  })

  it('a profile without a key keeps the server text, and selecting it drops the description key', () => {
    const other = { id: 'sub-dev', label: 'Sub-dev (Supabase MCP denied)', description: 'Full-stack sub-developer.', permissionMode: 'permissive' }
    const { select, desc } = renderProfiles('en', [DEFAULT_TEMPLATE, other])
    expect(select.options!.find(o => o.value === 'sub-dev')!.textContent).toBe(other.label)
    select.value = 'sub-dev'
    select.onchange!()
    expect(desc.textContent).toBe(other.description)
    expect(desc.dataset.i18n).toBeUndefined()
  })
})

// The DeepSeek / MiniMax option labels: the server sends Hungarian; the form shows the viewer's language by model id.
describe('the server-labelled model options', () => {
  const ROUTE = read('../web/routes/agents.ts')
  const serverLabel = (id: string) => {
    const m = ROUTE.match(new RegExp(`\\{ id: '${id.replace(/[.[\]]/g, '\\$&')}', label: '([^']+)' \\}`))
    expect(m, id).not.toBeNull()
    return m![1]
  }
  const keysSrc = slice('const SERVER_MODEL_LABEL_KEYS = {', '\n}\n') + '\n}'
  const KEYS = vm.runInNewContext(`(${keysSrc.slice(keysSrc.indexOf('{'))})`) as Record<string, string>
  const label = (lang: 'hu' | 'en', m: { id: string; label: string }) => {
    const opt = { textContent: '', dataset: {} as Record<string, string> }
    const window = { _lang: lang }
    const t = (key: string) => (lang === 'hu' ? HU : EN)[key] ?? EN[key] ?? key
    vm.runInNewContext(keysSrc + '\n' + slice('function setServerModelLabel(', '\n}\n') + '\n}\nsetServerModelLabel(opt, m)', { window, t, opt, m })
    return opt
  }

  it('covers every DeepSeek and MiniMax id the route serves, and the Hungarian key is the server label', () => {
    expect(Object.keys(KEYS).sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'minimax-m3'])
    for (const [id, key] of Object.entries(KEYS)) {
      expect(HU[key], key).toBe(serverLabel(id))
      expect(/[áéíóöőúüű]/i.test(EN[key]), key).toBe(false)
    }
  })

  it('an English viewer gets English, keyed on data-i18n; a Hungarian viewer gets the server text', () => {
    for (const id of Object.keys(KEYS)) {
      const m = { id, label: serverLabel(id) }
      const en = label('en', m)
      expect(en.textContent).toBe(EN[KEYS[id]])
      expect(en.dataset.i18n).toBe(KEYS[id])
      expect(label('hu', m).textContent).toBe(m.label)
    }
  })

  it('an id without a key keeps the server label and no key', () => {
    const opt = label('en', { id: 'deepseek-v5-new', label: 'DeepSeek-V5 (új)' })
    expect(opt.textContent).toBe('DeepSeek-V5 (új)')
    expect(opt.dataset.i18n).toBeUndefined()
  })

  it('both option loops use it', () => {
    const fn = slice('async function loadAvailableModels() {', '\n}\n')
    expect(fn.match(/setServerModelLabel\(opt, m\)/g)).toHaveLength(2)
    expect(fn).not.toContain('opt.textContent = m.label')
  })
})

// The model picker's CLI gate (hint + "not launchable" suffix), run from app.js's own source with a minimal DOM.
describe('the CLI gate follows a language applied after the models answer', () => {
  const gateSrc = slice('function applyClaudeCliGate(data) {', '\n}\n') + '\n}'
  const setup = () => {
    const mk = (value: string, key?: string) => ({ value, textContent: key ? HU[key] : value, dataset: (key ? { i18n: key } : {}) as Record<string, string>, disabled: false })
    const sel = { value: 'inherit', options: [mk('inherit', 'agents.model.inherit'), mk('claude-opus-5-5[1m]', 'agents.model.opus55_1m'), mk('claude-haiku-4-5', 'agents.model.haiku45')] }
    const hint = { textContent: '', style: { display: 'none' } }
    const window = { _lang: 'hu' as 'hu' | 'en' }
    const t = (key: string) => (window._lang === 'hu' ? HU : EN)[key] ?? EN[key] ?? key
    const els: Record<string, unknown> = { agentModel: sel, agentModelCliHint: hint }
    const ctx = vm.createContext({ window, t, document: { getElementById: (id: string) => els[id] ?? null } })
    vm.runInContext('var lastAvailableModelsData = null\n' + gateSrc, ctx)
    return { sel, hint, window, ctx, gate: (data: unknown) => vm.runInContext('applyClaudeCliGate(d)', Object.assign(ctx, { d: data })) }
  }
  const GATED = { cli: { error: null }, claudeSupport: { measured: true, installedVersion: '2.1.110', unsupported: [{ id: 'claude-opus-5-5', minCli: '2.1.280' }] } }
  const UNMEASURED = { cli: { error: 'claude binary not found on PATH' }, claudeSupport: { measured: false, installedVersion: null, unsupported: [] } }

  it('a gated option drawn on the hu fallback is relabelled in English when the gate runs again', () => {
    const { sel, window, gate } = setup()
    gate(GATED)
    expect(sel.options[1].textContent).toContain('legújabb Opus')
    window._lang = 'en'
    // What renderStaticI18n does: the data-i18n sweep resets the text, then the gate runs from the cache.
    sel.options[1].textContent = EN['agents.model.opus55_1m']
    gate(GATED)
    expect(sel.options[1].textContent).toBe(`${EN['agents.model.opus55_1m']} (not launchable by the installed CLI (2.1.110), needs at least 2.1.280)`)
    expect(sel.options[1].disabled).toBe(true)
    expect(sel.options[2].textContent).toBe(HU['agents.model.haiku45'])
  })

  it('the unmeasured hint is redrawn in the current language', () => {
    const { hint, window, gate } = setup()
    gate(UNMEASURED)
    expect(hint.textContent).toContain('nem mérhető')
    window._lang = 'en'
    gate(UNMEASURED)
    expect(hint.textContent).toBe(EN['agents.model.cliUnmeasured'].replace('{err}', 'claude binary not found on PATH'))
    expect(hint.style.display).toBe('')
  })

  it('an option without a lang key keeps its cached label', () => {
    const { sel, window, gate } = setup()
    sel.options[1].dataset = {}
    sel.options[1].textContent = 'Opus custom'
    gate(GATED)
    window._lang = 'en'
    gate(GATED)
    expect(sel.options[1].textContent.startsWith('Opus custom (')).toBe(true)
  })

  it('renderStaticI18n re-applies the gate from the cache, and the cache is a var (no TDZ on the early render)', () => {
    const render = slice('function renderStaticI18n() {', '\n}\n')
    expect(render).toContain('applyClaudeCliGate(lastAvailableModelsData)')
    expect(APP).toContain('\nvar lastAvailableModelsData = null\n')
    expect(APP.indexOf('function renderStaticI18n() {')).toBeLessThan(APP.indexOf('var lastAvailableModelsData'))
  })
})
