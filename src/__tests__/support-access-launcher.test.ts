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

  it('does not echo the code on a terminal, and always puts the terminal back (Dani S1, 78485)', () => {
    const before = LAUNCHER.indexOf('IFS= read -r CODE')
    const head = LAUNCHER.slice(0, before)
    expect(head).toContain('stty -echo')
    expect(head).toContain(`trap 'stty "$SAVED_TTY" 2>/dev/null' EXIT`)
    expect(head).toContain(`trap 'stty "$SAVED_TTY" 2>/dev/null; exit 130' INT TERM HUP`)
    expect(head.lastIndexOf('stty -echo')).toBeGreaterThan(head.lastIndexOf('trap '))
    expect(LAUNCHER.slice(before, before + 200)).toContain('stty "$SAVED_TTY"')
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

describe("the routine's enable refusals, as sentences", () => {
  // The function exactly as the committed launcher carries it, run alone.
  const fn = LAUNCHER.slice(LAUNCHER.indexOf('enable_refusal() {'), LAUNCHER.indexOf('\n}\n', LAUNCHER.indexOf('enable_refusal() {')) + 3)
  const mail = LAUNCHER.split('\n').filter((l) => l.startsWith('SUPPORT_MAIL='))
  const say = (code: string): string =>
    spawnSync('/bin/sh', ['-c', `${mail.join('\n')}\n${fn}\nenable_refusal "$1"`, '_', code], { encoding: 'utf8', timeout: 10_000 }).stdout

  it('already_on (Bence 78560, Dani F1 on #2779): turn it off first, with the disable line, then run again; the code is not spent (Bence 78639)', () => {
    const out = say('already_on')
    expect(out).toContain('(already_on)')
    expect(out).toContain(`~/.marveen/support/kit/${KIT_LAUNCHER_NAME} disable`)
    expect(out).toContain('futtasd újra ezt a sort')
    expect(out).toContain('nem fogy el')
    expect(out).not.toContain('új kódot')
    expect(out).not.toContain('Küldd el nekünk')
  })

  it('names the one support address, hello@marveen.io, wherever it asks the customer to write (the owner, 78568)', () => {
    expect(mail).toEqual(['SUPPORT_MAIL=hello@marveen.io'])
    expect(LAUNCHER).not.toMatch(/aiamindennapokban/)
    const asks = LAUNCHER.split('\n').filter((l) => /[Íí]rj nekünk|[Kk]üldd el nekünk/.test(l))
    expect(asks.length).toBeGreaterThan(5)
    for (const l of asks) expect(l).toContain('$SUPPORT_MAIL')
    expect(say('rate_limited')).not.toContain('hello@')
    expect(say('keys_file_layout')).toContain('(hello@marveen.io)')
    expect(say('service_unavailable')).toContain('írj nekünk (hello@marveen.io), és küldd el ezt a kódot: service_unavailable.')
  })

  it('a release whose pins are not complete (no key, no source address, malformed) says: update Marveen (Geri 78991)', () => {
    for (const code of ['support_keys_unset', 'support_from_unset', 'support_pins_invalid']) {
      const out = say(code)
      expect(out, code).toContain('(' + code + ')')
      expect(out, code).toContain('Ez a Marveen-kiadás még nem tartalmazza a távoli segítség beállításait (' + code + '). Frissítsd a Marveent.')
      expect(out, code).not.toContain('A bekapcsolás nem sikerült')
    }
  })

  it('an unknown code still falls through to the generic sentence with the code in it', () => {
    expect(say('something_new')).toContain('A bekapcsolás nem sikerült (something_new)')
  })
})

describe('a finished disable', () => {
  it('says the machine stays on the marveen.io account until the Profile page removes it (Dani 78558)', () => {
    const tail = LAUNCHER.slice(LAUNCHER.indexOf('if [ "$MODE" = disable ]; then'))
    const done = tail.slice(0, tail.indexOf('  exit 0\n'))
    expect(done).toContain('A levétel kész ezen a gépen.')
    expect(done).toContain('„Gép eltávolítása a supportból”')
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
