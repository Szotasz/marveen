import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ISSUE2472WSLSPIN1103: the #2472 reporter runs WSL 2.7.10. Before 3.0.1 an
// upstream WSL bug (microsoft/WSL#41173, fixed by #41319 in 3.0.1) makes the
// interop threads of wslhost.exe spin forever, and over hours or days the host
// CPU is eaten. On WSL, install-linux.sh now warns when the Windows-side WSL is
// older than 3.0.1, and stays silent whenever it cannot tell.
//
// This test runs the REAL block out of the shipped install-linux.sh, with a
// stub wsl.exe that answers `--version` the way the real one does (UTF-16LE,
// CRLF), under `set -e` + the installer's REAL ERR trap shape, and once more
// with `-u` and `pipefail` on top. The install must always reach the end.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const BEGIN = '# ISSUE2472WSLSPIN1103 begin'
const END = '# ISSUE2472WSLSPIN1103 end'

function block(src: string): string {
  const start = src.indexOf(BEGIN)
  const end = src.indexOf(END)
  if (start < 0 || end <= start) throw new Error('WSL interop-spin block not found')
  return src.slice(start, end + END.length)
}

/** What `wsl.exe --version` prints for a given WSL version (the first lines of the real output). */
const versionText = (wsl: string) =>
  `WSL version: ${wsl}\r\nKernel version: 6.6.87.2-1\r\nWSLg version: 1.0.66\r\nMSRDC version: 1.2.6074\r\nDirect3D version: 1.611.1-81528511\r\nDXCore version: 10.0.26100.1-240331-1435.ge-release\r\nWindows version: 10.0.26100.4652\r\n`
const utf16 = (s: string, bom = false) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wslspin-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
/**
 * Run the block. `answer` is the stub's stdout bytes (null = no wsl.exe on the
 * PATH at all); `fallback` places the stub only at the fallback path;
 * `strict` adds `-u` and `pipefail`.
 */
function run(answer: Buffer | null, opts: { strict?: boolean; rc?: number; timeout?: 'pass' | 'expire'; fallback?: boolean } = {}): { code: number; out: string } {
  const bin = join(dir, `bin${n++}`)
  mkdirSync(bin)
  const fallback = join(bin, 'no-such-fallback', 'wsl.exe')
  const originalFallback = '/mnt/c/Windows/System32/wsl.exe'
  const extracted = block(LINUX)
  expect(extracted).toContain(originalFallback)
  const isolated = extracted.replaceAll(originalFallback, fallback)
  if (answer !== null) {
    const payload = join(bin, 'answer.bin')
    writeFileSync(payload, answer)
    if (opts.fallback) mkdirSync(join(bin, 'no-such-fallback'))
    const stub = opts.fallback ? fallback : join(bin, 'wsl.exe')
    writeFileSync(stub, `#!/bin/bash\n[ "$1" = "--version" ] || exit 9\ncat '${payload}'\nexit ${opts.rc ?? 0}\n`)
    chmodSync(stub, 0o755)
  }
  if (opts.timeout) {
    // A stand-in for coreutils timeout: records its limit, then either runs the
    // command or behaves like an expired limit (no output, rc 124).
    const t = join(bin, 'timeout')
    // (stderr is discarded by the block, so the record goes to a file)
    const rec = `echo "TIMEOUT_USED $1" >> '${join(bin, 'timeout.log')}'`
    writeFileSync(t, opts.timeout === 'pass'
      ? `#!/bin/bash\n${rec}\nshift\nexec "$@"\n`
      : `#!/bin/bash\n${rec}\nexit 124\n`)
    chmodSync(t, 0o755)
  }
  const script = [
    opts.strict ? 'set -euo pipefail' : 'set -e',
    'on_error() { echo "TRAP_FIRED line $1"; exit 1; }',
    "trap 'on_error $LINENO' ERR",
    "ORANGE='<O>'; DIM='<D>'; NC='</>'",
    'IS_WSL=true',
    isolated,
    'echo REACHED_THE_END',
  ].join('\n')
  // Only the stub dir and the system tools: no real wsl.exe can answer.
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, LANG: 'C.UTF-8' },
  })
  let used = ''
  try { used = readFileSync(join(bin, 'timeout.log'), 'utf-8') } catch { /* no timeout stub, or never called */ }
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}${used}` }
}

const warned = (out: string) => out.includes('ismert hiba van')
// bash 4.4+ warns "ignored null byte in input" when a command substitution
// meets the raw UTF-16 NULs; the block strips them first, so the install log
// stays clean (bash 3.2 drops them silently, so this bites on Linux only).
const noNulWarning = (out: string) => expect(out).not.toMatch(/null byte/i)

describe('install-linux.sh warns about the WSL interop spin before 3.0.1', () => {
  for (const strict of [false, true]) {
    const mode = strict ? 'set -euo pipefail' : 'set -e'

    it(`UTF-16 3.0.3: silent, the install goes on (${mode})`, () => {
      const r = run(utf16(versionText('3.0.3.0')), { strict })
      expect(r.code).toBe(0)
      noNulWarning(r.out)
      expect(r.out).toContain('REACHED_THE_END')
      expect(r.out).not.toContain('TRAP_FIRED')
      expect(warned(r.out)).toBe(false)
    })

    it(`UTF-16 2.7.10: warns with the fix, the install goes on (${mode})`, () => {
      const r = run(utf16(versionText('2.7.10.0')), { strict })
      expect(r.code).toBe(0)
      expect(r.out).toContain('REACHED_THE_END')
      expect(r.out).not.toContain('TRAP_FIRED')
      expect(r.out).toContain('<O>WSL 2.7.10.0: ebben a regi WSL-verzioban ismert hiba van, amitol orak-napok alatt a wslhost.exe leterheli a gepet')
      expect(r.out).toContain('<D>Javitas Windows PowerShellben: wsl --update, utana: wsl --shutdown</>')
      noNulWarning(r.out)
    })

    it(`empty or garbage answer, or a failing wsl.exe: silent, rc 0 (${mode})`, () => {
      for (const [answer, rc] of [
        [Buffer.alloc(0), 0],
        [utf16('Usage: wsl.exe [Argument] [Options...] [CommandLine]\r\n'), 1],
        [Buffer.from([0xff, 0x00, 0x01, 0x02, 0xfe, 0x00, 0x0a]), 0],
        [utf16('WSL version: unknown\r\n'), 0],
        // only the WSLg line: not the WSL version, so no guess
        [utf16('WSLg version: 1.0.66\r\n'), 0],
      ] as Array<[Buffer, number]>) {
        const r = run(answer, { strict, rc })
        expect(r.code).toBe(0)
        expect(r.out).toContain('REACHED_THE_END')
        expect(r.out).not.toContain('TRAP_FIRED')
        expect(warned(r.out)).toBe(false)
      }
    })

    it(`no wsl.exe at all: silent, rc 0 (${mode})`, () => {
      const r = run(null, { strict })
      expect(r.code).toBe(0)
      expect(r.out).toContain('REACHED_THE_END')
      expect(r.out).not.toContain('TRAP_FIRED')
      expect(warned(r.out)).toBe(false)
    })
  }

  it('a stub only at the fallback path warns for WSL 2.7.10 and the install goes on', () => {
    const r = run(utf16(versionText('2.7.10.0')), { fallback: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain('REACHED_THE_END')
    expect(r.out).not.toContain('TRAP_FIRED')
    expect(warned(r.out)).toBe(true)
  })

  it('a BOM before the first line and a plain UTF-8 answer (WSL_UTF8=1) are read too', () => {
    expect(warned(run(utf16(versionText('2.7.10.0'), true)).out)).toBe(true)
    expect(warned(run(Buffer.from(versionText('2.7.10.0'), 'utf-8')).out)).toBe(true)
    expect(warned(run(Buffer.from(versionText('3.0.1.0'), 'utf-8')).out)).toBe(false)
  })

  it('a localized label still parses (the version follows "WSL" and its separator)', () => {
    expect(warned(run(utf16('WSL-verzió: 2.7.10.0\r\nKernelverzió: 6.6.87.2-1\r\n')).out)).toBe(true)
  })

  it('the comparison is numeric, component by component', () => {
    const cases: Array<[string, boolean]> = [
      ['3.0.1', false], ['3.0.1.0', false], ['3.0.0.9', true], ['3.0.10', false], ['3.1', false],
      ['2.10.0', true], ['2.9.99', true], ['2.7.14.0', true], ['10.0.0', false], ['3.00.01', false], ['2.07.10', true],
    ]
    for (const [v, warn] of cases) {
      expect([v, warned(run(utf16(`WSL version: ${v}\r\n`)).out)]).toEqual([v, warn])
    }
  })

  it('the call has a timeout, so a stuck interop cannot hang the installer', () => {
    expect(block(LINUX)).toContain('timeout 10 "$_wslexe" --version')
    for (const strict of [false, true]) {
      // timeout present: the call goes through it, with 10 s
      const through = run(utf16(versionText('2.7.10.0')), { strict, timeout: 'pass' })
      expect(through.out).toContain('TIMEOUT_USED 10')
      expect(warned(through.out)).toBe(true)
      // the limit expires (a stuck interop): silent, the install goes on
      const expired = run(utf16(versionText('2.7.10.0')), { strict, timeout: 'expire' })
      expect(expired.out).toContain('TIMEOUT_USED 10')
      expect(expired.code).toBe(0)
      expect(expired.out).toContain('REACHED_THE_END')
      expect(expired.out).not.toContain('TRAP_FIRED')
      expect(warned(expired.out)).toBe(false)
    }
  })

  it('sits in the WSL branch next to the vmIdleTimeout check, and the copy has no accents and no dash', () => {
    const b = block(LINUX)
    expect(b).toContain('if [ "$IS_WSL" = "true" ]; then')
    expect(LINUX.indexOf(BEGIN)).toBeGreaterThan(LINUX.indexOf('vmIdleTimeout=-1'))
    const copy = b.split('\n').filter((l) => l.includes('echo -e'))
    expect(copy).toHaveLength(2)
    for (const l of copy) {
      expect(l).not.toMatch(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/)
      expect(l).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
