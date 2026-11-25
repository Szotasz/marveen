// HOSTINGERRETEST1125 (points 2 and 4 of the Hostinger VPS team's list). On a router install a sub-agent either runs on
// the router (its custom provider: no Claude login, so the Claude login choices are not offered) or on a Claude
// subscription the owner logs in to from the agent's page, through the same setup-token relay as Settings > Claude
// subscriptions, the new plan then assigned to the agent. The agent's own /login in its terminal (own_team) is labelled
// as what it is: the dashboard cannot finish it. The functions are pulled out of web/app.js and run on stand-ins.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const APP = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
const HTML = readFileSync(join(ROOT, 'web/index.html'), 'utf-8')
const EN = readFileSync(join(ROOT, 'web/lang/en.js'), 'utf-8')
const HU = readFileSync(join(ROOT, 'web/lang/hu.js'), 'utf-8')

type El = { hidden: boolean; disabled: boolean; textContent: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void; removeAttribute(k: string): void }
const el = (): El => ({ hidden: false, disabled: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, removeAttribute(k) { delete this.attrs[k] } })

function hook(currentAgent: unknown) {
  const src = APP.match(/\nfunction applyMarveenReadonlyMode\(readOnly\) \{\n[\s\S]*?\n\}\n/)
  expect(src).toBeTruthy()
  const ids = ['securityProfileGroup', 'claudePlanGroup', 'authModeGroup', 'memoryIsolationGroup', 'codeModeGroup', 'mainAuthGroup',
    'marveenReadonlyNote', 'agentProviderAuthNote', 'agentProviderAuthNoteText', 'editClaudeMd', 'editSoulMd', 'editMcpJson', 'editAgentModel',
    'saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn', 'saveModelBtn']
  const els: Record<string, El> = Object.fromEntries(ids.map((id) => [id, el()]))
  const document = { getElementById: (id: string) => els[id] ?? null, querySelector: () => null }
  const t = (key: string, p?: Record<string, string>) => `${key}:${p?.provider ?? ''}`
  const fn = new Function('document', 'loadMainAuthPanel', 'currentAgent', 't', `${src![0]}\nreturn applyMarveenReadonlyMode`)(
    document, () => {}, currentAgent, t,
  ) as (readOnly: boolean) => void
  return { fn, els }
}

describe('a sub-agent on a custom provider is not offered a Claude login', () => {
  it('router agent: the auth mode and the Claude subscription groups are hidden, the note says why', () => {
    const { fn, els } = hook({ name: 'qarouter', role: 'agent', customProvider: 'hostinger-router' })
    fn(false)
    expect(els.authModeGroup.hidden).toBe(true)
    expect(els.claudePlanGroup.hidden).toBe(true)
    expect(els.agentProviderAuthNote.hidden).toBe(false)
    expect(els.agentProviderAuthNoteText.textContent).toBe('agents.plan_login.provider_note:hostinger-router')
    // the rest of the sub-agent settings stay
    expect(els.securityProfileGroup.hidden).toBe(false)
  })

  it('Claude agent: both groups are shown, no note', () => {
    const { fn, els } = hook({ name: 'qaclaude', role: 'agent', customProvider: null })
    fn(false)
    expect(els.authModeGroup.hidden).toBe(false)
    expect(els.claudePlanGroup.hidden).toBe(false)
    expect(els.agentProviderAuthNote.hidden).toBe(true)
  })

  it('a Claude agent opened after a router agent gets both groups back', () => {
    const router = hook({ name: 'qarouter', role: 'agent', customProvider: 'hostinger-router' })
    router.fn(false)
    const claude = hook({ name: 'qaclaude', role: 'agent', customProvider: null })
    Object.assign(claude.els, router.els)
    claude.fn(false)
    expect(claude.els.authModeGroup.hidden).toBe(false)
    expect(claude.els.claudePlanGroup.hidden).toBe(false)
    expect(claude.els.agentProviderAuthNote.hidden).toBe(true)
  })

  it('the main agent (read-only): no note, the groups hidden as before', () => {
    const { fn, els } = hook({ name: 'marveen', role: 'main', customProvider: 'hostinger-router' })
    fn(true)
    expect(els.agentProviderAuthNote.hidden).toBe(true)
    expect(els.authModeGroup.hidden).toBe(true)
    expect(els.claudePlanGroup.hidden).toBe(true)
  })
})

describe("the agent page's subscription login", () => {
  it('uses the measured setup-token relay, then assigns the plan with authMode shared', () => {
    const start = APP.slice(APP.indexOf("document.getElementById('agentPlanLoginBtn')"), APP.indexOf("document.getElementById('agentPlanLoginCopyBtn')"))
    expect(start).toContain("fetch('/api/claude-plans/login/start'")
    expect(start).toContain('channelsAllowed: false')
    const code = APP.slice(APP.indexOf("document.getElementById('agentPlanLoginCodeBtn')"), APP.indexOf("document.getElementById('agentPlanLoginCancelBtn')"))
    expect(code).toContain("fetch('/api/claude-plans/login/code'")
    // a plan token runs only with authMode 'shared' (plan-token-launch.ts), so both go in one write
    expect(code).toContain("JSON.stringify({ authMode: 'shared', claudePlan: data.id })")
    // the main agent's login is not this path
    expect(start).toContain("currentAgent.role === 'main'")
    // no keystrokes into the agent's pane on this path
    expect(start + code).not.toMatch(/auth\/init|send-keys|sendPromptToSession/)
  })

  it('the plan id fits the plan id charset and is new each time', () => {
    const src = APP.match(/\nfunction agentPlanLoginId\(agentName, now = Date\.now\(\)\) \{\n[\s\S]*?\n\}\n/)
    expect(src).toBeTruthy()
    const id = new Function(`${src![0]}\nreturn agentPlanLoginId`)() as (n: string, now?: number) => string
    expect(id('qa claude/../x', 1)).toMatch(/^[A-Za-z0-9_.-]+$/)
    expect(id('qaclaude', 1)).not.toBe(id('qaclaude', 2))
    expect(id('', 1)).toMatch(/^agent-/)
  })

  it('the markup carries the login block and the provider note', () => {
    for (const id of ['agentPlanLoginBtn', 'agentPlanLoginStep', 'agentPlanLoginLink', 'agentPlanLoginUrl', 'agentPlanLoginCode',
      'agentPlanLoginCodeBtn', 'agentPlanLoginCancelBtn', 'agentPlanLoginStatus', 'agentPlanLoginError', 'agentProviderAuthNote', 'agentProviderAuthNoteText']) {
      expect(HTML).toContain(`id="${id}"`)
    }
    expect(HTML).toMatch(/id="agentPlanLoginLink"[^>]*rel="noopener noreferrer"/)
  })
})

describe('own_team: the terminal /login is labelled as what it is', () => {
  it.each([['en', EN, /cannot finish this login/], ['hu', HU, /nem tudja befejezni/]])('%s', (_lang, src, rx) => {
    const desc = src.match(/'agents\.auth\.flow_desc':\s*'((?:[^'\\]|\\.)*)'/)
    expect(desc).toBeTruthy()
    expect(desc![1]).toMatch(rx)
    expect(src).toMatch(/'agents\.plan_login\.start':/)
  })
})
