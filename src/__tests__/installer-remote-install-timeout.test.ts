import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BUNTIMEOUT1108. On 2026-11-08 the owner's install on a freshly wiped VPS stalled in the "Claude + Bun" step: the
// Bun download (`curl -fsSL https://bun.sh/install | bash 2>/dev/null`) left ~/.bun/bin empty and the installer never
// got past it, with nothing on screen saying why. install-linux.sh now runs the vendor installers (Bun, Claude Code)
// through _run_remote_installer: the script is fetched with time limits, run under `timeout`, retried, decided by a
// real presence check, and the vendor's last lines are printed on the final failure. These tests run the REAL
// function, sliced out of the shipped script, against a fake `curl` that serves fixture "vendor scripts".

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const HAVE_TIMEOUT = (() => { try { execFileSync('sh', ['-c', 'command -v timeout'], { stdio: 'ignore' }); return true } catch { return false } })()
const BASH_BIN = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim()

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let i = src.indexOf('{', start) + 1
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i)
}

/** A PATH dir with a fake `curl`: it writes $FAKE_VENDOR_SCRIPT to the -o target (or fails with exit 22) and logs
 *  its arguments, one call per line. */
function fakeCurlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rinst-bin-'))
  writeFileSync(join(dir, 'curl'), [
    '#!/bin/bash',
    'echo "$*" >> "$FAKE_CURL_LOG"',
    'out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'if [ -n "${FAKE_CURL_FAIL:-}" ]; then echo "curl: (6) Could not resolve host" >&2; exit 6; fi',
    'cp "$FAKE_VENDOR_SCRIPT" "$out"',
  ].join('\n') + '\n')
  chmodSync(join(dir, 'curl'), 0o755)
  return dir
}

type Run = { status: number; out: string; ms: number; work: string }

/** Run the REAL _run_remote_installer under the installer's own `set -e` and ERR trap. The check is "the tool file
 *  exists in $WORK"; the fixture vendor script is a bash body that can use $WORK and its args. */
function run(vendorBody: string, env: Record<string, string> = {}, args: string[] = []): Run {
  const work = mkdtempSync(join(tmpdir(), 'rinst-work-'))
  const vendor = join(work, 'vendor.sh')
  writeFileSync(vendor, `#!/bin/bash\n${vendorBody}\n`)
  const script = [
    'set -e',
    "trap 'echo ERRTRAP; exit 99' ERR",
    'DIM=""; NC=""',
    'warn() { echo "warn: $*"; }',
    '_tool_present() { [ -f "$WORK/tool" ]; }',
    sliceShellFn(LINUX, '_run_remote_installer'),
    `if _run_remote_installer "Tool" https://vendor.example/install.sh _tool_present ${args.map((a) => `'${a}'`).join(' ')}; then echo RESULT=0; else echo RESULT=1; fi`,
    'echo END',
  ].join('\n')
  const t0 = Date.now()
  const r = spawnSync(BASH_BIN, ['-c', script], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      PATH: `${env.MKTEMP_DIR ? `${env.MKTEMP_DIR}:` : ''}${fakeCurlDir()}:${process.env.PATH}`,
      WORK: work,
      FAKE_VENDOR_SCRIPT: vendor,
      FAKE_CURL_LOG: join(work, 'curl.log'),
      REMOTE_INSTALL_RETRY_DELAY: '0',
      ...env,
    },
    encoding: 'utf-8',
  })
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0, work }
}

describe.skipIf(!HAVE_TIMEOUT)('the vendor installers run with time limits, retries and a visible reason (BUNTIMEOUT1108)', () => {
  it('THE INCIDENT: a vendor install that hangs is cut by the time limit, retried, and then reported (no endless step)', () => {
    const r = run('mkdir -p "$WORK/.bun/bin"; echo "Downloading bun..."; sleep 60', { REMOTE_INSTALL_TIMEOUT: '1', REMOTE_INSTALL_TRIES: '2' })
    expect(r.out).toContain('RESULT=1')
    expect(r.out).toContain('END')
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out.match(/tullepte az idokorlatot \(1 mp\)/g)?.length).toBe(2)
    expect(r.out).toContain('Downloading bun...')
    expect(r.ms).toBeLessThan(20_000)
  }, 30_000)

  it('the time limit takes the vendor script\'s own children too (its download), not only the script', () => {
    const r = run(`(sleep 30; touch "$WORK/late") & wait`, { REMOTE_INSTALL_TIMEOUT: '1', REMOTE_INSTALL_TRIES: '1' })
    expect(r.out).toContain('RESULT=1')
    spawnSync('sleep', ['2'])
    expect(existsSync(join(r.work, 'late'))).toBe(false)
    expect(r.ms).toBeLessThan(15_000)
  }, 30_000)

  it('a failure that goes away is retried and passes', () => {
    const r = run('n=$(cat "$WORK/n" 2>/dev/null || echo 0); echo $((n+1)) > "$WORK/n"; [ "$n" -ge 1 ] || { echo "error: transient" >&2; exit 1; }; touch "$WORK/tool"',
      { REMOTE_INSTALL_TRIES: '3' })
    expect(r.out).toContain('RESULT=0')
    expect(readFileSync(join(r.work, 'n'), 'utf-8').trim()).toBe('2')
    expect(r.out.match(/probalkozas sikertelen \(kilepesi kod: 1\)/g)?.length).toBe(1)
    expect(r.out).not.toContain('utolso sorai')
  })

  it('the final failure prints the vendor\'s own error lines (they are no longer thrown away)', () => {
    const r = run('echo "error: unzip is required to install bun" >&2; exit 1', { REMOTE_INSTALL_TRIES: '2' })
    expect(r.out).toContain('RESULT=1')
    expect(r.out).toContain('Tool telepito utolso sorai:')
    expect(r.out).toContain('    error: unzip is required to install bun')
  })

  it('exit 0 without the tool is a failure: the presence check decides, not the vendor\'s exit code', () => {
    const r = run('echo "done"; exit 0', { REMOTE_INSTALL_TRIES: '2' })
    expect(r.out).toContain('RESULT=1')
    expect(r.out.match(/probalkozas sikertelen \(kilepesi kod: 0\)/g)?.length).toBe(2)
  })

  it('a script that cannot be downloaded is retried and named, with curl\'s own error', () => {
    const r = run('touch "$WORK/tool"', { FAKE_CURL_FAIL: '1', REMOTE_INSTALL_TRIES: '2' })
    expect(r.out).toContain('RESULT=1')
    expect(r.out).toContain('could not be downloaded from https://vendor.example/install.sh, curl exit 6')
    expect(r.out).toContain('Could not resolve host')
    const calls = readFileSync(join(r.work, 'curl.log'), 'utf-8').trim().split('\n')
    expect(calls.length).toBe(2)
    // every fetch has a connect and a total time limit
    for (const c of calls) expect(c).toMatch(/--connect-timeout 20 --max-time 60 -o \S+ https:\/\/vendor\.example\/install\.sh$/)
  })

  it('the script args reach the vendor script (the pinned Claude version)', () => {
    const r = run('echo "$1" > "$WORK/pin"; touch "$WORK/tool"', {}, ['2.1.112'])
    expect(r.out).toContain('RESULT=0')
    expect(readFileSync(join(r.work, 'pin'), 'utf-8').trim()).toBe('2.1.112')
  })
})

describe('install-linux.sh wires the vendor installers through the helper (BUNTIMEOUT1108)', () => {
  it('no vendor "curl | bash" is left in the Claude and Bun steps', () => {
    const step = LINUX.slice(LINUX.indexOf('INSTALL_STEP="claude-bun-install"'), LINUX.indexOf('INSTALL_STEP="claude-auth"'))
    expect(step.length).toBeGreaterThan(1000)
    // code lines only (the helper's comment names the old pattern)
    const code = step.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).not.toMatch(/curl[^\n]*\|\s*bash/)
    expect(step).toMatch(/curl[^\n]*\|\s*bash/) // positive control: the instrument sees the pattern where it is
    expect(step.match(/_run_remote_installer "(Claude Code|Bun)/g)?.length).toBe(3)
    expect(step.match(/_install_bun_from_npm/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('Bun: the step calls _install_bun (GitHub, then npm, then a stop); Claude: a missing claude stops the install', () => {
    const step = LINUX.slice(LINUX.indexOf('INSTALL_STEP="claude-bun-install"'), LINUX.indexOf('INSTALL_STEP="claude-auth"'))
    // GROMZONOPROVIDER1108: Bun left the Claude step; it is installed in its own step after the channel choice, and only
    // for a Bun channel (telegram, discord; teams since EE2392D3).
    expect(step).not.toMatch(/^\s+_install_bun$/m)
    const bunStep = LINUX.slice(LINUX.indexOf('INSTALL_STEP="bun-install"'), LINUX.indexOf('INSTALL_STEP="npm-install"'))
    expect(bunStep.length).toBeGreaterThan(200)
    expect(bunStep).toMatch(/case "\$CHANNEL_PROVIDER" in\n(?:\s*#[^\n]*\n)*  telegram\|discord\|teams\)\n[\s\S]*?\n\s+_install_bun\n[\s\S]*?\n  \*\)\n\s+ok "Bun nem kell/)
    expect(LINUX.indexOf('INSTALL_STEP="bun-install"')).toBeGreaterThan(LINUX.indexOf('CHANNEL_PROVIDER="gromzo"'))
    expect(sliceShellFn(LINUX, '_install_bun')).toMatch(/\n\s+fail "A Bun telepitese nem sikerult: a GitHub-letoltes/)
    expect(LINUX).toMatch(/if ! _claude_present; then\n\s+fail "A Claude Code telepitese nem sikerult/)
    // the stop sits before the AVX message for a claude that is there but does not launch
    expect(LINUX.indexOf('fail "A Claude Code telepitese nem sikerult')).toBeLessThan(LINUX.indexOf('claude telepitve, de nem indul'))
  })
})

describe('the Bun pin follows the Docker image (BUNTIMEOUT1108)', () => {
  it('install-linux.sh BUN_PIN == Dockerfile BUN_VERSION', () => {
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8').match(/^ARG BUN_VERSION=(\S+)$/m)?.[1]
    const pin = LINUX.match(/^BUN_PIN="([^"]+)"$/m)?.[1]
    expect(docker).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pin).toBe(docker)
  })
})

/** The whole Bun path: the REAL _run_remote_installer, _bun_present, _install_bun_from_npm and _install_bun, with a
 *  fake curl serving a bun.sh script that fails like the measured GitHub download, and a fake npm. */
function runBun(env: Record<string, string>): Run {
  const work = mkdtempSync(join(tmpdir(), 'rinst-bun-'))
  const vendor = join(work, 'bun-install.sh')
  writeFileSync(vendor, '#!/bin/bash\nmkdir -p "$BUN_INSTALL/bin"\necho \'error: Failed to download bun from "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"\' >&2\nexit 1\n')
  const bin = fakeCurlDir()
  const npmPrefix = join(work, 'npm-prefix')
  writeFileSync(join(bin, 'npm'), [
    '#!/bin/bash',
    `if [ "$1" = prefix ]; then [ -n "\${FAKE_EMPTY_PREFIX:-}" ] || echo "${npmPrefix}"; exit 0; fi`,
    'echo "$*" >> "$FAKE_NPM_LOG"',
    'if [ -n "${FAKE_NPM_FAIL:-}" ]; then echo "npm error code E503" >&2; exit 1; fi',
    `mkdir -p "${npmPrefix}/lib/bun/bin" "${npmPrefix}/bin"`,
    `printf '#!/bin/bash\\necho 1.4.4\\n' > "${npmPrefix}/lib/bun/bin/bun.exe"; chmod +x "${npmPrefix}/lib/bun/bin/bun.exe"`,
    `ln -sf "${npmPrefix}/lib/bun/bin/bun.exe" "${npmPrefix}/bin/bun"`,
  ].join('\n') + '\n')
  chmodSync(join(bin, 'npm'), 0o755)
  const pinLine = LINUX.match(/^BUN_PIN="[^"]+"$/m)![0]
  const script = [
    'set -e',
    "trap 'echo ERRTRAP; exit 99' ERR",
    'DIM=""; NC=""',
    'ok() { echo "ok: $*"; }',
    'warn() { echo "warn: $*"; }',
    'fail() { echo "FAIL: $*"; exit 7; }',
    'ensure_global_npm_writable() { return 0; }',
    'export BUN_INSTALL="$WORK/.bun"',
    'export PATH="$BUN_INSTALL/bin:$PATH"',
    pinLine,
    ...['_run_remote_installer', '_bun_present', '_install_bun_from_npm', '_install_bun'].map((f) => sliceShellFn(LINUX, f)),
    '_install_bun',
    'echo END',
  ].join('\n')
  const t0 = Date.now()
  const r = spawnSync(BASH_BIN, ['-c', script], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      PATH: `${bin}:${env.EXTRA_PATH ? `${env.EXTRA_PATH}:` : ''}${npmPrefix}/bin:${process.env.PATH}`,
      WORK: work,
      FAKE_VENDOR_SCRIPT: vendor,
      FAKE_CURL_LOG: join(work, 'curl.log'),
      FAKE_NPM_LOG: join(work, 'npm.log'),
      REMOTE_INSTALL_RETRY_DELAY: '0',
      REMOTE_INSTALL_TRIES: '2',
      ...env,
    },
    encoding: 'utf-8',
  })
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0, work }
}

describe.skipIf(!HAVE_TIMEOUT)('Bun: the GitHub download fails, the npm fallback installs the pinned version (BUNTIMEOUT1108)', () => {
  it('THE INCIDENT SHAPE: the GitHub download fails twice, npm installs bun@<pin>, and ~/.bun/bin/bun is there and runs', () => {
    const r = runBun({})
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out).toContain('END')
    expect(r.out.match(/Bun \(GitHub-letoltes\): a\(z\) \d\/2\. probalkozas sikertelen/g)?.length).toBe(2)
    // the reason is on screen: the vendor's own line names the GitHub download
    expect(r.out).toContain('error: Failed to download bun from "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip"')
    expect(r.out).toContain('tartalek: npm install -g bun@1.4.4 (registry.npmjs.org)')
    expect(readFileSync(join(r.work, 'npm.log'), 'utf-8').trim()).toBe('install -g bun@1.4.4')
    expect(r.out).toContain('ok: bun telepitve (npm tartalek): 1.4.4')
    const linked = spawnSync(join(r.work, '.bun', 'bin', 'bun'), ['--version'], { encoding: 'utf-8' })
    expect(linked.stdout.trim()).toBe('1.4.4')
    expect(existsSync(join(r.work, '.bun', 'bin', 'bunx'))).toBe(true)
  })

  it('both paths fail: the install stops with the reason (exit, no hang, no continue)', () => {
    const r = runBun({ FAKE_NPM_FAIL: '1' })
    expect(r.status).toBe(7)
    expect(r.out).not.toContain('END')
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out).toContain('Bun (npm tartalek): sikertelen (kilepesi kod: 1).')
    expect(r.out).toContain('    npm error code E503')
    expect(r.out).toContain('FAIL: A Bun telepitese nem sikerult: a GitHub-letoltes (bun.sh/install) es az npm-tartalek (bun@1.4.4) is bukott')
  })

  it('an older, working bun earlier on PATH is not the one linked: npm\'s own prefix names the new one (Dani 73434)', () => {
    const old = mkdtempSync(join(tmpdir(), 'rinst-oldbun-'))
    writeFileSync(join(old, 'bun'), '#!/bin/bash\necho 1.0.0\n')
    chmodSync(join(old, 'bun'), 0o755)
    const r = runBun({ EXTRA_PATH: old })
    expect(r.out).toContain('ok: bun telepitve (npm tartalek): 1.4.4')
    expect(spawnSync(join(r.work, '.bun', 'bin', 'bun'), ['--version'], { encoding: 'utf-8' }).stdout.trim()).toBe('1.4.4')
  })

  it('an empty npm prefix links nothing (no "/bin/bun", Dani 73504) and the install stops with the reason', () => {
    const r = runBun({ FAKE_EMPTY_PREFIX: '1' })
    expect(r.status).toBe(7)
    expect(r.out).toContain('Bun (npm tartalek): sikertelen (kilepesi kod: 0).')
    expect(existsSync(join(r.work, '.bun', 'bin', 'bun'))).toBe(false)
    // no /bin/bun exists on a test host, so the behaviour alone cannot tell; the source names no prefix-less path
    expect(sliceShellFn(LINUX, '_install_bun_from_npm')).toContain('npm_bun="\${npm_prefix:+\$npm_prefix/bin/bun}"')
  })
  it('the macOS port carries the same empty-prefix guard (GROMZONOPROVIDER1108 A2 port of BUNTIMEOUT1108)', () => {
    const mac = sliceShellFn(readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8'), '_install_bun_from_npm')
    expect(mac).toContain('npm_bun="\${npm_prefix:+\$npm_prefix/bin/bun}"')
    expect(mac).toContain('if [ "$rc" = 0 ] && [ -n "$npm_bun" ] && [ -x "$npm_bun" ]')
    expect(mac).not.toContain('npm prefix -g 2>/dev/null || true)/bin/bun')
  })
  it('the macOS sudo route goes through root_npm_install_global with no time limit, then sudo -K; no plain sudo npm (Dani 73629)', () => {
    const mac = sliceShellFn(readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8'), '_install_bun_from_npm')
    expect(mac).toMatch(/if \[ "\$\{NPM_NEEDS_SUDO:-\}" = "1" \]; then\n(?:\s*#[^\n]*\n)+\s+if ! root_npm_install_global "bun@\$\{BUN_PIN\}" >"\$log" 2>&1; then\n\s+rc=1\n\s+echo -e "  \$\{RED\}✗\$\{NC\} \$\(_t macos\.root_npm_bun_failed\)"/)
    expect(mac).toContain('command /usr/bin/sudo -K 2>/dev/null || true')
    const code = mac.split('\n').filter((l) => !l.trimStart().startsWith('#') && !/^\s*echo\b/.test(l)).join('\n')
    expect(code).not.toMatch(/\bsudo npm\b/)
    expect(code).not.toMatch(/_mac_timeout[^\n]*sudo/)
    expect(code).not.toMatch(/_mac_timeout[^\n]*root_npm_install_global/)
  })

  it('the GitHub path works: no npm call at all', () => {
    const work = mkdtempSync(join(tmpdir(), 'rinst-okvendor-'))
    const vendor = join(work, 'ok.sh')
    writeFileSync(vendor, '#!/bin/bash\nmkdir -p "$BUN_INSTALL/bin"\nprintf \'#!/bin/bash\\necho 1.4.4\\n\' > "$BUN_INSTALL/bin/bun"; chmod +x "$BUN_INSTALL/bin/bun"\n')
    const r = runBun({ FAKE_VENDOR_SCRIPT: vendor })
    expect(r.out).toContain('ok: bun telepitve: 1.4.4')
    expect(existsSync(join(r.work, 'npm.log'))).toBe(false)
  })
})

describe.skipIf(!HAVE_TIMEOUT)('no predictable temp path for a root-run script (Dani 73434)', () => {
  it('mktemp fails: the vendor script is neither fetched nor run, and the helper reports it', () => {
    const fake = mkdtempSync(join(tmpdir(), 'rinst-nomktemp-'))
    writeFileSync(join(fake, 'mktemp'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(fake, 'mktemp'), 0o755)
    const r = run('touch "$WORK/ran"; touch "$WORK/tool"', { MKTEMP_DIR: fake })
    expect(r.out).toContain('RESULT=1')
    expect(r.out).toContain('nem tudtam privat ideiglenes konyvtarat letrehozni (mktemp -d)')
    expect(existsSync(join(r.work, 'ran'))).toBe(false)
    expect(existsSync(join(r.work, 'curl.log'))).toBe(false)
  })
  it('the source has no fixed /tmp fallback name in the two helpers', () => {
    for (const f of ['_run_remote_installer', '_install_bun_from_npm']) expect(sliceShellFn(LINUX, f)).not.toMatch(/\|\|\s*echo\s+"?\/tmp\//)
  })
})

describe('TMPPROBE1108: no predictable /tmp fallback for a mktemp anywhere in the installers (Dani 73504)', () => {
  const files = ['install-linux.sh', 'install-macos.sh', 'install-lang.sh', ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`)]
  it('no `mktemp ... || echo|printf /tmp/...` line (code lines; a positive control proves the pattern bites)', () => {
    const rx = /mktemp[^\n]*\|\|\s*(echo|printf)\s+["']?\/tmp\//
    expect('  x="$(mktemp -d 2>/dev/null || echo /tmp/x.$$)"').toMatch(rx)
    const hits: string[] = []
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf-8').split('\n').forEach((l, i) => {
        if (!l.trimStart().startsWith('#') && rx.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
  it('both service-auth probes skip (UNKNOWN) instead of running claude without a private config dir', () => {
    const mac = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
    expect(LINUX).toMatch(/_probe_cfg="\$\(mktemp -d 2>\/dev\/null\)" \|\| _probe_cfg=""/)
    expect(LINUX).toMatch(/if \[ -n "\$_probe_cfg" \] && command -v claude >\/dev\/null 2>&1; then/)
    expect(mac).toMatch(/_probe_cfg="\$\(mktemp -d 2>\/dev\/null\)" \|\| _probe_cfg=""\n  if \[ -z "\$_probe_cfg" \]; then\n[^\n]*\n    INSTALL_AUTH_STATE="UNKNOWN"\n  else\n/)
  })
})
