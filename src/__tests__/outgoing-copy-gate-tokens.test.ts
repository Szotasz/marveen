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

// COPYGATEEKEZETVAK915 (2026-09-15): the same prose-vs-identifier class, now on
// a FILENAME. `Mail.app-ot` is a dotted product name carrying a hyphenated
// Hungarian suffix. The TECHNICAL mask cut out `Mail.app` and left `-ot` behind,
// which the tokenizer read as the standalone word `ot` (-> öt) and BLOCKED the
// morning briefing. The Chrome-ot rule above does not reach it: that branch wants
// letters only before the hyphen, and a dot is not a letter. The fix keeps the
// suffix with the token it belongs to, so `.app`/`.sh`/`.json`/`.md` names can be
// declined in Hungarian -- which is how the owner has to type them on the machine.
describe('outgoing-copy gate tokenization: a Hungarian suffix on a dotted filename is not prose (COPYGATEEKEZETVAK915)', () => {
  it('the real blocked sentence passes: a product name with a dot plus a hyphenated suffix', () => {
    expect(auditAccent('Ha elindítod a Mail.app-ot, akkor a következő napindító újra valódi adatot ad, és nem kell azzal foglalkozni, hogy a levelek hol vannak, mert az index magától frissül.')).toEqual([])
  })

  it('script and config filenames decline the same way', () => {
    expect(auditAccent('A update.sh-t és a config.json-ban levő beállítást is megnéztem, és nem kell hozzányúlni, mert az a rész rendben van.')).toEqual([])
  })

  it('a real accent error next to the filename is still caught -- the mask must not swallow the sentence', () => {
    const probs = auditAccent('A config.json-ban van a video beállítás, és nem kell hozzányúlni, mert az a rész rendben van, csak a többi vár még rám.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('video -> videó')
  })

  it('a standalone "ot" in the same sentence as a filename is still caught (no whitelist widening)', () => {
    const probs = auditAccent('A Mail.app-ot megnéztem, de kérlek küldj át ot darabot, mert az a rész rendben van, csak a többi vár még rám.')
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('ot -> öt')
    expect(probs[0]).toContain('küldj át ot darabot')
  })
})

function auditAll(text: string): string[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps(g.audit(sys.argv[1])))
`, text], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

// ISSUE1838COPYGATE (#2543, 2026-11-05): GATESZAMKOTOJEL821 one step further. The number branch wanted a DIGIT
// right before the hyphen, so a suffix after a UNIT SIGN ('30%-ot', '2‰-es') was cut off and read as a standalone
// word: 'ot' -> 'öt', 'es' -> 'és'. Suffixes that are not dictionary words ('20%-kal', '15%-át') passed by luck,
// which is why the class stayed hidden. Number + sign + suffix is now one technical token.
// The sentences carry enough Hungarian context to be judged as Hungarian at all: a one-line sentence is not, and the
// accent check never runs on it -- a test on one would pass with and without the fix (measured on the mutant).
const HU_TAIL = 'ha a csomag megújul, és köszönöm, hogy szóltál.'

describe('outgoing-copy gate tokenization: a suffix after a number and a unit sign is not prose (ISSUE1838COPYGATE)', () => {
  it('the reported sentence passes: a percentage with a hyphenated suffix', () => {
    expect(auditAccent(`Szia! A jutalék a 30%-ot is elérheti, ${HU_TAIL}`)).toEqual([])
  })

  it('the other unit signs and a spaced or non-breaking-spaced sign decline the same way', () => {
    expect(auditAccent(`Szia! A 2‰-es arány, a 90°-os szög és az 5€-es díj is rendben van, ${HU_TAIL}`)).toEqual([])
    expect(auditAccent(`Szia! A jutalék a 30 %-ot is elérheti, ${HU_TAIL}`)).toEqual([])
    expect(auditAccent(`Szia! A jutalék a 30\u00a0%-ot is elérheti, ${HU_TAIL}`)).toEqual([])
  })

  it('the suffixes that already passed still pass (no regression on the lucky cases)', () => {
    expect(auditAccent(`Szia! A jutalék 20%-kal nőtt, a bevétel 15%-át és a 10%-os kedvezményt is beszámoljuk, ${HU_TAIL}`)).toEqual([])
  })

  it('a real accent error right after the percentage is still caught -- the mask ends at the suffix', () => {
    const probs = auditAccent(`Szia! A 30%-ot es a többit holnap küldöm, ${HU_TAIL}`)
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('es -> és')
  })

  it('a standalone "ot" in the same sentence as a percentage is still caught (no whitelist widening)', () => {
    const probs = auditAccent(`Szia! A 30%-ot megnéztem, de kérlek küldj át ot darabot, ${HU_TAIL}`)
    expect(probs.length).toBe(1)
    expect(probs[0]).toContain('ot -> öt')
    expect(probs[0]).toContain('küldj át ot darabot')
  })

  it('a Cyrillic homoglyph in the suffix still reaches the homoglyph rule (the sign branch is Latin-only)', () => {
    const probs = auditAll(`Szia! A jutalék a 30%-\u043et is elérheti, ${HU_TAIL}`)
    expect(probs.some((p) => p.includes('homoglifa') && p.includes('U+043E'))).toBe(true)
  })

  it('a non-Latin letter at the END of the suffix still reaches the homoglyph rule (the suffix end is pinned)', () => {
    for (const [suffix, code] of [['o\u0442', 'U+0442'], ['ka\u043b', 'U+043B'], ['o\u03c4', 'U+03C4']]) {
      const probs = auditAll(`Szia! A jutalék a 30%-${suffix} is elérheti, ${HU_TAIL}`)
      expect(probs.some((p) => p.includes('homoglifa') && p.includes(code))).toBe(true)
    }
  })
})

// COPYGATEHOMONUM1105: the PLAIN number branch (number, hyphen, suffix: '8:09-es', '2-es') took any Unicode letter as
// its suffix, so a Cyrillic or Greek letter in it was masked away before the homoglyph rule ran: the mixed word was
// never seen (measured on develop b492429c: 0 findings). Same rule as its sibling above: Hungarian Latin only, the
// end of the suffix pinned.
describe('outgoing-copy gate: a homoglyph in a number suffix reaches the homoglyph rule (COPYGATEHOMONUM1105)', () => {
  it('a non-Latin letter anywhere in the suffix after a plain number is reported', () => {
    for (const [suffix, code] of [['\u043et', 'U+043E'], ['o\u0442', 'U+0442'], ['ka\u043b', 'U+043B'], ['o\u03c4', 'U+03C4']]) {
      const probs = auditAll(`Szia! A díj a 30-${suffix} is elérheti, ${HU_TAIL}`)
      expect(probs.some((p) => p.includes('homoglifa') && p.includes(code)), suffix).toBe(true)
    }
    const probs = auditAll(`Szia! A hívás 8:09-\u0435s kezdődik, ${HU_TAIL}`)
    expect(probs.some((p) => p.includes('homoglifa') && p.includes('U+0435'))).toBe(true)
  })

  // The mask itself, read directly: on audit() the branch is not visible for Latin text (the accent tokenizer handles
  // a number-hyphen suffix on its own; measured 2026-11-06, the verdicts were identical with and without the branch),
  // so only this pin keeps the branch masking real Hungarian suffixes, accented ones included.
  it('strip_technical masks a Hungarian number suffix whole, and leaves a non-Latin one for the homoglyph rule', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
print(json.dumps([g.strip_technical(t).strip() for t in sys.argv[1:]]))
`, '8:09-es', '10-én', '5-ös', '2-őt', '17:06-kor', '30-\u043et', '30-o\u0442'], { encoding: 'utf-8' })
    const got = JSON.parse(out.trim()) as string[]
    expect(got.slice(0, 5)).toEqual(['', '', '', '', ''])
    expect(got[5]).toContain('\u043e')
    expect(got[6]).toContain('\u0442')
  })

  it('real Hungarian number suffixes still pass, accents included', () => {
    expect(auditAccent(`Szia! A 8:09-es vonattal megyek, a 2-es kapunál várlak 17:06-kor, ${HU_TAIL}`)).toEqual([])
    expect(auditAccent(`Szia! November 10-én, az 5-ös teremben a 2-őt és a 3-at is megnézzük, ${HU_TAIL}`)).toEqual([])
    expect(auditAll(`Szia! A 2-es kapunál várlak 17:06-kor, ${HU_TAIL}`).filter((p) => p.includes('homoglifa'))).toEqual([])
  })
})
