import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// GATENEVSTRIP921 -- two rules looking at the same text do not want the same mask.
//
// REPORTED (community feed, 2026-09-21): the name rule ran on the RAW text, so a
// name-shaped string inside a URL, a code span, a snake_case identifier or a path
// stopped the whole outgoing message. Those are identifiers, not prose.
//
// MEASURED BEFORE FIXING (card comment 17237): the obvious fix -- moving the name
// check after strip_technical -- OPENS A HOLE. Two alternatives of the shared
// TECHNICAL mask (proper noun + Hungarian suffix, lowercase hyphenated identifier)
// swallow the NAME ITSELF together with its suffix, so "Name-val" / "Name-nak" /
// "Name-fele" disappear from the text before the rule ever sees them, and pass
// SILENTLY -- while those are the rule's most common prose targets.
//
// SHIPPED: the name rule gets its OWN, NARROWER mask (NAME_MASK): only the
// unambiguously technical regions are cut, the suffix branches stay in.
//
// The patterns below are SYNTHETIC on purpose. The live rule names a private third
// party and is deliberately untracked (store/ is gitignored, GATEPERSIST816); a
// regression test must not publish it into the repo.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

let RULES = ''

beforeAll(() => {
  // The gate log is derived from the rules file's directory, so a temp dir also
  // keeps this test from appending to the install's real gate log.
  const dir = mkdtempSync(join(tmpdir(), 'copy-gate-name-'))
  RULES = join(dir, 'outgoing-copy-gate-rules.json')
  writeFileSync(RULES, JSON.stringify({
    bad_name_patterns: ['Kovách', 'Kovach\\s+S[áa]ra'],
    correction: 'A helyes alak: Kovach.',
  }), 'utf-8')
})

/** Name findings only -- the other checks (accents, em dash) have their own tests. */
function nameProblems(text: string): string[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps([p for p in g.audit(sys.argv[1]) if "HELYTELEN NEV" in p]))
`, text], { encoding: 'utf-8', env: { ...process.env, OUTGOING_COPY_GATE_RULES: RULES } })
  return JSON.parse(out.trim())
}

describe('outgoing-copy gate: the name rule has its own mask (GATENEVSTRIP921)', () => {
  it('loads the synthetic rule at all -- positive control for the whole file', () => {
    // Without this, every "passes" assertion below would also be green with the
    // name check switched off entirely.
    expect(nameProblems('Kovách Szabolcs volt ott').length).toBe(1)
    expect(nameProblems('Kovách Szabolcs volt ott')[0]).toContain('Kovách')
  })

  // --- the hole the obvious fix would open: suffixed prose forms must still block
  it('a suffixed prose form still blocks: -val', () => {
    expect(nameProblems('Kovách-val beszeltem tegnap')).toHaveLength(1)
  })

  it('a suffixed prose form still blocks: -nak', () => {
    expect(nameProblems('Kovách-nak irtam meg ma')).toHaveLength(1)
  })

  it('a suffixed prose form still blocks: -fele', () => {
    expect(nameProblems('a Kovách-fele megoldas')).toHaveLength(1)
  })

  it('the multi-word spelling still blocks', () => {
    expect(nameProblems('Kovach Sara holnap jon')).toHaveLength(1)
  })

  it('a name after a comma is prose and still blocks', () => {
    expect(nameProblems('mondta Kovách, hogy jon')).toHaveLength(1)
  })

  // --- the reported false positives: identifiers must pass
  it('a code span passes', () => {
    expect(nameProblems('a `Kovách` a kodban')).toEqual([])
  })

  it('a URL passes', () => {
    expect(nameProblems('https://github.com/Kovách/marveen nezd meg')).toEqual([])
  })

  it('a snake_case identifier passes', () => {
    expect(nameProblems('a Kovách_teszt valtozoban van')).toEqual([])
  })

  it('a filename passes', () => {
    expect(nameProblems('a Kovách.md fajlban all')).toEqual([])
  })

  it('an email address passes', () => {
    expect(nameProblems('Kovách@pelda.hu cimre irtam')).toEqual([])
  })

  it('a path passes', () => {
    expect(nameProblems('a docs/Kovách/README utvonalon')).toEqual([])
  })

  // --- the masks must not drift apart
  it('NAME_MASK is strictly narrower than TECHNICAL, and both are built from one source', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
probe = "Kovách-val a docs/x/y utvonalon"
print(json.dumps({
  "name_keeps_suffixed": "Kovách-val" in g.strip_for_name(probe),
  "technical_eats_suffixed": "Kovách-val" not in g.strip_technical(probe),
  "both_cut_path": ("docs/x/y" not in g.strip_for_name(probe)) and ("docs/x/y" not in g.strip_technical(probe)),
  "common_is_shared": g._TECH_COMMON in g.TECHNICAL.pattern and g._TECH_COMMON == g.NAME_MASK.pattern,
}))
`], { encoding: 'utf-8' })
    expect(JSON.parse(out.trim())).toEqual({
      name_keeps_suffixed: true,
      technical_eats_suffixed: true,
      both_cut_path: true,
      common_is_shared: true,
    })
  })
})
