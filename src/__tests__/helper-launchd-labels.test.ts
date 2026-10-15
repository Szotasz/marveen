// #1873 (external report): the macOS helper installers wrote a FIXED com.marveen.<name>
// launchd label while the main units are com.${SERVICE_ID}.*, so two installs under one
// user shared one helper job, and the last installer to run took it over. The label now
// keys off the install's own SERVICE_ID (scripts/launchd-label.sh), update.sh asks the
// installer for it, and a renamed install retires ITS OWN legacy com.marveen.<name> job
// once -- never another install's.
//
// Every case runs real code: the installers' --print-label, the helper's migration with a
// stubbed launchctl, a full installer run with stubbed uname/launchctl, and update.sh's
// two functions against stub installers.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const HELPERS = {
  'install-channel-keepalive-probe': 'channel-keepalive-probe',
  'install-main-inbox-observer': 'main-inbox-observer',
  'install-stuck-modal-guard': 'stuck-modal-guard',
  'install-channel-coordinator': 'channel-coordinator',
} as const

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'helperlabel-'))
}
function bash(args: string[], env: Record<string, string>): { out: string; err: string; code: number | null } {
  const r = spawnSync('bash', args, {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? tmpdir(), ...env },
  })
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status }
}
/** A launchctl stub that records its calls into <dir>/launchctl.log. */
function stubBin(dir: string, darwin = false): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'launchctl'), `#!/bin/bash\necho "launchctl $*" >> "${dir}/launchctl.log"\nexit 0\n`)
  chmodSync(join(bin, 'launchctl'), 0o755)
  if (darwin) {
    writeFileSync(join(bin, 'uname'), '#!/bin/bash\necho Darwin\n')
    chmodSync(join(bin, 'uname'), 0o755)
  }
  return bin
}
const legacyPlist = (label: string, workdir: string) =>
  `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>Label</key>\n<string>${label}</string>\n<key>WorkingDirectory</key>\n<string>${workdir}</string>\n</dict></plist>\n`

describe('--print-label: com.<SERVICE_ID>.<name>, from the install .env (all four installers)', () => {
  const cases: Array<[string, string | null, (n: string) => string, boolean]> = [
    ['no .env value: the default, unchanged', null, (n) => `com.marveen.${n}`, false],
    ['SERVICE_ID', 'SERVICE_ID=foo\n', (n) => `com.foo.${n}`, false],
    ['MAIN_AGENT_ID when SERVICE_ID is absent', 'MAIN_AGENT_ID=bar\n', (n) => `com.bar.${n}`, false],
    ['SERVICE_ID wins over MAIN_AGENT_ID, last line wins, quotes stripped', 'MAIN_AGENT_ID=bar\nSERVICE_ID=x\nSERVICE_ID="foo"\n', (n) => `com.foo.${n}`, false],
    ['an id that is not a label part: the default, and a warning', 'SERVICE_ID=../evil\n', (n) => `com.marveen.${n}`, true],
  ]
  for (const [installer, name] of Object.entries(HELPERS)) {
    for (const [label, env, want, warns] of cases) {
      it(`${installer}: ${label}`, () => {
        const d = tmp()
        try {
          const envFile = join(d, '.env')
          if (env !== null) writeFileSync(envFile, env)
          const r = bash([join(ROOT, 'scripts', `${installer}.sh`), '--print-label'], {
            HOME: d,
            MARVEEN_ENV_FILE: env === null ? join(d, 'absent.env') : envFile,
          })
          expect(r.code).toBe(0)
          expect(r.out.trim()).toBe(want(name))
          expect(r.err.includes('WARN')).toBe(warns)
          expect(existsSync(join(d, 'Library'))).toBe(false) // --print-label writes nothing
        } finally {
          rmSync(d, { recursive: true, force: true })
        }
      })
    }
  }
})

describe("retire_legacy_helper_label: only THIS install's legacy job", () => {
  const run = (project: string, newLabel: string, legacyWorkdir: string | null) => {
    const d = tmp()
    const agents = join(d, 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    const legacy = join(agents, 'com.marveen.stuck-modal-guard.plist')
    if (legacyWorkdir !== null) writeFileSync(legacy, legacyPlist('com.marveen.stuck-modal-guard', legacyWorkdir))
    const r = bash(
      ['-c', `set -euo pipefail; . "${join(ROOT, 'scripts', 'launchd-label.sh')}"; retire_legacy_helper_label "${project}" stuck-modal-guard "${newLabel}" "${agents}"`],
      { HOME: d, PATH: `${stubBin(d)}:${process.env.PATH}` },
    )
    const calls = existsSync(join(d, 'launchctl.log')) ? readFileSync(join(d, 'launchctl.log'), 'utf-8') : ''
    const kept = existsSync(legacy)
    rmSync(d, { recursive: true, force: true })
    return { r, calls, kept }
  }

  it('a renamed install retires its own legacy job: unloaded and removed, and it says so', () => {
    const { r, calls, kept } = run('/inst/A', 'com.foo.stuck-modal-guard', '/inst/A')
    expect(r.code).toBe(0)
    expect(kept).toBe(false)
    expect(calls).toContain('com.marveen.stuck-modal-guard')
    expect(r.out).toContain('com.marveen.stuck-modal-guard')
  })
  it("another install's com.marveen job is left alone (no unload, file kept)", () => {
    const { r, calls, kept } = run('/inst/A', 'com.foo.stuck-modal-guard', '/inst/B')
    expect(r.code).toBe(0)
    expect(kept).toBe(true)
    expect(calls).toBe('')
  })
  it('a path that only starts with ours is not ours', () => {
    const { kept, calls } = run('/inst/A', 'com.foo.stuck-modal-guard', '/inst/AB')
    expect(kept).toBe(true)
    expect(calls).toBe('')
  })
  it('a default install (the new label IS the legacy one) touches nothing', () => {
    const { kept, calls } = run('/inst/A', 'com.marveen.stuck-modal-guard', '/inst/A')
    expect(kept).toBe(true)
    expect(calls).toBe('')
  })
  it('no legacy plist: nothing to do, exit 0', () => {
    const { r, calls } = run('/inst/A', 'com.foo.stuck-modal-guard', null)
    expect(r.code).toBe(0)
    expect(calls).toBe('')
  })
})

describe('a full installer run (keepalive probe, stubbed uname and launchctl)', () => {
  const install = (legacyWorkdir: string) => {
    const d = tmp()
    const agents = join(d, 'home', 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, 'com.marveen.channel-keepalive-probe.plist'), legacyPlist('com.marveen.channel-keepalive-probe', legacyWorkdir))
    writeFileSync(join(d, '.env'), 'SERVICE_ID=foo\n')
    const r = bash([join(ROOT, 'scripts', 'install-channel-keepalive-probe.sh')], {
      HOME: join(d, 'home'),
      PATH: `${stubBin(d, true)}:${process.env.PATH}`,
      MARVEEN_ENV_FILE: join(d, '.env'),
    })
    const neu = join(agents, 'com.foo.channel-keepalive-probe.plist')
    const res = {
      r,
      newExists: existsSync(neu),
      newPlist: existsSync(neu) ? readFileSync(neu, 'utf-8') : '',
      legacyKept: existsSync(join(agents, 'com.marveen.channel-keepalive-probe.plist')),
    }
    rmSync(d, { recursive: true, force: true })
    return res
  }

  it('writes com.foo.<name> pointing at this tree, and retires the legacy job that pointed here', () => {
    const res = install(ROOT)
    expect(res.r.code).toBe(0)
    expect(res.newExists).toBe(true)
    expect(res.newPlist).toContain('<string>com.foo.channel-keepalive-probe</string>')
    expect(res.newPlist).toContain(`<string>${ROOT}</string>`)
    expect(res.legacyKept).toBe(false)
  })
  it("leaves a legacy job that belongs to another install", () => {
    const res = install('/some/other/install')
    expect(res.r.code).toBe(0)
    expect(res.newExists).toBe(true)
    expect(res.legacyKept).toBe(true)
  })
})

describe("update.sh asks the installer for the label (real functions, stub installers)", () => {
  const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
  const fn = (name: string) => {
    const start = UPDATE.indexOf(`${name}() {`)
    expect(start).toBeGreaterThan(-1)
    return UPDATE.slice(start, UPDATE.indexOf('\n}\n', start) + 3)
  }

  it('keepalive: an existing com.foo plist is the "already installed" signal, a com.marveen one is not', () => {
    const d = tmp()
    try {
      const inst = join(d, 'install')
      mkdirSync(join(inst, 'scripts'), { recursive: true })
      const agents = join(d, 'home', 'Library', 'LaunchAgents')
      mkdirSync(agents, { recursive: true })
      const installer = join(inst, 'scripts', 'install-channel-keepalive-probe.sh')
      writeFileSync(installer, `#!/bin/bash\nif [ "$1" = "--print-label" ]; then echo com.foo.channel-keepalive-probe; exit 0; fi\necho "INSTALLED $*" >> "${d}/inst.log"\n`)
      chmodSync(installer, 0o755)
      const script = `INSTALL_DIR="${inst}"\n${fn('install_keepalive_probe_launchd')}\ninstall_keepalive_probe_launchd`
      const env = { HOME: join(d, 'home'), PATH: `${stubBin(d, true)}:${process.env.PATH}` }
      // only the legacy shared plist exists: this install has no job of its own -> install
      writeFileSync(join(agents, 'com.marveen.channel-keepalive-probe.plist'), 'x')
      let r = bash(['-c', script], env)
      expect(r.code).toBe(0)
      expect(existsSync(join(d, 'inst.log'))).toBe(true)
      expect(r.out).toContain('com.foo.channel-keepalive-probe')
      // its own plist exists -> idempotent, nothing runs
      rmSync(join(d, 'inst.log'))
      writeFileSync(join(agents, 'com.foo.channel-keepalive-probe.plist'), 'x')
      r = bash(['-c', script], env)
      expect(existsSync(join(d, 'inst.log'))).toBe(false)
      expect(r.out).toBe('')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('stuck-modal guard: launchctl is asked about com.foo.<name>, not com.marveen.<name>', () => {
    const d = tmp()
    try {
      const inst = join(d, 'install')
      mkdirSync(join(inst, 'scripts'), { recursive: true })
      const installer = join(inst, 'scripts', 'install-stuck-modal-guard.sh')
      writeFileSync(installer, `#!/bin/bash\nif [ "$1" = "--print-label" ]; then echo com.foo.stuck-modal-guard; exit 0; fi\nexit 0\n`)
      chmodSync(installer, 0o755)
      const bin = stubBin(d, true)
      // launchctl list fails -> not loaded -> install path
      writeFileSync(join(bin, 'launchctl'), `#!/bin/bash\necho "launchctl $*" >> "${d}/launchctl.log"\nexit 1\n`)
      const r = bash(['-c', `INSTALL_DIR="${inst}"\n${fn('install_stuck_modal_guard_launchd')}\ninstall_stuck_modal_guard_launchd`], {
        HOME: d,
        PATH: `${bin}:${process.env.PATH}`,
      })
      expect(r.code).toBe(0)
      expect(readFileSync(join(d, 'launchctl.log'), 'utf-8')).toContain('list com.foo.stuck-modal-guard')
      expect(r.out).toContain('com.foo.stuck-modal-guard')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('the binding', () => {
  it('no helper installer carries a fixed com.marveen label any more', () => {
    for (const installer of Object.keys(HELPERS)) {
      const src = readFileSync(join(ROOT, 'scripts', `${installer}.sh`), 'utf-8')
      expect(src, installer).not.toMatch(/^LABEL="com\.marveen\./m)
      expect(src, installer).toContain('. "$SCRIPT_DIR/launchd-label.sh"')
      // the legacy retirement runs before the new plist is written
      const retire = src.indexOf('retire_legacy_helper_label "$PROJECT_DIR"')
      expect(retire, installer).toBeGreaterThan(-1)
      expect(retire, installer).toBeLessThan(src.indexOf('cat > "$PLIST" <<PLIST_EOF'))
    }
  })
  it('update.sh reads both labels through --print-label, not a fixed-string grep', () => {
    const update = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
    expect(update).toContain('_ka_label="$("$_ka_installer" --print-label 2>/dev/null | head -1)"')
    expect(update).toContain('_sm_label="$("$_sm_installer" --print-label 2>/dev/null | head -1)"')
    expect(update).not.toMatch(/sed -n 's\/\^LABEL=/)
  })
  it("the keepalive alert names this install's job", () => {
    const mon = readFileSync(join(ROOT, 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(mon).toContain('com.${SERVICE_ID}.channel-keepalive-probe launchd jobot')
    expect(mon).not.toContain('com.marveen.channel-keepalive-probe')
  })
})
