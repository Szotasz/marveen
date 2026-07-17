// String-contract guard for local agent skills on the global Skills page.
// Guards: (a) /api/skills/local route exists in skills.ts, (b) loadGlobalSkills
// fetches both endpoints, (c) local cards get skills-card--local class,
// (d) agent filter button is present, (e) i18n keys added in both locales.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP     = readFileSync(join(__dirname, '../../web/app.js'),         'utf-8')
const HTML    = readFileSync(join(__dirname, '../../web/index.html'),     'utf-8')
const CSS     = readFileSync(join(__dirname, '../../web/style.css'),      'utf-8')
const HU      = readFileSync(join(__dirname, '../../web/lang/hu.js'),     'utf-8')
const EN      = readFileSync(join(__dirname, '../../web/lang/en.js'),     'utf-8')
const SKILLS  = readFileSync(join(__dirname, '../../src/web/routes/skills.ts'), 'utf-8')

describe('local agent skills on global Skills page', () => {
  it('backend exposes /api/skills/local endpoint', () => {
    expect(SKILLS).toContain("'/api/skills/local'")
    expect(SKILLS).toContain("source: 'agent'")
  })

  it('loadGlobalSkills fetches both /api/skills and /api/skills/local', () => {
    expect(APP).toContain("fetch('/api/skills')")
    expect(APP).toContain("fetch('/api/skills/local')")
    expect(APP).toContain('Promise.all([')
    expect(APP).toContain('localAgentSkills')
  })

  it('local skill cards get skills-card--local CSS modifier', () => {
    expect(APP).toContain("'skills-card skills-card--local'")
  })

  it('CSS defines .skills-card--local with distinct border/background', () => {
    expect(CSS).toContain('.skills-card--local')
    expect(CSS).toContain('.skills-badge--agent')
  })

  it('agent filter button is present in HTML', () => {
    expect(HTML).toContain('data-filter="agent"')
    expect(HTML).toContain('data-i18n="skills.filter.agent"')
  })

  it('i18n keys present in hu.js', () => {
    expect(HU).toContain("'skills.filter.agent'")
    expect(HU).toContain("'skills.stat.agent_local'")
  })

  it('i18n keys present in en.js', () => {
    expect(EN).toContain("'skills.filter.agent'")
    expect(EN).toContain("'skills.stat.agent_local'")
  })
})
