// Makes scripts/support-standby.mjs, the support routine as ONE self-contained
// file, from src/support-standby-cli.ts.
//
//   node scripts/build-support-standby.mjs           write the file and the kit hashes
//   node scripts/build-support-standby.mjs --check   exit 1 when either file in the repo is not what a build gives
//
// After the routine it writes scripts/support-kit.sha256: the stored sha256 of
// every file of the kit (see src/support-kit-sources.ts, which names the same
// files; a test keeps the two lists and the values in step).
//
// esbuild runs HERE, at build time, and nowhere else: the built file is
// committed, the installer and the rescue path only ever run that file. A test
// (src/__tests__/support-standby-build.test.ts) fails when the committed file
// and a fresh build differ, so the two cannot drift apart unnoticed.
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const SUPPORT_STANDBY_SOURCE = 'src/support-standby-cli.ts'
export const SUPPORT_STANDBY_FILE = 'scripts/support-standby.mjs'
export const SUPPORT_KIT_HASHES_FILE = 'scripts/support-kit.sha256'
/** Kit name and tree path of every kit file, in name order (the same list as KIT_SOURCES). */
export const SUPPORT_KIT_FILES = [
  ['support-dispatch.sh', 'scripts/support-dispatch.sh'],
  ['support-standby.mjs', SUPPORT_STANDBY_FILE],
]

/** The text of the hashes file for the routine text `routine` and the other kit files as they are in the tree. */
export function kitHashesText(routine) {
  return SUPPORT_KIT_FILES.map(([name, path]) => {
    const bytes = path === SUPPORT_STANDBY_FILE ? Buffer.from(routine, 'utf8') : readFileSync(join(ROOT, path))
    return createHash('sha256').update(bytes).digest('hex') + '  ' + name + '\n'
  }).join('')
}

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
  const outputs = [
    [SUPPORT_STANDBY_FILE, fresh],
    [SUPPORT_KIT_HASHES_FILE, kitHashesText(fresh)],
  ]
  if (process.argv.includes('--check')) {
    for (const [file, text] of outputs) {
      let current = null
      try {
        current = readFileSync(join(ROOT, file), 'utf8')
      } catch {
        /* missing is "not the same" */
      }
      if (current !== text) {
        process.stderr.write(file + ' is not what a build gives; run: node scripts/build-support-standby.mjs\n')
        process.exitCode = 1
      }
    }
  } else {
    for (const [file, text] of outputs) {
      writeFileSync(join(ROOT, file), text)
      process.stdout.write('wrote ' + file + ' (' + text.length + ' characters)\n')
    }
  }
}
