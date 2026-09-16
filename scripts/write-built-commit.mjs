#!/usr/bin/env node
// Stamp dist/ with the commit it was built from.
//
// WHY THIS EXISTS AS A BUILD STEP AND NOT AS A HABIT: dist/.built-commit is read
// by the upgrade verification as the evidence of which commit produced the running
// code. It was maintained by hand, and on 2026-09-16 it was measured at 0a38062
// while HEAD was two weeks further on -- the 2026-09-15 rebuild had not touched it
// either. The direction of that lie is the harmful one: it claims dist is OLDER
// than it is, so a finished upgrade reads as "not applied" and gets run again.
//
// A checking tool whose input a human has to maintain is not a checking tool, it is
// a habit. So the build writes it, or nothing does.
//
// HONEST LIMIT, so the next reader does not have to find it by measuring: this runs
// from `npm run build`. Anything that invokes `tsc` DIRECTLY still leaves the marker
// naming the previous commit. The checker then reports ELTERES rather than staying
// quiet, which is the outcome that matters -- but the gap is real, and closing it
// would mean moving the stamp into the compiler step itself.
//
// FORMAT: line 1 is the bare SHA and nothing else, so `cat dist/.built-commit`
// stays readable and any existing reader keeps working. Line 2 carries context the
// SHA alone cannot give -- a build from a DIRTY tree does not correspond to that
// commit, and without the flag the marker would assert something the dist does not
// honour.
//
// DIRTY IS SCOPED TO WHAT tsc ACTUALLY READS, not to the whole tree. Measured on
// this checkout 2026-09-16: 161 modified/untracked paths, of which 0 were build
// inputs -- scratch files, screenshots, half-finished scripts. A whole-tree check
// would flag every single build as dirty, the verifier would fail every run, and a
// gate that is always red teaches exactly one reflex: override it. Untracked files
// still count WITHIN the scope, because a new .ts under src/ does get compiled.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// What tsc compiles, plus the files that decide HOW it compiles.
const BUILD_INPUTS = ['src', 'tsconfig.json', 'package.json']
const OUT = resolve(process.argv[2] ?? 'dist/.built-commit')
const CWD = resolve(process.argv[3] ?? '.')

function git(args) {
  return execFileSync('git', args, { cwd: CWD, encoding: 'utf8' }).trim()
}

let head
try {
  head = git(['rev-parse', 'HEAD'])
} catch {
  // Not a git checkout (a released tarball, a vendored copy). Refusing to write is
  // the honest outcome: an absent marker is a missing answer, which the checker
  // reports as such. A placeholder would be a WRONG answer, and those are read as
  // right.
  console.error('write-built-commit: not a git checkout, marker NOT written')
  process.exit(0)
}

const dirty = git(['status', '--porcelain', '--', ...BUILD_INPUTS]).length > 0
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${head}\ndirty=${dirty ? 1 : 0} built=${new Date().toISOString()}\n`)
console.log(`write-built-commit: ${head}${dirty ? ' (DIRTY tree)' : ''}`)
