// Migration of a sub-agent CLAUDE.md's skill section: agents created before the
// propose-only change still carry the OLD shipped section, which teaches
// `mkdir -p ~/.claude/skills/SKILL-NEV` -- writing straight into the global
// skills directory -- and so contradicts the new "propose, do not write the
// global directory" rule. ensureSkillSectionCurrent swaps a section that is
// still a shipped version (templates/retired-claude-md-sections.json, newest
// first) for the current one; a section the agent EDITED stays, and the main
// agent's CLAUDE.md is never touched. An LLM's copy of a shipped section may
// differ in whitespace only (blank lines, trailing spaces, CRLF) and still
// counts as unedited: comparison happens after normalizeSectionWhitespace.
//
// Pure functions only -- no real agent directory is read or written here.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildSkillSection,
  normalizeSectionWhitespace,
  upgradeRetiredSkillSection,
  readRetiredSkillSections,
  ensureSkillSectionCurrent,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

const root = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf-8')

const HEADING = '## Öntanulás és Skill rendszer'
// The same array (same file) ensureSkillSectionCurrent feeds to
// upgradeRetiredSkillSection on agent start.
const retired = readRetiredSkillSections()
const current = buildSkillSection()

// A sub-agent CLAUDE.md skeleton: a title and an intro before the section, an
// unrelated section after it.
const around = (section: string) => `# A\n\nintro\n\n${section}\n\n## Időkezelés\n\nx\n`
const MIGRATED = `# A\n\nintro\n\n${current}\n\n## Időkezelés\n\nx\n`

describe('skill section migration', () => {
  it('M0: normalizeSectionWhitespace erases copy artifacts only', () => {
    // CRLF, trailing spaces/tabs and every blank line (an LLM copy may add or drop one anywhere)
    expect(normalizeSectionWhitespace('\r\na \t\r\n\r\n\r\nb  \n\n')).toBe('a\nb')
    expect(normalizeSectionWhitespace('a\n   \nb')).toBe('a\nb')
    expect(normalizeSectionWhitespace('a\nb')).toBe(normalizeSectionWhitespace('a\n\nb'))
    expect(normalizeSectionWhitespace('\n\n\na\n\n\n')).toBe('a')
    // text is not whitespace: a changed or a joined line stays different
    expect(normalizeSectionWhitespace('a b')).not.toBe(normalizeSectionWhitespace('a\nb'))
  })

  it('M1: the newest retired section is replaced, its neighbours unchanged', () => {
    expect(retired.length).toBeGreaterThanOrEqual(2)
    const out = upgradeRetiredSkillSection(around(retired[0]), retired, current)
    if (out === null) throw new Error('newest retired section was not replaced')
    expect(out).toBe(MIGRATED)
    // the text before the section is untouched
    expect(out.startsWith('# A\n\nintro\n\n')).toBe(true)
    // the section after it is untouched
    const at = out.indexOf('## Időkezelés')
    expect(at).toBeGreaterThan(-1)
    expect(out.slice(at)).toBe('## Időkezelés\n\nx\n')
    // and exactly one blank line separates it from the new section
    expect(out.slice(0, at).endsWith('\n\n')).toBe(true)
    expect(out.slice(0, at).endsWith('\n\n\n')).toBe(false)
  })

  it('M2: the older retired section is replaced the same way', () => {
    expect(upgradeRetiredSkillSection(around(retired[1]), retired, current)).toBe(MIGRATED)
  })

  it('the live case: one blank line inserted between two text lines (an LLM copy) is still unedited', () => {
    // Measured on a live sub-agent: the copy had a blank line right after the
    // `mkdir -p ~/.claude/skills/SKILL-NEV` line, where the shipped text has none.
    const [r] = readRetiredSkillSections()
    const lines = r.split('\n')
    const at = lines.findIndex((l) => l.includes('SKILL-NEV'))
    expect(lines[at + 1]).not.toBe('')
    const copy = [...lines.slice(0, at + 1), '', ...lines.slice(at + 1)].join('\n')
    const out = upgradeRetiredSkillSection(`# A\n\n${copy}\n\n## Időkezelés\n\nx\n`, [r], buildSkillSection())
    expect(out).toBe(`# A\n\n${buildSkillSection()}\n\n## Időkezelés\n\nx\n`)
  })

  it('a heading line with trailing spaces is still the section heading', () => {
    const [r] = readRetiredSkillSections()
    const copy = r.replace(/^## Öntanulás és Skill rendszer/, '## Öntanulás és Skill rendszer  ')
    expect(copy).not.toBe(r)
    expect(upgradeRetiredSkillSection(`# A\n\n${copy}\n`, [r], buildSkillSection())).toBe(`# A\n\n${buildSkillSection()}\n`)
  })

  it('M3: a whitespace-only copy of the newest retired section is replaced too', () => {
    const lines = retired[0].split('\n')
    const mkdirAt = lines.findIndex((l) => l.includes('SKILL-NEV'))
    expect(mkdirAt).toBeGreaterThan(-1)
    // an LLM's copy: CRLF line endings, an extra blank line padded into the
    // SKILL-NEV block (where a blank line already sits, so normalizing absorbs
    // it), trailing spaces on two body lines (the heading line is left
    // verbatim so the section is still found)
    const padded = [...lines.slice(0, mkdirAt), '', ...lines.slice(mkdirAt)]
    padded[2] += '  '
    padded[padded.length - 1] += '  '
    const variant = padded.join('\r\n')
    // same text, whitespace only -- that is what makes it an unedited copy
    expect(normalizeSectionWhitespace(variant)).toBe(normalizeSectionWhitespace(retired[0]))
    expect(upgradeRetiredSkillSection(around(variant), retired, current)).toBe(MIGRATED)
  })

  it('M4: an edited section is left alone', () => {
    const edited = retired[0].replace('Generálj', 'Írj')
    expect(edited).not.toBe(retired[0])
    expect(upgradeRetiredSkillSection(around(edited), retired, current)).toBeNull()
  })

  it('M5: an already-current CLAUDE.md and one without the section are left alone', () => {
    expect(upgradeRetiredSkillSection(around(current), retired, current)).toBeNull()
    expect(upgradeRetiredSkillSection('# A\n\nintro\n\n## Időkezelés\n\nx\n', retired, current)).toBeNull()
  })

  it('M6: the section as the last section of the file is replaced, with one trailing newline', () => {
    const out = upgradeRetiredSkillSection(`# A\n\nintro\n\n${retired[0]}\n`, retired, current)
    if (out === null) throw new Error('last section of the file was not replaced')
    expect(out).toBe(`# A\n\nintro\n\n${current}\n`)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('M7: the current section proposes, every retired version wrote the global directory', () => {
    expect(current.startsWith(HEADING)).toBe(true)
    expect(current.endsWith('\n')).toBe(false)
    expect(current).toContain('/api/skills/propose')
    expect(current).toContain('mkdir -p .claude/skills/SKILL-NEV')
    // the migration is what removes the global-directory write
    expect(current).not.toContain('mkdir -p ~/.claude/skills/')
    expect(retired.length).toBeGreaterThan(0)
    for (const old of retired) expect(old).toContain('mkdir -p ~/.claude/skills/')
  })

  it('M8: readRetiredSkillSections returns [] for a missing file and for invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-section-'))
    try {
      expect(readRetiredSkillSections(join(dir, 'missing.json'))).toEqual([])
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, 'not { valid json')
      expect(readRetiredSkillSections(bad)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('M9: the main agent CLAUDE.md is never touched', () => {
    expect(ensureSkillSectionCurrent(MAIN_AGENT_ID)).toBe(false)
  })

  it('M10: generateClaudeMd embeds buildSkillSection(), and the heading lives only there', () => {
    // Read the source the way skill-propose-instructions.test.ts does, so the
    // prompt agents are SHIPPED and the section the migration WRITES cannot
    // drift apart.
    const src = read('src/web/agent-scaffold.ts')
    const body = (from: number) => {
      const m = src.slice(from + 1).search(/\n(function |export )/)
      return src.slice(from, m < 0 ? undefined : from + 1 + m)
    }
    expect(src).toContain('${buildSkillSection(tokenPath)}')
    const g = src.indexOf('function generateClaudeMd')
    expect(g).toBeGreaterThan(-1)
    expect(body(g)).toContain('${buildSkillSection(tokenPath)}')
    // the section text lives once, in buildSkillSection's template literal (it opens
    // with the heading); no line of the file is the bare heading, so no second copy of
    // the section sits in the prompt -- that would be the drift
    expect(src.split('`' + HEADING).length - 1).toBe(1)
    expect(src.split('\n').filter((l) => l === HEADING)).toHaveLength(0)
    const f = src.indexOf('function buildSkillSection')
    expect(f).toBeGreaterThan(-1)
    expect(body(f)).toContain(HEADING)
  })
})
