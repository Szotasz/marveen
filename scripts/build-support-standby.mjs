// Makes scripts/support-standby.mjs, the support routine as ONE self-contained
// file, from src/support-standby-cli.ts.
//
//   node scripts/build-support-standby.mjs           write the file
//   node scripts/build-support-standby.mjs --check   exit 1 when the file in the repo is not what a build gives
//
// esbuild runs HERE, at build time, and nowhere else: the built file is
// committed, the installer and the rescue path only ever run that file. A test
// (src/__tests__/support-standby-build.test.ts) fails when the committed file
// and a fresh build differ, so the two cannot drift apart unnoticed.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const SUPPORT_STANDBY_SOURCE = 'src/support-standby-cli.ts'
export const SUPPORT_STANDBY_FILE = 'scripts/support-standby.mjs'

const BANNER = `// GENERATED FILE, DO NOT EDIT. The support routine as one self-contained file:
// only node's own modules, no node_modules, nothing from the compiled tree.
// Source: ${SUPPORT_STANDBY_SOURCE}. Rebuild: node scripts/build-support-standby.mjs`

/** The text of a fresh build. Nothing is written. */
export async function buildSupportStandby() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [SUPPORT_STANDBY_SOURCE],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    // The lowest node the routine supports; see SUPPORT_ROUTINE_MIN_NODE_MAJOR.
    target: 'node20',
    // Anything that is not a node built-in would have to be inlined; there must be none.
    packages: 'bundle',
    legalComments: 'none',
    charset: 'ascii',
    banner: { js: BANNER },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fresh = await buildSupportStandby()
  const target = join(ROOT, SUPPORT_STANDBY_FILE)
  if (process.argv.includes('--check')) {
    let current = null
    try {
      current = readFileSync(target, 'utf8')
    } catch {
      /* missing is "not the same" */
    }
    if (current !== fresh) {
      process.stderr.write(SUPPORT_STANDBY_FILE + ' is not what a build gives; run: node scripts/build-support-standby.mjs\n')
      process.exitCode = 1
    }
  } else {
    writeFileSync(target, fresh)
    process.stdout.write('wrote ' + SUPPORT_STANDBY_FILE + ' (' + fresh.length + ' characters)\n')
  }
}
