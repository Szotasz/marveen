import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// GATEKOTOJEL817 + GATEHYPH816: two false positives in five minutes, in a live
// owner conversation, both the same class -- the gate could not tell PROSE
// from IDENTIFIER. (1) `Drive-ot`: a Hungarian suffix attaches to a foreign
// proper noun WITH a hyphen (that is the correct spelling); the letters-only
// tokenizer cut at the hyphen and read the `ot` remainder as a standalone
// Hungarian word (ot -> öt). (2) `Video atalakitas`: a Drive FOLDER NAME
// quoted in prose -- a mid-sentence capitalized word is an identifier, not
// prose. The fix is TOKENIZATION, not the dictionary (a word exception list
// would also pass real errors): hyphenated forms are checked as the WHOLE
// token, and mid-sentence capitalized words are skipped -- while sentence-
// start capitals and lowercase prose remain fully checked.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

function auditAccent(text: string): string[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps([p for p in g.audit(sys.argv[1]) if "HIANYZO" in p]))
`, text], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

describe('outgoing-copy gate tokenization: prose vs identifier (GATEKOTOJEL817/GATEHYPH816)', () => {
  it('a hyphen-suffixed foreign proper noun passes: the suffix fragment is not a standalone word', () => {
    // Marveen's real blocked sentence, correctly accented -- must go through.
    expect(auditAccent('Ha a Drive-ot választod, elég a mappába dobni, és köszönöm, hogy már átküldted.')).toEqual([])
  })

  it('a quoted identifier (mid-sentence capitalized folder name) passes', () => {
    // The second real blocked sentence: a Drive folder called "Video atalakitas".
    expect(auditAccent('A neve Video átalakítás, ott találod, hogy már ne kelljen külön keresni.')).toEqual([])
  })

  it('lowercase prose "video" still fails -- the fix must not widen into a whitelist', () => {
    const probs = auditAccent('Szia, a video nagyon jól sikerült, köszönöm, hogy átküldted.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('a sentence-START capitalized word is prose and still fails (the skip-rule must not over-reach)', () => {
    const probs = auditAccent('Köszönöm, hogy megnézted. Video lett a vége, már csak fel kell tölteni.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('a standalone accentless word that ALSO exists as a suffix still fails (ot -> öt)', () => {
    const probs = auditAccent('Kérlek, küldj át ot darabot, hogy már ne kelljen várni.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('ot -> öt')
  })

  it('the finding names its context: 3 words each side plus the character position (no more grepping mid-conversation)', () => {
    const probs = auditAccent('Szia, a video nagyon jól sikerült, köszönöm, hogy átküldted.')
    // Neighbours on both sides and an @<pos> marker.
    expect(probs[0]).toMatch(/"\.\.\.[^"]*a video nagyon[^"]*\.\.\." @\d+/)
  })
})

// GATESZAMKOTOJEL821 (2026-08-21): the same prose-vs-identifier class, one step
// further. HYPHEN_WORD admits only LETTERS around the hyphen, so a Hungarian
// suffix attached to a NUMBER ("429-es", "2026-os") is tokenized as a bare word
// -- and "es" then reads as the accent-stripped "és". The gate blocked a correct
// message about HTTP status codes. A digit before the hyphen is the signal: that
// token is part of an identifier, not prose.
describe('outgoing-copy gate tokenization: a suffix attached to a number is not prose (GATESZAMKOTOJEL821)', () => {
  it('HTTP status codes with Hungarian suffixes pass', () => {
    expect(auditAccent('A 429-es vagy 403-as hibakód esetén várunk egy kicsit, és köszönöm, hogy szóltál.')).toEqual([])
  })

  it('a year and a port number with suffixes pass', () => {
    expect(auditAccent('A 2026-os tervben a 3420-as port marad, és kérlek jelezz, ha nem így van.')).toEqual([])
  })

  it('a standalone "es" in the same sentence is still caught -- the fix must not widen into a whitelist', () => {
    // Both halves in one sentence: the suffix on 429 is skipped, the bare word is not.
    const probs = auditAccent('A 429-es hibakod mellett a dokumentum es a melleklet is megjott, kerlek nezd meg.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('es -> és')
    // the reported occurrence is the standalone one, not the suffix on 429
    expect(probs[0]).toContain('a dokumentum es a melleklet')
  })
})

// GATEIDEZET822 (2026-08-22): the gate blocked its OWN outgoing message because
// the message QUOTED the accent-stripped sentence from the incident it was
// explaining. The gate audits the author's own prose; a verbatim quote is not
// the author's writing, and showing the wrong form is often the whole point.
// Quoted spans are therefore masked out of every check -- but the masking must
// not become a bypass: the same wrong form in the author's own sentence still
// blocks, and a masked-away finding is written to the gate log, never silent.
function auditAll(text: string): string[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps(g.audit(sys.argv[1])))
`, text], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

describe('outgoing-copy gate: quoted spans are the author\'s evidence, not the author\'s prose (GATEIDEZET822)', () => {
  it('an accent-stripped sentence inside Hungarian quotes passes', () => {
    expect(auditAll('A tegnapi levélben ez ment ki: „itt van a licenckulcsod es a telepito”. Ezt javítottuk, köszönjük a jelzést.')).toEqual([])
  })

  it('the same accent-stripped words in the author\'s own sentence still fail', () => {
    const probs = auditAll('Itt van a licenckulcsod es a telepito, kerlek jelezz ha megjott, koszonom.')
    expect(probs.some((p) => p.includes('HIANYZO EKEZETEK'))).toBe(true)
  })

  it('straight double quotes mask too', () => {
    expect(auditAll('A hibás alak, amit kerülünk: "es a telepito". Helyesen és a telepítő.')).toEqual([])
  })

  it('a markdown blockquote line is masked', () => {
    expect(auditAll('A panasz szövege így szólt:\n> a felulet nem mukodik es nem jon valasz\n\nEzt kivizsgáljuk, köszönjük a jelzést.')).toEqual([])
  })

  it('an unclosed quote does not swallow the rest of the message', () => {
    const probs = auditAll('Idézem: „ez a mondat sosem zárul le, es a telepito hibas maradt, kerlek nezd meg.')
    expect(probs.some((p) => p.includes('HIANYZO EKEZETEK'))).toBe(true)
  })

  it('a paragraph break inside a quote pair cancels the masking', () => {
    const probs = auditAll('Idézem: „első rész\n\nes a telepito hibas maradt, kerlek nezd meg” vége.')
    expect(probs.some((p) => p.includes('HIANYZO EKEZETEK'))).toBe(true)
  })
})
