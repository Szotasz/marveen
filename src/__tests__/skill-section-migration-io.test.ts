import { afterAll, describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// agentDir points into a throwaway root, so ensureSkillSectionCurrent reads and writes
// real files there -- including one for the main agent, which it must leave alone.
const H = vi.hoisted(() => ({ root: '' }))
H.root = mkdtempSync(join(tmpdir(), 'skill-section-io-'))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(H.root, 'agents', name) }
})

const { ensureSkillSectionCurrent, buildSkillSection, readRetiredSkillSections, preQuarantineSwitchSection, SKILL_SECTION_SWITCH_SENTENCES } = await import('../web/agent-scaffold.js')
const { MAIN_AGENT_ID } = await import('../config.js')

const write = (name: string, text: string) => {
  mkdirSync(join(H.root, 'agents', name), { recursive: true })
  const p = join(H.root, 'agents', name, 'CLAUDE.md')
  writeFileSync(p, text)
  return p
}
const doc = (section: string) => `# Ágens\n\nbevezető\n\n${section}\n\n## Időkezelés\n\nx\n`

describe('ensureSkillSectionCurrent on real files', () => {
  afterAll(() => rmSync(H.root, { recursive: true, force: true }))
  const [retired] = readRetiredSkillSections()

  it('replaces an unedited sub-agent section once, and the second run writes nothing', () => {
    const p = write('worker', doc(retired))
    expect(ensureSkillSectionCurrent('worker')).toBe(true)
    // VOICETOKENLEAK1101 PR-A1: the helper recipe (worker's settings do not deny it), the token never on argv
    expect(readFileSync(p, 'utf-8')).toBe(doc(buildSkillSection('worker')))
    expect(ensureSkillSectionCurrent('worker')).toBe(false)
  })

  it('never touches the main agent, even with an unedited old section', () => {
    const p = write(MAIN_AGENT_ID, doc(retired))
    expect(ensureSkillSectionCurrent(MAIN_AGENT_ID)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(doc(retired))
  })

  it('leaves an edited section alone', () => {
    const edited = retired.replace('Generálj skill-t', 'Írj skill-t')
    expect(edited).not.toBe(retired)
    const p = write('edited', doc(edited))
    expect(ensureSkillSectionCurrent('edited')).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(doc(edited))
  })

  // SKILLAPPROVALOFF1101: an agent whose section was generated before the quarantine became a switch (it says every
  // proposal waits) gets today's section at its next start; an edited one stays.
  it('the section from before the quarantine switch is migrated; an edited one is not', () => {
    const now = buildSkillSection('switch-worker')
    const before = preQuarantineSwitchSection(now)
    for (const [old, cur] of SKILL_SECTION_SWITCH_SENTENCES) {
      expect(now).toContain(cur)
      expect(before).toContain(old)
      expect(before).not.toContain(cur)
    }
    const p = write('switch-worker', doc(before))
    expect(ensureSkillSectionCurrent('switch-worker')).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(doc(now))
    const edited = before.replace('Generálj skill-t', 'Írj skill-t')
    const q = write('switch-edited', doc(edited))
    expect(ensureSkillSectionCurrent('switch-edited')).toBe(false)
    expect(readFileSync(q, 'utf-8')).toBe(doc(edited))
  })

  it('runs on every agent start, right after the skills-path trap section', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toMatch(/ensureSkillsPathTrapSection\(name\)\n\s*ensureSkillSectionCurrent\(name\)/)
  })
})
