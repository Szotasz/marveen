// SUPPORTMENTOUT1114: the kit's sh launcher (scripts/support-access).
// What runs it end to end against a real kit is scripts/__tests__/support-access-launcher.test.sh
// (CI or a container only, because it writes under the home). This file pins
// what can be checked without writing anything: the committed file is what the
// template and the routine's constants give; the loader inside it is word for
// word the dashboard's; every node it starts gets env -i; its manifest reader
// accepts and refuses exactly the shared cases; its code check is the redeem shape.
import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderSupportLauncher, supportCodeGlob, SUPPORT_LAUNCHER_FILE, SUPPORT_LAUNCHER_TEMPLATE } from '../support-access-launcher.js'
import { KIT_LOADER_SOURCE, KIT_RUN_ENV } from '../support-kit-loader.js'
import { KIT_DISPATCHER_NAME, KIT_LAUNCHER_NAME, KIT_ROUTINE_NAME } from '../support-kit-sources.js'
import { KIT_MAX_FILES, parseKitManifest } from '../support-kit.js'
import { SUPPORT_CODE_SHAPE } from '../support-access-redeem.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const LAUNCHER = readFileSync(join(ROOT, SUPPORT_LAUNCHER_FILE), 'utf8')
const CASES = JSON.parse(readFileSync(join(ROOT, 'tests', 'support-kit', 'manifest-cases.json'), 'utf8')) as {
  good: string
  bad: { label: string; text: string }[]
}

describe('the committed launcher', () => {
  it('is exactly what the template and the constants give', () => {
    expect(LAUNCHER).toBe(renderSupportLauncher(readFileSync(join(ROOT, SUPPORT_LAUNCHER_TEMPLATE), 'utf8')))
  })

  it('is exactly what the build script writes (rebuild with: node scripts/build-support-standby.mjs)', async () => {
    const build = (await import(pathToFileURL(join(ROOT, 'scripts', 'build-support-standby.mjs')).href)) as {
      buildSupportLauncher: () => Promise<string>
      SUPPORT_LAUNCHER_FILE: string
    }
    expect(build.SUPPORT_LAUNCHER_FILE).toBe(SUPPORT_LAUNCHER_FILE)
    expect(LAUNCHER).toBe(await build.buildSupportLauncher())
  })

  it('is executable in the tree, and passes a sh syntax check', () => {
    expect(statSync(join(ROOT, SUPPORT_LAUNCHER_FILE)).mode & 0o111).not.toBe(0)
    const run = spawnSync('/bin/sh', ['-n', join(ROOT, SUPPORT_LAUNCHER_FILE)], { encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
  })

  it('carries the loader word for word, once, between single quotes, with everything that varies after --', () => {
    const marker = "--input-type=module -e '"
    expect(LAUNCHER.split(marker).length).toBe(2)
    const start = LAUNCHER.indexOf(marker) + marker.length
    const end = LAUNCHER.indexOf("' -- ", start)
    expect(LAUNCHER.slice(start, end)).toBe(KIT_LOADER_SOURCE)
    expect(LAUNCHER.slice(end, LAUNCHER.indexOf('\n', end))).toBe(`' -- "$RHASH" "$KIT/${KIT_ROUTINE_NAME}" "$@"`)
  })

  it('starts every node with env -i and exactly the routine run environment', () => {
    // Every line that STARTS a node: the path check, the version, the loader run, the tree run.
    const starts = LAUNCHER.split('\n').filter((l) => /"\$NODE" (-e|--version|--input-type|"\$ROOT)/.test(l))
    expect(starts.length).toBe(4)
    const prefix = `env -i PATH=${KIT_RUN_ENV.PATH} LC_ALL=${KIT_RUN_ENV.LC_ALL} "$NODE" `
    for (const line of starts) expect(line, line).toContain(prefix)
    // And nothing else in the file names the node as a command.
    expect(LAUNCHER.split('\n').filter((l) => /(^|[;|&(]\s*)"\$NODE"/.test(l.trim()))).toEqual([])
  })

  it('never puts the one-time code in an argument: it reaches the routine on standard input', () => {
    expect(LAUNCHER).toContain(`OUT=$(printf '%s\\n' "$CODE" | run_kit enable --consent "$CV" `)
    expect(LAUNCHER).not.toMatch(/run_kit[^\n]*"\$CODE"/)
  })

  it('takes the consent version from the routine status, never from a number of its own (Samu 78474)', () => {
    expect(LAUNCHER).toContain('consent_version=*) CV=${line#consent_version=} ;;')
    expect(LAUNCHER).toContain('run_kit consent-text --consent "$CV"')
    expect(LAUNCHER).not.toMatch(/--consent [0-9]/)
  })
})

/** The launcher's manifest reader: the awk program inside it, run as the launcher runs it. */
function runReader(text: string): { status: number | null; stdout: string } {
  const open = LAUNCHER.indexOf('awk -v maxfiles=')
  const progStart = LAUNCHER.indexOf("'\n", open) + 2
  const progEnd = LAUNCHER.indexOf("\n}')", progStart) + 2
  const program = LAUNCHER.slice(progStart, progEnd)
  const run = spawnSync(
    'awk',
    ['-v', 'maxfiles=' + KIT_MAX_FILES, '-v', 'want_l=' + KIT_LAUNCHER_NAME, '-v', 'want_d=' + KIT_DISPATCHER_NAME, '-v', 'want_r=' + KIT_ROUTINE_NAME, program],
    { input: text, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10_000 },
  )
  return { status: run.status, stdout: run.stdout }
}

/** The checks the sh launcher makes around the reader: the size, no CR, a final LF. */
function launcherAccepts(text: string): boolean {
  if (Buffer.byteLength(text, 'latin1') > 4096 || text.includes('\r') || !text.endsWith('\n')) return false
  return runReader(text).status === 0
}

describe("the launcher's manifest reader, on the cases the routine's reader is held to", () => {
  it('accepts the good manifest and reads the four values the launcher uses', () => {
    expect(parseKitManifest(CASES.good)).not.toBeNull()
    const run = runReader(CASES.good)
    expect(run.status).toBe(0)
    const m = parseKitManifest(CASES.good)!
    expect(run.stdout).toBe([m.installRoot, m.nodePath, String(m.nodeMin), m.files[KIT_ROUTINE_NAME]].join('\n') + '\n')
  })

  it.each(CASES.bad.map((c) => [c.label, c.text] as const))('refuses: %s', (_label, text) => {
    expect(parseKitManifest(text)).toBeNull()
    expect(launcherAccepts(text)).toBe(false)
  })

  it('refuses a manifest the routine reads but that lacks one of the three run files', () => {
    const noDispatcher = CASES.good.replace(/^file support-dispatch\.sh [0-9a-f]{64}\n/m, '')
    expect(parseKitManifest(noDispatcher)).not.toBeNull()
    expect(runReader(noDispatcher).status).not.toBe(0)
  })
})

describe('the code check', () => {
  const caseGlob = (code: string): boolean =>
    spawnSync('/bin/sh', ['-c', `case "$1" in ${supportCodeGlob()}) exit 0 ;; *) exit 1 ;; esac`, '_', code], { timeout: 10_000 }).status === 0

  it.each([
    'msc_' + 'a'.repeat(32),
    'msc_' + 'A-_9'.repeat(8),
    'msc_' + 'a'.repeat(31),
    'msc_' + 'a'.repeat(33),
    'msx_' + 'a'.repeat(32),
    'msc_' + 'a'.repeat(31) + '!',
    'msc_' + 'a'.repeat(31) + ' ',
    '',
  ])('decides %j as the redeem shape does', (code) => {
    expect(caseGlob(code)).toBe(SUPPORT_CODE_SHAPE.test(code))
  })
})
