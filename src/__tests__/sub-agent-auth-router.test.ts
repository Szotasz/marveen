// HOSTINGERSUBAGENTAUTH1122: on a router install with no Claude login, a Claude sub-agent is refused at launch
// (instead of sitting on the login screen in silence), and the create form warns and preselects the router.
// Off a router install nothing changes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { subAgentClaudeAuthMissing } from '../web/hostinger-router.js'

const base = {
  routerInstall: true,
  isMainAgent: false,
  needsClaudeLogin: true,
  tokenExported: false,
  configuredConfigDir: false,
  sharedLoginPresent: false,
}

describe('subAgentClaudeAuthMissing', () => {
  it('is true only for a Claude sub-agent with no auth source on a router install', () => {
    expect(subAgentClaudeAuthMissing(base)).toBe(true)
  })

  it.each([
    ['not a router install (nothing changes elsewhere)', { routerInstall: false }],
    ['the main agent (its own auth step owns it)', { isMainAgent: true }],
    ['an agent that does not use the Claude login', { needsClaudeLogin: false }],
    ['a token is exported (fleet, own file or plan)', { tokenExported: true }],
    ['an operator-set config dir carries its own login', { configuredConfigDir: true }],
    ['the shared ~/.claude has a login', { sharedLoginPresent: true }],
  ])('is false when %s', (_label, patch) => {
    expect(subAgentClaudeAuthMissing({ ...base, ...patch })).toBe(false)
  })
})

describe('the launcher wiring (source)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
  const start = src.indexOf('export async function startAgentProcess(')
  const body = src.slice(start)
  const check = body.indexOf('subAgentClaudeAuthMissing({')

  it('decides after every token export and before the launch writes anything for the session', () => {
    expect(start).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(-1)
    const lastExport = body.lastIndexOf('oauthTokenEnv = ', check)
    expect(lastExport).toBeGreaterThan(-1)
    expect(check).toBeLessThan(body.indexOf('stampProjectTrustForDir('))
  })

  it('reads the facts from this launch: api and own_team agents keep their own auth, the token is the launch env', () => {
    const block = body.slice(check, body.indexOf('})', check))
    expect(block).toContain("needsClaudeLogin: isClaude && authMode !== 'api' && authMode !== 'own_team'")
    expect(block).toContain("tokenExported: oauthTokenEnv !== ''")
    expect(block).toContain('isMainAgent: name === MAIN_AGENT_ID')
    expect(block).toContain('configuredConfigDir,')
  })

  it('refuses with an error that names the way out', () => {
    const after = body.slice(check, check + 1200)
    expect(after).toMatch(/return \{ ok: false, error: 'no-claude-auth: [^']*Hostinger AI Router[^']*' \}/)
  })
})

describe('the create form (source)', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
  const fn = app.slice(app.indexOf('function applySubAgentAuthAdvice('), app.indexOf('function updateCustomModelIdRow('))

  it('preselects the router only while the form is on its default, so a user choice is never overwritten', () => {
    expect(fn).toContain("advice.routerSuggested && routerOption && sel.value === 'inherit'")
  })

  it('is applied from the models endpoint, and the endpoint sends the advice', () => {
    expect(app).toContain('applySubAgentAuthAdvice(data.subAgentAuth)')
    const routes = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(routes).toContain('subAgentAuth: readSubAgentAuthAdvice(),')
  })

  it('has both texts in both languages', () => {
    for (const lang of ['en', 'hu']) {
      const s = readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf-8')
      expect(s).toContain("'agents.model.no_claude_auth':")
      expect(s).toContain("'agents.model.no_claude_auth_router':")
    }
  })
})
