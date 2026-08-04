import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The channel could die silently and stay dead, on Linux only.
//
// channels.sh has watchdog branches that exit ON PURPOSE ("plugin dead for Ns
// -- exiting for service-manager restart"), then fall through to `exit 0` for
// any run longer than 30s. The systemd unit carried Restart=on-failure, and
// systemd does not consider a zero exit a failure -- so the unit went
// inactive/dead and nothing brought the channel back. No failed unit, no
// crash-loop, no alert: the bot simply stops answering.
//
// Measured on a live install (vps47, v1.27.0, 2026-08-04 06:51:43):
//   ExecMainStatus=0, ActiveState=inactive, SubState=dead, NRestarts=0
//   channels.error.log: "telegram plugin dead for 180s -- exiting for
//   service-manager restart"
// and it was still dead ten minutes later, until started by hand.
//
// macOS was immune the whole time, which is why the fleet never saw it: the
// launchd plist uses KeepAlive=true, which restarts regardless of exit code.
//
// Three things have to hold, and they are three separate failure modes:
//   1. the shipped tail of channels.sh must report a watchdog exit as non-zero
//      (so even an un-migrated old unit restarts it),
//   2. the installer template must write Restart=always for the channels unit
//      (symmetry with launchd KeepAlive),
//   3. update.sh must migrate ALREADY INSTALLED units -- the template alone
//      reaches new installs only, and the machines that have this bug today are
//      exactly the already-installed ones.

const ROOT = join(__dirname, '..', '..')
const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

/** Slice a region [from marker .. end marker]. The end is searched FROM the
 *  start offset, never from 0 -- an earlier match would silently return a
 *  neighbouring block that happens to pass. */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`start marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`end marker not found after start: ${endMarker}`)
  return src.slice(start, end + endMarker.length)
}

/** Pull one shell function out of a script so it can be executed for real. */
function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

function runScript(body: string, env: Record<string, string> = {}): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'chanrestart-'))
  try {
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    try {
      const out = execFileSync('bash', [p], { encoding: 'utf-8', env: { ...process.env, ...env } })
      return { out: out.trim(), code: 0 }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim(), code: err.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('channels.sh watchdog exit status', () => {
  // The tail of the REAL script is executed here, not a re-typed copy of it.
  const tail = CHANNELS.slice(CHANNELS.indexOf('ELAPSED=$(( $(date +%s) - START_TS ))'))

  it('exits non-zero when a watchdog branch asked for the restart', () => {
    const store = mkdtempSync(join(tmpdir(), 'chanstore-'))
    try {
      const r = runScript(
        `INSTALL_DIR="${store}"\nmkdir -p "$INSTALL_DIR/store"\nSTART_TS=$(( $(date +%s) - 600 ))\nRESTART_REQUESTED=1\n` + tail,
      )
      expect(r.code).toBe(1)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('still exits zero on a genuinely normal end (no watchdog request)', () => {
    const store = mkdtempSync(join(tmpdir(), 'chanstore-'))
    try {
      const r = runScript(
        `INSTALL_DIR="${store}"\nmkdir -p "$INSTALL_DIR/store"\nSTART_TS=$(( $(date +%s) - 600 ))\nRESTART_REQUESTED=0\n` + tail,
      )
      expect(r.code).toBe(0)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('sets the flag in BOTH watchdog branches, not just the one that was observed', () => {
    const sustained = sliceBetween(CHANNELS, 'plugin dead for $((NOW - PLUGIN_DEAD_SINCE))s', 'break')
    const neverStarted = sliceBetween(CHANNELS, 'plugin never started within', 'break')
    expect(sustained).toContain('RESTART_REQUESTED=1')
    expect(neverStarted).toContain('RESTART_REQUESTED=1')
  })
})

describe('installer unit template', () => {
  const chanUnit = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${CHAN_UNIT}.service" <<EOF', '\nEOF')

  it('writes Restart=always for the channels unit', () => {
    expect(chanUnit).toMatch(/^Restart=always$/m)
    expect(chanUnit).not.toMatch(/^Restart=on-failure$/m)
  })

  it('keeps the crash-loop throttle that bounds the new restart policy', () => {
    expect(chanUnit).toMatch(/StartLimitIntervalSec=\d+/)
    expect(chanUnit).toMatch(/StartLimitBurst=\d+/)
  })

  it('leaves the dashboard unit policy alone (scope pin)', () => {
    const dashUnit = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${DASH_UNIT}.service" <<EOF', '\nEOF')
    expect(dashUnit).toMatch(/^Restart=on-failure$/m)
  })

  it('the macOS side already restarts regardless of exit code -- this is the symmetry being restored', () => {
    expect(MACOS).toContain('<key>KeepAlive</key>')
  })
})

describe('update.sh migration for already-installed machines', () => {
  const fn = sliceShellFn(UPDATE, 'migrate_channels_restart')

  function runMigration(unitsDir: string): { out: string; code: number } {
    return runScript(`${fn}\nmigrate_channels_restart "${unitsDir}"`)
  }

  const OLD_UNIT = [
    '[Unit]',
    'Description=Marveen Channels (Telegram bridge)',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/root/marveen/scripts/channels.sh',
    'Restart=on-failure',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')

  it('rewrites an existing on-failure channels unit and leaves no backup file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      const unit = join(dir, 'marveen-channels.service')
      writeFileSync(unit, OLD_UNIT)
      const r = runMigration(dir)
      expect(r.code).toBe(0)
      const after = readFileSync(unit, 'utf-8')
      expect(after).toMatch(/^Restart=always$/m)
      expect(after).not.toMatch(/^Restart=on-failure$/m)
      // everything else must survive verbatim
      expect(after).toContain('ExecStart=/root/marveen/scripts/channels.sh')
      expect(after).toContain('StartLimitBurst=5')
      expect(readdirSync(dir).filter((f) => f.includes('marveen-bak'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: a second run changes nothing and reports nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      const unit = join(dir, 'marveen-channels.service')
      writeFileSync(unit, OLD_UNIT)
      runMigration(dir)
      const firstPass = readFileSync(unit, 'utf-8')
      const second = runMigration(dir)
      expect(second.code).toBe(0)
      expect(second.out).not.toContain('Csatorna-unit javitva')
      expect(readFileSync(unit, 'utf-8')).toBe(firstPass)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates a renamed install too (unit name derives from the bot name)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      const unit = join(dir, 'hermes-channels.service')
      writeFileSync(unit, OLD_UNIT)
      runMigration(dir)
      expect(readFileSync(unit, 'utf-8')).toMatch(/^Restart=always$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not touch the dashboard unit in the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      const dash = join(dir, 'marveen-dashboard.service')
      writeFileSync(dash, OLD_UNIT.replace('channels.sh', 'start-dashboard.sh'))
      runMigration(dir)
      expect(readFileSync(dash, 'utf-8')).toMatch(/^Restart=on-failure$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a directory with no units at all (fresh macOS host)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      expect(runMigration(dir).code).toBe(0)
      expect(runMigration(join(dir, 'does-not-exist')).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is actually called by update.sh, not merely defined', () => {
    const afterDefinition = UPDATE.slice(UPDATE.indexOf('migrate_channels_restart() {') + 1)
    expect(afterDefinition).toMatch(/^migrate_channels_restart$/m)
  })
})
