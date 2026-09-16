#!/usr/bin/env node
// Resolve (and guard) the backup directory an upgrade run writes its evidence into.
//
// WHY THIS IS NOT A ONE-LINE `BK=...` IN THE SHELL SCRIPT:
//
// The path used to be hardcoded to `backups/frissites-v1360`, while the file names
// inside it come from the PHASE only (`verify-elotte.txt`, `schedule-utana.txt`) and
// carry no version. A v1.38.0 run would therefore have written into the v1.36.0
// folder and overwritten the 2026-09-02 evidence in place -- two upgrades' proof
// mixed in one directory, with the older one vanishing under an identical file name.
// That is the kind of loss nobody notices afterwards, because nothing about the
// directory looks different.
//
// AND THE VERSION MUST BE PASSED IN, NOT READ FROM package.json. Measured
// 2026-09-16: package.json says 1.37.0 on the deployed branch and 1.38.0 on develop.
// During an upgrade it changes BETWEEN the two phases -- which is exactly when the
// two phases must agree. Deriving it would send `elotte` and `utana` to different
// directories, and the comparison step would then report "NINCS elotte-pillanatkep"
// and carry on, so a missing comparison would read as an operator mistake rather
// than as the tooling's. There is deliberately NO default: stopping is cheaper than
// writing evidence to the wrong place.
//
// Usage:
//   node scripts/frissites-backup-dir.mjs --verzio 1.38.0 --root /path [--bk DIR] [--stamp]
// Prints the resolved directory on stdout; every diagnostic goes to stderr, so the
// caller can do BK=$(... ) safely.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1] ?? null
}

const verzio = arg('--verzio')
const root = resolve(arg('--root') ?? '.')
const explicitBk = arg('--bk')
const stamp = process.argv.includes('--stamp')

if (!verzio || !/^\d+\.\d+\.\d+$/.test(verzio)) {
  console.error('frissites-backup-dir: --verzio <x.y.z> KOTELEZO (nincs alapertelmezes).')
  console.error('  Az ok: a package.json verzioja a ket fazis KOZOTT valtozik, tehat nem forras.')
  process.exit(64)
}

// 1.36.0 -> v1360, matching the directories already on disk (v1360, v1370).
const slug = `v${verzio.replace(/\./g, '')}`
const BK = explicitBk ? resolve(explicitBk) : join(root, 'backups', `frissites-${slug}`)
const STAMP = join(BK, '.verzio')

if (existsSync(BK)) {
  if (!statSync(BK).isDirectory()) {
    console.error(`frissites-backup-dir: ${BK} letezik, de nem konyvtar.`)
    process.exit(65)
  }
  if (existsSync(STAMP)) {
    const owner = readFileSync(STAMP, 'utf8').trim()
    if (owner !== verzio) {
      console.error(`frissites-backup-dir: ALLJ MEG -- ${BK} a ${owner} verziohoz tartozik, a cel ${verzio}.`)
      console.error('  A fajlnevek (verify-elotte.txt, schedule-utana.txt) verzio nelkuliek, tehat')
      console.error('  ez a futas FELULIRNA a masik frissites bizonyitekat, azonos nev alatt.')
      process.exit(66)
    }
  } else if (readdirSync(BK).length > 0 && basename(BK) !== `frissites-${slug}`) {
    // An unstamped, non-empty directory whose NAME does not encode this version.
    // Only reachable via --bk; the derived path always agrees with itself.
    console.error(`frissites-backup-dir: ALLJ MEG -- ${BK} nem ures, es a neve nem a ${verzio} verzioe.`)
    console.error('  Nincs benne .verzio belyeg sem, tehat nem tudjuk, kie. Ne irjunk bele.')
    process.exit(66)
  }
}

if (stamp) {
  const letezett = existsSync(BK)
  mkdirSync(BK, { recursive: true })
  // Only stamp a directory we created or one that is empty. An existing evidence
  // folder (the 2026-09-02 one) must not gain files from a later run.
  if (!letezett || readdirSync(BK).length === 0) {
    writeFileSync(STAMP, `${verzio}\n`)
  } else if (!existsSync(STAMP)) {
    console.error(`frissites-backup-dir: ${BK} mar letezik es nem ures -- a .verzio belyeget NEM irom bele.`)
    console.error('  A nev hordozza a verziot, es a meglevo bizonyitekhoz nem nyulunk.')
  }
}

console.log(BK)
