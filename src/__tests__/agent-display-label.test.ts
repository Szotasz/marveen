// DASHNAME1109: the overview's activity feed showed the main agent's routing id ("marveen") on an install whose agent
// is called "Patex" (the Bridge path: headless install with the default name, then the wizard renames BOT_NAME only).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDisplayLabel, type AgentDisplayLabelDeps } from '../web/agent-display-label.js'

const deps = (over: Partial<AgentDisplayLabelDeps> = {}): AgentDisplayLabelDeps => ({
  mainAgentId: 'marveen',
  botName: () => 'Patex',
  isKnownAgent: (id) => id === 'marveen' || id === 'samu' || id === 'dani',
  displayName: (id) => (id === 'samu' ? 'Samu, a tech lead' : id.charAt(0).toUpperCase() + id.slice(1)),
  ...over,
})

describe('agentDisplayLabel', () => {
  it('the main agent routing id shows the current display name (the Bridge-path rename)', () => {
    expect(agentDisplayLabel('marveen', deps())).toBe('Patex')
  })

  it('reads the name fresh each call (the wizard writes .env while the dashboard runs)', () => {
    let name = 'Marveen'
    const d = deps({ botName: () => name })
    expect(agentDisplayLabel('marveen', d)).toBe('Marveen')
    name = 'Patex'
    expect(agentDisplayLabel('marveen', d)).toBe('Patex')
  })

  it('a known sub-agent shows its display name', () => {
    expect(agentDisplayLabel('samu', deps())).toBe('Samu, a tech lead')
    expect(agentDisplayLabel('dani', deps())).toBe('Dani')
  })

  it('anything else is shown as it is: system, an unknown id, a federated peer/agent id, empty', () => {
    expect(agentDisplayLabel('system', deps())).toBe('system')
    expect(agentDisplayLabel('segito', deps())).toBe('segito')
    expect(agentDisplayLabel('kovacs-rendszer/marveen', deps({ isKnownAgent: () => true }))).toBe('kovacs-rendszer/marveen')
    expect(agentDisplayLabel('', deps())).toBe('')
    expect(agentDisplayLabel(null, deps())).toBe('')
    expect(agentDisplayLabel(undefined, deps())).toBe('')
  })

  it('an empty display name or a throwing lookup falls back to the id, never to nothing', () => {
    expect(agentDisplayLabel('marveen', deps({ botName: () => '' }))).toBe('marveen')
    expect(agentDisplayLabel('samu', deps({ displayName: () => '' }))).toBe('samu')
    expect(agentDisplayLabel('samu', deps({ isKnownAgent: () => { throw new Error('fs') } }))).toBe('samu')
  })
})

describe('the overview activity feed uses it (wiring)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'overview.ts'), 'utf-8')
  it('the memory line and both ends of the message line go through agentDisplayLabel', () => {
    expect(src).toContain('text: `${agentDisplayLabel(r.agent_id)}: ')
    expect(src).toContain('text: `${agentDisplayLabel(r.from_agent)} → ${agentDisplayLabel(r.to_agent)}: ')
    expect(src).not.toMatch(/text: `\$\{r\.(agent_id|from_agent|to_agent)\}/)
  })
})

describe('the wizard title follows the brand (onboarding.title)', () => {
  for (const [lang, want] of [['hu', "'{brand} beállítása'"], ['en', "'Set up {brand}'"]] as const) {
    it(`web/lang/${lang}.js`, () => {
      const s = readFileSync(join(__dirname, '..', '..', 'web', 'lang', `${lang}.js`), 'utf-8')
      const line = s.split('\n').find((l) => l.trim().startsWith("'onboarding.title':")) || ''
      expect(line).toContain(want)
    })
  }
})
