// SHAJELZES1115: a procedure change is reported with the SHA of what is on disk.
//
// The owner's rule: when an agent's development changes one of its
// own procedures (a SKILL.md, a scheduled task's prompt, its own tool or script),
// the report under fleet rule 5 says WHAT CHANGED and carries the SHA-256 of
// every affected file, measured at the end of the work. The report's text says
// what the agent meant to do; only the SHA says what is on disk, and the two
// drift apart (an abandoned edit, a regenerated block, a later fix). Afterwards
// only the SHA tells which version a report was about.
//
// The rule went into the existing agents' CLAUDE.md files by hand, and onto no
// generating surface -- the AUTHSECT919 shape again (see agent-scaffold.ts). An
// agent generated since then reports a procedure change without the SHA, and
// nothing errors: the gap shows only when someone later asks which version a
// report meant.
//
// Both halves are pinned, in both languages: the colleague agent's rule inside
// rule 5 of the generateClaudeMd prompt, and the main agent's receiving half in
// the persona template (it forwards the reports, so it carries the SHA on and
// asks for it when it is missing). The test reads the sources, as
// agent-scaffold-inviolable-rules.test.ts does, because the regression would
// live in a prompt string.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

// The rule-5 line of a generator prompt: the SHA sentence must sit IN that rule,
// not anywhere in a 200 KB file.
const rule5 = (src: string, head: string): string => {
  const line = src.split('\n').find((l) => l.startsWith(head))
  expect(line, head).toBeDefined()
  return line as string
}

describe('fleet rule 5 carries the SHA of a procedure change (SHAJELZES1115)', () => {
  it('the Hungarian generator prompt: what changed, the SHA, measured at the end, not an approval gate', () => {
    const l = rule5(read('src/web/agent-scaffold.ts'), '5. **FEJLESZTHETSZ a saját munkádhoz')
    expect(l).toContain('MI VÁLTOZOTT')
    expect(l).toContain('minden érintett fájl SHA-256-jának első 12 karakterét')
    expect(l).toContain('a munka VÉGÉN mérve')
    expect(l).toContain('nyom-követelmény, nem jóváhagyási kapu')
  })

  it('the English generator prompt says the same', () => {
    const l = rule5(read('src/web/agent-scaffold-en.ts'), '5. **You MAY DEVELOP for your own work')
    expect(l).toContain('WHAT CHANGED')
    expect(l).toContain('the first 12 characters of the SHA-256 of every affected file')
    expect(l).toContain('measured at the END of the work')
    expect(l).toContain('a trace requirement, not an approval gate')
  })

  it('the main-agent templates carry the receiving half: the SHA goes on unchanged, and is asked for when missing', () => {
    const hu = read('templates/CLAUDE.md.template')
    expect(hu).toContain('### Sub-ágens fejlesztés-jelzése (flotta-szabály 5.)')
    expect(hu).toContain('változatlanul vidd tovább; ha hiányzik, kérd el')
    const en = read('templates/en/CLAUDE.md.template')
    expect(en).toContain("### A sub-agent's development report (fleet rule 5)")
    expect(en).toContain('Carry it into the summary unchanged; if it is missing, ask for it')
  })
})
