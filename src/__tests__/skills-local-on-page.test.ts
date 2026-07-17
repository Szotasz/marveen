// String-contract guard for local agent skills on the global Skills page.
// Guards: (a) /api/skills/local route exists in skills.ts, (b) loadGlobalSkills
// fetches both endpoints, (c) local cards get skills-card--local class,
// (d) agent filter button is present, (e) i18n keys added in both locales,
// (f) agent filter sidebar uses localAgentSkills, (g) documented stat removed.
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

  it('main agent is NOT skipped -- no bare continue after MAIN_AGENT_ID check', () => {
    // Previously: `if (agentName === MAIN_AGENT_ID) continue` excluded 29 skills.
    // The fix uses a PROJECT_ROOT branch instead of skipping entirely.
    expect(SKILLS).not.toMatch(/if \(agentName === MAIN_AGENT_ID\) continue/)
  })

  it('main agent skills path uses PROJECT_ROOT not agentDir', () => {
    // The main agent has no agents/<id>/ directory; its local skills live at
    // PROJECT_ROOT/.claude/skills (same pattern as CLAUDE.md path resolution).
    expect(SKILLS).toContain('PROJECT_ROOT')
    expect(SKILLS).toMatch(/MAIN_AGENT_ID[\s\S]{0,200}PROJECT_ROOT/)
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

  it('sidebar uses localAgentSkills for agent filter (categories stay populated)', () => {
    // When the 'agent' filter is active, renderSkillsSidebar must draw from
    // localAgentSkills -- not globalSkills -- so category labels don't disappear.
    expect(APP).toMatch(/skillsActiveFilter === 'agent'[\s\S]{0,100}localAgentSkills/)
  })

  it('documented stat card and dead code removed', () => {
    expect(APP).not.toContain('withSkillMd')
    expect(APP).not.toContain("'skills.stat.documented'")
    expect(HU).not.toContain("'skills.stat.documented'")
    expect(EN).not.toContain("'skills.stat.documented'")
  })

  it('page subtitle describes all three skill sources in both locales', () => {
    expect(HU).toContain("'skills.page_subtitle'")
    expect(HU).toMatch(/'skills\.page_subtitle':.*ágens-saját/)
    expect(EN).toContain("'skills.page_subtitle'")
    expect(EN).toMatch(/'skills\.page_subtitle':.*agent-local/)
    // old stale description must be gone
    expect(HU).not.toMatch(/'skills\.page_subtitle':.*\(user mappa \+ plugin cache\)'/)
    expect(EN).not.toMatch(/'skills\.page_subtitle':.*\(user folder \+ plugin cache\)'/)
  })
})
