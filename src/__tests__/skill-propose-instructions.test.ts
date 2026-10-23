import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')
const NO_DIRECT = ['mkdir -p ~/.claude/skills/', 'cat > ~/.claude/skills/']

describe('skill propose instructions', () => {
  it('T1: settings template is valid JSON and PreCompact prompt proposes', () => {
    const j = JSON.parse(read('templates/settings.json.template'))
    const hook = j.hooks.PreCompact.flatMap((h: any) => h.hooks ?? [h]).find((h: any) => h.type === 'agent')
    expect(hook).toBeTruthy()
    const prompt: string = hook.prompt
    expect(prompt).toContain('/api/skills/propose')
    expect(prompt).toContain('mkdir -p .claude/skills/SKILL-NEV')
    for (const bad of NO_DIRECT) expect(prompt).not.toContain(bad)
  })

  it('T2: CLAUDE.md template proposes', () => {
    const t = read('templates/CLAUDE.md.template')
    expect(t).toContain('/api/skills/propose')
    for (const bad of NO_DIRECT) expect(t).not.toContain(bad)
  })

  it('T3: skill-factory and memoria-heartbeat propose', () => {
    for (const f of ['skills/skill-factory/SKILL.md', 'scheduled-tasks/memoria-heartbeat/SKILL.md']) {
      const t = read(f)
      expect(t).toContain('/api/skills/propose')
      for (const bad of NO_DIRECT) expect(t).not.toContain(bad)
    }
  })

  it('T4: sub-agent CLAUDE.md section in agent-scaffold', () => {
    const src = read('src/web/agent-scaffold.ts')
    const a = src.indexOf('## Öntanulás és Skill rendszer')
    const b = src.indexOf('### Mikor generálj skill-t?', a)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    const sec = src.slice(a, b)
    expect(sec).toContain('/api/skills/propose')
    expect(sec).toContain('mkdir -p .claude/skills/SKILL-NEV')
    expect(sec).toContain('$(cat ${tokenPath})')
    expect(sec).not.toContain('mkdir -p ~/.claude/skills/')
  })

  it('T5: path-trap block mentions propose in shared and main-agent lines', () => {
    const src = read('src/web/agent-scaffold.ts')
    const a = src.indexOf('function buildSkillsPathTrapBody')
    expect(a).toBeGreaterThan(-1)
    const rest = src.slice(a + 1)
    const m = rest.search(/\n(function |export )/)
    const body = src.slice(a, m < 0 ? undefined : a + 1 + m)
    expect(body.split('POST /api/skills/propose').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('T6: security-hardening doc describes propose', () => {
    const t = read('docs/security-hardening.md')
    expect(t).toContain('POST /api/skills/propose')
    expect(t).toContain('skills-replaced')
  })
})
