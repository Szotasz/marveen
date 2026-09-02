import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanResult } from '../skill-scan.js'

/**
 * MIOCLISKILL831 -- a CLI szkennerenek PARITASA az EREDETI Python mio-scan-nel.
 *
 * MIERT ARANYFAJL, ES NEM ELO OSSZEHASONLITAS: a Python eredeti egy MASIK
 * repoban el (marveen-io), tehat itt nem futtathato. Az aranyfajlokat az
 * EREDETI szkenner generalta, es adatkent utaznak a fixture-ok mellett -- egy
 * eltéres igy aranyfajl-elteresként bukik ki, nem eszrevetlenul.
 *
 * ES AMI NELKUL A ZOLD EREDMENY KEVESEBBET ERNE, MINT AMENNYINEK LATSZIK:
 * a zold csak azt mondja, hogy MOST nincs kulonbseg -- nem azt, hogy a
 * fixture-keszlet ESZREVENNE, ha lenne. Ket egyforman vak szkenner kimenete
 * is egyezik. Ezert mind az OT bezart Python/JS eltérest KULON elrontjuk a
 * port egy masolataban, es megkoveteljuk, hogy a keszlet ETTOL elterjen.
 * Ami nem ter el, arrol a zold nem mond semmit.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures/skill-scan')
const FORRAS = join(HERE, '../skill-scan.ts')

const fixtureNevek = readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort()

/** Minden szabaly, aminek tuznie KELL valahol a keszletben. */
const MINDEN_SZABALY = [
  'ignore-previous-instructions', 'ignore-previous-instructions-hu', 'role-reassignment',
  'system-prompt-probe', 'fake-system-tag', 'imperative-html-comment', 'pipe-to-shell',
  'exfiltrate-instruction', 'tool-invocation-bait', 'long-base64-blob',
  'email-address', 'hu-phone-number', 'card-number-shaped', 'api-key-shaped',
  'bearer-token-literal', 'hu-taj-shaped', 'secret-assignment',
]

describe('skill-scan paritas az eredeti Python mio-scan-nel', () => {
  it(`a fixture-keszlet nem ures (${fixtureNevek.length} eset)`, () => {
    // "A nulla kulonbseg nulla eseten is nulla" -- a darabszam allitas, nem dísz.
    expect(fixtureNevek.length).toBeGreaterThanOrEqual(25)
  })

  for (const nev of fixtureNevek) {
    it(`${nev} kimenete BAJTRA egyezik az aranyfajllal`, () => {
      const szoveg = readFileSync(join(FIXTURES, nev), 'utf8')
      const arany = JSON.parse(readFileSync(join(FIXTURES, nev.replace(/\.md$/, '.expected.json')), 'utf8'))
      expect(scanResult(szoveg)).toEqual(arany)
    })
  }

  it('MINDEN szabalyra van ismert pozitiv (kulonben a zold diff nem bizonyit)', () => {
    const latott = new Set<string>()
    for (const nev of fixtureNevek) {
      for (const f of scanResult(readFileSync(join(FIXTURES, nev), 'utf8')).findings) latott.add(f.rule)
    }
    expect([...MINDEN_SZABALY].filter((r) => !latott.has(r))).toEqual([])
  })

  it('ISMERT NEGATIV: a tiszta fixture-on nulla talalat (a szkenner nem mindenre tuzel)', () => {
    expect(scanResult(readFileSync(join(FIXTURES, '24-tiszta.md'), 'utf8')).findings).toEqual([])
  })
})

/**
 * A mutacio a port egy MASOLATAT rontja el, es kulon folyamatban (tsx) futtatja
 * -- a production forrashoz nem nyul, es teszt-kapcsolo sem kerul bele.
 */
function mutaltKimenet(minta: RegExp, csere: string, fixtureNev: string): string {
  const forras = readFileSync(FORRAS, 'utf8')
  const rontott = forras.replace(minta, csere)
  if (rontott === forras) throw new Error(`a mutacio nem talalt mintat: ${minta}`)
  const dir = mkdtempSync(join(tmpdir(), 'skill-scan-mut-'))
  try {
    writeFileSync(join(dir, 'skill-scan.ts'), rontott)
    writeFileSync(
      join(dir, 'cli.ts'),
      `import { scanResult } from './skill-scan.js'\n` +
        `import { readFileSync } from 'node:fs'\n` +
        `console.log(JSON.stringify(scanResult(readFileSync(process.argv[2], 'utf8'))))\n`,
    )
    return execFileSync('npx', ['tsx', join(dir, 'cli.ts'), join(FIXTURES, fixtureNev)], {
      encoding: 'utf8',
      cwd: join(HERE, '../..'),
    }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function jokimenet(fixtureNev: string): string {
  return JSON.stringify(scanResult(readFileSync(join(FIXTURES, fixtureNev), 'utf8')))
}

describe('mutacios kontrollok -- a keszlet MERI-e az ot csapdat?', () => {
  const esetek: Array<[string, RegExp, string, string]> = [
    [
      'az inline flagek nem kerulnek at a RegExp flagjeire -- kis-nagybetu',
      /if \(inline\) \{[\s\S]*?\n  \}/,
      'if (inline) {\n    src = src.slice(inline[0].length);\n  }',
      '03-role-reassignment.md',
    ],
    [
      'az inline flagek nem kerulnek at -- a pont a sorvegen is atmegy',
      /if \(inline\) \{[\s\S]*?\n  \}/,
      'if (inline) {\n    src = src.slice(inline[0].length);\n  }',
      '06-imperative-html-comment.md',
    ],
    [
      'a szohatar a JS ASCII-valtozata marad (nem unicode-tudatos)',
      /out \+= BOUNDARY;/,
      "out += '\\\\b';",
      '27-unicode-szohatar.md',
    ],
    [
      'a szamjegy-osztaly ASCII-ra szukul (nem \\p{Nd})',
      /out \+= inClass \? String\.raw`\\p\{Nd\}` : String\.raw`\[\\p\{Nd\}\]`;/,
      "out += '\\\\d';",
      '22-unicode-szamjegy.md',
    ],
    [
      'a csonkitas UTF-16 egysegek szerint megy (nem kodpont szerint)',
      /const points = Array\.from\(s\);\n  return points\.length > 80 \? points\.slice\(0, 80\)\.join\(''\) \+ '\.\.\.' : s;/,
      "return s.length > 80 ? s.slice(0, 80) + '...' : s;",
      '21-emoji-csonkitas.md',
    ],
    [
      'a span UTF-16 egysegekben all (nem kodpontban)',
      /span: \[startKp, startKp \+ Array\.from\(snippet\)\.length\],/,
      'span: [start, start + snippet.length],',
      '28-emoji-a-talalat-elott.md',
    ],
  ]

  for (const [nev, minta, csere, fixtureNev] of esetek) {
    it(`eszreveszi, ha: ${nev}`, () => {
      expect(mutaltKimenet(minta, csere, fixtureNev)).not.toEqual(jokimenet(fixtureNev))
    }, 60_000)
  }
})
