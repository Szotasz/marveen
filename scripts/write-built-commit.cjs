#!/usr/bin/env node
// Stamp dist/.built-commit with the commit the build was made from
// (BUILTSTAMPKEZI920, 2026-09-20).
//
// WHY THE BUILD WRITES IT. update.sh:747-751 uses dist/.built-commit as the
// staleness detector for the "git=NEW + dist=OLD" self-heal: a missing or
// mismatching stamp means "rebuild". Until now only install-macos.sh,
// install-linux.sh and update.sh wrote the stamp; a plain `npm run build` did
// not, so after every MANUAL build the stamp lied and someone had to write it
// by hand. And the hand-written stamp is the one operation that can BLIND the
// detector: a HEAD stamp over an older dist reads as fresh, and the self-heal
// never fires. Measured 2026-09-20: the stamp stayed on df5e4462 after a build
// from 70213357 and was corrected by hand only because the reviewer checked
// the dist's content and mtime first -- discipline, not a guarantee.
//
// CONTRACT (the card's two conditions):
//   1. Runs only AFTER a successful compile: package.json chains it with `&&`
//      behind `tsc`, so a failed build leaves the stamp untouched (a fresh
//      stamp over a half-built dist would be the blinding case again).
//   2. No git tree (tarball install), no readable HEAD, or no dist/: write
//      NOTHING and exit 0. A missing stamp already counts as STALE in
//      update.sh, so the fail-safe direction is unchanged, and the build must
//      not fail over a marker. The install/update scripts keep writing their
//      own stamp; the two agree because both write the full HEAD sha.
//
// Format matches the install scripts: the 40-hex sha and one newline.
'use strict'
const { execFileSync } = require('node:child_process')
const { existsSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const distDir = path.join(root, 'dist')
const stampFile = path.join(distDir, '.built-commit')

function headSha() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim()
    return /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    return null
  }
}

function main() {
  if (!existsSync(distDir)) {
    process.stderr.write('write-built-commit: no dist/ -- nothing stamped\n')
    return
  }
  const sha = headSha()
  if (!sha) {
    process.stderr.write('write-built-commit: no git HEAD (not a git tree?) -- nothing stamped\n')
    return
  }
  writeFileSync(stampFile, sha + '\n')
  process.stdout.write(`built-commit: ${sha}\n`)
}

main()
