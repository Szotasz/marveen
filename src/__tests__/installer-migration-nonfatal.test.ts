import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MIGRATENONFATAL1122 (#3038): the optional migration prompt runs after every service is up, yet a
// mistyped source path made scripts/migrate.sh exit 1, the installer's ERR trap fired and the whole
// install was reported as failed (at step "launchagent", line 2292 on macOS bash 3.2). The fix is a
// `|| warn ...` on the migrate.sh call in both installers. Nothing else guards it: removing that
// `|| warn` kept the rest of the installer suite green. This test runs the REAL migration block out of
// each shipped installer under `set -e` + an ERR trap, with a stub migrate.sh, and pins:
//   - a failing migrate.sh: the block finishes rc=0, the trap stays quiet, the warning is printed and
//     names the FULL migrate.sh path (MIGRATEHINTPATH1122: the shell is not in the install folder);
//   - a succeeding migrate.sh still runs;
//   - "y" (the English prompt asks y/n) runs it like "i"; "n" does not.

const ROOT = join(__dirname, '..', '..')
const LANG_FILE = join(ROOT, 'install-lang.sh')
const INSTALLERS = ['install-macos.sh', 'install-linux.sh'] as const

/** The migration block: from its INSTALL_STEP line to the closing esac of the answer switch. */
function migrationBlock(installer: string): string {
  const src = readFileSync(join(ROOT, installer), 'utf-8')
  const start = src.indexOf('INSTALL_STEP="migration"')
  if (start < 0) throw new Error(`${installer}: migration block not found`)
  const end = src.indexOf('\nesac\n', start)
  if (end < 0) throw new Error(`${installer}: closing esac of the migration block not found`)
  return src.slice(start, end + '\nesac'.length)
}

function runBlock(installer: string, opts: { answer: string; migrateRc: number; lang?: 'hu' | 'en' }) {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-migrate-block-'))
  // A space in the install path: the hint must stay copy-pasteable.
  const installDir = join(dir, 'my install')
  mkdirSync(join(installDir, 'scripts'), { recursive: true })
  const stub = join(installDir, 'scripts', 'migrate.sh')
  writeFileSync(stub, `#!/bin/bash\necho MIGRATE_STUB_RAN\nexit ${opts.migrateRc}\n`)
  chmodSync(stub, 0o755)

  const script = [
    'set -e',
    'on_error() { echo "TRAP_FIRED line $1"; exit 1; }',
    "trap 'on_error $LINENO' ERR",
    `MARVEEN_LANG=${opts.lang ?? 'hu'}`,
    `INSTALL_DIR=${JSON.stringify(installDir)}`,
    'WEB_PORT=3420',
    `source ${JSON.stringify(LANG_FILE)}`,
    'warn() { echo "WARN: $*"; }',
    // install-linux.sh asks ni_answer first; interactive (its non-zero) falls through to the read.
    'ni_answer() { return 1; }',
    migrationBlock(installer),
    'echo REACHED_THE_END',
  ].join('\n')
  const file = join(dir, 'block.sh')
  writeFileSync(file, script)
  try {
    const out = execFileSync('/bin/bash', [file], { encoding: 'utf-8', input: `${opts.answer}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, out, installDir }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, installDir }
  }
}

describe.each(INSTALLERS)('%s: the optional migration step is non-fatal (MIGRATENONFATAL1122)', (installer) => {
  it('a failing migrate.sh warns and the install continues (rc=0, no ERR trap)', () => {
    const { code, out, installDir } = runBlock(installer, { answer: 'i', migrateRc: 1 })
    expect(out).toContain('MIGRATE_STUB_RAN')
    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain('REACHED_THE_END')
    expect(out).toMatch(/WARN: .*költöztetés nem futott végig/)
    // MIGRATEHINTPATH1122: the re-run hint names the full, quoted path.
    expect(out).toContain(`bash "${installDir}/scripts/migrate.sh"`)
    expect(code).toBe(0)
  })

  it('the English hint names the full path and the dashboard too', () => {
    const { code, out, installDir } = runBlock(installer, { answer: 'y', migrateRc: 1, lang: 'en' })
    expect(out).not.toContain('TRAP_FIRED')
    expect(out).toContain(`bash "${installDir}/scripts/migrate.sh"`)
    expect(out).toContain('http://localhost:3420 -> Migration')
    expect(code).toBe(0)
  })

  it('a successful migrate.sh still runs, with no warning', () => {
    const { code, out } = runBlock(installer, { answer: 'i', migrateRc: 0 })
    expect(out).toContain('MIGRATE_STUB_RAN')
    expect(out).not.toContain('WARN:')
    expect(out).toContain('REACHED_THE_END')
    expect(code).toBe(0)
  })

  it('"y" runs the migration like "i"; "n" skips it', () => {
    expect(runBlock(installer, { answer: 'y', migrateRc: 0 }).out).toContain('MIGRATE_STUB_RAN')
    const skipped = runBlock(installer, { answer: 'n', migrateRc: 1 })
    expect(skipped.out).not.toContain('MIGRATE_STUB_RAN')
    expect(skipped.out).toContain('REACHED_THE_END')
    expect(skipped.code).toBe(0)
  })
})
