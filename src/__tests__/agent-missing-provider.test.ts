// An agent whose custom provider was deleted does not start, but nothing on the dashboard said so: the agent editor
// showed the provider like any other, and the agent card just its model. The agent editor also saved the picker value
// ("custom:<id>") as the model when the model id field was empty. Now the editor and the card say the provider is
// gone, the editor needs a model id with a custom provider, and PUT /api/agents/:name refuses a provider that does
// not exist, as the POST does.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The provider store is mocked: other test files write and restore the real store/custom-providers.json in
// parallel, and a file shared mid-run would make these results depend on which ran first.
vi.mock('../web/custom-providers.js', async (orig) => {
  const real = await orig<typeof import('../web/custom-providers.js')>()
  const here = { id: 'here', label: 'Here', baseUrl: 'http://127.0.0.1:1', authHeader: 'none' as const, vaultKey: null }
  return { ...real, loadCustomProvider: (id: string) => (id === 'here' ? here : null) }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT } = await import('../config.js')

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
const ROUTE = readFileSync(new URL('../web/routes/agents.ts', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}

describe('the agent editor says the provider is gone, and needs a model id', () => {
  const MARK = between(APP, 'async function markMissingCustomProvider(', '\n}\n')
  const SAVE = between(APP, "document.getElementById('saveModelBtn').addEventListener('click'", 'const res = await fetch(')

  it('the parts were found', () => {
    for (const part of [MARK, SAVE]) expect(part).not.toBe('')
  })

  it('the provider list decides: a missing provider relabels the option and shows the line under the picker', () => {
    expect(MARK).toContain("await fetch('/api/custom-providers')")
    expect(MARK).toContain('if (!ids || ids.includes(providerId) || currentAgent !== agent) return')
    expect(MARK).toContain("opt.textContent = '🔧 ' + t('agents.model.provider_deleted', { id: providerId }); opt.dataset.deleted = '1'")
    expect(MARK).toContain("warn.hidden = sel.selectedOptions[0]?.dataset.deleted !== '1'")
    expect(APP).toContain('markMissingCustomProvider(sel, customProviderId, ')
    expect(HTML).toContain('<p id="editAgentModelProviderMissing" hidden')
    expect(HTML).toContain('data-i18n="agents.model.provider_missing"')
  })

  it('picking another model hides the line', () => {
    expect(APP).toContain("document.getElementById('editAgentModelProviderMissing').hidden = sel.selectedOptions[0]?.dataset.deleted !== '1'")
  })

  it('a model saved as "custom:<id>" is not put back into the model id field', () => {
    expect(APP).toContain("if (modelInput) modelInput.value = mv.startsWith('custom:') ? '' : mv")
  })

  it('a save with a custom provider and no model id stops with the focus and a toast; the picker value is never the model', () => {
    expect(SAVE).toContain("if (isCustom && !customModelId) { customModelInput.focus(); showToast(t('agents.model.custom_model_required')); return }")
    expect(SAVE).toContain('const newModel = isCustom ? customModelId : selectVal')
    expect(SAVE).not.toContain('|| selectVal)')
  })
})

describe('a model saved as "custom:<id>" with no provider is flagged too', () => {
  const MARK = between(APP, 'async function markMissingCustomProvider(', '\n}\n')

  it('the summary carries the broken model when no provider is beside it', () => {
    expect(ROUTE).toContain("brokenCustomModel: typeof agentModelConfig.model === 'string' && agentModelConfig.model.startsWith('custom:') && !readAgentCustomProvider(name) ? agentModelConfig.model : null,")
  })

  it('the card warns with its own text', () => {
    expect(APP).toContain('agent.missingCustomProvider || agent.brokenCustomModel')
    expect(APP).toContain("t('agents.model.custom_model_broken', { model: agent.brokenCustomModel })")
  })

  it('the editor shows its own line, before the provider list is asked, and marks no option', () => {
    expect(APP).toContain("markMissingCustomProvider(sel, customProviderId, customProviderId ? null : (mv.startsWith('custom:') ? mv : null))")
    const broken = MARK.indexOf('if (brokenModel) {')
    expect(broken).toBeGreaterThan(-1)
    expect(broken).toBeLessThan(MARK.indexOf("await fetch('/api/custom-providers')"))
    const branch = MARK.slice(broken, MARK.indexOf('return', broken))
    expect(branch).toContain("warn.textContent = t('agents.model.custom_model_broken', { model: brokenModel })")
    expect(branch).toContain('warn.hidden = false')
    expect(branch).not.toContain('dataset.deleted')
    for (const lang of [HU, EN]) expect(lang.split('\n').find(l => l.includes("'agents.model.custom_model_broken':"))).toContain('{model}')
  })
})

describe('the agent card warns about a deleted provider', () => {
  it('the summary carries the missing provider id, from the agent config and the provider store', () => {
    expect(ROUTE).toContain('missingCustomProvider: (() => { const id = readAgentCustomProvider(name); return id && !loadCustomProvider(id) ? id : null })(),')
  })

  it('the card shows a red badge with a translated tooltip naming the provider', () => {
    expect(APP).toContain('agent.missingCustomProvider')
    expect(APP).toContain('class="agent-model-badge provider-missing" title="${escapeHtml(agent.missingCustomProvider')
    expect(APP).toContain("? t('agents.model.provider_missing_card', { id: agent.missingCustomProvider })")
    expect(CSS).toMatch(/\.agent-model-badge\.provider-missing \{[^}]*color: var\(--danger\)/)
  })

  it('the keys are in both languages', () => {
    for (const key of ['agents.model.custom_model_required', 'agents.model.provider_deleted', 'agents.model.provider_missing', 'agents.model.provider_missing_card']) {
      expect(HU, key).toContain(`'${key}':`)
      expect(EN, key).toContain(`'${key}':`)
    }
    for (const lang of [HU, EN]) {
      expect(lang.split('\n').find(l => l.includes("'agents.model.provider_deleted':"))).toContain('{id}')
      expect(lang.split('\n').find(l => l.includes("'agents.model.provider_missing_card':"))).toContain('{id}')
    }
  })
})

describe('PUT /api/agents/:name refuses a provider that does not exist', () => {
  const AGENT = '__test-missing-provider'
  const CONFIG = join(agentDir(AGENT), 'agent-config.json')

  async function put(body: unknown) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
    req.headers = {}
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const url = new URL(`http://127.0.0.1:3420/api/agents/${AGENT}`)
    expect(await tryHandleAgents({ req, res, path: url.pathname, method: 'PUT', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))).toBe(true)
    return { status: out.status || 200, body: out.body }
  }

  beforeEach(() => {
    rmSync(agentDir(AGENT), { recursive: true, force: true })
    mkdirSync(agentDir(AGENT), { recursive: true })
    writeFileSync(CONFIG, JSON.stringify({ model: 'claude-opus-5' }))
  })
  afterAll(() => { rmSync(agentDir(AGENT), { recursive: true, force: true }) })

  it('an unknown provider is a 400 before the first write: the model is not written either', async () => {
    const before = readFileSync(CONFIG, 'utf-8')
    const r = await put({ model: 'deepseek-chat', customProvider: 'gone' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('Unknown custom provider')
    expect(readFileSync(CONFIG, 'utf-8')).toBe(before)
  })

  it('an existing provider is written with the model', async () => {
    const r = await put({ model: 'deepseek-chat', customProvider: 'here' })
    expect(r.status).toBe(200)
    const config = JSON.parse(readFileSync(CONFIG, 'utf-8'))
    expect(config.customProvider).toBe('here')
    expect(config.model).toBe('deepseek-chat')
  })

  it('clearing the provider is still allowed', async () => {
    const r = await put({ model: 'claude-opus-5', customProvider: null })
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(CONFIG, 'utf-8')).customProvider ?? null).toBe(null)
  })
})
