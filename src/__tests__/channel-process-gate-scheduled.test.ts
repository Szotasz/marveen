import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const INSTALLER = join(ROOT, 'scripts', 'install-channel-process-gate.sh')

// CHANPROCGATE923. scripts/hooks/channel-process-gate.py shipped on 2026-09-20
// with 16 tests, a notify path and a docstring describing "the scheduler that
// runs this gate" -- and no scheduler existed. Measured 2026-09-23: a caller
// grep across the tree found nothing outside its own test suite, so the one
// probe that catches a declared-but-dead channel plugin had never run on any
// install. These tests pin the wiring, because the gate's own suite stays green
// whether or not anything ever calls it.
describe('the channel process gate is actually scheduled', () => {
  it('install-macos.sh invokes the gate installer with --load', () => {
    const sh = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
    expect(sh).toContain('scripts/install-channel-process-gate.sh')
    expect(sh).toMatch(/install-channel-process-gate\.sh" --load/)
  })

  it('install-linux.sh writes the gate service AND enables its timer', () => {
    const sh = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
    expect(sh).toContain('GATE_UNIT="${SERVICE_ID}-channel-process-gate"')
    expect(sh).toContain('channel-process-gate.py --notify')
    // Writing a unit without enabling it is the exact failure this card is
    // about, so the enable list is asserted, not just the unit file.
    expect(sh).toMatch(/systemctl --user enable .*\$\{GATE_UNIT\}\.timer/)
  })

  it('the installer is executable and syntax-clean', () => {
    expect(existsSync(INSTALLER)).toBe(true)
    execFileSync('bash', ['-n', INSTALLER])
  })
})

describe('install-channel-process-gate.sh writes a unit that runs the gate', () => {
  function runInstaller(): { home: string; out: string } {
    const home = mkdtempSync(join(tmpdir(), 'changate-'))
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    const out = execFileSync('bash', [INSTALLER], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    })
    return { home, out }
  }

  it('installs without starting, and names the gate plus --notify', () => {
    const { home, out } = runInstaller()
    try {
      expect(out).toContain('NOT started')
      const darwin = process.platform === 'darwin'
      const unit = darwin
        ? join(home, 'Library', 'LaunchAgents', 'com.marveen.channel-process-gate.plist')
        : join(home, '.config', 'systemd', 'user', 'marveen-channel-process-gate.service')
      // The label/unit name carries SERVICE_ID; this tree's .env may brand it,
      // so fall back to whatever single unit the installer wrote.
      const written = existsSync(unit)
      expect(written || out.includes('channel-process-gate')).toBe(true)
      const path = out.match(/(\/\S*channel-process-gate[^\s,]*)/)?.[1]
      expect(path).toBeTruthy()
      const body = readFileSync(path!, 'utf-8')
      expect(body).toContain('channel-process-gate.py')
      expect(body).toContain('--notify')
      // A monitor with no period is a monitor that runs once and stops mattering.
      expect(body).toMatch(darwin ? /<integer>300<\/integer>/ : /OnUnitActiveSec=5min/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('fails loudly when the gate script is missing instead of writing a unit that runs nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changate-empty-'))
    try {
      mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'install-channel-process-gate.sh'),
        readFileSync(INSTALLER, 'utf-8'))
      let code = 0
      let stderr = ''
      try {
        execFileSync('bash', [join(dir, 'scripts', 'install-channel-process-gate.sh')], {
          encoding: 'utf-8',
          env: { ...process.env, HOME: dir },
        })
      } catch (e) {
        const err = e as { status?: number; stderr?: string }
        code = err.status ?? -1
        stderr = String(err.stderr ?? '')
      }
      expect(code).toBe(1)
      expect(stderr).toContain('not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
