import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Run a real script FILE (not `bash -c`) and return its output + exit code.
 *  The distinction matters: $LINENO inside an ERR trap numbers a file the way
 *  the installer is numbered, while `bash -c` numbers the -c string. */
function runScriptFile(lines: string[]): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'errtrap-'))
  try {
    const p = join(dir, 'probe.sh')
    writeFileSync(p, lines.join('\n') + '\n')
    try {
      return { out: execFileSync('bash', [p], { encoding: 'utf-8' }).trim(), code: 0 }
    } catch (e) {
      const err = e as { stdout?: string; status?: number }
      return { out: String(err.stdout ?? '').trim(), code: err.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Three installer defects that share one shape: the installer REPORTS a step it
// never verified, so a broken install reads as a healthy one and the outage only
// surfaces once the bot has already been answering nobody for hours.
//
//   1. the fail-closed auth gate aborts instead of failing closed -- the probe
//      runs under `set -e`, so a 401 kills the script at the enclosing `fi`
//      before the BROKEN branch (and its `scripts/auth.sh` hint) can run;
//   2. `claude --prompt` -- the flag does not exist, so the "shall I open Claude
//      Code to diagnose this?" offer dies with `unknown option '--prompt'` at
//      the exact moment the operator asked for help. install-linux.sh already
//      fixed this; install-macos.sh was missed;
//   3. `launchctl load` only PENDS a RunAtLoad spawn on modern macOS. Measured
//      on 26.5.1 with a throwaway agent (RunAtLoad=true, KeepAlive=true):
//
//          launchctl load <plist>            -> rc=0, runs = 0, never starts
//          launchctl bootstrap gui/$UID ...  -> rc=0, runs = 0, never starts
//          launchctl print ...               -> "pended nondemand spawn = speculative"
//          launchctl kickstart -p gui/$UID/L -> starts immediately, runs = 1
//
//      still `state = not running` after 30s. The installer swallowed that
//      (`2>/dev/null || true`) and printed "Szolgaltatasok elinditva" over two
//      units that had never run.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const HELPER = readFileSync(join(ROOT, 'scripts', 'launchd-unit.sh'), 'utf-8')
const START = readFileSync(join(ROOT, 'scripts', 'start.sh'), 'utf-8')

/** Pull one shell function out of a script so it can be executed for real. */
function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

/** Join backslash-continued lines so a probe spanning several source lines is
 *  examined as the single logical command bash actually executes. */
function logicalLines(src: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const line of src.split('\n')) {
    acc += acc === '' ? line : ' ' + line.trim()
    if (/\\$/.test(acc.trimEnd())) acc = acc.trimEnd().replace(/\\$/, '')
    else {
      out.push(acc)
      acc = ''
    }
  }
  if (acc !== '') out.push(acc)
  return out
}

/** The only guard that keeps a failing capture away from the ERR trap while
 *  still preserving its exit status. `set +e` does NOT (see the premise tests). */
const STATUS_GUARD = /&&\s*\w+=0\s*\|\|\s*\w+=\$\?/

describe.each([
  ['install-linux.sh', LINUX],
  ['install-macos.sh', MACOS],
])('%s -- a failing probe must not abort the installer', (_name, SRC) => {
  // The whole point of the three-state auth gate is to REPORT a broken
  // credential. An unguarded capture lets the ERR trap fire on the 401 and
  // exit(1) before INSTALL_AUTH_STATE is ever consulted, so the operator gets
  // "Varatlan hiba ... (sor: <the closing fi>)" instead of the diagnosis.
  it('guards every `claude --print "ping"` capture so its failure stays DATA', () => {
    const offenders = logicalLines(SRC)
      .filter((l) => l.includes('claude --print "ping"'))
      .filter((l) => !STATUS_GUARD.test(l))
    expect(offenders).toEqual([])
  })

  it('still declares the BROKEN verdict the probe is supposed to produce', () => {
    expect(SRC).toContain('INSTALL_AUTH_STATE="BROKEN"')
  })
})

describe('the ERR-trap abort is real (guards the premise of the tests above)', () => {
  const TRAP = [
    'set -e',
    'on_error() { echo "TRAP:$1"; exit 9; }',
    "trap 'on_error $LINENO' ERR",
  ]

  // Same shape as the installer's auth gate: an assignment whose command
  // substitution fails, inside the `then` branch of an `if`. bash blames the
  // enclosing `fi`, which is why the installer reported line 658 for a command
  // that lives on line 644.
  it('an unguarded capture aborts, and bash blames the enclosing `fi`', () => {
    const r = runScriptFile([...TRAP, 'if [ -n "x" ]; then', '  out="$(false)"', 'fi', 'echo REACHED'])
    expect(r.out).toBe('TRAP:6')
    expect(r.out).not.toContain('REACHED')
    expect(r.code).toBe(9)
  })

  // The tempting fix that does NOTHING here. A `trap ... ERR` fires regardless
  // of the errexit setting, and this installer's handler exits 1 -- so every
  // `set +e` window in it is a false safeguard against an aborting trap.
  it('a `set +e` window does NOT stop an ERR trap that exits', () => {
    const r = runScriptFile([...TRAP, 'set +e', 'out="$(false)"', 'set -e', 'echo REACHED'])
    expect(r.out).toMatch(/^TRAP:/)
    expect(r.out).not.toContain('REACHED')
  })

  // The form actually shipped: the capture becomes part of an && / || list, and
  // only the FINAL command of such a list is subject to errexit and the ERR trap.
  it('the `&& rc=0 || rc=$?` guard survives AND keeps the real exit status', () => {
    const r = runScriptFile([
      ...TRAP,
      `out="$(sh -c 'echo boom >&2; exit 7' 2>&1)" && rc=0 || rc=$?`,
      'echo "REACHED:$rc:$out"',
    ])
    expect(r.out).toBe('REACHED:7:boom')
    expect(r.code).toBe(0)
  })

  it('the same guard reports success unchanged', () => {
    const r = runScriptFile([...TRAP, 'out="$(echo ok)" && rc=0 || rc=$?', 'echo "REACHED:$rc:$out"'])
    expect(r.out).toBe('REACHED:0:ok')
  })
})

describe.each([
  ['install-linux.sh', LINUX],
  ['install-macos.sh', MACOS],
])('%s -- the diagnose-with-Claude offer must be runnable', (_name, SRC) => {
  it('never invokes the non-existent `--prompt` flag', () => {
    const offenders = SRC.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /claude\s+(\\)?["']?--prompt/.test(line))
      .map(({ n }) => n)
    expect(offenders).toEqual([])
  })

  it('passes the prompt positionally, the way the CLI accepts it', () => {
    const fn = sliceShellFn(SRC, 'offer_claude_fallback')
    expect(fn).toMatch(/claude "\$prompt"/)
  })
})

describe('install-macos.sh -- launchd units must be verified, not assumed', () => {
  const FN = 'start_launchd_unit'

  /**
   * Run start_launchd_unit() against a stub `launchctl` and return both what the
   * function printed (the pid, or nothing) and which subcommands it invoked.
   *
   * The three modes are the three behaviours measured on macOS 26.5.1:
   *   healthy   -- load/bootstrap pend; only kickstart starts it; pid persists
   *   pended    -- `pended nondemand spawn = speculative`, no pid, ever
   *   crashloop -- a transient `xpcproxy` pid, then `spawn scheduled`, no pid,
   *                `last exit code = 78: EX_CONFIG` (program missing)
   */
  function runStart(mode: 'healthy' | 'pended' | 'crashloop'): { pid: string; calls: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'launchd-'))
    try {
      const calls = join(dir, 'calls')
      const prints = join(dir, 'prints')
      const stub = join(dir, 'launchctl')
      writeFileSync(
        stub,
        [
          '#!/bin/bash',
          `echo "$1" >> "${calls}"`,
          // load/bootstrap "succeed" while starting nothing -- the real trap
          'case "$1" in',
          '  load|bootstrap) exit 0 ;;',
          '  kickstart) exit 0 ;;',
          '  print)',
          `    echo x >> "${prints}"`,
          `    n=$(wc -l < "${prints}")`,
          `    mode="${mode}"`,
          `    up=0`,
          `    if grep -q kickstart "${calls}"; then`,
          '      case "$mode" in',
          '        healthy) up=1 ;;',
          // the transient pid appears on the FIRST print and is gone by the
          // confirming re-read after the settle
          '        crashloop) if [ "$n" -le 1 ]; then up=1; fi ;;',
          '      esac',
          '    fi',
          '    if [ "$up" = "1" ]; then',
          '      printf "\\tstate = running\\n\\tpid = 4242\\n"',
          '    else',
          '      printf "\\tstate = spawn scheduled\\n\\truns = 1\\n"',
          '    fi',
          '    exit 0 ;;',
          'esac',
          'exit 0',
        ].join('\n'),
      )
      chmodSync(stub, 0o755)
      const script = [
        'set -e',
        'on_error() { echo "ABORTED:$1"; exit 9; }',
        "trap 'on_error $LINENO' ERR",
        `export PATH="${dir}:$PATH"`,
        'PLIST_DIR=/tmp',
        'LAUNCHD_START_TRIES=2',
        sliceShellFn(HELPER, FN),
        `printf 'PID=%s' "$(${FN} com.example.unit)"`,
      ].join('\n')
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf-8' })
      const pid = /PID=(\d*)/.exec(out)?.[1] ?? ''
      const recorded = (() => {
        try {
          return readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean)
        } catch {
          return []
        }
      })()
      return { pid, calls: recorded }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('never trusts load/bootstrap alone -- it always kickstarts', () => {
    expect(runStart('healthy').calls).toContain('kickstart')
  })

  it('returns the pid once the unit is actually up', () => {
    expect(runStart('healthy').pid).toBe('4242')
  })

  it('returns NOTHING when the spawn stays pended, so the caller can fail loudly', () => {
    expect(runStart('pended').pid).toBe('')
  })

  it('returns NOTHING for a crash-looping unit whose first pid was transient', () => {
    // launchd hands out an xpcproxy pid before the exec fails, so a single read
    // would report a dead unit as started.
    expect(runStart('crashloop').pid).toBe('')
  })

  it('does not abort the installer when launchd refuses to start the unit', () => {
    // `set -e` is live here too: a bare `[ -n "$pid" ] && break` in the poll loop
    // would exit(1) the whole installer on the very last iteration.
    expect(() => runStart('pended')).not.toThrow()
  })

  it('install-macos.sh gates the success banner on the verified pids', () => {
    const sourced = MACOS.indexOf('scripts/launchd-unit.sh')
    expect(sourced).toBeGreaterThan(0)
    const tail = MACOS.slice(sourced)
    // the old code printed this unconditionally, one line after `launchctl load`
    const banner = /Szolgaltatasok elinditva/.exec(tail)
    expect(banner).not.toBeNull()
    const before = tail.slice(0, banner!.index)
    expect(before).toMatch(new RegExp(`${FN}\\s`))
    expect(before).toMatch(/if \[ -n "\$DASHBOARD_PID" \] && \[ -n "\$CHANNELS_PID" \]/)
    // and there must be a loud else-branch for the failure the operator hit
    expect(tail.slice(banner!.index)).toMatch(/launchctl kickstart/)
  })

  // scripts/start.sh carried the identical defect: measured live on 26.5.1 it
  // printed "Dashboard: http://localhost:3420" and "Csatorna inditva" while
  // `launchctl print` reported `state = not running` for BOTH units.
  it('scripts/start.sh uses the same verified starter, not a bare load', () => {
    expect(START).toContain('scripts/launchd-unit.sh')
    expect(START).toMatch(new RegExp(`${FN}\\s`))
    const bareLoad = START.split('\n').filter((l) => /^\s*launchctl load /.test(l))
    expect(bareLoad).toEqual([])
  })

  it('scripts/start.sh refuses to report success when a unit did not come up', () => {
    const banner = START.indexOf('✓ Dashboard: http://localhost')
    expect(banner).toBeGreaterThan(0)
    // the guard must come BEFORE the success line, and must not fall through
    const before = START.slice(0, banner)
    expect(before).toMatch(/if \[ -n "\$LAUNCHD_FAILED" \]/)
    expect(before).toMatch(/exit 1/)
  })
})

describe('every touched shell entry point stays parseable', () => {
  it.each(['install-linux.sh', 'install-macos.sh', 'scripts/start.sh', 'scripts/launchd-unit.sh'])(
    'bash -n %s',
    (f) => {
      expect(() => execFileSync('bash', ['-n', join(ROOT, f)], { stdio: 'pipe' })).not.toThrow()
    },
  )
})
