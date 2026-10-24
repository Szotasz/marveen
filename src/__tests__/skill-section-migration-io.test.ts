import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const { ensureSkillSectionCurrent, buildSkillSection, readRetiredSkillSections } = await import('../web/agent-scaffold.js')
const { MAIN_AGENT_ID } = await import('../config.js')

const write = (name: string, text: string) => {
  mkdirSync(join(H.root, 'agents', name), { recursive: true })
  const p = join(H.root, 'agents', name, 'CLAUDE.md')
  writeFileSync(p, text)
  return p
}
const doc = (section: string) => `# Ágens\n\nbevezető\n\n${section}\n\n## Időkezelés\n\nx\n`

describe('ensureSkillSectionCurrent on real files', () => {
  const [retired] = readRetiredSkillSections()

  it('replaces an unedited sub-agent section once, and the second run writes nothing', () => {
    const p = write('worker', doc(retired))
    expect(ensureSkillSectionCurrent('worker')).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(doc(buildSkillSection()))
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

  it('runs on every agent start, right after the skills-path trap section', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toMatch(/ensureSkillsPathTrapSection\(name\)\n\s*ensureSkillSectionCurrent\(name\)/)
  })
})
