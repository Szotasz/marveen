#!/usr/bin/env node
// Answer ONE question: was dist/ built from the commit that is checked out now?
//
// Three outcomes, and they are deliberately three and not two:
//   OK       marker present and equal to HEAD
//   ELTERES  marker present and different -- dist came from another commit
//   HIANYZIK marker absent -- we do not know, and that is NOT the same as "no"
//
// The missing case exits non-zero on purpose. The previous behaviour printed
// "HIANYZIK" into a report and carried on with exit 0, so the absence of evidence
// was rendered in the same calm tone as evidence of success -- and a reader
// scanning a 200-line verification output reads a calm line as a passing line.
//
// Usage: node scripts/built-commit-check.mjs [marker-path] [repo-dir]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MARKER = resolve(process.argv[2] ?? 'dist/.built-commit')
const CWD = resolve(process.argv[3] ?? '.')

let head = null
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CWD, encoding: 'utf8' }).trim()
} catch {
  head = null
}

let raw = null
try {
  raw = readFileSync(MARKER, 'utf8')
} catch {
  raw = null
}

if (raw === null) {
  console.log(`  built-commit   : HIANYZIK (${MARKER})`)
  console.log('  VERDIKT        : NEM TUDJUK, melyik commitbol keszult a dist.')
  console.log('                   A hianyzo bizonyitek NEM azonos a negativ bizonyitekkal:')
  console.log('                   ez nem azt mondja, hogy regi a dist, hanem hogy nincs valaszunk.')
  console.log('                   Javitas: npm run build (az irja a markert).')
  process.exit(3)
}

// Line 1 is the SHA; anything after it is context, not part of the comparison.
const lines = raw.split('\n')
const marker = (lines[0] ?? '').trim()
const context = (lines[1] ?? '').trim()

console.log(`  built-commit   : ${marker}${context ? `   [${context}]` : ''}`)
console.log(`  HEAD           : ${head ?? '(nem git checkout)'}`)

if (head === null) {
  console.log('  VERDIKT        : nincs HEAD, az osszevetes nem elvegezheto.')
  process.exit(3)
}

if (marker === head) {
  const dirtyAtBuild = /(^|\s)dirty=1(\s|$)/.test(context)
  if (dirtyAtBuild) {
    console.log('  VERDIKT        : a marker egyezik, DE a build PISZKOS fabol keszult --')
    console.log('                   a dist nem kizarolag ezt a commitot tartalmazza.')
    process.exit(1)
  }
  console.log('  VERDIKT        : OK, a dist ebbol a commitbol keszult.')
  process.exit(0)
}

console.log('  VERDIKT        : ELTERES -- a dist NEM a jelenlegi HEAD-bol keszult.')
console.log('                   Amig nincs ujraepites, a FUTO kod mast csinal, mint a forras,')
console.log('                   es a kulonbseg semmilyen hibauzenetben nem jelenik meg.')
process.exit(1)
