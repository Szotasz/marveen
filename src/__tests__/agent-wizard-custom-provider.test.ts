// The new-agent wizard offered the custom providers in its model picker but sent the picker value ("custom:<id>") as
// the model, with no customProvider. The agent then ran that string as a model, and the provider was on no record:
// its delete named no agent (usedBy reads customProvider) and the agent could not start. Now the wizard sends the
// provider and the model id apart, as the agent editor does, and POST /api/agents stores the provider.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The provider store is mocked: other test files write and restore the real store/custom-providers.json in
// parallel, and a file shared mid-run would make these results depend on which ran first.
vi.mock('../web/custom-providers.js', async (orig) => ({
  ...await orig<typeof import('../web/custom-providers.js')>(),
  loadCustomProvider: () => null,
}))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT } = await import('../config.js')

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const ROUTE = readFileSync(new URL('../web/routes/agents.ts', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from)
  const j = i < 0 ? -1 : src.indexOf(to, i)
  return i < 0 || j < 0 ? '' : src.slice(i, j)
}
const NEXT = between(APP, "document.getElementById('wizardNextBtn').addEventListener('click'", "const statusEl = document.getElementById('wizardGenStatus')")
const CREATE_BODY = between(APP, "const res = await fetch('/api/agents', {", '})')
const POST = between(ROUTE, "if (path === '/api/agents' && method === 'POST') {", "logger.info({ name, description }, 'Generating agent CLAUDE.md and SOUL.md...')")

describe('the wizard sends a custom provider apart from the model id', () => {
  it('the parts were found', () => {
    for (const part of [NEXT, CREATE_BODY, POST]) expect(part).not.toBe('')
  })

  it('the picker value is split into the provider and the typed model id', () => {
    expect(NEXT).toContain("const customProvider = modelVal.startsWith('custom:') ? modelVal.slice('custom:'.length) : null")
    expect(NEXT).toContain("const customModelId = customProvider ? customModelInput.value.trim() : ''")
    expect(CREATE_BODY).toContain('model: customProvider ? customModelId : modelVal,')
    expect(CREATE_BODY).toContain('customProvider,')
    expect(CREATE_BODY).not.toContain('model: agentModel.value')
  })

  it('with a custom provider and no model id, the field gets the focus and a toast, before any request', () => {
    expect(NEXT).toContain("if (customProvider && !customModelId) { customModelInput.focus(); showToast(t('agents.model.custom_model_required')); return }")
    expect(NEXT).not.toMatch(/\bfetch\(/)
    for (const lang of [HU, EN]) expect(lang).toContain("'agents.model.custom_model_required':")
  })

  it('the model id field shows when a custom provider is picked, and a reset clears it', () => {
    expect(APP).toContain("agentModel.addEventListener('change', () => updateCustomModelIdRow(agentModel))")
    const reset = between(APP, 'function resetWizard() {', '\n}\n')
    expect(reset).toContain("document.getElementById('agentModelCustomModelId').value = ''")
    expect(reset).toContain('updateCustomModelIdRow(agentModel)')
  })
})

describe('POST /api/agents stores the custom provider', () => {
  it('the provider is checked before anything is created, and written right after the model', () => {
    // The refusals and the base writes live in agent-create.ts since MIOAGENTINSTALL1114 PR-I0; the route calls the
    // checks, answers a refusal, and only then writes. (The order of the refusals and of the writes is pinned
    // by behaviour in agent-create-characterization.test.ts.)
    const CREATE = readFileSync(new URL('../web/agent-create.ts', import.meta.url), 'utf-8')
    const checks = between(CREATE, 'export async function checkAgentCreatable(', 'export interface AgentBase')
    const writes = CREATE.slice(CREATE.indexOf('export function writeAgentBase('))
    expect(checks).toContain('if (customProvider && !loadCustomProvider(customProvider)) return { status: 400,')
    const callCheck = POST.indexOf('await checkAgentCreatable(name, model, customProvider,')
    const callWrite = POST.indexOf('writeAgentBase(name, {')
    expect(callCheck).toBeGreaterThan(-1)
    expect(callWrite).toBeGreaterThan(callCheck)
    expect(POST.slice(callCheck, callWrite)).toContain('if (refusal) { json(res, refusal.body, refusal.status); return true }')
    const writeModel = writes.indexOf('writeAgentModel(name, base.model)')
    const writeProvider = writes.indexOf('if (base.customProvider) writeAgentCustomProvider(name, base.customProvider)')
    expect(writeModel).toBeGreaterThan(-1)
    expect(writeProvider).toBeGreaterThan(writeModel)
  })

  const AGENT = '__test-wizard-cp'
  beforeAll(() => { rmSync(agentDir(AGENT), { recursive: true, force: true }) })
  afterAll(() => { rmSync(agentDir(AGENT), { recursive: true, force: true }) })

  it('an unknown provider is a 400, and no agent directory is left behind', async () => {
    const req = Readable.from([Buffer.from(JSON.stringify({ name: AGENT, description: 'x', model: 'deepseek-chat', customProvider: 'nope' }))]) as unknown as http.IncomingMessage
    req.headers = {}
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const url = new URL('http://127.0.0.1:3420/api/agents')
    expect(await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('Unknown custom provider')
    expect(existsSync(agentDir(AGENT))).toBe(false)
  })
})
